"""Synthetic full recovery tests; never access production paths."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'deploy' / (name+'.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
backup, recovery = load('backup'), load('restore')

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); self.root = Path(t.name)
        self.data=self.root/'data';self.data.mkdir()
        with contextlib.closing(sqlite3.connect(self.data/'mobiup.sqlite')) as db:
            db.execute('CREATE TABLE orders(kind TEXT,status TEXT,payload TEXT)');db.commit()
        self.runtime=self.root/'runtime';self.runtime.mkdir()
        (self.runtime/'server.js').write_text('// synthetic runtime')
        self.release=self.runtime/'RELEASE.json';self.release.write_text(json.dumps({'sha':'a'*40,'resourceMode':'private'}))
        self.resources=self.root/'resources';self.resources.mkdir()
        (self.resources/'seed.json').write_text('{"synthetic":true}')
        (self.resources/'resource-mode.json').write_text(json.dumps({'mode':'private','sha256':{'seed.json':backup.digest(self.resources/'seed.json')}}))
        self.products=self.root/'products';self.products.mkdir();(self.products/'image.png').write_bytes(b'synthetic image')
        self.kwargs=dict(data=self.data,local=self.root/'local',nas=self.root/'nas',nas_mount=self.root/'nas',release=self.release,recovery={'runtime':self.runtime,'resources':self.resources,'products':self.products})
    def make_backup(self):
        with patch.object(backup.os.path,'ismount',return_value=True),contextlib.redirect_stdout(io.StringIO()):
            return backup.run_backup(**self.kwargs)
    def test_roundtrip_includes_runtime_and_private_inputs(self):
        archive=self.make_backup(); result=recovery.restore(archive,self.root/'restored')
        self.assertEqual(result['databases'],{'mobiup.sqlite':'ok'})
        self.assertEqual((self.root/'restored/recovery/products/image.png').read_bytes(),b'synthetic image')
        self.assertTrue((self.root/'restored/recovery/runtime/server.js').exists())
    def test_existing_target_never_overwritten(self):
        archive=self.make_backup(); target=self.root/'existing';target.mkdir();(target/'keep').write_text('keep')
        with self.assertRaisesRegex(RuntimeError,'must not exist'):recovery.restore(archive,target)
        self.assertEqual((target/'keep').read_text(),'keep')
    def test_checksum_mismatch_fails_before_restoring(self):
        archive=self.make_backup();archive.write_bytes(archive.read_bytes()+b'corrupt')
        with self.assertRaisesRegex(RuntimeError,'checksum'):recovery.restore(archive,self.root/'restored')
        self.assertFalse((self.root/'restored').exists())
    def test_resource_tampering_rejects_backup(self):
        (self.resources/'seed.json').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'integrity'):self.make_backup()
        self.assertFalse(list((self.root/'local').glob('*.tar.gz')))
    def test_symlink_in_recovery_rejected(self):
        (self.products/'escape').symlink_to(self.data/'mobiup.sqlite')
        with self.assertRaisesRegex(RuntimeError,'symlink'):self.make_backup()
    def test_missing_runtime_rejected(self):
        (self.runtime/'server.js').unlink()
        with self.assertRaisesRegex(RuntimeError,'missing'):self.make_backup()
    def test_release_change_during_backup_rejected(self):
        original=backup.add_recovery_files
        def change(output,parts,release,captured):
            release.write_text('{"sha":"changed"}')
            return original(output,parts,release,captured)
        with patch.object(backup,'add_recovery_files',side_effect=change):
            with self.assertRaisesRegex(RuntimeError,'release'):self.make_backup()
    def test_tar_path_traversal_rejected(self):
        path=self.root/'evil.tar.gz'
        with tarfile.open(path,'w:gz') as out:
            t=tarfile.TarInfo('../outside');t.size=1;out.addfile(t,io.BytesIO(b'x'))
        path.with_suffix('.gz.sha256').write_text(backup.digest(path))
        with self.assertRaisesRegex(RuntimeError,'Unsafe'):recovery.restore(path,self.root/'restored')
        self.assertFalse((self.root/'outside').exists())

if __name__=='__main__':unittest.main(verbosity=2)
