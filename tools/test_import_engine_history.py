import hashlib,json,os,shutil,sqlite3,unittest,uuid
from unittest.mock import patch
import test_client_history_upload as fixtures
from test_client_sales_history import row
import import_engine_history as executor

class HistoryExecutorTests(unittest.TestCase):
 setUp=fixtures.UploadTests.setUp
 tearDown=fixtures.UploadTests.tearDown
 upload=fixtures.UploadTests.upload
 def test_preview_commit_and_reconcile_without_replay(self):
  data=self.upload([row(Data='01.02.2024'),row(Data='02.02.2024')],True)
  job_id=str(uuid.uuid4());folder=self.directory/'import-engine-spool'/job_id;folder.mkdir(parents=True)
  source=folder/'source.xlsx';shutil.copyfile(data[3]['source'],source)
  digest=hashlib.sha256(source.read_bytes()).hexdigest()
  with sqlite3.connect(self.directory/'mobiup.sqlite') as auth:
   auth.executescript('CREATE TABLE users(id TEXT,role TEXT,active INTEGER,must_change_password INTEGER,profile_revision INTEGER,manager_scope TEXT);CREATE TABLE sessions(user_id TEXT,token_hash TEXT,expires_at INTEGER);')
   auth.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',('synthetic','manager',1,0,1,'global'))
   auth.execute('INSERT INTO sessions VALUES(?,?,?)',('synthetic','synthetic-hash',9999999999999))
  authorization={'userId':'synthetic','profileVersion':1,'managerScope':'global','tokenHash':'synthetic-hash'}
  job={'id':job_id,'kind':'sales_location','source':{'filename':'synthetic.xlsx','sha256':digest,'size':source.stat().st_size,'date_start':'2024-02-01','date_end':'2024-02-29'},'payload':{'commit_authorization':authorization}}
  action_id=str(uuid.uuid4())
  with patch.dict(os.environ,{'MOBIUP_DATA_DIR':str(self.directory)}):
   preview=executor.run({'mode':'execute','action':'preview','action_id':str(uuid.uuid4()),'job':job})
   self.assertEqual(preview['state'],'ready');job['preview']=preview['preview'];job['options']={'allowRegression':True}
   result=executor.run({'mode':'execute','action':'commit','action_id':action_id,'job':job})
   self.assertEqual(result['state'],'committed_refresh_pending');self.assertTrue(result['receipt']['verified'])
   count=self.c.execute('SELECT COUNT(*) FROM history_imports').fetchone()[0]
   recovered=executor.run({'mode':'reconcile','action':'commit','action_id':action_id,'job':job})
   self.assertEqual(recovered['receipt'],result['receipt']);self.assertEqual(self.c.execute('SELECT COUNT(*) FROM history_imports').fetchone()[0],count)

if __name__=="__main__":unittest.main()
