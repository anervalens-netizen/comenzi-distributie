"""Synthetic tests for cumulative uploads; no live resources."""
import json,pathlib,tempfile,unittest,uuid,zipfile,re,sqlite3
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
if __name__=='__main__':unittest.main()
