"""Verify and restore a full application backup to a NEW isolated directory.

Does not start services or modify production. Requires the archive SHA-256 sidecar.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tarfile
import tempfile


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def restore(archive: Path, destination: Path, checksum: Path | None = None) -> dict:
    archive = archive.resolve(strict=True)
    checksum = checksum or archive.with_suffix(archive.suffix + '.sha256')
    expected = checksum.read_text().split()[0]
    if len(expected) != 64 or digest(archive) != expected:
        raise RuntimeError('Archive checksum mismatch')
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise RuntimeError('Destination must not exist; production is never overwritten')
    temporary = Path(tempfile.mkdtemp(prefix='.restore-', dir=destination.parent))
    os.chmod(temporary, 0o700)
    try:
        seen = set()
        total = 0
        with tarfile.open(archive, 'r:gz') as source:
            for member in source:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or member.name in seen:
                    raise RuntimeError('Unsafe or duplicate archive path')
                if not member.isfile() and not member.isdir():
                    raise RuntimeError('Only regular files and directories may be restored')
                seen.add(member.name)
                total += member.size
                if len(seen) > 100000 or total > 8 * 1024**3:
                    raise RuntimeError('Recovery archive exceeds the bounded restore budget')
                target = temporary.joinpath(*path.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with source.extractfile(member) as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
        manifest = json.loads((temporary / 'recovery/manifest.json').read_text())
        if manifest.get('schema') != 1 or not manifest.get('files'):
            raise RuntimeError('Missing full-recovery manifest')
        for name, checksum_value in manifest['files'].items():
            if not name.startswith('recovery/') or name not in seen or digest(temporary / name) != checksum_value:
                raise RuntimeError('Recovery file checksum mismatch')
        recovery_members = {name for name in seen if name.startswith('recovery/') and (temporary / name).is_file() and name != 'recovery/manifest.json'}
        if recovery_members != set(manifest['files']):
            raise RuntimeError('Unverified recovery file')
        runtime = temporary / 'recovery/runtime'
        release = json.loads((temporary / 'RELEASE.json').read_text())
        if json.loads((runtime / 'RELEASE.json').read_text()) != release or not (runtime / 'server.js').is_file():
            raise RuntimeError('Release/runtime recovery mismatch')
        databases = {}
        for name in ('mobiup.sqlite', 'sales.sqlite', 'client-history/client-sales-history.sqlite'):
            path = temporary / name
            if not path.exists():
                if name == 'mobiup.sqlite':
                    raise RuntimeError('Required application database is missing')
                continue
            with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as db:
                integrity = db.execute('PRAGMA integrity_check').fetchall()
                if integrity != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchone():
                    raise RuntimeError('Restored database is inconsistent')
                if name == 'client-history/client-sales-history.sqlite':
                    for source_hash, relative in db.execute('SELECT sha256,original_path FROM history_imports'):
                        original = temporary / 'client-history' / relative
                        if not original.resolve().is_relative_to((temporary / 'client-history').resolve()) or not original.is_file() or digest(original) != source_hash:
                            raise RuntimeError('Restored customer history original is inconsistent')
                databases[name] = 'ok'
        # Prevent a race from replacing a directory created by someone else.
        destination.mkdir(mode=0o700)
        try:
            for path in temporary.iterdir():
                path.rename(destination / path.name)
        except Exception:
            # Preserve any partially moved data for inspection; do not delete others' paths.
            raise RuntimeError('Restore publication failed; inspect the isolated destination')
        return {'status': 'restored_not_started', 'sha': release.get('sha'), 'databases': databases,
                'recoveryFiles': len(manifest['files']), 'destination': str(destination)}
    finally:
        shutil.rmtree(temporary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    parser.add_argument('--checksum', type=Path)
    args = parser.parse_args()
    print(json.dumps(restore(args.archive, args.destination, args.checksum)))
