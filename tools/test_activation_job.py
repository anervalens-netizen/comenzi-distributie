import json
import gzip
import hashlib
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from activation_job import authorized_publication, run_job
from activation_focus_evidence import build_focus_evidence
import activations
from test_activations import fixture,row

class JobTests(unittest.TestCase):
 def test_authorized_publication_serializes_revocation_and_rejects_stale_session(self):
  with tempfile.TemporaryDirectory() as folder:
   dbpath=Path(folder)/'settings.sqlite'
   with closing(sqlite3.connect(dbpath)) as db:
    db.executescript('CREATE TABLE users(id TEXT,role TEXT,active INTEGER,must_change_password INTEGER,profile_revision INTEGER,manager_scope TEXT); CREATE TABLE sessions(user_id TEXT,token_hash TEXT,expires_at INTEGER);')
    db.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',('manager','manager',1,0,3,'global'))
    db.execute('INSERT INTO sessions VALUES(?,?,?)',('manager','synthetic-hash',int(time.time()*1000)+60000))
    db.commit()
   auth={'userId':'manager','profileVersion':3,'managerScope':'global','tokenHash':'synthetic-hash'}
   with authorized_publication(dbpath,auth):
    with closing(sqlite3.connect(dbpath,timeout=0)) as other:
     with self.assertRaisesRegex(sqlite3.OperationalError,'locked'):other.execute('DELETE FROM sessions')
   with closing(sqlite3.connect(dbpath)) as db:db.execute('DELETE FROM sessions');db.commit()
   with self.assertRaises(PermissionError):
    with authorized_publication(dbpath,auth):self.fail('revoked session accepted')

 def test_publication_guard_covers_pointer_change_and_denial_preserves_pointer(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);data=root/'data';file=fixture(root/'one.xlsx',[row()]);batch={'files':[str(file)],'operator':'vodafone'}
   run_job(data,[batch]);old=(data/'current').resolve();events=[]
   @contextmanager
   def guard(stage):
    events.append(('enter',(data/'current').resolve()))
    yield
    events.append(('exit',(data/'current').resolve()))
   result=run_job(data,[batch],publication_guard=guard)
   self.assertEqual(events,[('enter',old),('exit',data/'generations'/result['generation'])])
   current=(data/'current').resolve()
   @contextmanager
   def denied(stage):
    raise PermissionError('authorization revoked')
    yield
   with self.assertRaisesRegex(PermissionError,'authorization revoked'):run_job(data,[batch],publication_guard=denied)
   self.assertEqual((data/'current').resolve(),current)

 def test_explicit_no_import_full_reconciliation_is_versioned_and_preserves_provenance(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);data=root/'digi'
   file=fixture(root/'digi.xlsx',[__import__('test_activations').digi_row(Activat='0000000000000000010',DataDigi='2026-10-15')],headers=activations.DIGI_HEADERS,header_row=1)
   batch={'files':[str(file)],'operator':'digi','site_aliases':{('ExampleCo','TR Example'):'SITE-A'}}
   first=run_job(data,[batch])
   old=(data/'current').resolve()
   with closing(sqlite3.connect(old/'activations.sqlite')) as c:
    imports=c.execute('SELECT id,sha256,company,row_count,source_kind FROM activation_imports').fetchall()
    c.execute("UPDATE activation_facts SET company='exampleco',candidate_site=NULL,status='unresolved' WHERE company='ExampleCo' AND provider='digi'")
    c.commit()
   with self.assertRaisesRegex(ValueError,'cannot mix'):
    run_job(data,[batch],force_reconcile=True)
   self.assertEqual((data/'current').resolve(),old)
   updated=run_job(data,[],force_reconcile=True)
   new=(data/'current').resolve()
   self.assertNotEqual(old,new)
   self.assertEqual(updated['imports'],[])
   self.assertEqual((data/'current').resolve(),new)
   with closing(sqlite3.connect(new/'activations.sqlite')) as c:
    self.assertEqual(c.execute('SELECT id,sha256,company,row_count,source_kind FROM activation_imports').fetchall(),imports)
    self.assertEqual(c.execute("SELECT COUNT(*) FROM activation_facts WHERE company='exampleco'").fetchone()[0],0)
    self.assertEqual(c.execute("SELECT candidate_site FROM activation_facts WHERE company='ExampleCo'").fetchone()[0],'SITE-A')
    self.assertEqual(c.execute('PRAGMA quick_check').fetchone()[0],'ok')
   with closing(sqlite3.connect(new/'activation-report.sqlite')) as c:
    self.assertEqual(c.execute('PRAGMA quick_check').fetchone()[0],'ok')
    self.assertEqual(c.execute("SELECT SUM(count) FROM dimension_monthly WHERE is_tr=1 AND provider='digi'").fetchone()[0],1)

 def test_focus_evidence_published_and_recoverable_without_mutating_sources(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder); data=root/'data'; source=root/'operator.json.gz'
   with gzip.open(source,'wt') as out:
    json.dump([{'SerieText':'000000000000000001','DATE_OF_ACTIVATION':'2026-10-15',
      'COUNTY_OF_ACTIVATION':'ARGES','DEALER_NAME':'MOBIUP DISTRIBUTION SRL - CONSIGNATIE'}],out)
   batch={'files':[str(source)],'operator':'vodafone','source_kind':'operator','source_at':'2026-10-22',
     'period_start':'2026-10-01','period_end':'2026-10-22','company':'Vodafone'}
   def publish(stage):
    self.assertTrue((stage/'vodafone-focus-evidence.sqlite').is_file())
   result=run_job(data,[batch],before_publish=publish)
   self.assertEqual(result['report']['focusEvidence'],'rebuilt')
   current=(data/'current').resolve()
   def source_hashes():
    return [hashlib.sha256((current/name).read_bytes()).digest() for name in ('activations.sqlite','activation-report.sqlite')]
   hashes=source_hashes()
   (current/'vodafone-focus-evidence.sqlite').unlink()
   self.assertEqual(build_focus_evidence(current),'rebuilt')
   self.assertEqual(build_focus_evidence(current),'current')
   self.assertEqual(build_focus_evidence(current,force=True),'rebuilt')
   self.assertEqual(source_hashes(),hashes)
   self.assertEqual((data/'current').resolve(),current)
   with patch('activation_job.build_focus_evidence',side_effect=OSError('unavailable')):
    fallback=run_job(data,[])
   self.assertEqual(fallback['report']['focusEvidence'],'unavailable: OSError')
   self.assertTrue((data/'current'/'activation-report.sqlite').exists())

 def test_noop_semantic_migration_is_atomic_and_preserves_prior_generation(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);data=root/'data';eligible='SIM with initial credit >= 3 EUR'
   file=fixture(root/'one.xlsx',[row(DataActivare='20261015',HandSetType=eligible)])
   operator=root/'operator.json.gz'
   with gzip.open(operator,'wt') as out:json.dump([{'SerieText':'000000000000000001','DATE_OF_ACTIVATION':'2026-10-15','COUNTY_OF_ACTIVATION':'ARGES','Paid SIM Category':'-'}],out)
   batches=[{'files':[str(file)],'operator':'vodafone','source_at':'2026-10-20'},{'files':[str(operator)],'operator':'vodafone','source_kind':'operator','source_at':'2026-10-22','company':'ExampleCo'}]
   with patch.dict(activations.versions.FIELD_UNKNOWN,{'handset':activations.versions.UNKNOWN}):run_job(data,batches)
   old=(data/'current').resolve()
   with closing(sqlite3.connect(old/'activations.sqlite')) as c:
    self.assertEqual(json.loads(c.execute('SELECT evidence_json FROM activation_facts').fetchone()[0])['observation']['handset'],eligible)
    c.execute("DELETE FROM activation_meta WHERE key='facts_version'");c.commit()
    old_generation=int(c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0])
   files=['activations.sqlite','activation-report.sqlite']
   hashes={name:hashlib.sha256((old/name).read_bytes()).hexdigest() for name in files}
   originals={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (old/'activation-originals').glob('*.xlsx')}
   def crash(stage):
    with closing(sqlite3.connect(stage/'activations.sqlite')) as c:self.assertEqual(json.loads(c.execute('SELECT evidence_json FROM activation_facts').fetchone()[0])['observation']['handset'],'-')
    raise RuntimeError('synthetic migration interruption')
   with self.assertRaisesRegex(RuntimeError,'migration interruption'):run_job(data,[],before_publish=crash)
   self.assertEqual((data/'current').resolve(),old)
   self.assertEqual({name:hashlib.sha256((old/name).read_bytes()).hexdigest() for name in files},hashes)
   migrated=run_job(data,[]);current=(data/'current').resolve()
   self.assertEqual(migrated['imports'],[]);self.assertNotEqual(current,old)
   with closing(sqlite3.connect(current/'activations.sqlite')) as c:
    self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_imports').fetchone()[0],2)
    self.assertEqual(int(c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0]),old_generation+1)
    self.assertEqual(c.execute("SELECT value FROM activation_meta WHERE key='facts_version'").fetchone()[0],activations.versions.FACTS_VERSION)
    self.assertEqual(json.loads(c.execute('SELECT evidence_json FROM activation_facts').fetchone()[0])['observation']['handset'],'-')
   with closing(sqlite3.connect(current/'activation-report.sqlite')) as c:
    self.assertEqual(c.execute('SELECT handset FROM details').fetchone()[0],'-')
    self.assertEqual(c.execute("SELECT value FROM report_meta WHERE key='factsVersion'").fetchone()[0],activations.versions.FACTS_VERSION)
   self.assertEqual({name:hashlib.sha256((old/name).read_bytes()).hexdigest() for name in files},hashes)
   self.assertEqual({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (current/'activation-originals').glob('*.xlsx')},originals)
   run_job(data,[])
   with closing(sqlite3.connect((data/'current').resolve()/'activations.sqlite')) as c:self.assertEqual(int(c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0]),old_generation+1,'current no-op jobs do not rebuild facts again')

 def test_legacy_migration_without_new_import_rebuilds_effective_movements(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);data=root/'data';file=fixture(root/'one.xlsx',[row()])
   c=activations.connect(data)
   activations.import_files(c,data,[file],operator='vodafone');c.close()
   with closing(sqlite3.connect(data/'activations.sqlite')) as c:
    c.execute('DROP TABLE activation_effective_movements')
    c.execute('DROP TABLE activation_observations')
    for name in ['source_kind','source_at','period_start','period_end','company']:
     c.execute('ALTER TABLE activation_imports DROP COLUMN '+name)
    c.execute("UPDATE activation_meta SET value='2' WHERE key='schema_version'")
    c.execute("DELETE FROM activation_meta WHERE key='generation'")
    c.commit()
   result=run_job(data,[])
   self.assertEqual(result['imports'],[])
   with closing(sqlite3.connect((data/'current').resolve()/'activations.sqlite')) as c:
    self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_effective_movements').fetchone()[0],1)
    self.assertEqual(c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0],'1')
   with closing(sqlite3.connect((data/'current').resolve()/'activation-report.sqlite')) as c:
    self.assertEqual(c.execute('SELECT SUM(count) FROM monthly').fetchone()[0],1)
    self.assertEqual(c.execute("SELECT value FROM report_meta WHERE key='version'").fetchone()[0],'4')

 def test_atomic_generation_interruption_and_replay(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);data=root/'data';file=fixture(root/'one.xlsx',[row()]);batch={'files':[str(file)],'operator':'vodafone'}
   first=run_job(data,[batch]);old=(data/'current').resolve()
   file2=fixture(root/'two.xlsx',[row(DocumentDetailId='NEW',IMEI='0000000000000000020',Activat='000000000000000002')])
   def crash(stage):raise RuntimeError('synthetic interruption')
   with self.assertRaisesRegex(RuntimeError,'interruption'):run_job(data,[{'files':[str(file2)],'operator':'vodafone'}],before_publish=crash)
   self.assertEqual((data/'current').resolve(),old)
   c=sqlite3.connect(old/'activations.sqlite');self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_imports').fetchone()[0],1);c.close()
   retry=run_job(data,[batch]);self.assertEqual(retry['imports'][0]['files'][0]['status'],'already_imported');self.assertNotEqual(first['generation'],retry['generation'])

 def test_invalid_rules_never_replace_the_valid_generation(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);file=fixture(root/'one.xlsx',[row()]);batch={'files':[str(file)],'operator':'vodafone'}
   run_job(root/'data',[batch]);before=(root/'data/current').resolve()
   with self.assertRaisesRegex(ValueError,'Invalid distribution rules'):run_job(root/'data',[batch],rules={'version':1})
   self.assertEqual((root/'data/current').resolve(),before)

 def test_simultaneous_same_source_has_one_import(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);file=fixture(root/'one.xlsx',[row()]);manifest=root/'manifest.json';manifest.write_text(json.dumps([{'files':[str(file)],'operator':'vodafone'}]))
   command=[sys.executable,str(Path(__file__).with_name('activation_job.py')),'--data-dir',str(root/'data'),'--manifest',str(manifest)]
   children=[subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
   for child in children:
    out,err=child.communicate(timeout=30);self.assertEqual(child.returncode,0,err)
   c=sqlite3.connect((root/'data/current').resolve()/'activations.sqlite');self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_imports').fetchone()[0],1);self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_movements').fetchone()[0],1);c.close()

if __name__=='__main__':unittest.main()
