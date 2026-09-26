"""Consistent application and sales snapshots, with immutable source/export files."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile
from datetime import datetime, timezone, timedelta


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prune_backups(folder: Path, cutoff: datetime) -> None:
    # Retain fourteen days of this application's own backup generations.
    for old in folder.glob('mobiup-comenzi-????????T??????Z.tar.gz'):
        if old.is_symlink() or not old.resolve().is_relative_to(folder.resolve()):
            continue
        saved = datetime.strptime(old.name[15:-7], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
        if saved < cutoff:
            old.unlink()
            old.with_suffix(old.suffix + '.sha256').unlink(missing_ok=True)


def prune_partials(folder: Path, cutoff: datetime) -> None:
    """Remove only stale interrupted generations owned by this backup job."""
    if not folder.exists():
        return
    root = folder.resolve()
    for partial in folder.glob('mobiup-comenzi-*.tar.gz.partial'):
        if partial.is_symlink() or not partial.resolve().is_relative_to(root):
            continue
        try:
            modified = datetime.fromtimestamp(partial.stat().st_mtime, timezone.utc)
        except FileNotFoundError:
            continue
        if modified < cutoff:
            partial.unlink(missing_ok=True)


def run_backup(
    *,
    data: Path = Path('/storage/comenzi-distributie'),
    local: Path = Path('/storage/backups/comenzi-distributie'),
    nas: Path = Path('/mnt/nas/backups/server-68/comenzi-distributie'),
    nas_mount: Path = Path('/mnt/nas'),
    release: Path = Path('/opt/Mobiup/comenzi-distributie/runtime/current/RELEASE.json'),
) -> Path:
    """Publish locally first; an offsite failure still exits unsuccessfully.

    Path arguments allow isolated tests without accessing production storage.
    The systemd invocation and default production locations remain unchanged.
    """
    local.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    prune_partials(local, now - timedelta(days=1))
    stamp = now.strftime('%Y%m%dT%H%M%SZ')
    name = f'mobiup-comenzi-{stamp}.tar.gz'
    archive = local / name
    local_partial = Path(str(archive) + '.partial')
    with tempfile.TemporaryDirectory(prefix='snapshot-', dir=local) as temporary:
        snapshot = Path(temporary) / 'mobiup.sqlite'
        with closing(sqlite3.connect(f'file:{data / "mobiup.sqlite"}?mode=ro', uri=True)) as source, closing(sqlite3.connect(snapshot)) as copy:
            source.backup(copy)
            if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Application snapshot integrity check failed')
            keys = []
            for row in copy.execute("SELECT kind,payload FROM orders WHERE status='finalized'"):
                kind, payload = row
                order = json.loads(payload)
                key = order.get('exportKey')
                # Email-only stand notices intentionally have no Excel attachment.
                # Their complete finalized payload is already in the SQLite snapshot.
                # Relational kind is authoritative, just as in application orderView.
                if kind == 'stand_client' and key is None:
                    continue
                if not isinstance(key, str) or not key:
                    raise RuntimeError('Finalized order is missing its required export key')
                keys.append(key)
        sales_snapshot = Path(temporary) / 'sales.sqlite'
        if (data / 'sales.sqlite').exists():
            with closing(sqlite3.connect(f'file:{data / "sales.sqlite"}?mode=ro', uri=True)) as source, closing(sqlite3.connect(sales_snapshot)) as copy:
                source.backup(copy)
                if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Sales snapshot integrity check failed')
        # Sources are immutable and published before their database transaction.
        # Enumerating after the snapshot includes all its sources; extra newer files
        # are harmless and do not change the generation recorded in the snapshot.
        sales_sources = sorted(path for path in (data / 'sales-imports').glob('*') if path.suffix in ('.xlsx', '.xls')) if sales_snapshot.exists() else []
        try:
            with tarfile.open(local_partial, 'w:gz', compresslevel=2) as output:
                output.add(snapshot, arcname='mobiup.sqlite')
                if sales_snapshot.exists():
                    output.add(sales_snapshot, arcname='sales.sqlite')
                for path in sales_sources:
                    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to((data / 'sales-imports').resolve()):
                        raise RuntimeError('Invalid sales source location')
                    output.add(path, arcname='sales-imports/' + path.name)
                for key in keys:
                    path = (data / 'files' / key).resolve()
                    if not path.is_relative_to((data / 'files').resolve()):
                        raise RuntimeError('Invalid export location')
                    output.add(path, arcname='files/' + key)
                output.add(release, arcname='RELEASE.json')
            local_partial.replace(archive)
        except Exception:
            local_partial.unlink(missing_ok=True)
            raise
    checksum = digest(archive)
    checksum_file = archive.with_suffix(archive.suffix + '.sha256')
    checksum_file.write_text(f'{checksum}  {name}\n')
    print(f'Verified local backup: {name}; exports={len(keys)}; sales_sources={len(sales_sources)}; sha256={checksum}', flush=True)
    # Local retention must not depend on NAS availability or write permissions.
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    prune_backups(local, cutoff)

    temporary_copy = nas / (name + '.partial')
    try:
        # Check before mkdir/copy: do not write a fake NAS backup to local disk.
        if not os.path.ismount(nas_mount):
            raise RuntimeError('NAS is not mounted')
        nas.mkdir(parents=True, exist_ok=True)
        prune_partials(nas, now - timedelta(days=1))
        shutil.copyfile(archive, temporary_copy)
        if digest(temporary_copy) != checksum:
            raise RuntimeError('NAS backup checksum mismatch')
        temporary_copy.replace(nas / name)
        shutil.copyfile(checksum_file, nas / checksum_file.name)
        prune_backups(nas, cutoff)
    except (OSError, RuntimeError) as error:
        temporary_copy.unlink(missing_ok=True)
        # Preserve the verified local generation, but let systemd report failure.
        raise RuntimeError(f'Local backup verified: {name}; NAS backup failed: {error}') from error

    print(f'Verified local and NAS backup: {name}; exports={len(keys)}; sales_sources={len(sales_sources)}; sha256={checksum}')
    return archive


if __name__ == '__main__':
    run_backup()
