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
        self.release=self.runtime/'RELEASE.json'
        self.resources=self.root/'resources';self.resources.mkdir()
        names=['seed.json','initial-users.json','accesorii.xlsx','standuri.xlsx','templates.json','template-hashes.json','mail-defaults.json']
        for name in names:(self.resources/name).write_text('{"synthetic":true}')
        hashes={name:backup.digest(self.resources/name) for name in names}
        (self.resources/'resource-mode.json').write_text(json.dumps({'mode':'private','schema':1,'sha256':hashes}))
        resource_digest=hashlib.sha256(json.dumps(hashes,separators=(',',':')).encode()).hexdigest()
        self.release.write_text(json.dumps({'sha':'a'*40,'resourceMode':'private','resourceDigest':resource_digest}))
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
        self.assertEqual(result['status'],'restored_not_started')
        manifest=json.loads((self.root/'restored/recovery/manifest.json').read_text())
        for name, expected in manifest['files'].items():
            self.assertEqual(backup.digest(self.root/'restored'/name),expected)
        self.assertEqual((self.root/'restored').stat().st_mode & 0o777,0o700)
    def test_customer_history_roundtrip(self):
        root=self.data/'client-history';(root/'client-sales-originals').mkdir(parents=True)
        original=root/'client-sales-originals/example.xlsx';original.write_bytes(b'synthetic historical source')
        with sqlite3.connect(root/'client-sales-history.sqlite') as db:
            db.execute('CREATE TABLE history_imports(sha256 TEXT,original_path TEXT)')
            db.execute('INSERT INTO history_imports VALUES(?,?)',(backup.digest(original),'client-sales-originals/example.xlsx'))
        result=recovery.restore(self.make_backup(),self.root/'history-restored')
        self.assertEqual(result['databases']['client-history/client-sales-history.sqlite'],'ok')
        self.assertEqual((self.root/'history-restored/client-history/client-sales-originals/example.xlsx').read_bytes(),original.read_bytes())
    def test_hardlinked_products_restore_as_regular_files(self):
        (self.products/'second.png').hardlink_to(self.products/'image.png')
        archive=self.make_backup()
        with tarfile.open(archive) as saved:
            self.assertTrue(saved.getmember('recovery/products/image.png').isfile())
            self.assertTrue(saved.getmember('recovery/products/second.png').isfile())
        recovery.restore(archive,self.root/'restored-hardlinks')
        self.assertEqual((self.root/'restored-hardlinks/recovery/products/second.png').read_bytes(),b'synthetic image')
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
    def test_resource_set_mismatches_compiled_runtime(self):
        release=json.loads(self.release.read_text());release['resourceDigest']='0'*64;self.release.write_text(json.dumps(release))
        with self.assertRaisesRegex(RuntimeError,'compiled release'):self.make_backup()
    def test_tar_path_traversal_rejected(self):
        path=self.root/'evil.tar.gz'
        with tarfile.open(path,'w:gz') as out:
            t=tarfile.TarInfo('../outside');t.size=1;out.addfile(t,io.BytesIO(b'x'))
        path.with_suffix('.gz.sha256').write_text(backup.digest(path))
        with self.assertRaisesRegex(RuntimeError,'Unsafe'):recovery.restore(path,self.root/'restored')
        self.assertFalse((self.root/'outside').exists())

    def rewrite_archive(self, change):
        archive=self.make_backup()
        with tarfile.open(archive) as saved:
            files={member.name:saved.extractfile(member).read() for member in saved if member.isfile()}
        change(files)
        with tarfile.open(archive,'w:gz') as output:
            for name,data in files.items():
                member=tarfile.TarInfo(name);member.size=len(data);output.addfile(member,io.BytesIO(data))
        archive.with_suffix('.gz.sha256').write_text(backup.digest(archive))
        return archive

    def assert_restore_rejected(self,archive,pattern):
        destination=self.root/'rejected'
        with self.assertRaisesRegex((RuntimeError,FileNotFoundError),pattern):recovery.restore(archive,destination)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob('.restore-*')),[])

    def test_inner_manifest_tampering_rejected_with_valid_outer_checksum(self):
        archive=self.rewrite_archive(lambda files:files.update({'recovery/runtime/server.js':b'changed runtime'}))
        self.assert_restore_rejected(archive,'checksum')

    def test_missing_required_resource_rejected_even_with_matching_manifest(self):
        def omit(files):
            name='recovery/resources/seed.json';del files[name]
            manifest=json.loads(files['recovery/manifest.json']);del manifest['files'][name]
            files['recovery/manifest.json']=json.dumps(manifest).encode()
        self.assert_restore_rejected(self.rewrite_archive(omit),'Required recovery resource')

    def test_unlisted_recovery_file_rejected(self):
        self.assert_restore_rejected(self.rewrite_archive(lambda files:files.update({'recovery/runtime/unlisted':b'extra'})),'Unverified')

    def test_missing_products_rejected_even_with_matching_manifest(self):
        def omit(files):
            name='recovery/products/image.png';del files[name]
            manifest=json.loads(files['recovery/manifest.json']);del manifest['files'][name]
            files['recovery/manifest.json']=json.dumps(manifest).encode()
        self.assert_restore_rejected(self.rewrite_archive(omit),'products are missing')

    def test_different_resource_set_rejected_even_with_matching_file_hashes(self):
        def change(files):
            files['recovery/resources/seed.json']=b'{"synthetic":"different"}'
            mode=json.loads(files['recovery/resources/resource-mode.json'])
            mode['sha256']['seed.json']=hashlib.sha256(files['recovery/resources/seed.json']).hexdigest()
            files['recovery/resources/resource-mode.json']=json.dumps(mode).encode()
            manifest=json.loads(files['recovery/manifest.json'])
            for name in ['recovery/resources/seed.json','recovery/resources/resource-mode.json']:
                manifest['files'][name]=hashlib.sha256(files[name]).hexdigest()
            files['recovery/manifest.json']=json.dumps(manifest).encode()
        self.assert_restore_rejected(self.rewrite_archive(change),'compiled release')

    def test_archive_links_rejected(self):
        for kind in (tarfile.SYMTYPE,tarfile.LNKTYPE):
            with self.subTest(kind=kind):
                archive=self.root/'link.tar.gz'
                with tarfile.open(archive,'w:gz') as output:
                    member=tarfile.TarInfo('escape');member.type=kind;member.linkname='../outside';output.addfile(member)
                archive.with_suffix('.gz.sha256').write_text(backup.digest(archive))
                self.assert_restore_rejected(archive,'Only regular')

    def test_missing_startup_helper_rejected_by_backup_and_restore(self):
        (self.runtime/'server.js').write_bytes((ROOT/'deploy/server.mjs').read_bytes())
        with self.assertRaisesRegex(RuntimeError,'bind-ready'):self.make_backup()
        (self.runtime/'bind-ready.mjs').write_bytes((ROOT/'deploy/bind-ready.mjs').read_bytes())
        def omit(files):
            name='recovery/runtime/bind-ready.mjs';del files[name]
            manifest=json.loads(files['recovery/manifest.json']);del manifest['files'][name]
            files['recovery/manifest.json']=json.dumps(manifest).encode()
        self.assert_restore_rejected(self.rewrite_archive(omit),'bind-ready')

    def test_corrupt_history_original_rejected_with_valid_outer_checksum(self):
        root=self.data/'client-history';(root/'client-sales-originals').mkdir(parents=True)
        original=root/'client-sales-originals/example.xlsx';original.write_bytes(b'synthetic original')
        with contextlib.closing(sqlite3.connect(root/'client-sales-history.sqlite')) as db:
            db.execute('CREATE TABLE history_imports(sha256 TEXT,original_path TEXT)')
            db.execute('INSERT INTO history_imports VALUES(?,?)',(backup.digest(original),'client-sales-originals/example.xlsx'));db.commit()
        archive=self.rewrite_archive(lambda files:files.update({'client-history/client-sales-originals/example.xlsx':b'corrupt'}))
        self.assert_restore_rejected(archive,'history original')

if __name__=='__main__':unittest.main(verbosity=2)
