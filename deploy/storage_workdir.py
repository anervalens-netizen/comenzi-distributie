#!/usr/bin/env python3
"""Local scratch reservations and process leases; never prunes backup archives.

Managed consumers call consume() before writing bounded content. The allocated
ballast shrinks as content replaces it, so the reservation is not a second copy.
Manual allocate keeps the ballast; budget for both it and the external writer.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid

BASE = Path('/storage/.agent-restore-work')
MARKER = '.managed-storage-work.json'
GIB = 1024 ** 3


def process_identity(pid):
    """Boot and start ticks prevent PID reuse from impersonating a lease owner."""
    try:
        fields = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        return {'pid': int(pid), 'start': fields[19],
                'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except FileNotFoundError:
        return None


def active_users(path, strict=True):
    """Conservative legacy/child check, including cwd, root and mapped files."""
    prefix = str(path) + '/'
    def inside(value):
        return value == str(path) or value.startswith(prefix)
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            links = [proc / 'cwd', proc / 'root', *list((proc / 'fd').iterdir())]
            for link in links:
                try:
                    target = os.readlink(link)
                    if proc.name == str(os.getpid()) and target in (str(path / '.lease'), str(path / '.reservation')):
                        continue
                    if inside(target):
                        return True
                except FileNotFoundError:
                    pass
            for row in (proc / 'maps').read_text().splitlines():
                fields = row.split(maxsplit=5)
                if len(fields) == 6 and inside(fields[5]):
                    return True
        except FileNotFoundError:
            continue
        except PermissionError:
            # GC runs as root; an incomplete process scan is not deletion proof.
            try:
                if os.geteuid() != 0 and proc.stat().st_uid != os.geteuid():
                    continue  # Other unprivileged users cannot enter mode-0700 scratch.
            except FileNotFoundError:
                continue
            if strict:
                return True
    return False


@contextmanager
def locked(base):
    base = Path(base).absolute()
    if base.is_symlink():
        raise RuntimeError('Unsafe scratch base')
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    if base.resolve() != base:
        raise RuntimeError('Scratch ancestors must not be symlinks')
    fd = os.open(base / '.allocation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield base
    finally:
        os.close(fd)


def candidate(base, path):
    path = Path(path).absolute()
    if path.is_symlink() or path.parent != base or not path.is_dir():
        raise RuntimeError('Not a managed scratch directory')
    marker = path / MARKER
    if marker.is_symlink():
        raise RuntimeError('Unsafe scratch marker')
    data = json.loads(marker.read_text())
    if data.get('path') != str(path) or data.get('schema') not in (1, 2):
        raise RuntimeError('Scratch marker mismatch')
    return data


def local_filesystem(base):
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        before, after = line.split(' - ', 1)
        mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), before.split()[4])
        if base == Path(mount) or Path(mount) in base.parents:
            mounts.append((len(mount), after.split()[0]))
    if not mounts or max(mounts)[1] in {'cifs', 'smb3', 'nfs', 'nfs4', '9p', 'ceph', 'fuse.sshfs', 'fuse.glusterfs'}:
        raise RuntimeError('Scratch must be on a verified local filesystem')


def collect_locked(base, only=None):
    result = []
    for path in sorted(base.iterdir()):
        if not path.is_dir() or path.is_symlink() or (only is not None and path != only):
            continue
        lease = None
        try:
            data = candidate(base, path)
            if data['schema'] == 1:
                recent = any(p.lstat().st_mtime > time.time() - 6*3600 for p in path.rglob('*'))
                if time.time() < data['expires_at'] or recent:
                    result.append({'path': str(path), 'status': 'preserved-legacy'})
                    continue
            else:
                lease = os.open(path / '.lease', os.O_RDWR | os.O_NOFOLLOW)
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                owner = data.get('owner')
                if owner and process_identity(owner['pid']) == owner:
                    result.append({'path': str(path), 'status': 'preserved-owner'})
                    continue
            if active_users(path, strict=data['schema'] == 1):
                result.append({'path': str(path), 'status': 'preserved-users'})
                continue
            shutil.rmtree(path)
            result.append({'path': str(path), 'status': 'removed-abandoned'})
        except BlockingIOError:
            result.append({'path': str(path), 'status': 'preserved-lease'})
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            result.append({'path': str(path), 'status': 'preserved-error', 'error': str(error)})
        finally:
            if lease is not None:
                os.close(lease)
    return result


class Scratch:
    def __init__(self, base, content_bytes, *, tag='restore', overhead_bytes=64*1024**2,
                 min_free_bytes=40*GIB, max_used_ratio=0.75, owner_pid=None, ttl_hours=48):
        if (not isinstance(content_bytes, int) or content_bytes < 0 or overhead_bytes < 0
                or min_free_bytes < 0 or not math.isfinite(max_used_ratio)
                or not 0 < max_used_ratio <= 1 or not 1 <= ttl_hours <= 72
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,45}', tag)):
            raise ValueError('Invalid scratch budget, tag or TTL')
        self.base = Path(base).absolute()
        self.limit = self.remaining = content_bytes
        self.overhead = overhead_bytes
        self.min_free = min_free_bytes
        self.max_used = max_used_ratio
        self.owner = process_identity(owner_pid or os.getpid())
        if self.owner is None:
            raise RuntimeError('Scratch owner is not alive')
        self.ttl = ttl_hours
        self.tag = tag
        self.path = None
        self.reserve = self.lease = None

    def check_space(self, projected=0):
        disk = shutil.disk_usage(self.base)
        if (disk.free - projected < self.min_free
                or (disk.total - disk.free + projected) / disk.total > self.max_used):
            raise RuntimeError('Insufficient scratch space: reserve or occupancy limit would be violated')

    def __enter__(self):
        with locked(self.base):
            local_filesystem(self.base)
            collect_locked(self.base)
            if any(path.is_dir() for path in self.base.iterdir()):
                raise RuntimeError('A restore scratch directory already exists; finish it first')
            self.check_space(self.limit + self.overhead)
            self.path = self.base / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + self.tag + '-' + uuid.uuid4().hex[:8])
            self.path.mkdir(mode=0o700)
            try:
                self.lease = os.open(self.path / '.lease', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
                fcntl.flock(self.lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                marker = {'schema': 2, 'path': str(self.path), 'owner': self.owner,
                          'created_at': time.time(), 'expires_at': time.time() + self.ttl*3600,
                          'content_bytes': self.limit, 'overhead_bytes': self.overhead}
                (self.path / MARKER).write_text(json.dumps(marker))
                self.reserve = os.open(self.path / '.reservation', os.O_CREAT | os.O_RDWR | os.O_EXCL, 0o600)
                os.posix_fallocate(self.reserve, 0, self.limit + self.overhead)
                self.check_space()
            except BaseException:
                self._close_fds()
                shutil.rmtree(self.path)
                raise
        return self

    def consume(self, count):
        if not isinstance(count, int) or count < 0 or count > self.remaining:
            raise RuntimeError('Scratch content exceeds the reserved budget')
        self.check_space()
        self.remaining -= count
        os.ftruncate(self.reserve, self.remaining + self.overhead)

    def extend(self, count):
        if not isinstance(count, int) or count < 0:
            raise ValueError('Invalid additional reservation')
        self.check_space(count)
        os.posix_fallocate(self.reserve, self.remaining + self.overhead, count)
        self.remaining += count
        self.limit += count

    def _close_fds(self):
        for name in ('reserve', 'lease'):
            fd = getattr(self, name)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)

    def __exit__(self, *exc):
        with locked(self.base):
            self._close_fds()
            # Only this exact lease's directory is eligible for normal cleanup.
            if candidate(self.base, self.path).get('owner') != self.owner:
                raise RuntimeError('Scratch ownership changed; preserving directory')
            if active_users(self.path, strict=False):
                raise RuntimeError('Scratch is still in use; preserving directory for GC')
            shutil.rmtree(self.path)


def configured(base, content_bytes, **kwargs):
    return Scratch(Path(os.environ.get('MOBIUP_SCRATCH_ROOT', str(base))), content_bytes,
                   min_free_bytes=int(os.environ.get('MOBIUP_SCRATCH_MIN_FREE_BYTES', str(40*GIB))),
                   max_used_ratio=float(os.environ.get('MOBIUP_SCRATCH_MAX_USED_RATIO', '0.75')), **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=BASE)
    sub = parser.add_subparsers(dest='action', required=True)
    allocate = sub.add_parser('allocate')
    allocate.add_argument('tag')
    allocate.add_argument('--estimated-gib', type=float, required=True)
    allocate.add_argument('--ttl-hours', type=int, default=48)
    allocate.add_argument('--owner-pid', type=int, required=True, help='Live owning shell/job, not this short-lived allocator')
    release = sub.add_parser('release'); release.add_argument('path', type=Path)
    sub.add_parser('gc'); sub.add_parser('status')
    args = parser.parse_args()
    if args.action == 'allocate':
        if not math.isfinite(args.estimated_gib) or not 0 <= args.estimated_gib <= 500:
            raise ValueError('Invalid estimate')
        size = int(args.estimated_gib * GIB)
        # External writers cannot release ballast; account for both footprints.
        scratch = Scratch(args.base, 2*size, tag=args.tag, ttl_hours=args.ttl_hours, owner_pid=args.owner_pid)
        scratch.__enter__()
        os.ftruncate(scratch.reserve, size + scratch.overhead)
        scratch._close_fds()
        print(scratch.path)
    else:
        with locked(args.base) as base:
            if args.action == 'status':
                disk = shutil.disk_usage(base)
                print(json.dumps({'free_bytes': disk.free, 'total_bytes': disk.total,
                                  'managed_dirs': sum(p.is_dir() for p in base.iterdir())}))
            else:
                only = args.path.absolute() if args.action == 'release' else None
                if only is not None:
                    candidate(base, only)
                result = collect_locked(base, only)
                print(json.dumps(result))
                if only is not None and only.exists():
                    raise RuntimeError('Scratch has a live owner, lease or user; finish the owning job first')


if __name__ == '__main__':
    main()
