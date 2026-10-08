"""Consistent application and sales snapshots, with immutable source/export files."""
from contextlib import closing
import hashlib
import importlib.util
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


def prune_backups(folder: Path, keep_count: int = 2) -> None:
    """Keep only the newest complete local generations for bounded recovery."""
    if keep_count < 1:
        raise ValueError('Backup retention must keep at least one generation')
    root = folder.resolve()
    complete = []
    for archive in sorted(folder.glob('mobiup-comenzi-????????T??????Z.tar.gz'), reverse=True):
        if archive.is_symlink() or not archive.resolve().is_relative_to(root):
            continue
        checksum_file = archive.with_suffix(archive.suffix + '.sha256')
        try:
            expected = checksum_file.read_text().split()
        except (OSError, UnicodeError):
            expected = []
        if (len(expected) != 2 or expected[1] != archive.name or len(expected[0]) != 64
                or expected[0] != digest(archive)):
            archive.unlink(missing_ok=True)
            checksum_file.unlink(missing_ok=True)
            continue
        complete.append(archive)
    for old in complete[keep_count:]:
        old.unlink()
        old.with_suffix(old.suffix + '.sha256').unlink(missing_ok=True)


def prune_nas_latest(folder: Path, current: Path, validation_root: Path | None = None) -> None:
    """Retain the latest complete verified recovery generation when configured."""
    if current.parent != folder or current.is_symlink():
        raise RuntimeError('Unsafe NAS generation')
    expected = current.with_suffix(current.suffix + '.sha256').read_text().split()
    if expected != [digest(current), current.name]:
        raise RuntimeError('NAS retention checksum mismatch')
    # Before deleting the last offsite fallback, exercise the same supported
    # restore gates (budget, paths, resources, runtime and database integrity).
    spec = importlib.util.spec_from_file_location('backup_retention_restore', Path(__file__).with_name('restore.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='retention-verify-', dir=validation_root) as temporary:
        module.restore(current, Path(temporary) / 'restored')
    for old in folder.glob('mobiup-comenzi-????????T??????Z.tar.gz'):
        if old.name < current.name and old.is_file() and not old.is_symlink():
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



def add_recovery_files(output: tarfile.TarFile, recovery: dict[str, Path], release: Path, expected_release: bytes) -> None:
    """Include the exact runnable release and private build inputs, never symlinks."""
    if set(recovery) != {'runtime', 'resources', 'products'}:
        raise RuntimeError('Full recovery requires runtime, resources and products directories')
    roots = {name: path.resolve(strict=True) for name, path in recovery.items()}
    if (roots['runtime'] / 'RELEASE.json').read_bytes() != expected_release:
        raise RuntimeError('Recovery runtime does not match the active release')
    for name, required in [('runtime', 'server.js'), ('resources', 'resource-mode.json')]:
        if not (roots[name] / required).is_file():
            raise RuntimeError(f'Recovery {name} is missing {required}')
    if './bind-ready.mjs' in (roots['runtime'] / 'server.js').read_text() and not (roots['runtime'] / 'bind-ready.mjs').is_file():
        raise RuntimeError('Recovery runtime is missing bind-ready.mjs')
    mode = json.loads((roots['resources'] / 'resource-mode.json').read_text())
    names = ['seed.json', 'initial-users.json', 'accesorii.xlsx', 'standuri.xlsx', 'templates.json', 'template-hashes.json', 'mail-defaults.json']
    if mode.get('mode') != 'private' or mode.get('schema') != 1 or any(name not in mode.get('sha256', {}) for name in names):
        raise RuntimeError('Recovery resources are not complete private production inputs')
    hashes = {}
    for name in names:
        source = (roots['resources'] / name).resolve()
        if not source.is_relative_to(roots['resources']) or digest(source) != mode['sha256'][name]:
            raise RuntimeError('Recovery resource integrity mismatch')
        hashes[name] = mode['sha256'][name]
    resource_digest = hashlib.sha256(json.dumps(hashes, separators=(',', ':')).encode()).hexdigest()
    if json.loads(expected_release).get('resourceDigest') != resource_digest:
        raise RuntimeError('Recovery private inputs do not match the compiled release')
    manifest = {'schema': 1, 'files': {}}
    for name, root in roots.items():
        if not root.is_dir():
            raise RuntimeError(f'Missing recovery directory: {name}')
        files = sorted(root.rglob('*'))
        if not any(path.is_file() for path in files):
            raise RuntimeError(f'Empty recovery directory: {name}')
        for path in files:
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise RuntimeError('Recovery tree contains a symlink or escaping path')
            if path.is_dir():
                continue
            if not path.is_file():
                raise RuntimeError('Recovery tree contains a non-regular file')
            key = 'recovery/' + name + '/' + path.relative_to(root).as_posix()
            before = digest(path)
            # Serialize bytes, not inode aliases: hardlinked source files must
            # remain independent regular archive members accepted by restore.
            with path.open('rb') as stream:
                info = output.gettarinfo(fileobj=stream, arcname=key)
                info.type = tarfile.REGTYPE
                info.linkname = ''
                info.size = os.fstat(stream.fileno()).st_size
                output.addfile(info, stream)
            if digest(path) != before:
                raise RuntimeError('Recovery inputs changed during backup; retry the backup')
            manifest['files'][key] = before
    if release.read_bytes() != expected_release:
        raise RuntimeError('Active release changed during backup; retry the backup')
    import io
    payload = json.dumps(manifest, sort_keys=True).encode()
    info = tarfile.TarInfo('recovery/manifest.json')
    info.size = len(payload)
    info.mode = 0o600
    output.addfile(info, io.BytesIO(payload))


def verify_sqlite_snapshot(connection: sqlite3.Connection, label: str) -> None:
    integrity = connection.execute('PRAGMA integrity_check').fetchall()
    if integrity != [('ok',)]:
        raise RuntimeError(f'{label} integrity check failed')
    foreign_keys = connection.execute('PRAGMA foreign_key_check').fetchall()
    if foreign_keys:
        raise RuntimeError(f'{label} foreign key check failed')


def run_backup(
    *,
    data: Path = Path('/storage/comenzi-distributie'),
    local: Path = Path('/storage/backups/comenzi-distributie'),
    nas: Path = Path('/mnt/nas/backups/server-68/comenzi-distributie'),
    nas_mount: Path = Path('/mnt/nas'),
    release: Path = Path('/opt/Mobiup/comenzi-distributie/runtime/current/RELEASE.json'),
    recovery: dict[str, Path] | None = None,
    nas_latest_only: bool = False,
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
            verify_sqlite_snapshot(copy, 'Application snapshot')
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
                verify_sqlite_snapshot(copy, 'Sales snapshot')
        # Sources are immutable and published before their database transaction.
        # Enumerating after the snapshot includes all its sources; extra newer files
        # are harmless and do not change the generation recorded in the snapshot.
        sales_sources = sorted(path for path in (data / 'sales-imports').glob('*') if path.suffix in ('.xlsx', '.xls')) if sales_snapshot.exists() else []
        history_snapshot = Path(temporary) / 'client-sales-history.sqlite'
        history_root = data / 'client-history'
        history_db = history_root / 'client-sales-history.sqlite'
        history_sources = []
        if history_db.exists():
            if history_root.is_symlink() or history_db.is_symlink():
                raise RuntimeError('Invalid customer history location')
            with closing(sqlite3.connect(f'file:{history_db}?mode=ro', uri=True)) as source, closing(sqlite3.connect(history_snapshot)) as copy:
                source.backup(copy)
                verify_sqlite_snapshot(copy, 'Customer history snapshot')
                for expected, relative in copy.execute('SELECT sha256,original_path FROM history_imports'):
                    path = history_root / relative
                    if path.is_symlink() or not path.resolve().is_relative_to(history_root.resolve()) or not path.is_file() or digest(path) != expected:
                        raise RuntimeError('Customer history original missing or checksum mismatch')
                    history_sources.append((path, relative, expected))
        captured_release = release.read_bytes()
        try:
            with tarfile.open(local_partial, 'w:gz', compresslevel=2) as output:
                output.add(snapshot, arcname='mobiup.sqlite')
                if sales_snapshot.exists():
                    output.add(sales_snapshot, arcname='sales.sqlite')
                if history_snapshot.exists():
                    output.add(history_snapshot, arcname='client-history/client-sales-history.sqlite')
                for path, relative, expected in history_sources:
                    output.add(path, arcname='client-history/' + relative)
                    if digest(path) != expected:
                        raise RuntimeError('Customer history source changed during backup')
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
                if recovery is not None:
                    add_recovery_files(output, recovery, release, captured_release)
                if release.read_bytes() != captured_release:
                    raise RuntimeError('Release changed during archive creation')
            local_partial.replace(archive)
        except Exception:
            local_partial.unlink(missing_ok=True)
            raise
    checksum = digest(archive)
    checksum_file = archive.with_suffix(archive.suffix + '.sha256')
    checksum_file.write_text(f'{checksum}  {name}\n')
    print(f'Verified local backup: {name}; exports={len(keys)}; sales_sources={len(sales_sources)}; sha256={checksum}', flush=True)
    # Local retention must not depend on NAS availability or write permissions.
    prune_backups(local)

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
        if nas_latest_only:
            prune_nas_latest(nas, nas / name, local)
        else:
            prune_backups(nas)
    except (OSError, RuntimeError) as error:
        temporary_copy.unlink(missing_ok=True)
        # Preserve the verified local generation, but let systemd report failure.
        raise RuntimeError(f'Local backup verified: {name}; NAS backup failed: {error}') from error

    print(f'Verified local and NAS backup: {name}; exports={len(keys)}; sales_sources={len(sales_sources)}; sha256={checksum}')
    return archive


if __name__ == '__main__':
    configured = {name: os.environ.get('MOBIUP_RECOVERY_' + name.upper(), '') for name in ('runtime', 'resources', 'products')}
    if any(configured.values()) and not all(configured.values()):
        raise RuntimeError('Incomplete recovery configuration')
    run_backup(recovery={name: Path(value) for name, value in configured.items()} if all(configured.values()) else None,
               nas_latest_only=os.environ.get('MOBIUP_NAS_LATEST_ONLY') == '1')
