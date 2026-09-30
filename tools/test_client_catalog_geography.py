import unittest
from client_catalog_geography import infer,enrich
class GeoTests(unittest.TestCase):
 def test_explicit(self):self.assertEqual(infer(['TR Iasi 01 Example'],{})['county'],'IS')
 def test_override_multiple(self):
  result=infer(['TR Iasi 01 Example'],{'TR IASI 01 EXAMPLE':['IS','VS']})
  self.assertIsNone(result['county']);self.assertEqual(result['status'],'multi_county')
 def test_intersection(self):
  result=infer(['First','Second'],{'FIRST':['IS','VS'],'SECOND':['VS']})
  self.assertEqual(result['county'],'VS')
 def test_conflict(self):
  self.assertEqual(infer(['First','Second'],{'FIRST':['IS'],'SECOND':['VS']})['status'],'seller_conflict')
 def test_unknown_prevents_false_certainty(self):
  self.assertEqual(infer(['First','Unknown'],{'FIRST':['IS']})['status'],'seller_unknown')
 def test_metro(self):
  self.assertEqual(infer(['TR Bucuresti 01 Example'],{})['candidateCounties'],['B','IF'])
 def test_no_substrings(self):self.assertEqual(infer(['Aradace Example'],{})['status'],'seller_unknown')
 def test_keep_known_address(self):
  plan={'additions':[{'id':'p','county':'Vaslui','historyCatalog':{}}],'identityLinks':[{'identityId':1,'partnerIds':['p']}]}
  result=enrich(plan,[(1,'TR Iasi 01 Example')],{})
  self.assertEqual(result['additions'][0]['county'],'Vaslui')
 def test_customer_distribution_provenance(self):
  result=infer(['Example'],{'EXAMPLE':['MS']},{'EXAMPLE':'customer_distribution_inferred'})
  self.assertEqual(result['county'],'MS')
  self.assertEqual(result['evidence'][0]['method'],'customer_distribution_inferred')
if __name__=='__main__':unittest.main()
