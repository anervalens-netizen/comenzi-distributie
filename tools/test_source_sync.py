"""Synthetic Git repositories prove that reconciliation never discards work."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/sync_source.py'
spec = importlib.util.spec_from_file_location('source_sync_test', SOURCE)
sync = importlib.util.module_from_spec(spec); spec.loader.exec_module(sync)


class SourceSyncTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.origin = self.root / 'remote.git'
        self.author = self.root / 'author'; self.checkout = self.root / 'checkout'
        self.run_git('init', '--bare', str(self.origin))
        self.run_git('clone', str(self.origin), str(self.author))
        self.run_git('-C', str(self.author), 'checkout', '-b', 'main')
        self.run_git('-C', str(self.author), 'config', 'user.email', 'synthetic@example.invalid')
        self.run_git('-C', str(self.author), 'config', 'user.name', 'Synthetic')
        self.first = self.commit('first')
        self.run_git('-C', str(self.author), 'push', 'origin', 'main')
        self.run_git('clone', '--branch', 'main', str(self.origin), str(self.checkout))
        self.second = self.commit('second')
        self.run_git('-C', str(self.author), 'push', 'origin', 'main')

    def run_git(self, *args):
        return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, value):
        (self.author / 'file').write_text(value)
        self.run_git('-C', str(self.author), 'add', 'file')
        self.run_git('-C', str(self.author), 'commit', '-m', value)
        return self.run_git('-C', str(self.author), 'rev-parse', 'HEAD')

    def test_clean_checkout_fast_forwards_to_authorized_release(self):
        result = sync.synchronize(self.checkout, self.second, 'main')
        self.assertEqual(result['status'], 'fast-forwarded')
        self.assertEqual(self.run_git('-C', str(self.checkout), 'rev-parse', 'HEAD'), self.second)

    def test_dirty_checkout_and_file_are_preserved(self):
        (self.checkout / 'file').write_text('concurrent work')
        with self.assertRaisesRegex(RuntimeError, 'Dirty'):
            sync.synchronize(self.checkout, self.second, 'main')
        self.assertEqual((self.checkout / 'file').read_text(), 'concurrent work')
        self.assertEqual(self.run_git('-C', str(self.checkout), 'rev-parse', 'HEAD'), self.first)

    def test_unpublished_release_cannot_be_selected(self):
        third = self.commit('unpublished')
        with self.assertRaisesRegex(RuntimeError, 'authorized'):
            sync.synchronize(self.checkout, third, 'main')
        self.assertEqual(self.run_git('-C', str(self.checkout), 'rev-parse', 'HEAD'), self.first)

    def test_rollback_does_not_reset_newer_source(self):
        sync.synchronize(self.checkout, self.second, 'main')
        result = sync.synchronize(self.checkout, self.first, 'main')
        self.assertEqual(result['status'], 'source-ahead')
        self.assertEqual(self.run_git('-C', str(self.checkout), 'rev-parse', 'HEAD'), self.second)


if __name__ == '__main__':
    unittest.main(verbosity=2)
