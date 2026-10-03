"""Synthetic tests for cumulative uploads; no live resources."""
import json,pathlib,tempfile,unittest,uuid,zipfile,re,sqlite3,os
from unittest import mock
import client_sales_history as h
import client_history_upload as u
from test_client_sales_history import fixture,row

class UploadTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.directory=pathlib.Path(self.temp.name);self.root=self.directory/'client-history';self.root.mkdir()
  self.partners=self.directory/'partners.json';self.partners.write_text(json.dumps({'partners':[{'id':'p1','cui':'123','county':'County','city':'City','address':'Street 1','historyFranchises':['F001'],'crm':{'ignored':'synthetic payload'}}]}))
  self.master=self.directory/'master.json';self.master.write_text(json.dumps([{'CIF':'123','PartnerCode':'123','Cod_Franciza':'F001','Judet':'County','Oras':'City','Street':'Street 1'}]))
  self.c=h.connect(self.root/'client-sales-history.sqlite')
  path=self.directory/'annual.xlsx';fixture(path,[row(Data='01.01.2024'),row(Data='01.02.2024'),row(Data='01.03.2024')])
  h.import_file(self.c,path,self.partners,self.master)
 def tearDown(self):self.c.close();self.temp.cleanup()
 def upload(self,records,metadata=False):
  path=self.directory/(str(uuid.uuid4())+'.xlsx');fixture(path,records,'2024-02-01','2024-02-29')
  if not metadata:
   with zipfile.ZipFile(path) as z:files={n:z.read(n) for n in z.namelist()}
   name='xl/worksheets/sheet1.xml';files[name]=re.sub(rb'<row r="[1-4]">.*?</row>',b'',files[name])
   with zipfile.ZipFile(path,'w') as z:
    for name,data in files.items():z.writestr(name,data)
  rows,summary,end=u.parse_upload(path);p=u.preview(self.c,rows,summary,end)
  req={'jobId':str(uuid.uuid4()),'source':str(path),'filename':path.name,'revision':p['revision'],'fileHash':p['fileHash'],'allowRegression':False}
  return rows,summary,end,req,p
 def commit(self,data,ack=False):
  rows,summary,end,req,p=data;req['allowRegression']=ack
  return u.apply(self.c,rows,summary,end,req,self.root)
 def facts(self):return [tuple(r) for r in self.c.execute('SELECT date,quantity_micros,value_cents FROM history_current ORDER BY date,value_cents')]
 def test_incompatible_header_explains_expected_customer_report(self):
  path=self.directory/'incompatible.xlsx';fixture(path,[row(Data='01.02.2024')],'2024-02-01','2024-02-29')
  with zipfile.ZipFile(path) as z:files={name:z.read(name) for name in z.namelist()}
  files['xl/worksheets/sheet1.xml']=files['xl/worksheets/sheet1.xml'].replace(b'Cod Client',b'Other Column')
  with zipfile.ZipFile(path,'w') as z:
   for name,data in files.items():z.writestr(name,data)
  before=self.facts()
  with self.assertRaisesRegex(u.UploadError,'Lipsește antetul așteptat.*Cod Client.*Datele existente nu au fost modificate'):u.parse_upload(path)
  self.assertEqual(self.facts(),before)
 def test_changed_customer_columns_explained_without_import(self):
  path=self.directory/'changed.xlsx';fixture(path,[row(Data='01.02.2024')],'2024-02-01','2024-02-29')
  with zipfile.ZipFile(path) as z:files={name:z.read(name) for name in z.namelist()}
  files['xl/worksheets/sheet1.xml']=files['xl/worksheets/sheet1.xml'].replace(b'ItemName',b'UnexpectedColumn')
  with zipfile.ZipFile(path,'w') as z:
   for name,data in files.items():z.writestr(name,data)
  before=self.facts()
  with self.assertRaisesRegex(u.UploadError,'Coloanele raportului.*Datele existente nu au fost modificate'):u.parse_upload(path)
  self.assertEqual(self.facts(),before)
 def test_infer_and_preserve_other_months(self):
  data=self.upload([row(Data='01.02.2024'),row(Data='02.02.2024')])
  self.assertEqual(data[1]['through'],'2024-02-02');self.assertTrue(data[-1]['coverageShorter'])
  with self.assertRaises(u.UploadError):self.commit(data)
  self.commit(data,True);self.assertEqual(len(self.facts()),4)
  self.assertEqual([x[0] for x in self.facts()],['2024-01-01','2024-02-01','2024-02-02','2024-03-01'])
  for r in self.c.execute('SELECT sha256,original_path FROM history_imports'):self.assertEqual(h.file_sha(self.root/r['original_path']),r['sha256'])
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM history_import_projections').fetchone()[0],2)
 def test_cumulative_addition_and_repeat(self):
  self.commit(self.upload([row(Data='01.02.2024')]),True)
  data=self.upload([row(Data='01.02.2024'),row(Data='02.02.2024')]);self.assertFalse(data[-1]['requiresAcknowledgement']);self.commit(data)
  before=self.facts();count=self.c.execute('SELECT COUNT(*) FROM history_imports').fetchone()[0]
  self.assertEqual(self.commit(data)['status'],'already_imported');self.assertEqual(self.facts(),before);self.assertEqual(self.c.execute('SELECT COUNT(*) FROM history_imports').fetchone()[0],count)
 def test_corrections_require_ack_and_preserve_occurrences(self):
  first=[row(Data='01.02.2024'),row(Data='01.02.2024')]
  self.commit(self.upload(first),True)
  data=self.upload([row(Data='01.02.2024',Valoare='18',Pret='9'),row(Data='01.02.2024',Valoare='18',Pret='9')]);self.assertEqual(data[-1]['removedOccurrences'],2)
  before=self.facts()
  with self.assertRaises(u.UploadError):self.commit(data)
  self.assertEqual(self.facts(),before);self.commit(data,True)
  self.assertEqual(sum(x[2] for x in self.facts() if x[0][:7]=='2024-02'),3600)
 def test_stale_preview_rejected(self):
  first=self.upload([row(Data='01.02.2024')])
  self.commit(self.upload([row(Data='02.02.2024')]),True)
  with self.assertRaisesRegex(u.UploadError,'schimbat'):self.commit(first,True)
 def test_shorter_period(self):
  self.commit(self.upload([row(Data='01.02.2024'),row(Data='03.02.2024')]),True)
  data=self.upload([row(Data='01.02.2024')]);self.assertTrue(data[-1]['coverageShorter']);self.assertEqual(data[-1]['removedOccurrences'],1)
 def test_metadata_full_month(self):
  data=self.upload([row(Data='01.02.2024')],True);self.assertEqual(data[1]['through'],'2024-02-29');self.assertFalse(data[1]['inferredPeriod'])
 def test_mixed_months_rejected(self):
  with self.assertRaisesRegex(u.UploadError,'mai multe luni'):self.upload([row(Data='01.02.2024'),row(Data='01.03.2024')])
 def test_future_rejected(self):
  with self.assertRaisesRegex(u.UploadError,'viitor'):self.upload([row(Data='01.02.9999')])
 def test_returns_missing_and_unknown_codes_retained(self):
  data=self.upload([row(Data='01.02.2024',Cantitate='-2',Valoare='-20'),row(Data='02.02.2024',Pret='',Valoare='',**{'Cod Client':'999','Cod_Franciza':'F999'})])
  self.assertEqual(data[1]['missingValues'],1);self.commit(data,True)
  feb=[x for x in self.facts() if x[0][:7]=='2024-02'];self.assertEqual(len(feb),2);self.assertIsNone(feb[-1][2])
  self.assertEqual(self.c.execute('SELECT COUNT(*) FROM history_current WHERE client_code=?',('999',)).fetchone()[0],1)
 def test_superseded_hash_rejected(self):
  original=self.upload([row(Data='01.02.2024')]);self.commit(original,True)
  self.commit(self.upload([row(Data='02.02.2024')]),True)
  with self.assertRaisesRegex(u.UploadError,'mai nou'):u.preview(self.c,*original[:3])
 def test_preview_does_not_mutate(self):
  before=self.c.total_changes;self.upload([row(Data='01.02.2024')]);self.assertEqual(self.c.total_changes,before)
 def test_reference_projection_preserves_resolver(self):
  data=self.upload([row(Data='01.02.2024',**{'Cod Client':'123','Cod_Franciza':'F001'}),row(Data='02.02.2024',**{'Cod Client':'999','Cod_Franciza':'F999'})])
  self.commit(data,True)
  self.assertEqual(self.c.execute("SELECT allocation_status FROM history_current WHERE franchise_code='F001'").fetchone()[0],'direct_code')
  self.assertEqual(self.c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
 def assert_stale_without_effects(self,data):
  before=self.facts();imports=[tuple(r) for r in self.c.execute('SELECT * FROM history_imports')]
  with mock.patch.object(h,'archive_source',side_effect=AssertionError('Stale preview archived a file')):
   with self.assertRaisesRegex(u.UploadError,'schimbat'):self.commit(data,True)
  self.assertEqual(self.facts(),before)
  self.assertEqual([tuple(r) for r in self.c.execute('SELECT * FROM history_imports')],imports)
  self.assertFalse((self.root/'upload-backups').exists())
 def test_raw_corrections_invalidate_preview_across_connections(self):
  changes=["UPDATE history_rows SET value_cents=9876 WHERE date='2024-02-01'",
   "UPDATE history_rows SET raw_json='{}' WHERE date='2024-02-01'",
   "UPDATE history_allocations SET reason='Synthetic correction'",
   "UPDATE history_identities SET client_code='corrected-code'",
   "UPDATE history_references SET master_json='[]'"]
  for sql in changes:
   for reconnect in (False,True):
    with self.subTest(sql=sql,reconnect=reconnect):
     data=self.upload([row(Data='02.02.2024')])
     metadata=[tuple(r) for r in self.c.execute('SELECT * FROM history_imports')]
     # Repeated subcases still change the facts, never just metadata/row_hash.
     with sqlite3.connect(self.root/'client-sales-history.sqlite') as writer:
      if '9876' in sql:sql=sql.replace('9876',str(9876+int(reconnect)))
      elif reconnect:sql=sql.replace('correction','correction again').replace('corrected-code','corrected-code-again').replace("'{}'","'{ }'").replace("'[]'","'[ ]'")
      writer.execute(sql)
     if reconnect:self.c.close();self.c=u.open_history(self.directory)
     self.assertEqual([tuple(r) for r in self.c.execute('SELECT * FROM history_imports')],metadata)
     self.assert_stale_without_effects(data)
 def test_same_connection_correction_and_fresh_acknowledgement(self):
  data=self.upload([row(Data='01.02.2024')],True)
  self.c.execute("UPDATE history_rows SET value_cents=12345 WHERE date='2024-02-01'");self.c.commit()
  self.assert_stale_without_effects(data)
  fresh=u.preview(self.c,*data[:3]);self.assertEqual(fresh['removedOccurrences'],1);self.assertTrue(fresh['requiresAcknowledgement'])
 def test_revision_stable_on_reopen_checkpoint_and_read_only_activity(self):
  data=self.upload([row(Data='02.02.2024')])
  expected=data[-1]['revision'];self.c.execute('PRAGMA wal_checkpoint(TRUNCATE)');self.c.close()
  self.c=u.open_history(self.directory)
  os.utime(self.root/'client-sales-history.sqlite',None)
  self.assertEqual(u.preview(self.c,*data[:3])['revision'],expected)
  self.commit(data,True);self.c.close();self.c=u.open_history(self.directory)
  self.assertEqual(self.commit(data,True)['status'],'already_imported')
 def test_atomic_replacement_invalidates_even_identical_database(self):
  for change in (False,True):
   with self.subTest(change=change):
    data=self.upload([row(Data='02.02.2024')]);replacement=self.root/'replacement.sqlite'
    with sqlite3.connect(replacement) as other:
     self.c.backup(other)
     if change:other.execute("UPDATE history_rows SET value_cents=7777 WHERE date='2024-02-01'")
    other.close()
    self.c.close();os.replace(replacement,self.root/'client-sales-history.sqlite');self.c=u.open_history(self.directory)
    self.assert_stale_without_effects(data)
 def test_atomic_replacement_with_old_connection_fails_before_archive(self):
  self.c.execute('PRAGMA journal_mode=DELETE')
  data=self.upload([row(Data='02.02.2024')]);replacement=self.root/'replacement.sqlite'
  other=sqlite3.connect(replacement)
  try:self.c.backup(other)
  finally:other.close()
  os.replace(replacement,self.root/'client-sales-history.sqlite')
  with mock.patch.object(h,'archive_source',side_effect=AssertionError('Replaced source must not archive')):
   with self.assertRaisesRegex(u.UploadError,'schimbat'):self.commit(data,True)
  self.assertFalse((self.root/'upload-backups').exists())
 def test_preview_uses_one_wal_snapshot(self):
  original=u.facts_revision
  def mutate(c,start,end):
   with sqlite3.connect(self.root/'client-sales-history.sqlite') as writer:writer.execute("UPDATE history_rows SET value_cents=9999 WHERE date='2024-02-01'")
   return original(c,start,end)
  rows,summary,end,req,p=self.upload([row(Data='02.02.2024')])
  with mock.patch.object(u,'facts_revision',side_effect=mutate):pinned=u.preview(self.c,rows,summary,end)
  self.assertEqual(pinned['previous']['valueCents'],2000)
  self.assertEqual(pinned['revision'],p['revision'])
  self.assert_stale_without_effects((rows,summary,end,req,pinned))
 def test_commit_reserves_writer_through_backup_verification(self):
  data=self.upload([row(Data='02.02.2024')]);verify=u.verify_recovery
  def locked(*args):
   with sqlite3.connect(self.root/'client-sales-history.sqlite',timeout=0) as other:
    with self.assertRaisesRegex(sqlite3.OperationalError,'locked'):other.execute("UPDATE history_rows SET value_cents=1111")
   return verify(*args)
  with mock.patch.object(u,'verify_recovery',side_effect=locked):self.commit(data,True)
 def test_backup_damage_or_copy_failure_never_archives_or_changes_source(self):
  copy=u.copy_recovery
  for fault in ('corrupt','foreign_key','missing_rows','wrong_facts','missing_table','copy_error'):
   with self.subTest(fault=fault):
    data=self.upload([row(Data='02.02.2024')]);before=self.facts()
    def damage(source,path):
     if fault=='copy_error':raise sqlite3.OperationalError('Synthetic backup failure')
     copy(source,path)
     if fault=='corrupt':path.write_bytes(b'not a database');return
     with sqlite3.connect(path) as bad:
      if fault=='foreign_key':bad.execute('UPDATE history_rows SET identity_id=99999')
      if fault=='missing_rows':bad.execute("DELETE FROM history_rows WHERE date='2024-02-01'")
      if fault=='wrong_facts':bad.execute('UPDATE history_rows SET value_cents=123')
      if fault=='missing_table':bad.execute('DROP TABLE history_allocations')
    with mock.patch.object(u,'copy_recovery',side_effect=damage),mock.patch.object(h,'archive_source',side_effect=AssertionError('Unverified backup must not archive')):
     with self.assertRaisesRegex(u.UploadError,'recuperare'):self.commit(data,True)
    self.assertEqual(self.facts(),before);self.assertFalse(self.c.in_transaction)
 def test_existing_corrupt_backup_rejected(self):
  data=self.upload([row(Data='02.02.2024')]);backup=self.root/'upload-backups';backup.mkdir()
  (backup/(data[3]['jobId']+'.sqlite')).write_bytes(b'damaged')
  with mock.patch.object(u,'copy_recovery',side_effect=AssertionError('Do not replace existing recovery')),mock.patch.object(h,'archive_source',side_effect=AssertionError('Do not archive')):
   with self.assertRaisesRegex(u.UploadError,'recuperare'):self.commit(data,True)
 def test_backup_is_reopenable_and_matches_precommit_facts(self):
  data=self.upload([row(Data='02.02.2024')]);before=self.facts();result=self.commit(data,True)
  backup=self.root/'upload-backups'/(data[3]['jobId']+'.sqlite')
  with sqlite3.connect(backup.as_uri()+'?mode=ro',uri=True) as restored:
   self.assertEqual(restored.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
   self.assertEqual(restored.execute('PRAGMA foreign_key_check').fetchall(),[])
   self.assertEqual(restored.execute('SELECT date,quantity_micros,value_cents FROM history_current ORDER BY date,value_cents').fetchall(),before)
  self.assertEqual(result['status'],'imported')
 def test_declared_empty_replaces_only_month_with_verified_zero_coverage(self):
  data=self.upload([],True);p=data[-1]
  self.assertEqual((p['rows'],p['valueCents'],p['quantityMicros'],p['missingValues']),(0,0,0,0))
  self.assertEqual((p['firstDate'],p['lastDate']),('',''))
  self.assertEqual((p['from'],p['through']),('2024-02-01','2024-02-29'))
  self.assertEqual((p['removedOccurrences'],p['addedOccurrences']),(1,0));self.assertTrue(p['requiresAcknowledgement'])
  before=self.facts()
  with self.assertRaises(u.UploadError):self.commit(data)
  self.assertEqual(self.facts(),before)
  result=self.commit(data,True)
  self.assertEqual([r[0] for r in self.facts()],['2024-01-01','2024-03-01'])
  coverage=self.c.execute('SELECT period_start,period_end,row_count,value_cents,quantity_micros FROM history_imports WHERE id=?',(result['importId'],)).fetchone()
  self.assertEqual(tuple(coverage),('2024-02-01','2024-02-29',0,0,0))
  self.assertEqual(self.c.execute("SELECT COUNT(*) FROM history_current WHERE date LIKE '2024-02-%'").fetchone()[0],0)
  self.assertEqual(h.file_sha(self.root/'client-sales-originals'/(p['fileHash']+'.xlsx')),p['fileHash'])
  self.assertTrue((self.root/'upload-backups'/(data[3]['jobId']+'.sqlite')).is_file())
  self.assertEqual(self.commit(data,True)['status'],'already_imported')
 def test_empty_inferred_and_invalid_declared_periods_rejected(self):
  with self.assertRaisesRegex(u.UploadError,'explicit'):self.upload([])
  for start,end in [('2024-02-02','2024-02-29'),('2024-02-01','2024-03-01'),('9999-02-01','9999-02-28'),('2024-02-01','2024-01-31')]:
   with self.subTest(start=start,end=end):
    path=self.directory/'empty.xlsx';fixture(path,[],start,end)
    with self.assertRaises(ValueError):u.parse_upload(path)
 def test_empty_header_and_ambiguous_declarations_rejected(self):
  transforms=[lambda raw:raw.replace(b'ItemName',b'WrongHeader'),
   lambda raw:raw.replace(b'<row r="3"></row>',re.search(rb'<row r="1">.*?</row>',raw)[0]),
   lambda raw:re.sub(rb'<row r="2">.*?</row>',b'',raw)]
  for transform in transforms:
   with self.subTest(transform=transform):
    path=self.directory/'empty.xlsx';fixture(path,[],'2024-02-01','2024-02-29')
    with zipfile.ZipFile(path) as z:files={n:z.read(n) for n in z.namelist()}
    name='xl/worksheets/sheet1.xml';files[name]=transform(files[name])
    with zipfile.ZipFile(path,'w') as z:
     for name,raw in files.items():z.writestr(name,raw)
    with self.assertRaises(ValueError):u.parse_upload(path)
if __name__=='__main__':unittest.main()
