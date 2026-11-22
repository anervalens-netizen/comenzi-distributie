"""Synthetic full recovery tests; never access production paths."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
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
backup, recovery, receiver = load('backup'), load('restore'), load('receive_backup')

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); self.root = Path(t.name)
        environment = patch.dict(backup.os.environ, {
            'MOBIUP_SCRATCH_ROOT': str(self.root / 'scratch'),
            'MOBIUP_SCRATCH_MIN_FREE_BYTES': '0', 'MOBIUP_SCRATCH_MAX_USED_RATIO': '1'})
        environment.start(); self.addCleanup(environment.stop)
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
        self.kwargs['nas_mount'].mkdir(exist_ok=True)
        with patch.object(backup.os.path,'ismount',return_value=True),contextlib.redirect_stdout(io.StringIO()):
            return backup.run_backup(**self.kwargs)
    def test_latest_only_backup_validates_through_pinned_nas_directory(self):
        self.kwargs['nas_latest_only'] = True
        archive = self.make_backup()
        receipt = backup.validation_receipt(archive, backup.digest(archive))
        self.assertEqual(receipt['release'], 'a' * 40)
        nas = self.kwargs['nas']
        self.assertTrue(backup.validation_path(nas / archive.name).is_file())
        self.assertEqual(list(nas.glob('*.partial')), [])

    def test_latest_nas_retention_preserves_current_and_unrelated_files(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        old = nas / 'mobiup-comenzi-20000101T000000Z.tar.gz'
        old.write_bytes(b'old generation')
        old.with_suffix(old.suffix + '.sha256').write_text('old')
        unrelated = nas / 'manual-recovery.tar.gz'
        unrelated.write_bytes(b'keep')
        backup.prune_nas_latest(nas, nas / archive.name)
        self.assertFalse(old.exists())
        self.assertFalse(old.with_suffix(old.suffix + '.sha256').exists())
        self.assertTrue((nas / archive.name).exists())
        self.assertTrue(unrelated.exists())

    def test_latest_nas_retention_preserves_old_when_restore_rejects(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        old = nas / 'mobiup-comenzi-20000101T000000Z.tar.gz'
        old.write_bytes(b'keep')
        # Corrupt the inner manifest but retain a valid outer checksum.
        broken = nas / archive.name
        with tarfile.open(broken, 'r:gz') as source:
            members = [(entry, source.extractfile(entry).read() if entry.isfile() else None) for entry in source]
        with tarfile.open(broken, 'w:gz') as target:
            for entry, content in members:
                if entry.name == 'recovery/manifest.json':
                    content = b'{"schema":1,"files":{}}'
                    entry.size = len(content)
                target.addfile(entry, io.BytesIO(content) if content is not None else None)
        broken.with_suffix(broken.suffix + '.sha256').write_text(backup.digest(broken) + '  ' + broken.name)
        with self.assertRaisesRegex(RuntimeError, 'manifest'):
            backup.prune_nas_latest(nas, broken)
        self.assertTrue(old.exists())

    def test_latest_nas_retention_fails_before_deleting_on_bad_checksum(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        old = nas / 'mobiup-comenzi-20000101T000000Z.tar.gz'
        old.write_bytes(b'keep')
        (nas / archive.name).with_suffix('.gz.sha256').write_text('bad')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            backup.prune_nas_latest(nas, nas / archive.name)
        self.assertTrue(old.exists())

    def test_nas_restore_cannot_promote_a_different_digest_to_local_validation(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        current = nas / archive.name
        checksum = backup.digest(archive)
        with patch.object(backup, 'prune_backups') as prune:
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                backup.prune_nas_latest(nas, current, expected_checksum='0' * 64)
            with patch.object(backup, 'validate_archive', return_value={'sha256': '0' * 64}):
                with self.assertRaisesRegex(RuntimeError, 'receipt does not match'):
                    backup.prune_nas_latest(nas, current, expected_checksum=checksum)
            prune.assert_not_called()
        self.assertFalse(backup.validation_path(archive).exists())

    def test_restore_rejects_when_extraction_does_not_confirm_the_prechecked_digest(self):
        archive = self.make_backup()
        destination = self.root / 'restored'
        real_reader = recovery.DigestReader
        def inconsistent_verification(stream):
            reader = real_reader(stream)
            reader.hash.update(b'independent mismatch')
            return reader
        with patch.object(recovery, 'DigestReader', side_effect=inconsistent_verification):
            with self.assertRaisesRegex(RuntimeError, 'changed during restore'):
                recovery.restore(archive, destination)
        self.assertFalse(destination.exists())

    def test_actual_restore_receipt_promotes_receiver_and_ignores_newer_unvalidated(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        destination = self.root / 'receiver'
        backup.validate_archive(nas / archive.name)
        result = receiver.receive(nas, destination)
        self.assertEqual(result['sha256'], backup.digest(archive))
        receipt = backup.validation_receipt(destination / archive.name, result['sha256'])
        self.assertEqual(receipt['validated_by'], 'receiver')
        self.assertEqual(receipt['release'], 'a' * 40)
        broken = nas / 'mobiup-comenzi-20990101T000000Z.tar.gz'
        broken.write_bytes(b'newer but not restorable')
        broken.with_suffix('.gz.sha256').write_text(backup.digest(broken) + '  ' + broken.name)
        result2 = receiver.receive(nas, destination)
        self.assertEqual(result2['archive'], archive.name)
        self.assertFalse((destination / broken.name).exists())

    def test_receiver_requires_local_restore_before_promotion_or_pruning(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        backup.validate_archive(nas / archive.name)
        destination = self.root / 'receiver'
        destination.mkdir()
        fallback = destination / 'mobiup-comenzi-20000101T000000Z.tar.gz'
        fallback.write_bytes(b'previous snapshot')
        with patch.object(receiver.backup, 'validate_archive', side_effect=RuntimeError('local restore failed')):
            with self.assertRaisesRegex(RuntimeError, 'local restore failed'):
                receiver.receive(nas, destination)
        self.assertEqual(fallback.read_bytes(), b'previous snapshot')
        self.assertFalse((destination / archive.name).exists())
        self.assertEqual(list(destination.glob('.receive-*')), [])

    def test_receiver_revalidates_legacy_receipts_and_reuses_its_own(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        backup.validate_archive(nas / archive.name)
        destination = self.root / 'receiver'
        shutil.copytree(nas, destination)
        with patch.object(receiver.backup, 'validate_archive', wraps=receiver.backup.validate_archive) as validate:
            receiver.receive(nas, destination)
            receiver.receive(nas, destination)
            self.assertEqual(validate.call_count, 1)

    def test_portfolio_verifies_plain_and_encrypted_receiver_bytes(self):
        verify = load('verify_received_generation')
        archive = self.make_backup()
        folder = self.root / 'portfolio'
        folder.mkdir()
        stored = folder / archive.name
        shutil.copyfile(archive, stored)
        scratch = self.root / 'disk-scratch'
        receipt = self.root / 'trusted' / 'local.json'
        original_scratch = verify.storage.Scratch

        def small_scratch(*args, **kwargs):
            kwargs.update(min_free_bytes=0, max_used_ratio=1)
            return original_scratch(*args, **kwargs)

        with patch.object(verify.storage, 'Scratch', side_effect=small_scratch):
            result = verify.verify(folder, receipt, scratch)
            self.assertEqual(result['sha256'], backup.digest(archive))
            self.assertEqual(result['databases'], {'mobiup.sqlite': 'ok'})
            self.assertTrue(verify.verify(folder, receipt, scratch)['reused'])
            previous = json.loads(receipt.read_text())
            previous['schema'] = 1
            receipt.write_text(json.dumps(previous))
            self.assertFalse(verify.verify(folder, receipt, scratch)['reused'])
            trusted = receipt.read_bytes()
            with patch.object(verify.restore, 'restore', side_effect=RuntimeError('local restore failed')):
                with stored.open('ab') as stream:
                    stream.write(b'\x00')
                with self.assertRaisesRegex(RuntimeError, 'local restore failed'):
                    verify.verify(folder, receipt, scratch)
            self.assertEqual(receipt.read_bytes(), trusted)
            shutil.copyfile(archive, stored)
            if shutil.which('age') and shutil.which('age-keygen'):
                key = self.root / 'identity'
                subprocess.run(['age-keygen', '-o', str(key)], check=True, capture_output=True)
                public = subprocess.check_output(['age-keygen', '-y', str(key)], text=True).strip()
                subprocess.run(['age', '-r', public, '-o', str(stored) + '.age', str(stored)], check=True)
                stored.unlink()
                encrypted = verify.verify(folder, receipt, scratch, identity=key,
                                          decrypt_scratch=self.root / 'memory-scratch')
                self.assertEqual(encrypted['sha256'], result['sha256'])
                self.assertNotEqual(encrypted['stored_sha256'], result['stored_sha256'])
                self.assertFalse(encrypted['reused'])
                rotated_key = self.root / 'rotated-identity'
                subprocess.run(['age-keygen', '-o', str(rotated_key)], check=True, capture_output=True)
                with self.assertRaisesRegex(RuntimeError, 'could not decrypt'):
                    verify.verify(folder, receipt, scratch, identity=rotated_key,
                                  decrypt_scratch=self.root / 'memory-scratch')
                self.assertEqual(json.loads(receipt.read_text())['identity_sha256'], encrypted['identity_sha256'])

    def test_portfolio_inputs_bind_verified_bytes_to_the_receiver_digest(self):
        verifier = load('verify_received_generation')
        archive = self.make_backup()
        expected = backup.digest(archive)
        with verifier.pinned_archive(archive) as pinned:
            self.assertEqual(verifier.restore.digest(pinned), expected)
            with verifier.plaintext(archive, pinned, expected, None, None) as (local, bound):
                self.assertEqual(local, pinned)
                self.assertEqual(bound, expected)
                checksum = self.root / 'expected.sha256'
                checksum.write_text(bound)
                result = verifier.restore.restore(local, self.root / 'pinned-restore', checksum,
                                                  expected_checksum=bound)
                self.assertEqual(result['databases'], {'mobiup.sqlite': 'ok'})
        if shutil.which('age') and shutil.which('age-keygen'):
            key = self.root / 'cipher-key'
            subprocess.run(['age-keygen', '-o', str(key)], check=True, capture_output=True)
            public = subprocess.check_output(['age-keygen', '-y', str(key)], text=True).strip()
            encrypted = Path(str(archive) + '.age')
            subprocess.run(['age', '-r', public, '-o', str(encrypted), str(archive)], check=True)
            with verifier.pinned_archive(encrypted) as pinned, self.assertRaisesRegex(RuntimeError, 'ciphertext'):
                with verifier.plaintext(encrypted, pinned, '0' * 64, key, self.root / 'decrypt-fixture'):
                    self.fail('An incorrect stored digest must prevent use of the plaintext')

    def test_receiver_without_validated_source_preserves_existing_copy(self):
        archive = self.make_backup()
        destination = self.root / 'receiver'; destination.mkdir()
        old = destination / 'mobiup-comenzi-20000101T000000Z.tar.gz'; old.write_bytes(b'keep')
        with self.assertRaisesRegex(RuntimeError, 'No restore-validated'):
            receiver.receive(self.root / 'nas', destination)
        self.assertEqual(old.read_bytes(), b'keep')

    def test_failed_managed_restore_keeps_fallback_and_cleans_scratch(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        old = nas / 'mobiup-comenzi-20000101T000000Z.tar.gz'; old.write_bytes(b'keep')
        with patch.object(backup.storage.Scratch, 'consume', side_effect=RuntimeError('synthetic write failure')):
            with self.assertRaisesRegex(RuntimeError, 'synthetic write failure'):
                backup.prune_nas_latest(nas, nas / archive.name)
        self.assertEqual(old.read_bytes(), b'keep')
        self.assertFalse(any(p.is_dir() for p in (self.root / 'scratch').iterdir()))
        self.assertFalse(backup.validation_path(nas / archive.name).exists())

    def test_usage_database_roundtrip(self):
        with contextlib.closing(sqlite3.connect(self.data / 'usage.sqlite')) as db:
            db.execute('CREATE TABLE usage_days (user_id TEXT)')
            db.execute("INSERT INTO usage_days VALUES ('synthetic-user')")
            db.commit()
        archive=self.make_backup(); result=recovery.restore(archive,self.root/'usage-restored')
        self.assertEqual(result['databases']['usage.sqlite'], 'ok')
        with contextlib.closing(sqlite3.connect(self.root/'usage-restored/usage.sqlite')) as db:
            self.assertEqual(db.execute('SELECT user_id FROM usage_days').fetchall(), [('synthetic-user',)])

    def test_restore_byte_budget_rejects_then_allows_same_archive(self):
        archive = self.make_backup()
        with tarfile.open(archive) as saved:
            total = sum(member.size for member in saved)
        destination = self.root / 'budget-restored'
        with patch.dict(recovery.os.environ, {'MOBIUP_RESTORE_MAX_BYTES': str(total - 1)}):
            with self.assertRaisesRegex(RuntimeError, 'bounded restore budget'):
                recovery.restore(archive, destination)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob('.restore-*')), [])
        with patch.dict(recovery.os.environ, {'MOBIUP_RESTORE_MAX_BYTES': str(total)}):
            self.assertEqual(recovery.restore(archive, destination)['status'], 'restored_not_started')

    def test_invalid_restore_budget_preserves_existing_nas_fallback(self):
        archive = self.make_backup()
        nas = self.root / 'nas'
        old = nas / 'mobiup-comenzi-20000101T000000Z.tar.gz'
        old.write_bytes(b'keep')
        for value in ('', '0', '-1', 'unbounded', '1.5'):
            with self.subTest(value=value), patch.dict(recovery.os.environ, {'MOBIUP_RESTORE_MAX_BYTES': value}):
                with self.assertRaisesRegex(ValueError, 'positive integer'):
                    backup.prune_nas_latest(nas, nas / archive.name)
                self.assertTrue(old.exists())

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

    def automation_fixture(self):
        (self.runtime / 'activation_versions.py').write_text("FACTS_VERSION = '2'\n")
        automation = self.root / 'automation'; automation.mkdir()
        selected = automation / 'tooling/reviewed'; selected.mkdir(parents=True)
        (selected / 'activations.py').write_text("CHRONOLOGY_POLICY_VERSION = 'positive-documents-nonblocking-v1'\n")
        (selected / 'activation_versions.py').write_text("FACTS_VERSION = '2'\n")
        (automation / 'run_import.py').write_bytes(b"TOOLING_CONTRACT = 'sim-chronology-v1'\n# synthetic runner\n")
        (automation / 'receipts').mkdir()
        (automation / 'receipts/example.json').write_bytes(b'{"status":"synthetic"}\n')
        (automation / 'encrypted-originals').mkdir()
        (automation / 'encrypted-originals/example.bin').write_bytes(b'synthetic encrypted original')
        # Large or irrelevant trees are never enumerated into the archive.
        (automation / 'release').mkdir(); (automation / 'release/excluded.tar.gz').write_bytes(b'exclude release')
        config = {'schema': 1, 'contract': 'sim-chronology-v1'}
        for provider in ('vodafone', 'digi'):
            config[provider] = {'path': 'tooling/reviewed', 'compatibleRuntime': 'a' * 40,
                                'files': {name: backup.digest(selected / name) for name in ('activations.py', 'activation_versions.py')}}
        (automation / 'provider-tooling.json').write_text(json.dumps(config))
        files = ['run_import.py', 'provider-tooling.json', 'tooling/reviewed/activations.py', 'tooling/reviewed/activation_versions.py']
        (automation / 'recovery-files.json').write_text(json.dumps({'schema': 1, 'contract': 'sim-chronology-v1', 'files': files,
                                                                   'runnerSha256': backup.digest(automation / 'run_import.py'),
                                                                   'optionalDirectories': ['receipts', 'encrypted-originals']}))
        self.kwargs['recovery']['automation'] = automation
        return automation

    def test_automation_roundtrip_preserves_bytes_and_selects_relocated_tooling(self):
        automation = self.automation_fixture()
        archive = self.make_backup()
        restored = self.root / 'automation-restored'
        result = recovery.restore(archive, restored)
        recovered = restored / 'recovery/automation'
        selected, selections = backup.sim_tooling.recovery_files(recovered, restored / 'recovery/runtime')
        for name in selected:
            self.assertEqual((recovered / name).read_bytes(), (automation / name).read_bytes())
        self.assertEqual(result['automationTooling'], selections)
        for provider in ('vodafone', 'digi'):
            actual = backup.sim_tooling.provider_tooling(recovered, provider, restored / 'recovery/runtime')
            self.assertEqual(Path(actual['path']), recovered / 'tooling/reviewed')
        self.assertFalse((recovered / 'release').exists())
        (recovered / 'provider-tooling.json').unlink()
        with self.assertRaises(FileNotFoundError):
            backup.sim_tooling.provider_tooling(recovered, 'digi', restored / 'recovery/runtime')

    def test_automation_missing_config_is_not_replaced_by_legacy_config(self):
        automation = self.automation_fixture()
        (automation / 'provider-tooling.json').rename(automation / 'digi-tooling.json')
        with self.assertRaises(FileNotFoundError): self.make_backup()

    def test_automation_restore_rejects_missing_config_even_with_matching_manifest(self):
        self.automation_fixture()
        def omit(files):
            name = 'recovery/automation/provider-tooling.json'; del files[name]
            manifest = json.loads(files['recovery/manifest.json']); del manifest['files'][name]
            files['recovery/manifest.json'] = json.dumps(manifest).encode()
        self.assert_restore_rejected(self.rewrite_archive(omit), 'provider-tooling.json')

    def test_automation_backup_rejects_unselected_tooling_and_budget_overflow(self):
        automation = self.automation_fixture()
        policy = automation / 'recovery-files.json'; content = json.loads(policy.read_text())
        content['files'].remove('tooling/reviewed/activations.py'); policy.write_text(json.dumps(content))
        with self.assertRaisesRegex(ValueError, 'not selected'): self.make_backup()
        content['files'].append('tooling/reviewed/activations.py'); policy.write_text(json.dumps(content))
        with (automation / 'receipts/oversized.json').open('wb') as output: output.truncate(16 * 1024**2)
        with self.assertRaisesRegex(ValueError, '16 MiB'): self.make_backup()

    def test_automation_restore_rejects_changed_selection_metadata(self):
        self.automation_fixture()
        def change(files):
            manifest = json.loads(files['recovery/manifest.json'])
            manifest['automation']['providers']['digi']['path'] = 'tooling/older'
            files['recovery/manifest.json'] = json.dumps(manifest).encode()
        self.assert_restore_rejected(self.rewrite_archive(change), 'selection mismatch')

    def test_automation_runner_identity_is_explicitly_pinned(self):
        automation = self.automation_fixture()
        (automation / 'run_import.py').write_bytes(b'# stale synthetic runner\n')
        with self.assertRaisesRegex(ValueError, 'runner contract or checksum'): self.make_backup()

    def test_automation_directory_entry_limit_includes_empty_directories(self):
        automation = self.automation_fixture()
        receipts = automation / 'receipts'
        for index in range(1001): (receipts / str(index)).mkdir()
        with self.assertRaisesRegex(ValueError, '1000 entries'): self.make_backup()
    def test_customer_history_roundtrip(self):
        root=self.data/'client-history';(root/'client-sales-originals').mkdir(parents=True)
        original=root/'client-sales-originals/example.xlsx';original.write_bytes(b'synthetic historical source')
        with contextlib.closing(sqlite3.connect(root/'client-sales-history.sqlite')) as db, db:
            db.execute('CREATE TABLE history_imports(sha256 TEXT,original_path TEXT)')
            db.execute('INSERT INTO history_imports VALUES(?,?)',(backup.digest(original),'client-sales-originals/example.xlsx'))
        result=recovery.restore(self.make_backup(),self.root/'history-restored')
        self.assertEqual(result['databases']['client-history/client-sales-history.sqlite'],'ok')
        self.assertEqual((self.root/'history-restored/client-history/client-sales-originals/example.xlsx').read_bytes(),original.read_bytes())
    def test_regenerable_history_restore_requires_reimport(self):
        with patch.dict(backup.os.environ, {'MOBIUP_BACKUP_CUSTOMER_HISTORY': '0'}):
            archive = self.make_backup()
        result = recovery.restore(archive, self.root / 'without-history')
        self.assertEqual(result['reimportRequired'], ['customer_history'])
        self.assertEqual(result['databases'], {'mobiup.sqlite': 'ok'})
        self.assertFalse((self.root / 'without-history/client-history').exists())

    def activation_fixture(self, relative='activations'):
        root=self.data/relative;(root/'activation-originals').mkdir(parents=True)
        payload=b'synthetic activation original';sha=hashlib.sha256(payload).hexdigest()
        original=root/'activation-originals'/(sha+'.xlsx');original.write_bytes(payload)
        with contextlib.closing(sqlite3.connect(root/'activations.sqlite')) as db, db:
            db.execute('CREATE TABLE activation_imports(sha256 TEXT,status TEXT)')
            db.execute('INSERT INTO activation_imports VALUES(?,?)',(sha,'complete'))
        with contextlib.closing(sqlite3.connect(root/'activation-report.sqlite')) as db, db:
            db.execute('CREATE TABLE monthly(month TEXT,count INTEGER)')
            db.execute("INSERT INTO monthly VALUES('2026-10',3)")
        return original
    def test_activation_roundtrip(self):
        original=self.activation_fixture()
        result=recovery.restore(self.make_backup(),self.root/'activation-restored')
        self.assertEqual(result['databases']['activations/activations.sqlite'],'ok')
        self.assertEqual(result['databases']['activations/activation-report.sqlite'],'ok')
        self.assertEqual((self.root/'activation-restored/activations/activation-originals'/original.name).read_bytes(),original.read_bytes())
    def test_published_activation_generation_roundtrip(self):
        original=self.activation_fixture()
        old=self.data/'activations';generation=old/'generations'/'synthetic';generation.mkdir(parents=True)
        for name in ('activations.sqlite','activation-report.sqlite','activation-originals'):(old/name).rename(generation/name)
        (old/'current').symlink_to('generations/synthetic',target_is_directory=True)
        restored=self.root/'published-restored'
        recovery.restore(self.make_backup(),restored)
        self.assertEqual((restored/'activations/activation-originals'/original.name).read_bytes(),b'synthetic activation original')
        self.assertFalse((restored/'activations/current').exists(),'restore flattens one coherent generation')

    def test_activation_pointer_cannot_escape_data_root(self):
        self.activation_fixture();outside=self.root/'outside';outside.mkdir()
        (self.data/'activations/current').symlink_to(outside,target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError,'generation location'):self.make_backup()

    def test_separate_digi_and_vodafone_roundtrip(self):
        vodafone = self.activation_fixture()
        digi = self.activation_fixture('activations/digi')
        result = recovery.restore(self.make_backup(), self.root / 'operators-restored')
        for relative, original in [('activations', vodafone), ('activations/digi', digi)]:
            self.assertEqual(result['databases'][relative + '/activations.sqlite'], 'ok')
            self.assertEqual(result['databases'][relative + '/activation-report.sqlite'], 'ok')
            self.assertEqual((self.root / 'operators-restored' / relative / 'activation-originals' / original.name).read_bytes(), original.read_bytes())

    def test_missing_digi_original_rejects_backup(self):
        self.activation_fixture('activations/digi').unlink()
        with self.assertRaisesRegex(RuntimeError, 'Activation original'):
            self.make_backup()

    def test_digi_original_tampering_rejects_restore(self):
        original = self.activation_fixture('activations/digi')
        archive = self.rewrite_archive(lambda files: files.update({'activations/digi/activation-originals/' + original.name: b'corrupt'}))
        self.assert_restore_rejected(archive, 'activation original')

    def test_missing_activation_original_rejects_backup(self):
        self.activation_fixture().unlink()
        with self.assertRaisesRegex(RuntimeError,'Activation original'):self.make_backup()
    def test_activation_original_tampering_rejects_restore(self):
        original=self.activation_fixture()
        archive=self.rewrite_archive(lambda files:files.update({'activations/activation-originals/'+original.name:b'corrupt'}))
        self.assert_restore_rejected(archive,'activation original')
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
