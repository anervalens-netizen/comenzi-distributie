import contextlib,fcntl,gzip,hashlib,json,os,shutil,sqlite3,tempfile,unittest,uuid,zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import activations,activation_job,import_engine_sim
from test_activations import fixture,row,digi_row

class SimExecutorTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name);self.data=self.base/'data';self.data.mkdir();self.net=self.data/'activations';self.net.mkdir();self.digi=self.net/'digi';self.digi.mkdir()
  self.rules={'version':1,'revision':'synthetic','history':'all','assignments':[],'products':{}}
  self.settings=self.data/'mobiup.sqlite'
  with contextlib.closing(sqlite3.connect(self.settings)) as c:
   c.executescript('CREATE TABLE users(id TEXT,role TEXT,active INTEGER,must_change_password INTEGER,profile_revision INTEGER,manager_scope TEXT);CREATE TABLE sessions(user_id TEXT,token_hash TEXT,expires_at INTEGER);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);')
   c.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',('manager','manager',1,0,1,'global'));c.execute('INSERT INTO sessions VALUES(?,?,?)',('manager','synthetic',9999999999999));c.execute('INSERT INTO settings VALUES(?,?)',('distribution-rules-v1',json.dumps(self.rules)));c.commit()
  v=fixture(self.base/'baseline-v.xlsx',[row()]);d=fixture(self.base/'baseline-d.xlsx',[digi_row()],headers=activations.DIGI_HEADERS,header_row=1)
  activation_job.run_job(self.net,[{'files':[str(v)],'operator':'vodafone'}],self.rules)
  activation_job.run_job(self.digi,[{'files':[str(d)],'operator':'digi','site_aliases':{('ExampleCo','TR Example'):'SITE-A'}}],self.rules)
  self.env=patch.dict(os.environ,{'MOBIUP_DATA_DIR':str(self.data),'MOBIUP_ACTIVATIONS_DIR':str(self.net)});self.env.start()
  self.space=patch.object(import_engine_sim.shutil,'disk_usage',return_value=SimpleNamespace(free=100*1024**3));self.space.start()
 def tearDown(self):self.space.stop();self.env.stop();self.tmp.cleanup()
 def source(self,kind):
  path=self.base/'input.xlsx'
  if kind=='sim_sales_vodafone':fixture(path,[row(DataVDF='20260110',IMEI='0000000000000000020',Activat='000000000000000002',DocumentDetailId='NEW')])
  elif kind=='sim_sales_digi':fixture(path,[digi_row(Data='2026-01-10',IMEI='0000000000000000020',Activat='0000000000000000020')],headers=activations.DIGI_HEADERS,header_row=1)
  else:
   headers=['SerieText','DATE_OF_ACTIVATION','COUNTY_OF_ACTIVATION','Paid SIM Category'] if kind.endswith('vodafone') else ['Distribuitor','Seria SIM (iccid)','Data activare']
   item={'SerieText':'000000000000000002','DATE_OF_ACTIVATION':'2026-01-10','COUNTY_OF_ACTIVATION':'TEST','Paid SIM Category':'-'} if kind.endswith('vodafone') else {'Distribuitor':'ExampleCo','Seria SIM (iccid)':'0000000000000000020','Data activare':'2026-01-10'}
   fixture(path,[item],headers=headers,header_row=1)
   with zipfile.ZipFile(path) as z:parts={n:(z.read(n).replace(b'name="SIM"',b'name="Detailed SIM"' if kind.endswith('vodafone') else b'name="activari"') if n=='xl/workbook.xml' else z.read(n)) for n in z.namelist()}
   with zipfile.ZipFile(path,'w') as z:
    for n,value in parts.items():z.writestr(n,value)
  job_id=str(uuid.uuid4());folder=self.data/'import-engine-spool'/job_id;folder.mkdir(parents=True);target=folder/'source.xlsx';shutil.copyfile(path,target)
  return {'id':job_id,'kind':kind,'actor':{'id':'manager','label':'Synthetic','type':'human'},'source':{'filename':'synthetic.xlsx','sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'size':target.stat().st_size,'date_start':'2026-01-01','date_end':'2026-01-31','source_at':'2026-01-31'},'payload':{'company':'ExampleCo','commit_authorization':{'userId':'manager','profileVersion':1,'managerScope':'global','tokenHash':'synthetic'}}}
 def test_four_independent_sources_preview_commit_and_reconcile(self):
  for kind in ('sim_sales_vodafone','sim_sales_digi','sim_activations_vodafone','sim_activations_digi'):
   with self.subTest(kind=kind):
    job=self.source(kind);action=str(uuid.uuid4());other=self.digi if kind.endswith('vodafone') else self.net;other_before=(other/'current').resolve()
    preview=import_engine_sim.run({'job':job,'mode':'execute','action':'preview','action_id':str(uuid.uuid4())});self.assertEqual(preview['preview']['rows'],1)
    job['preview']=preview['preview'];result=import_engine_sim.run({'job':job,'mode':'execute','action':'commit','action_id':action});self.assertEqual(result['state'],'completed');self.assertTrue(result['receipt']['verified']);self.assertEqual((other/'current').resolve(),other_before)
    recovered=import_engine_sim.run({'job':job,'mode':'reconcile','action':'commit','action_id':action});self.assertEqual(recovered['receipt'],result['receipt'])
 def test_vodafone_operator_company_is_fixed_even_for_old_client_header(self):
  job=self.source('sim_activations_vodafone')
  del job['payload']['company']
  preview=import_engine_sim.run({'job':job,'mode':'execute','action':'preview','action_id':str(uuid.uuid4())})
  self.assertEqual(preview['preview']['company'],'Vodafone')
  job['payload']['company']='wrong brand from cached form'
  job['preview']=preview['preview']
  done=import_engine_sim.run({'job':job,'mode':'execute','action':'commit','action_id':str(uuid.uuid4())})
  self.assertEqual(done['state'],'completed')
  self.assertEqual(done['receipt']['company'],'Vodafone')
  with contextlib.closing(sqlite3.connect((self.net/'current'/'activations.sqlite').resolve())) as db:
   self.assertEqual(db.execute("SELECT company FROM activation_imports WHERE source_kind='operator'").fetchone()[0],'Vodafone')

 def test_revoked_session_never_publishes(self):
  job=self.source('sim_sales_vodafone');job['preview']=import_engine_sim.run({'job':job,'mode':'execute','action':'preview','action_id':str(uuid.uuid4())})['preview'];old=(self.net/'current').resolve()
  with contextlib.closing(sqlite3.connect(self.settings)) as c:c.execute('DELETE FROM sessions');c.commit()
  with self.assertRaises(PermissionError):import_engine_sim.run({'job':job,'mode':'execute','action':'commit','action_id':str(uuid.uuid4())})
  self.assertEqual((self.net/'current').resolve(),old)
 def test_staging_reserves_against_concurrent_upload_admission(self):
  job=self.source('sim_sales_vodafone');job['preview']=import_engine_sim.run({'job':job,'mode':'execute','action':'preview','action_id':str(uuid.uuid4())})['preview']
  original=activation_job.run_job
  def locked(*args,**kwargs):
   with (self.data/'import-engine-spool'/'.admission.lock').open('a') as admission:
    with self.assertRaises(BlockingIOError):fcntl.flock(admission,fcntl.LOCK_EX|fcntl.LOCK_NB)
   return original(*args,**kwargs)
  with patch.object(activation_job,'run_job',side_effect=locked):
   result=import_engine_sim.run({'job':job,'mode':'execute','action':'commit','action_id':str(uuid.uuid4())})
  self.assertEqual(result['state'],'completed')
 def test_streaming_operator_json_rejects_trailing_comma(self):
  path=self.base/'bad.json.gz'
  with gzip.open(path,'wt') as stream:stream.write('[{"synthetic":1},]')
  with self.assertRaises(ValueError):list(import_engine_sim.json_records(path))
 def test_declared_period_matches_optional_workbook_metadata(self):
  job=self.source('sim_sales_vodafone');path=self.data/'import-engine-spool'/job['id']/'source.xlsx'
  with zipfile.ZipFile(path) as z:parts={name:z.read(name) for name in z.namelist()}
  sheet='xl/worksheets/sheet1.xml';metadata=b'<row r="1"><c r="A1" t="inlineStr"><is><t>Data Start</t></is></c><c r="B1" t="inlineStr"><is><t>2026-01-10</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Data Stop</t></is></c><c r="B2" t="inlineStr"><is><t>2026-01-31</t></is></c></row>'
  parts[sheet]=parts[sheet].replace(b'<sheetData>',b'<sheetData>'+metadata)
  with zipfile.ZipFile(path,'w') as z:
   for name,value in parts.items():z.writestr(name,value)
  job['source'].update(sha256=hashlib.sha256(path.read_bytes()).hexdigest(),size=path.stat().st_size,date_start='2026-01-10')
  req={'job':job,'mode':'execute','action':'preview','action_id':str(uuid.uuid4())}
  self.assertEqual(import_engine_sim.run(req)['state'],'ready','Mid-month declared start is accepted')
  job['source']['date_start']='2026-01-09'
  with self.assertRaisesRegex(ValueError,'period mismatch'):import_engine_sim.run(req)

if __name__=='__main__':unittest.main()
