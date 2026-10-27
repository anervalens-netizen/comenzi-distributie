"""Real filesystem/process tests using tiny, wholly synthetic reservations."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/storage_workdir.py'
spec = importlib.util.spec_from_file_location('scratch_test', SOURCE)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class ScratchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='scratch-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.base = self.root / 'scratch'

    def work(self, **kwargs):
        return storage.Scratch(self.base, 8192, overhead_bytes=8192,
                               min_free_bytes=0, max_used_ratio=1, **kwargs)

    def test_real_reservation_replaced_by_bounded_content_and_cleaned(self):
        with self.work() as work:
            reserve = work.path / '.reservation'
            self.assertGreaterEqual(reserve.stat().st_blocks*512, 16384)
            work.consume(4096)
            (work.path / 'content').write_bytes(b'x'*4096)
            self.assertEqual(reserve.stat().st_size, 12288)
            with self.assertRaisesRegex(RuntimeError, 'exceeds'):
                work.consume(8192)
        self.assertEqual([p for p in self.base.iterdir() if p.is_dir()], [])

    def test_exception_cleans_without_touching_unrelated_data(self):
        unrelated = self.root / 'keep'; unrelated.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'synthetic'):
            with self.work() as work:
                raise ValueError('synthetic')
        self.assertFalse(work.path.exists())
        self.assertEqual(unrelated.read_text(), 'keep')

    def test_insufficient_space_fails_before_creating_work(self):
        usage = type('Usage', (), {'free': 16383, 'total': 65536})()
        with patch.object(storage.shutil, 'disk_usage', return_value=usage):
            with self.assertRaisesRegex(RuntimeError, 'Insufficient'):
                with self.work():
                    self.fail('Must refuse allocation')
        self.assertFalse(any(p.is_dir() for p in self.base.iterdir()))

    def test_second_process_cannot_allocate_while_lease_is_alive(self):
        with self.work():
            code = (f'import runpy; m=runpy.run_path({str(SOURCE)!r}); '
                    f'w=m["Scratch"]({str(self.base)!r},8192,overhead_bytes=8192,min_free_bytes=0,max_used_ratio=1); w.__enter__()')
            result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('already exists', result.stderr)

    def test_live_lease_preserved_even_when_expired(self):
        with self.work() as work:
            marker = work.path / storage.MARKER
            data = json.loads(marker.read_text()); data['expires_at'] = 0
            marker.write_text(json.dumps(data))
            with storage.locked(self.base):
                result = storage.collect_locked(self.base)
            self.assertEqual(result[0]['status'], 'preserved-lease')
            self.assertTrue(work.path.exists())

    def test_killed_process_is_collected_and_capacity_can_be_reused(self):
        code = (f'import runpy,sys; m=runpy.run_path({str(SOURCE)!r}); '
                f'w=m["Scratch"]({str(self.base)!r},8192,overhead_bytes=8192,min_free_bytes=0,max_used_ratio=1); '
                'w.__enter__(); print(w.path,flush=True); sys.stdin.read()')
        child = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            abandoned = Path(child.stdout.readline().strip())
            self.assertTrue(abandoned.is_dir())
            child.send_signal(signal.SIGKILL); child.wait(timeout=5)
            with storage.locked(self.base):
                result = storage.collect_locked(self.base)
            self.assertEqual(result[0]['status'], 'removed-abandoned')
            self.assertFalse(abandoned.exists())
            with self.work():
                pass
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=5)
            child.stdin.close(); child.stdout.close()

    def test_process_cwd_is_detected(self):
        directory = self.root / 'cwd'; directory.mkdir()
        child = subprocess.Popen([sys.executable, '-c', 'import sys; print("ready",flush=True); sys.stdin.read()'],
                                 cwd=directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            child.stdout.readline()
            self.assertTrue(storage.active_users(directory))
        finally:
            child.terminate(); child.wait(timeout=5); child.stdin.close(); child.stdout.close()

    def test_failed_fallocate_leaves_no_marker_or_directory(self):
        with patch.object(storage.os, 'posix_fallocate', side_effect=OSError('synthetic allocation failure')):
            with self.assertRaisesRegex(OSError, 'synthetic'):
                with self.work():
                    self.fail('Must refuse failed reservation')
        self.assertFalse(any(p.is_dir() for p in self.base.iterdir()))

    def test_symlinked_base_is_never_followed(self):
        target = self.root / 'target'; target.mkdir(); self.base.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
            with self.work():
                self.fail('Must not follow symlink')

    def test_network_filesystem_is_rejected(self):
        self.base.mkdir()
        real_read = Path.read_text
        def mountinfo(path, *args, **kwargs):
            if str(path) == '/proc/self/mountinfo':
                return '1 0 0:1 / / rw - ext4 /dev/example rw\n2 1 0:2 / ' + str(self.base) + ' rw - cifs //example.invalid/share rw\n'
            return real_read(path, *args, **kwargs)
        with patch.object(Path, 'read_text', mountinfo):
            with self.assertRaisesRegex(RuntimeError, 'local filesystem'):
                with self.work():
                    self.fail('Must not restore SQLite over a network mount')

    def test_root_gc_lock_retains_the_scratch_directory_owner(self):
        self.base.mkdir()
        owner = self.base.stat()
        with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage.os, 'fchown') as chown:
            with storage.locked(self.base):
                self.assertEqual(chown.call_args.args[1:], (owner.st_uid, owner.st_gid))


if __name__ == '__main__':
    unittest.main(verbosity=2)
