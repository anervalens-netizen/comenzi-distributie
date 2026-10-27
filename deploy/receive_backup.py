"""Receive only a hash-bound, restore-validated generation from a mounted source.

The caller must verify the source mount identity. This copies existing backups;
it never makes a new backup, restores data or starts application services.
"""
import argparse
import fcntl
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
            if archive.is_symlink():
                continue
            checksum_file = archive.with_suffix(archive.suffix + '.sha256')
            try:
                if checksum_file.is_symlink():
                    continue
                expected = checksum_file.read_text().split()
                if len(expected) != 2 or expected[1] != archive.name or len(expected[0]) != 64:
                    continue
                receipt = backup.validation_receipt(archive, expected[0])
                if receipt and backup.digest(archive) == expected[0]:
                    selected = (archive, expected[0], receipt)
                    break
            except (OSError, ValueError):
                continue
        if selected is None:
            raise RuntimeError('No restore-validated source generation; existing recovery copies preserved')
        archive, checksum, receipt = selected
        current = destination / archive.name
        if current.is_symlink():
            raise RuntimeError('Unsafe receiver generation')
        if not current.exists() or backup.digest(current) != checksum:
            copy_fd, temporary = tempfile.mkstemp(prefix=current.name + '.', suffix='.partial', dir=destination)
            os.close(copy_fd)
            try:
                shutil.copyfile(archive, temporary)
                if backup.digest(Path(temporary)) != checksum:
                    raise RuntimeError('Receiver checksum mismatch; prior recovery preserved')
                os.replace(temporary, current)
            finally:
                Path(temporary).unlink(missing_ok=True)
        sidecar = current.with_suffix(current.suffix + '.sha256')
        sidecar.write_text(checksum + '  ' + current.name + '\n')
        backup.record_validation(current, checksum, {'status': receipt['status'], 'sha': receipt['release']})
        backup.prune_backups(destination, keep_count=1)
        return {'archive': current.name, 'sha256': checksum, 'validation': 'copied-from-restore-validated-source'}
    finally:
        os.close(fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(receive(args.source, args.destination)))
