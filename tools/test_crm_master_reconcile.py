import json,pathlib,sqlite3,tempfile,unittest
from crm_master_reconcile import build_plan,apply_plan,snapshot,FIELDS,dump
class CRMTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.db=self.root/'mobiup.sqlite'
  self.c=sqlite3.connect(self.db);self.c.row_factory=sqlite3.Row
  self.c.executescript("""
   CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER);
   CREATE TABLE users(id TEXT,name TEXT,warehouse_id TEXT,warehouse_name TEXT,site_code TEXT,active INTEGER,role TEXT);
   INSERT INTO users VALUES('agent','Example','w','Example','EX',1,'agent');
   CREATE TABLE partner_profiles(customer_id TEXT PRIMARY KEY REFERENCES customers(id),latitude REAL,longitude REAL,contact TEXT,revision INTEGER);
   CREATE TABLE orders(id TEXT PRIMARY KEY,payload TEXT);
   INSERT INTO orders VALUES('order','unchanged');
   CREATE TRIGGER changed_address AFTER UPDATE OF data ON customers WHEN json_extract(OLD.data,'$.address') IS NOT json_extract(NEW.data,'$.address') OR json_extract(OLD.data,'$.city') IS NOT json_extract(NEW.data,'$.city') OR json_extract(OLD.data,'$.county') IS NOT json_extract(NEW.data,'$.county') BEGIN UPDATE partner_profiles SET latitude=NULL,longitude=NULL,revision=revision+1 WHERE customer_id=NEW.id; END;
  """)
  self.roster={'reviewed':True,'agents':[{'agentId':'agent','warehouseId':'w','counties':['IS']}]}
 def tearDown(self):self.c.close();self.tmp.cleanup()
 def customer(self,id='old',cui='123',code='',address='',active=1,profile=False):
  p={'id':id,'name':'Old','cui':cui,'address':address,'city':'Iasi' if address else '', 'county':'Iasi','route':'kept','warehouseId':'old-w','warehouseIds':['old-w']}
  if code:p['historyFranchises']=[code]
  self.c.execute('INSERT INTO customers VALUES(?,?,?,?)',(id,'old-w',dump(p),active))
  if profile:self.c.execute('INSERT INTO partner_profiles VALUES(?,?,?,?,?)',(id,47.0,27.0,'kept contact',7))
  self.c.commit()
 def row(self,code='TR001',address='Example Street 1',aid='21',pid='11',cif='RO123',client='123'):
  r={k:'' for k in FIELDS};r.update(Cod_Franciza=code,PartnerAddressId=aid,PartnerId=pid,CIF=cif,PartnerCode=client,PartnerName='Example Company',SyntheticName='Example shop',Street=address,Oras='Iasi',Judet='Iasi',ManagerZona='obsolete',ASMM='obsolete',TradeReprezentative='historical creator')
  return {'row':2,'raw':dict(r),'value':r}
 def plan(self,rows):return build_plan(snapshot(self.c),rows,self.roster,'a'*64,'source.xlsx')
 def test_address_completion_and_replay(self):
  self.customer(code='TR001');p=self.plan([self.row()])
  self.assertEqual(p['summary']['existingStreetCompleted'],1);self.assertEqual(p['summary']['newRecords'],0)
  out=apply_plan(self.db,p,self.root/'receipt');self.assertTrue(out['protectedTablesUnchanged'])
  self.assertEqual(apply_plan(self.db,p,self.root/'receipt')['state'],'already_applied')
  self.assertEqual(self.c.execute('select count(*) from crm_locations').fetchone()[0],1)
  raw=json.loads(self.c.execute('select source_json from crm_locations').fetchone()[0])
  self.assertNotIn('ManagerZona',raw);self.assertEqual(raw['TradeReprezentative'],'historical creator')
 def test_preserve_position_and_actual_address(self):
  self.customer(code='TR001',address='Verified Street 9',profile=True);p=self.plan([self.row()])
  apply_plan(self.db,p,self.root/'receipt')
  v=json.loads(self.c.execute('select data from customers').fetchone()[0])
  self.assertEqual(v['address'],'Verified Street 9')
  self.assertEqual(tuple(self.c.execute('select latitude,longitude,contact,revision from partner_profiles').fetchone()),(47.,27.,'kept contact',7))
  self.assertEqual(self.c.execute('select street from crm_locations').fetchone()[0],'Example Street 1')
 def test_no_code_single_point_can_complete(self):
  self.customer();p=self.plan([self.row()])
  self.assertEqual(p['summary']['newRecords'],0)
  self.assertEqual(p['links'][0]['method'],'single_crm_location')
 def test_no_code_multiple_points_not_arbitrarily_assigned(self):
  self.customer();p=self.plan([self.row(),self.row(code='TR002',aid='22',address='Other Street 2')])
  self.assertEqual(p['summary']['newRecords'],2)
  old=next(x['after'] for x in p['changes'] if x['before']['id']=='old')
  self.assertEqual(json.loads(old['data'])['address'],'')
  self.assertTrue(any(x['customerId']=='old' and x['reason']=='multiple_crm_locations' for x in p['missingAddresses']))
 def test_identity_conflict_cannot_borrow_address(self):
  self.customer(cui='999',code='TR001');p=self.plan([self.row()])
  self.assertEqual(p['summary']['newRecords'],1)
  self.assertEqual(p['issues'][0]['kind'],'stored_franchise_owner_conflict')
  self.assertFalse(any(x['before']['id']=='old' for x in p['changes']))
 def test_stale_profile_rejected(self):
  self.customer(code='TR001',address='Verified Street 9',profile=True);p=self.plan([self.row()])
  self.c.execute('update partner_profiles set revision=revision+1');self.c.commit()
  with self.assertRaisesRegex(ValueError,'Concurrent'):apply_plan(self.db,p,self.root/'receipt')
  self.assertIsNone(self.c.execute("select name from sqlite_master where name='crm_locations'").fetchone())
 def test_missing_cif_uses_code_but_preserves_raw(self):
  self.customer(code='TR001');p=self.plan([self.row(cif='')]);apply_plan(self.db,p,self.root/'receipt')
  self.assertEqual(self.c.execute('select cif from crm_companies').fetchone()[0],'')
  self.assertEqual(json.loads(self.c.execute('select data from customers').fetchone()[0])['cui'],'123')
 def test_inactive_record_retained(self):
  self.customer(code='TR001',active=0);p=self.plan([self.row()]);apply_plan(self.db,p,self.root/'receipt')
  self.assertEqual(self.c.execute('select active from customers where id="old"').fetchone()[0],0)
 def test_equivalent_cif_formats_allowed(self):
  p=self.plan([self.row(),self.row(code='TR002',aid='22',cif='123')])
  self.assertEqual(p['summary']['crmCompanies'],1)
 def test_existing_complete_nonfranchise_exact_address(self):
  self.customer(address='Example Street 1')
  p=self.plan([self.row()]);self.assertEqual(p['summary']['newRecords'],0)
  self.assertEqual(p['links'][0]['method'],'company_exact_address')
 def test_legacy_address_recovery_without_crm(self):
  self.customer(id='historical',cui='999')
  self.customer(id='known',cui='999',address='Known Street 8',active=0)
  p=self.plan([self.row()]);old=next(x['after'] for x in p['changes'] if x['before']['id']=='historical')
  value=json.loads(old['data']);self.assertEqual(value['address'],'Known Street 8');self.assertNotIn('historyFranchises',value)
 def test_unrelated_trigger_mutation_rolls_back(self):
  self.customer(code='TR001');p=self.plan([self.row()])
  self.c.execute("CREATE TRIGGER unexpected AFTER UPDATE ON customers BEGIN UPDATE orders SET payload='bad'; END;");self.c.commit()
  with self.assertRaisesRegex(ValueError,'Protected'):apply_plan(self.db,p,self.root/'receipt')
  self.assertEqual(self.c.execute('select payload from orders').fetchone()[0],'unchanged')
  self.assertIsNone(self.c.execute("select name from sqlite_master where name='crm_locations'").fetchone())
if __name__=='__main__':unittest.main()
