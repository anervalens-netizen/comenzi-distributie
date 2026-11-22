"""Check a locally received portfolio archive before promoting or pruning recovery."""
import argparse
import hashlib
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def sibling(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


restore = sibling('restore')
storage = sibling('storage_workdir')
GIB = 1024 ** 3
ARCHIVE = re.compile(r'mobiup-comenzi-[0-9]{8}T[0-9]{6}Z\.tar\.gz(?:\.age)?')


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if path.resolve(strict=True) != path.absolute() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError('Receiver work and receipts require a private local directory')
    storage.local_filesystem(path)


@contextmanager
def plaintext(archive, identity, decrypt_scratch):
    if archive.suffix != '.age':
        yield archive
        return
    if identity is None or decrypt_scratch is None:
        raise ValueError('Encrypted archive requires an age identity and local decryption scratch')
    # An authenticated age stream is never longer than its encrypted input.
    private_directory(decrypt_scratch)
    size = archive.stat().st_size
    available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemAvailable:'))
    if available < size + 2 * GIB:
        raise RuntimeError('Insufficient available memory for local decryption scratch')
    with storage.Scratch(decrypt_scratch, size, tag='receiver-decrypt',
                         min_free_bytes=GIB, max_used_ratio=0.75) as work:
        output = work.path / archive.stem
        with output.open('xb') as dst, subprocess.Popen(
                ['age', '--decrypt', '--identity', str(identity), str(archive)],
                stdout=subprocess.PIPE) as child:
            try:
                with child.stdout as stream:
                    while chunk := stream.read(1024 * 1024):
                        work.consume(len(chunk))
                        dst.write(chunk)
            except BaseException:
                child.kill()
                raise
            if child.wait():
                raise RuntimeError('Receiver could not decrypt the stored archive')
        yield output


def verify(folder, receipt, scratch, *, identity=None, decrypt_scratch=None, max_used_ratio=0.75):
    if receipt.resolve().is_relative_to(folder.resolve()):
        raise ValueError('Trusted receiver receipt must be outside the received folder')
    private_directory(receipt.parent)
    private_directory(scratch)
    candidates = [p for p in folder.iterdir() if ARCHIVE.fullmatch(p.name)]
    if len(candidates) != 1 or candidates[0].is_symlink() or not candidates[0].is_file():
        raise ValueError('Expected exactly one local regular recovery archive')
    archive = candidates[0]
    stored_digest = restore.digest(archive)
    identity_hash = None
    if archive.suffix == '.age':
        if identity is None:
            raise ValueError('Encrypted archive requires an age identity')
        public_identity = subprocess.check_output(['age-keygen', '-y', str(identity)], timeout=15)
        identity_hash = hashlib.sha256(public_identity.strip()).hexdigest()
    try:
        known = json.loads(receipt.read_text())
    except FileNotFoundError:
        known = {}
    if (known.get('schema') == 1 and known.get('status') == 'restored_not_started'
            and known.get('archive') == archive.name and known.get('stored_sha256') == stored_digest
            and known.get('identity_sha256') == identity_hash):
        return {**known, 'reused': True}

    with plaintext(archive, identity, decrypt_scratch) as local:
        size, members = restore.inspect_archive(local)
        with storage.Scratch(scratch, size, tag='receiver-restore', max_used_ratio=max_used_ratio,
                             overhead_bytes=64 * 1024 ** 2 + members * 8192) as work:
            checksum = work.path / 'archive.sha256'
            digest = restore.digest(local)
            checksum.write_text(digest + '\n')
            result = restore.restore(local, work.path / 'restored', checksum, scratch=work)
    if result.get('status') != 'restored_not_started' or restore.digest(archive) != stored_digest:
        raise RuntimeError('Stored archive changed or receiver restore failed')
    record = {'schema': 1, 'archive': archive.name, 'stored_sha256': stored_digest, 'sha256': digest,
              'status': result['status'], 'release': result['sha'], 'databases': result['databases']}
    if identity_hash:
        record['identity_sha256'] = identity_hash
    fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=receipt.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, receipt)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {**record, 'reused': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', required=True, type=Path)
    parser.add_argument('--receipt', required=True, type=Path, help='Trusted receiver-local file outside received data')
    parser.add_argument('--scratch', required=True, type=Path)
    parser.add_argument('--age-identity', type=Path)
    parser.add_argument('--decrypt-scratch', type=Path, help='Private local tmpfs for decrypted input')
    parser.add_argument('--max-used-ratio', type=float, default=0.75,
                        help='Receiver filesystem occupancy limit; 40 GiB free is always required')
    args = parser.parse_args()
    print(json.dumps(verify(args.folder, args.receipt, args.scratch, identity=args.age_identity,
                            decrypt_scratch=args.decrypt_scratch, max_used_ratio=args.max_used_ratio)))
