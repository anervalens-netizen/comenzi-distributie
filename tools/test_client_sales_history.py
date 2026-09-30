#!/usr/bin/env python3
"""Synthetic contract tests. No application or owner data."""
import json,pathlib,sqlite3,tempfile,unittest,zipfile,xml.sax.saxutils as xml
import client_sales_history as h

def row(**changes):
 v=dict(zip(h.HEADERS,['01.02.2024','Region A','TR A','P1','Example product','2','Brand','10','20','999','Example Partner','42','TR OLD','Type','123','12','Type','999','Category','']))
 v.update(changes);return v
def fixture(path,records,start='2024-01-01',end='2024-12-31'):
 matrix=[['Data Start',start],['Data Stop',end],[],[],h.HEADERS]+[[v.get(k,'') for k in h.HEADERS] for v in records]
 def letters(n):
  out=''
  while n:n,q=divmod(n-1,26);out=chr(65+q)+out
  return out
 body=''
 for i,r in enumerate(matrix,1):
  cells=''.join('<c r="'+letters(j)+str(i)+'" t="inlineStr"><is><t>'+xml.escape(str(v))+'</t></is></c>' for j,v in enumerate(r,1))
  body+='<row r="'+str(i)+'">'+cells+'</row>'
 with zipfile.ZipFile(path,'w') as z:
  z.writestr('xl/workbook.xml','<workbook xmlns="'+h.NS['s']+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>')
  z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
  z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="'+h.NS['s']+'"><sheetData>'+body+'</sheetData></worksheet>')
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.p=pathlib.Path(self.tmp.name)
  self.partner={'id':'p1','active':1,'cui':'RO123','county':'Example County','city':'Example City','address':'Example Road 1'}
  self.master={'Cod_Franciza':'F001','CIF':'123','PartnerCode':'123','Judet':'Example County','Oras':'Example City','Street':'Example Road 1'}
  self.pp=self.p/'partners.json';self.mp=self.p/'locations.json';self.pp.write_text(h.dump({'partners':[self.partner]}));self.mp.write_text(h.dump([self.master]))
  self.c=h.connect(self.p/'client-sales-history.sqlite')
 def tearDown(self):self.c.close();self.tmp.cleanup()
 def resolve(self,code='123',franchise='',partners=None,master=None):
  return h.Resolver(partners if partners is not None else [self.partner],master if master is not None else [self.master]).resolve(code,franchise)
 def put(self,name,records,**options):
  f=self.p/name;fixture(f,records);return h.import_file(self.c,f,self.pp,self.mp,**options)
 def test_direct_code(self):
  a=self.resolve(franchise='F001');self.assertEqual((a['status'],a['point_key'],a['partner_ids']),('direct_code','franchise:F001',['p1']))
 def test_absent_code_unique_partner(self):
  a=self.resolve();self.assertEqual(a['status'],'single_partner');self.assertEqual(a['point_key'],'franchise:F001')
 def test_partial_master(self):
  self.assertEqual(self.resolve(master=[])['status'],'single_partner')
  a=self.resolve(franchise='F999');self.assertEqual((a['status'],a['point_key'],a['partner_ids']),('direct_code','franchise:F999',[]))
 def test_ambiguous_partner(self):
  b={**self.partner,'id':'p2','address':'Example Road 2'}
  self.assertEqual(self.resolve(partners=[self.partner,b])['status'],'reconcile')
 def test_master_alternative_blocks_guess(self):
  b={**self.master,'Street':'Other Road 4','Cod_Franciza':'F002'}
  self.assertEqual(self.resolve(master=[self.master,b])['status'],'reconcile')
 def test_incomplete_address(self):
  self.assertEqual(self.resolve(partners=[{**self.partner,'address':''}])['status'],'reconcile')
 def test_shared_portfolio_is_one_point(self):
  p={**self.partner,'warehouseIds':['a','b']}
  self.assertEqual(self.resolve(partners=[p])['status'],'single_partner')
 def test_conflicting_franchise(self):
  b={**self.master,'CIF':'456'}
  self.assertEqual(self.resolve(franchise='F001',master=[self.master,b])['status'],'reconcile')
  self.assertEqual(self.resolve(code='456',franchise='F001')['status'],'reconcile')
 def test_consumer_and_absent(self):
  self.assertEqual(self.resolve(code='clientgen')['status'],'consumer')
  self.assertEqual(self.resolve(code='')['status'],'reconcile')
 def test_alias_to_cif(self):
  b={**self.master,'PartnerCode':'CRM123'}
  self.assertEqual(self.resolve(code='CRM123',master=[b])['status'],'single_partner')
 def test_address_punctuation_not_collapsed(self):
  b={**self.master,'Street':'Example Road 1-3'}
  self.assertEqual(self.resolve(partners=[{**self.partner,'address':'Example Road 13'}],master=[b])['status'],'reconcile')
 def test_identical_lines_preserved_idempotent(self):
  a=self.put('first.xlsx',[row(),row()]);self.assertEqual(a['rows'],2)
  b=h.import_file(self.c,self.p/'first.xlsx',self.pp,self.mp);self.assertEqual(b['status'],'already_imported')
  self.assertEqual(self.c.execute('SELECT count(*),sum(value_cents) FROM history_current').fetchone()[:],(2,4000))
 def test_overlapping_snapshot_no_append(self):
  self.put('first.xlsx',[row()])
  with self.assertRaisesRegex(ValueError,'Overlapping'):self.put('second.xlsx',[row(),row()])
  self.assertEqual(self.c.execute('SELECT count(*) FROM history_current').fetchone()[0],1)
 def test_replacement_retains_old_and_multiplicity(self):
  self.put('first.xlsx',[row(),row()])
  with self.assertRaisesRegex(ValueError,'occurrences'):self.put('second.xlsx',[row()],replace=True)
  self.assertEqual(self.c.execute('SELECT count(*) FROM history_current').fetchone()[0],2)
  self.put('second.xlsx',[row()],replace=True,allow_regression=True)
  self.assertEqual(self.c.execute('SELECT count(*) FROM history_current').fetchone()[0],1)
  self.assertEqual(self.c.execute('SELECT count(*) FROM history_rows').fetchone()[0],3)
 def test_returns_and_original_seller(self):
  self.put('first.xlsx',[row(),row(Cantitate='-1',Valoare='-10')])
  a=self.c.execute('SELECT sum(value_cents),sum(quantity_micros),tr,tr_old FROM history_current').fetchone()
  self.assertEqual(tuple(a),(1000,1000000,'TR A','TR OLD'))
 def test_missing_value_not_invented(self):
  self.put('first.xlsx',[row(Pret='',Valoare='')])
  r=self.c.execute('SELECT price_cents,value_cents,quality_issue,quantity_micros FROM history_current').fetchone()
  self.assertEqual(tuple(r),(None,None,'Pret_missing,Valoare_missing',2000000))
 def test_atomic_failure(self):
  with self.assertRaises(ValueError):self.put('first.xlsx',[row(),row(Valoare='invalid')])
  self.assertEqual(self.c.execute('SELECT count(*) FROM history_rows').fetchone()[0],0)
  self.assertTrue(list((self.p/'client-sales-originals').glob('*.xlsx')))
 def test_tr_database_refused_unchanged(self):
  fake=self.p/'isolated';fake.mkdir();path=fake/'client-sales-history.sqlite'
  d=sqlite3.connect(path);d.execute('CREATE TABLE sales_rows(value INTEGER)');d.commit();d.close();before=path.read_bytes()
  with self.assertRaisesRegex(ValueError,'unrelated'):h.connect(path)
  self.assertEqual(path.read_bytes(),before)
  with self.assertRaises(ValueError):h.connect(self.p/'sales.sqlite')
  self.assertFalse((self.p/'sales.sqlite').exists())
 def test_reconciliation_does_not_change_facts(self):
  self.put('first.xlsx',[row()]);before=self.c.execute('SELECT raw_json FROM history_rows').fetchone()[0]
  self.pp.write_text(h.dump({'partners':[self.partner,{**self.partner,'id':'p2','address':'Other Road'}]}))
  with self.c:h.store_reference(self.c,self.pp,self.mp)
  self.assertEqual(self.c.execute('SELECT allocation_status FROM history_current').fetchone()[0],'reconcile')
  self.assertEqual(self.c.execute('SELECT raw_json FROM history_rows').fetchone()[0],before)
  self.assertEqual(self.c.execute('SELECT count(*) FROM history_allocations').fetchone()[0],2)
 def test_inactive_history_is_considered(self):
  old={**self.partner,'active':0}
  self.assertEqual(self.resolve(partners=[old])['status'],'single_partner')
  other={**old,'id':'p2','address':'Older Road 9'}
  self.assertEqual(self.resolve(partners=[self.partner,other])['status'],'reconcile')
 def test_date_and_decimal(self):
  self.assertEqual(h.iso('45292'),'2024-01-01');self.assertEqual(h.scaled('-1.20',100),-120)
  with self.assertRaises(ValueError):h.iso('31.02.2024')
  with self.assertRaises(ValueError):h.scaled('1.235',100)
if __name__=='__main__':unittest.main()
