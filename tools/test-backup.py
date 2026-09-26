"""Backup regression tests. Only temporary synthetic data is read or written.

Run from any directory: python3 tools/test-backup.py
No NAS mount, running app, credentials, or third-party packages are required.
"""
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / 'deploy' / 'backup.py'
spec = importlib.util.spec_from_file_location('distribution_backup', SOURCE)
assert spec is not None and spec.loader is not None
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='comenzi-backup-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / 'data'
        self.local = self.root / 'local'
        self.mount = self.root / 'nas'
        self.nas = self.mount / 'backups'
        self.release = self.root / 'RELEASE.json'
        (self.data / 'files').mkdir(parents=True)
        (self.data / 'sales-imports').mkdir()
        self.release.write_text(json.dumps({'commit': 'synthetic-test-release'}))
        with contextlib.closing(sqlite3.connect(self.data / 'mobiup.sqlite')) as db:
            db.execute("CREATE TABLE orders (status TEXT NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'accessories')")
            db.executemany('INSERT INTO orders(status,payload) VALUES (?, ?)', [
                ('finalized', json.dumps({'exportKey': 'order.xlsx'})),
                ('draft', json.dumps({'exportKey': 'not-exported.xlsx'})),
            ])
            db.commit()
        with contextlib.closing(sqlite3.connect(self.data / 'sales.sqlite')) as db:
            db.execute('CREATE TABLE sales_rows (amount_cents INTEGER NOT NULL)')
            db.execute('INSERT INTO sales_rows VALUES (12345)')
            db.commit()
        # The backup treats source/export files as opaque bytes, not workbooks.
        (self.data / 'files' / 'order.xlsx').write_bytes(b'synthetic export')
        (self.data / 'sales-imports' / 'source.xlsx').write_bytes(b'synthetic source')
        (self.data / 'sales-imports' / 'ignored.tmp').write_bytes(b'unpublished')
        self.output = io.StringIO()

    def run_backup(self, mounted=True):
        with mock.patch.object(backup.os.path, 'ismount', return_value=mounted) as check:
            with contextlib.redirect_stdout(self.output):
                result = backup.run_backup(
                    data=self.data, local=self.local, nas=self.nas,
                    nas_mount=self.mount, release=self.release,
                )
            check.assert_called_once_with(self.mount)
            return result

    def assert_local_snapshot(self, sales=True):
        archives = sorted(self.local.glob('mobiup-comenzi-????????T??????Z.tar.gz'))
        self.assertTrue(archives, 'A verified local generation must survive NAS failure')
        archive = archives[-1]
        checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
        sidecar = archive.with_suffix(archive.suffix + '.sha256')
        self.assertEqual(sidecar.read_text(), f'{checksum}  {archive.name}\n')
        expected = {'mobiup.sqlite', 'files/order.xlsx', 'RELEASE.json'}
        if sales:
            expected.update({'sales.sqlite', 'sales-imports/source.xlsx'})
        with tarfile.open(archive, 'r:gz') as saved:
            self.assertEqual(set(saved.getnames()), expected)
            self.assertEqual(saved.extractfile('files/order.xlsx').read(), b'synthetic export')
            self.assertEqual(saved.extractfile('RELEASE.json').read(), self.release.read_bytes())
            restored = self.root / 'restored-mobiup.sqlite'
            restored.write_bytes(saved.extractfile('mobiup.sqlite').read())
            with contextlib.closing(sqlite3.connect(restored)) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(db.execute('SELECT COUNT(*) FROM orders').fetchone()[0], 2)
                payload = db.execute("SELECT payload FROM orders WHERE status='finalized'").fetchone()[0]
                self.assertEqual(json.loads(payload)['exportKey'], 'order.xlsx')
            if sales:
                self.assertEqual(saved.extractfile('sales-imports/source.xlsx').read(), b'synthetic source')
                restored_sales = self.root / 'restored-sales.sqlite'
                restored_sales.write_bytes(saved.extractfile('sales.sqlite').read())
                with contextlib.closing(sqlite3.connect(restored_sales)) as db:
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                    self.assertEqual(db.execute('SELECT amount_cents FROM sales_rows').fetchone()[0], 12345)
        return archive

    def old_generation(self, folder, days):
        folder.mkdir(parents=True, exist_ok=True)
        stamp = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y%m%dT%H%M%SZ')
        archive = folder / f'mobiup-comenzi-{stamp}.tar.gz'
        archive.write_bytes(b'older synthetic backup')
        checksum = archive.with_suffix(archive.suffix + '.sha256')
        checksum.write_text('older synthetic checksum')
        return archive, checksum

    def test_email_only_stand_notice_preserves_payload_without_export(self):
        payload = {'kind': 'stand_client', 'notes': 'Synthetic email-only notice'}
        with contextlib.closing(sqlite3.connect(self.data / 'mobiup.sqlite')) as db:
            db.execute("UPDATE orders SET kind='stand_client',payload=? WHERE status='finalized'", (json.dumps(payload),))
            db.commit()
        archive = self.run_backup()
        with tarfile.open(archive, 'r:gz') as saved:
            self.assertFalse(any(name.startswith('files/') for name in saved.getnames()))
            restored = self.root / 'email-only.sqlite'
            restored.write_bytes(saved.extractfile('mobiup.sqlite').read())
            with contextlib.closing(sqlite3.connect(restored)) as db:
                value = json.loads(db.execute("SELECT payload FROM orders WHERE status='finalized'").fetchone()[0])
                self.assertEqual(value, payload)
        self.assertEqual(archive.read_bytes(), (self.nas / archive.name).read_bytes())

    def test_stand_notice_legacy_export_is_still_included(self):
        with contextlib.closing(sqlite3.connect(self.data / 'mobiup.sqlite')) as db:
            db.execute("UPDATE orders SET kind='stand_client',payload=? WHERE status='finalized'", (json.dumps({'kind': 'stand_client', 'exportKey': 'order.xlsx'}),))
            db.commit()
        self.run_backup()
        self.assert_local_snapshot()

    def test_json_kind_cannot_skip_an_export_required_by_relational_kind(self):
        with contextlib.closing(sqlite3.connect(self.data / 'mobiup.sqlite')) as db:
            db.execute("UPDATE orders SET kind='accessories',payload=? WHERE status='finalized'", (json.dumps({'kind': 'stand_client'}),))
            db.commit()
        with self.assertRaisesRegex(RuntimeError, 'required export key'):
            self.run_backup()
        self.assertEqual(list(self.local.glob('*.tar.gz')), [])

    def test_relational_email_only_kind_does_not_require_duplicated_json_kind(self):
        with contextlib.closing(sqlite3.connect(self.data / 'mobiup.sqlite')) as db:
            db.execute("UPDATE orders SET kind='stand_client',payload=? WHERE status='finalized'", (json.dumps({'kind': 'accessories', 'notes': 'Legacy duplicate field'}),))
            db.commit()
        archive = self.run_backup()
        with tarfile.open(archive, 'r:gz') as saved:
            self.assertIn('mobiup.sqlite', saved.getnames())
            self.assertFalse(any(name.startswith('files/') for name in saved.getnames()))
        self.assertEqual(archive.read_bytes(), (self.nas / archive.name).read_bytes())

    def test_missing_required_export_key_is_not_silently_skipped(self):
        for payload in [{'kind': 'accessories'}, {'kind': 'sim', 'exportKey': None}, {'kind': 'stands', 'exportKey': ''}, {'kind': 'stand_client', 'exportKey': 123}]:
            with self.subTest(payload=payload):
                with contextlib.closing(sqlite3.connect(self.data / 'mobiup.sqlite')) as db:
                    db.execute("UPDATE orders SET payload=? WHERE status='finalized'", (json.dumps(payload),))
                    db.commit()
                with self.assertRaisesRegex(RuntimeError, 'required export key'):
                    self.run_backup()
                self.assertEqual(list(self.local.glob('*.tar.gz')), [])

    def test_success_publishes_identical_local_and_nas_snapshots(self):
        original = {
            path.relative_to(self.data): path.read_bytes()
            for path in self.data.rglob('*') if path.is_file()
        }
        result = self.run_backup()
        archive = self.assert_local_snapshot()
        self.assertEqual(result, archive)
        self.assertEqual((self.nas / archive.name).read_bytes(), archive.read_bytes())
        sidecar = archive.with_suffix(archive.suffix + '.sha256')
        self.assertEqual((self.nas / sidecar.name).read_bytes(), sidecar.read_bytes())
        self.assertFalse(list(self.nas.glob('*.partial')))
        self.assertIn('Verified local and NAS backup:', self.output.getvalue())
        self.assertEqual(original, {
            path.relative_to(self.data): path.read_bytes()
            for path in self.data.rglob('*') if path.is_file()
        })

    def test_unmounted_nas_preserves_local_without_creating_nas_directory(self):
        with self.assertRaisesRegex(RuntimeError, 'Local backup verified:.*NAS is not mounted'):
            self.run_backup(mounted=False)
        self.assert_local_snapshot()
        self.assertFalse(self.mount.exists())
        self.assertIn('Verified local backup:', self.output.getvalue())
        self.assertNotIn('Verified local and NAS backup:', self.output.getvalue())

    def test_offsite_failure_exits_nonzero_and_preserves_local_in_subprocess(self):
        # Explicit temporary paths: never invoke production defaults in a test.
        arguments = ', '.join(f'{key}=Path({str(value)!r})' for key, value in {
            'data': self.data, 'local': self.local, 'nas': self.nas,
            'nas_mount': self.mount, 'release': self.release,
        }.items())
        code = (
            "from pathlib import Path\nimport os, runpy\n"
            f"module = runpy.run_path({str(SOURCE)!r})\n"
            "os.path.ismount = lambda path: False\n"
            f"module['run_backup']({arguments})\n"
        )
        result = subprocess.run([sys.executable, '-c', code], capture_output=True,
                                text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Verified local backup:', result.stdout)
        self.assertIn('NAS backup failed: NAS is not mounted', result.stderr)
        self.assertNotIn('Verified local and NAS backup:', result.stdout)
        self.assert_local_snapshot()
        self.assertFalse(self.mount.exists())

    def test_unmounted_nas_still_prunes_only_old_local_generations(self):
        old_local = self.old_generation(self.local, 20)
        recent_local = self.old_generation(self.local, 1)
        old_nas = self.old_generation(self.nas, 20)
        unrelated = self.local / 'other-application.tar.gz'
        unrelated.write_bytes(b'keep me')
        with self.assertRaisesRegex(RuntimeError, 'NAS is not mounted'):
            self.run_backup(mounted=False)
        self.assert_local_snapshot()
        self.assertTrue(all(not path.exists() for path in old_local))
        self.assertTrue(all(path.exists() for path in recent_local + old_nas))
        self.assertEqual(unrelated.read_bytes(), b'keep me')

    def test_success_retains_recent_and_prunes_old_on_both_destinations(self):
        old = self.old_generation(self.local, 20) + self.old_generation(self.nas, 20)
        recent = self.old_generation(self.local, 1) + self.old_generation(self.nas, 1)
        self.run_backup()
        self.assertTrue(all(not path.exists() for path in old))
        self.assertTrue(all(path.exists() for path in recent))
        self.assert_local_snapshot()

    def test_copy_failure_keeps_local_retention_and_does_not_prune_nas(self):
        old_local = self.old_generation(self.local, 20)
        old_nas = self.old_generation(self.nas, 20)
        with mock.patch.object(backup.shutil, 'copyfile', side_effect=OSError('NAS write failed')):
            with self.assertRaisesRegex(RuntimeError, 'Local backup verified:.*NAS write failed'):
                self.run_backup()
        archive = self.assert_local_snapshot()
        self.assertTrue(all(not path.exists() for path in old_local))
        self.assertTrue(all(path.exists() for path in old_nas))
        self.assertFalse((self.nas / archive.name).exists())
        self.assertNotIn('Verified local and NAS backup:', self.output.getvalue())

    def test_checksum_mismatch_never_publishes_corrupt_nas_archive(self):
        def corrupt_copy(source, destination):
            Path(destination).write_bytes(b'corrupted in transit')
        with mock.patch.object(backup.shutil, 'copyfile', side_effect=corrupt_copy):
            with self.assertRaisesRegex(RuntimeError, 'NAS backup checksum mismatch'):
                self.run_backup()
        archive = self.assert_local_snapshot()
        self.assertFalse((self.nas / archive.name).exists())
        self.assertFalse((self.nas / (archive.name + '.sha256')).exists())

    def test_sidecar_copy_failure_remains_failure_and_preserves_local(self):
        original_copy = backup.shutil.copyfile
        def fail_sidecar(source, destination):
            if Path(source).name.endswith('.sha256'):
                raise OSError('NAS checksum file write failed')
            return original_copy(source, destination)
        with mock.patch.object(backup.shutil, 'copyfile', side_effect=fail_sidecar):
            with self.assertRaisesRegex(RuntimeError, 'NAS checksum file write failed'):
                self.run_backup()
        archive = self.assert_local_snapshot()
        self.assertEqual((self.nas / archive.name).read_bytes(), archive.read_bytes())
        self.assertNotIn('Verified local and NAS backup:', self.output.getvalue())

    def test_absent_optional_sales_database_is_supported(self):
        (self.data / 'sales.sqlite').unlink()
        self.run_backup()
        self.assert_local_snapshot(sales=False)

    def test_missing_application_database_fails_before_nas_access(self):
        (self.data / 'mobiup.sqlite').unlink()
        with mock.patch.object(backup.os.path, 'ismount') as check:
            with self.assertRaises(sqlite3.OperationalError):
                backup.run_backup(data=self.data, local=self.local, nas=self.nas,
                                  nas_mount=self.mount, release=self.release)
            check.assert_not_called()
        self.assertFalse(list(self.local.glob('*.tar.gz')))
        self.assertFalse(self.nas.exists())

    def test_missing_export_does_not_publish_incomplete_generation(self):
        (self.data / 'files' / 'order.xlsx').unlink()
        with self.assertRaises(FileNotFoundError):
            self.run_backup()
        self.assertFalse(list(self.local.glob('*.tar.gz')))
        self.assertFalse(self.nas.exists())
        self.assertNotIn('Verified local backup:', self.output.getvalue())

    def test_missing_release_does_not_publish_incomplete_generation(self):
        self.release.unlink()
        with self.assertRaises(FileNotFoundError):
            self.run_backup()
        self.assertFalse(list(self.local.glob('*.tar.gz')))
        self.assertFalse(self.nas.exists())

    def test_export_outside_files_directory_is_rejected(self):
        outside = self.data / 'outside.xlsx'
        outside.write_bytes(b'not an export')
        with contextlib.closing(sqlite3.connect(self.data / 'mobiup.sqlite')) as db:
            db.execute("UPDATE orders SET payload=? WHERE status='finalized'",
                       (json.dumps({'exportKey': '../outside.xlsx'}),))
            db.commit()
        with self.assertRaisesRegex(RuntimeError, 'Invalid export location'):
            self.run_backup()
        self.assertFalse(list(self.local.glob('*.tar.gz')))
        self.assertFalse(self.nas.exists())

    def test_symlinked_sales_source_is_rejected(self):
        source = self.data / 'sales-imports' / 'source.xlsx'
        source.unlink()
        source.symlink_to(self.data / 'files' / 'order.xlsx')
        with self.assertRaisesRegex(RuntimeError, 'Invalid sales source location'):
            self.run_backup()
        self.assertFalse(list(self.local.glob('*.tar.gz')))
        self.assertFalse(self.nas.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
