#!/usr/bin/env python3
import unittest,json
from client_catalog_plan import build_plan,county_key,roster_map
class CatalogTests(unittest.TestCase):
 def agent(self,id='a',wh='w'):return dict(id=id,warehouse_id=wh,warehouse_name='TR Example',name='Example Agent',site_code='EX',active=1)
 def snapshot(self,customers=()):return {'customers':list(customers),'agents':[self.agent()]}
 def identity(self,id=1,client='123',franchise='F1'):return dict(id=id,client_code=client,franchise_code=franchise,name='Example Company',row_count=10,first_date='2023-01-01',last_date='2026-09-01')
 def customer(self,id='old',county='Iasi',active=1):
  p=dict(id=id,cui='RO123',city='Example City',county=county,address='Example Street 1',warehouseIds=['old-agent'],warehouseId='old-agent',name='Original name',route='Original route')
  return dict(id=id,warehouse_id='old-agent',active=active,data=json.dumps(p))
 def test_counties(self):
  self.assertEqual(county_key('Municipiul București'),'B');self.assertEqual(county_key('SB'),'SB');self.assertEqual(county_key('Iași'),'IS');self.assertIsNone(county_key('Unknown'))
 def test_complete_roster_required(self):
  with self.assertRaises(ValueError):roster_map({'reviewed':True,'agents':[]},[self.agent()])
 def test_shared_bucharest_ilfov(self):
  agents=[self.agent('a','one'),self.agent('b','two')]
  roster={'reviewed':True,'agents':[{'agentId':'a','warehouseId':'one','counties':['B']},{'agentId':'b','warehouseId':'two','counties':['IF']}]}
  mapping,_=roster_map(roster,agents);self.assertEqual(mapping['B'],['one','two']);self.assertEqual(mapping['B'],mapping['IF'])
 def test_unique_existing_address_and_preservation(self):
  snapshot=self.snapshot([self.customer()]);before=json.dumps(snapshot)
  p=build_plan(snapshot,[self.identity(franchise='')],[]);self.assertEqual(p['summary']['additions'],0)
  self.assertEqual(p['identityLinks'][0]['partnerIds'],['old']);self.assertEqual(json.dumps(snapshot),before)
  self.assertFalse(p['rosterReviewed']);self.assertEqual(p['membershipUpdates'],[])
 def test_unknown_code_does_not_merge_into_partial_old_catalog(self):
  p=build_plan(self.snapshot([self.customer()]),[self.identity()],[])
  self.assertEqual(p['summary']['newWorkPoints'],1);self.assertNotEqual(p['identityLinks'][0]['partnerIds'],['old'])
 def test_distinct_codes_not_merged(self):
  p=build_plan(self.snapshot(),[self.identity(),self.identity(2,franchise='F2')],[])
  self.assertEqual(p['summary']['newWorkPoints'],2);self.assertNotEqual(p['identityLinks'][0]['partnerIds'],p['identityLinks'][1]['partnerIds'])
 def test_company_only_retained(self):
  p=build_plan(self.snapshot(),[self.identity(franchise='')],[])
  self.assertEqual(p['summary']['newCompanyOnly'],1);self.assertEqual(p['identityLinks'][0]['status'],'reconcile')
 def test_generic_consumer_not_company(self):
  p=build_plan(self.snapshot(),[self.identity(client='CLIENTGEN',franchise='')],[])
  self.assertEqual(p['summary']['additions'],0);self.assertEqual(p['identityLinks'][0]['status'],'consumer')
 def test_membership_only_no_address_changes(self):
  snapshot=self.snapshot([self.customer()])
  roster={'reviewed':True,'agents':[{'agentId':'a','warehouseId':'w','counties':['IS']}]}
  p=build_plan(snapshot,[self.identity()],[],roster)
  after=json.loads(p['membershipUpdates'][0]['after']['data'])
  self.assertEqual(after['warehouseIds'],['w']);self.assertEqual(after['address'],'Example Street 1');self.assertEqual(after['name'],'Original name')
 def test_inactive_not_reactivated(self):
  p=build_plan(self.snapshot([self.customer(active=0)]),[self.identity(franchise='')],[])
  self.assertEqual(p['summary']['linksToInactiveOnly'],1);self.assertEqual(p['membershipUpdates'],[])
if __name__=='__main__':unittest.main()
