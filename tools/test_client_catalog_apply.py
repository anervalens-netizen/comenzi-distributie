import json,pathlib,sqlite3,tempfile,unittest
from client_catalog_plan import build_plan
from client_catalog_apply import apply_plan,read_customers,read_agents
class ApplyTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.path=self.root/'mobiup.sqlite'
  self.c=sqlite3.connect(self.path);self.c.row_factory=sqlite3.Row
  self.c.executescript("""
   CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER);
   CREATE TABLE users(id TEXT,name TEXT,warehouse_id TEXT,warehouse_name TEXT,site_code TEXT,active INTEGER,role TEXT);
   INSERT INTO users VALUES('agent','Example','w','Example territory','EX',1,'agent');
   CREATE TABLE partner_profiles(customer_id TEXT PRIMARY KEY REFERENCES customers(id),latitude REAL,longitude REAL,contact TEXT,revision INTEGER);
   CREATE TABLE partner_visits(id TEXT,customer_id TEXT REFERENCES customers(id),notes TEXT);
   CREATE TABLE orders(id TEXT,payload TEXT); INSERT INTO orders VALUES('order','preserved');
   CREATE TRIGGER address_change AFTER UPDATE OF data ON customers
   WHEN json_extract(OLD.data,'$.address') IS NOT json_extract(NEW.data,'$.address')
   OR json_extract(OLD.data,'$.city') IS NOT json_extract(NEW.data,'$.city')
   OR json_extract(OLD.data,'$.county') IS NOT json_extract(NEW.data,'$.county')
   BEGIN UPDATE partner_profiles SET latitude=NULL,longitude=NULL,revision=revision+1 WHERE customer_id=NEW.id; END;
  """)
  self.partner={'id':'old','cui':'123','name':'Original name','address':'Original Street 1','city':'City','county':'Iasi','route':'Original route','warehouseId':'old','warehouseIds':['old']}
  self.c.execute('INSERT INTO customers VALUES(?,?,?,?)',('old','old',json.dumps(self.partner),1))
  self.c.execute('INSERT INTO customers VALUES(?,?,?,?)',('inactive','old',json.dumps({**self.partner,'id':'inactive'}),0))
  self.c.execute("INSERT INTO partner_profiles VALUES('old',47.1,27.5,'Original contact',7)")
  self.c.execute("INSERT INTO partner_visits VALUES('visit','old','Original visit')");self.c.commit()
  self.snapshot={'customers':read_customers(self.c),'agents':read_agents(self.c)}
  identities=[{'id':i,'client_code':client,'franchise_code':code,'name':'History name','row_count':3,'first_date':'2023-01-01','last_date':'2026-09-30'} for i,client,code in [(1,'123','F1'),(2,'456','F2')]]
  master=[{'CIF':client,'Cod_Franciza':code,'Judet':'Iasi','Oras':'City','Street':address} for client,code,address in [('123','F1','Original Street 1'),('456','F2','New Street 2')]]
  roster={'reviewed':True,'agents':[{'agentId':'agent','warehouseId':'w','counties':['IS']}]}
  self.plan=build_plan(self.snapshot,identities,master,roster)
 def tearDown(self):self.c.close();self.temp.cleanup()
 def test_additive_preserves_pins_visits_contacts_inactive_and_fields(self):
  before_profiles=[tuple(r) for r in self.c.execute('SELECT * FROM partner_profiles')]
  result=apply_plan(self.path,self.plan,self.snapshot,self.root/'receipt')
  self.assertEqual(result['added'],1);self.assertTrue(result['protectedTablesUnchanged'])
  self.assertEqual([tuple(r) for r in self.c.execute('SELECT * FROM partner_profiles')],before_profiles)
  self.assertEqual(self.c.execute('SELECT notes FROM partner_visits').fetchone()[0],'Original visit')
  self.assertEqual(self.c.execute("SELECT active FROM customers WHERE id='inactive'").fetchone()[0],0)
  row=json.loads(self.c.execute("SELECT data FROM customers WHERE id='old'").fetchone()[0])
  self.assertEqual(row['historyFranchises'],['F1']);self.assertEqual(row['warehouseIds'],['w'])
  for key in ('name','address','city','county','route'):self.assertEqual(row[key],self.partner[key])
  with sqlite3.connect(self.root/'receipt'/'mobiup-before.sqlite') as backup:self.assertEqual(backup.execute('SELECT count(*) FROM customers').fetchone()[0],2)
  self.assertEqual(apply_plan(self.path,self.plan,self.snapshot,self.root/'retry')['state'],'already_applied')
  self.assertEqual(self.c.execute('SELECT count(*) FROM customers').fetchone()[0],3)
 def test_stale_catalog_rejected(self):
  self.c.execute("UPDATE customers SET data=json_set(data,'$.route','Concurrent edit') WHERE id='old'");self.c.commit()
  with self.assertRaisesRegex(ValueError,'Catalog changed'):apply_plan(self.path,self.plan,self.snapshot,self.root/'receipt')
  self.assertFalse((self.root/'receipt').exists())
 def test_address_mutation_rejected(self):
  self.plan['membershipUpdates'][0]['after']['data']=json.dumps({**self.partner,'address':'Wrong Street'})
  with self.assertRaisesRegex(ValueError,'protected'):apply_plan(self.path,self.plan,self.snapshot,self.root/'receipt')
 def test_unexpected_profile_trigger_rolls_back(self):
  self.c.execute("CREATE TRIGGER unsafe_customer_trigger AFTER UPDATE ON customers BEGIN UPDATE partner_profiles SET revision=revision+1; END");self.c.commit()
  with self.assertRaisesRegex(ValueError,'Protected tables changed'):apply_plan(self.path,self.plan,self.snapshot,self.root/'receipt')
  self.assertEqual(self.c.execute('SELECT revision FROM partner_profiles').fetchone()[0],7)
  self.assertEqual(self.c.execute('SELECT count(*) FROM customers').fetchone()[0],2)
 def test_tr_sales_path_refused(self):
  with self.assertRaises(ValueError):apply_plan(self.root/'sales.sqlite',self.plan,self.snapshot,self.root/'receipt')
  self.assertFalse((self.root/'sales.sqlite').exists())
if __name__=='__main__':unittest.main()
