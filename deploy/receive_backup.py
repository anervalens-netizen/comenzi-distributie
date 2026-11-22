"""Independently restore-check a candidate before promoting it on the receiver.

The caller must verify the source mount identity. Restores use local scratch;
production data and application services are never touched.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

spec = importlib.util.spec_from_file_location('receiver_backup', Path(__file__).with_name('backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def receive(source, destination):
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or destination.is_symlink():
        raise RuntimeError('Unsafe recovery directory')
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(destination / '.receive.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selected = None
        for archive in sorted(source.glob('mobiup-comenzi-????????T??????Z.tar.gz'), reverse=True):
            if archive.is_symlink() or not archive.is_file():
                continue
            checksum_file = archive.with_suffix(archive.suffix + '.sha256')
            try:
                expected = backup.read_metadata(checksum_file).split()
                if (len(expected) != 2 or expected[1] != archive.name or len(expected[0]) != 64
                        or any(c not in '0123456789abcdef' for c in expected[0])):
                    continue
                # The source marker signals a complete upload. Only the receiver's
                # own restore can authorize publication and retention.
                if not backup.validation_receipt(archive, expected[0]):
                    continue
                with backup.regular_input(archive) as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected[0]:
                        continue
                selected = archive, expected[0]
                break
            except (OSError, ValueError):
                continue
        if selected is None:
            raise RuntimeError('No restore-validated source generation; existing recovery copies preserved')
        archive, checksum = selected
        current = destination / archive.name
        if current.is_symlink():
            raise RuntimeError('Unsafe receiver generation')
        if current.exists() and backup.digest(current) != checksum:
            raise RuntimeError('Receiver generation name already has different contents; prior recovery preserved')
        receipt = backup.validation_receipt(current, checksum) if current.exists() else None
        sidecar = current.with_suffix(current.suffix + '.sha256')
        if (not receipt or receipt.get('validated_by') != 'receiver'
                or not sidecar.is_file() or sidecar.is_symlink()
                or backup.read_metadata(sidecar).split() != [checksum, current.name]):
            with tempfile.TemporaryDirectory(prefix='.receive-', dir=destination) as staging_dir:
                staged = Path(staging_dir) / current.name
                # A legacy receipt from this directory can have originated on the source.
                # Revalidate those bytes once, including when the archive already exists.
                with backup.regular_input(archive) as source_file, staged.open('xb') as target:
                    size = os.fstat(source_file.fileno()).st_size
                    reserve = int(os.environ.get('MOBIUP_SCRATCH_MIN_FREE_BYTES', str(40 * 1024**3)))
                    if shutil.disk_usage(destination).free - size < reserve:
                        raise RuntimeError('Insufficient receiver space to stage the candidate')
                    remaining = size
                    while remaining:
                        chunk = source_file.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            raise RuntimeError('Source archive changed during transfer')
                        target.write(chunk)
                        remaining -= len(chunk)
                    if source_file.read(1):
                        raise RuntimeError('Source archive changed during transfer')
                if backup.digest(staged) != checksum:
                    raise RuntimeError('Receiver checksum mismatch; prior recovery preserved')
                staged_sidecar = staged.with_suffix(staged.suffix + '.sha256')
                staged_sidecar.write_text(checksum + '  ' + current.name + '\n')
                backup.validate_archive(staged, destination, validated_by='receiver')
                os.replace(staged, current)
                os.replace(staged_sidecar, sidecar)
                os.replace(backup.validation_path(staged), backup.validation_path(current))
        backup.prune_backups(destination, keep_count=1, validated_by='receiver')
        return {'archive': current.name, 'sha256': checksum, 'validation': 'restored-on-receiver'}
    finally:
        os.close(fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(receive(args.source, args.destination)))
