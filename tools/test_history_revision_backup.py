"""Synthetic revision migrations: recovery must precede every schema write."""
import hashlib,json,pathlib,sqlite3,tempfile,unittest
from unittest import mock
from contextlib import closing
import client_sales_history as h
import client_history_upload as u

class RevisionBackupTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.directory=pathlib.Path(self.temp.name)
  self.root=self.directory/'client-history';self.root.mkdir()
  self.path=self.root/'client-sales-history.sqlite'
  self.c=sqlite3.connect(self.path);self.c.row_factory=sqlite3.Row
  self.c.executescript(h.SCHEMA)
  self.c.execute("INSERT INTO history_identities VALUES(1,'synthetic','point')")
  self.c.commit()
 def tearDown(self):self.c.close();self.temp.cleanup()
 def snapshot(self,c):return '\n'.join(c.iterdump())
 def copies(self):return sorted((self.root/'migration-backups').glob('history-revision-*/receipt.json'))
 def test_migration_preserves_verified_copy_before_first_schema_write(self):
  before=self.snapshot(self.c);observed=[]
  def trace(sql):
   if sql.startswith('CREATE TABLE IF NOT EXISTS history_revision'):
    copies=self.copies();observed.append(len(copies))
  self.c.set_trace_callback(trace)
  h.ensure_history_revision(self.c)
  self.assertEqual(observed,[1],'a verified recovery copy must precede revision DDL')
  receipt=json.loads(self.copies()[0].read_text())
  copy=self.copies()[0].parent/receipt['backup']
  self.assertEqual(hashlib.sha256(copy.read_bytes()).hexdigest(),receipt['sha256'])
  with closing(sqlite3.connect(copy)) as saved:self.assertEqual(self.snapshot(saved),before)
 def test_missing_backup_destination_refuses_migration(self):
  (self.root/'migration-backups').write_text('unavailable')
  before=self.snapshot(self.c)
  with self.assertRaises(ValueError):h.ensure_history_revision(self.c)
  self.assertEqual(self.snapshot(self.c),before)
  self.assertFalse(self.c.in_transaction)
 def test_open_history_refuses_migration_if_backup_unavailable(self):
  (self.root/'migration-backups').write_text('unavailable')
  before=self.snapshot(self.c)
  with self.assertRaises(ValueError):u.open_history(self.directory)
  self.assertEqual(self.snapshot(self.c),before)

 def test_connect_refuses_before_any_setup_write(self):
  (self.root/'migration-backups').write_text('unavailable')
  before=self.snapshot(self.c)
  with self.assertRaises(ValueError):h.connect(self.path)
  self.assertEqual(self.snapshot(self.c),before)
 def test_valid_schema_skips_backup_and_preserves_revision(self):
  h.ensure_history_revision(self.c);before=h.logical_revision(self.c)
  with mock.patch.object(h,'preserve_revision_backup',side_effect=AssertionError('unnecessary history copy')):
   for _ in range(3):
    h.ensure_history_revision(self.c)
    with closing(u.open_history(self.directory)) as opened:self.assertEqual(h.logical_revision(opened),before)
    with closing(h.connect(self.path)) as opened:self.assertEqual(h.logical_revision(opened),before)
  self.assertEqual(len(self.copies()),1)
 def test_repair_keeps_a_new_premigration_copy(self):
  h.ensure_history_revision(self.c);epoch=self.c.execute('SELECT epoch FROM history_revision').fetchone()[0]
  self.c.execute('DROP TRIGGER history_revision_history_identities_update')
  self.c.execute("UPDATE history_identities SET client_code='corrected'");self.c.commit()
  before=self.snapshot(self.c);previous=set(self.copies())
  h.ensure_history_revision(self.c)
  new=set(self.copies())-previous;self.assertEqual(len(new),1)
  receipt_path=new.pop();receipt=json.loads(receipt_path.read_text())
  with closing(sqlite3.connect(receipt_path.parent/receipt['backup'])) as saved:self.assertEqual(self.snapshot(saved),before)
  self.assertNotEqual(self.c.execute('SELECT epoch FROM history_revision').fetchone()[0],epoch)
 def test_committed_wal_is_included(self):
  self.c.execute('PRAGMA journal_mode=WAL')
  self.c.execute("INSERT INTO history_identities VALUES(2,'wal-only','point')");self.c.commit()
  self.assertGreater(pathlib.Path(str(self.path)+'-wal').stat().st_size,0)
  h.ensure_history_revision(self.c)
  copy=self.copies()[0].parent/'client-sales-history.sqlite'
  with closing(sqlite3.connect(copy)) as saved:
   self.assertEqual(saved.execute('SELECT client_code FROM history_identities WHERE id=2').fetchone()[0],'wal-only')
   self.assertIsNone(saved.execute("SELECT 1 FROM sqlite_master WHERE name='history_revision'").fetchone())
  self.assertFalse(pathlib.Path(str(copy)+'-wal').exists())
 def test_fsync_failure_preserves_original_schema(self):
  before=self.snapshot(self.c)
  with mock.patch.object(h.os,'fsync',side_effect=OSError('synthetic storage failure')):
   with self.assertRaisesRegex(ValueError,'verified recovery copy'):h.ensure_history_revision(self.c)
  self.assertEqual(self.snapshot(self.c),before);self.assertEqual(self.copies(),[])
 def test_corrupted_copy_is_refused_before_migration(self):
  before=self.snapshot(self.c);real_hash=h.file_sha;changed=[]
  def corrupt(path):
   digest=real_hash(path)
   if not changed:path.write_bytes(b'invalid sqlite copy');changed.append(True)
   return digest
  with mock.patch.object(h,'file_sha',side_effect=corrupt):
   with self.assertRaisesRegex(ValueError,'verified recovery copy'):h.ensure_history_revision(self.c)
  self.assertEqual(self.snapshot(self.c),before);self.assertEqual(self.copies(),[])
 def test_missing_receipt_is_refused(self):
  before=self.snapshot(self.c);verify=h.verify_revision_backup
  def missing(folder,receipt):
   (folder/'receipt.json').unlink();verify(folder,receipt)
  with mock.patch.object(h,'verify_revision_backup',side_effect=missing):
   with self.assertRaisesRegex(ValueError,'verified recovery copy'):h.ensure_history_revision(self.c)
  self.assertEqual(self.snapshot(self.c),before)
 def test_foreign_writer_excluded_until_copy_verified(self):
  verify=h.verify_revision_backup;attempts=[]
  def probe(folder,receipt):
   with closing(sqlite3.connect(self.path,timeout=0)) as other:
    with self.assertRaisesRegex(sqlite3.OperationalError,'locked'):
     other.execute("UPDATE history_identities SET client_code='racing'")
   attempts.append(True);return verify(folder,receipt)
  with mock.patch.object(h,'verify_revision_backup',side_effect=probe):h.ensure_history_revision(self.c)
  self.assertTrue(attempts)
  self.assertEqual(self.c.execute('SELECT client_code FROM history_identities').fetchone()[0],'synthetic')
 def test_migration_failure_rolls_back_but_preserves_recovery(self):
  before=self.snapshot(self.c)
  def deny(action,*args):return sqlite3.SQLITE_DENY if action==sqlite3.SQLITE_CREATE_TRIGGER else sqlite3.SQLITE_OK
  self.c.set_authorizer(deny)
  with self.assertRaises(sqlite3.DatabaseError):h.ensure_history_revision(self.c)
  self.c.set_authorizer(None)
  self.assertEqual(self.snapshot(self.c),before);self.assertFalse(self.c.in_transaction)
  self.assertEqual(len(self.copies()),1)
  receipt=json.loads(self.copies()[0].read_text());h.verify_revision_backup(self.copies()[0].parent,receipt)
 def test_backup_directory_symlink_refused(self):
  other=self.directory/'other';other.mkdir()
  (self.root/'migration-backups').symlink_to(other,target_is_directory=True)
  before=self.snapshot(self.c)
  with self.assertRaisesRegex(ValueError,'verified recovery copy'):h.ensure_history_revision(self.c)
  self.assertEqual(self.snapshot(self.c),before);self.assertEqual(list(other.iterdir()),[])
 def test_private_recovery_permissions(self):
  h.ensure_history_revision(self.c);manifest=self.copies()[0]
  for p in [manifest.parent,manifest.parent.parent]:self.assertEqual(p.stat().st_mode&0o777,0o700)
  for p in [manifest,manifest.parent/'client-sales-history.sqlite']:self.assertEqual(p.stat().st_mode&0o777,0o600)
 def test_active_transaction_refused_without_backup(self):
  self.c.execute('BEGIN')
  with self.assertRaisesRegex(ValueError,'own transaction'):h.ensure_history_revision(self.c)
  self.c.rollback();self.assertEqual(self.copies(),[])

if __name__=='__main__':unittest.main()
