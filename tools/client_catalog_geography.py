#!/usr/bin/env python3
"""Infer missing partner counties from explicit historical seller territory evidence.
Never rewrite known partner geography or historical seller facts. Unknown and
multi-county results retain candidate counties and provenance for reconciliation.
"""
from __future__ import annotations
import argparse,collections,json,pathlib,re,sqlite3
from client_sales_history import norm,dump
from client_catalog_plan import COUNTIES,county_key
def seller_counties(seller,territories):
 key=norm(seller)
 explicit=territories.get(key)
 if explicit is not None:return set(explicit),'seller_reference'
 # County embedded in original source label; use full tokens, never substrings.
 found={code for code,name in COUNTIES.items() if re.search(r'(?<!\w)'+re.escape(norm(name))+r'(?!\w)',key)}
 if 'TIMISOARA' in key:found.add('TM')
 if 'B' in found:found.add('IF') # Shared metro territory does not identify exact address.
 return found,'source_seller_label' if found else 'unknown_seller'
def infer(sellers,territories):
 evidence=[];sets=[];unknown=[]
 for seller in sorted(set(sellers)):
  counties,method=seller_counties(seller,territories)
  evidence.append({'seller':seller,'candidateCounties':sorted(counties),'method':method})
  if counties:sets.append(counties)
  else:unknown.append(seller)
 if not sets:return {'county':None,'candidateCounties':[],'status':'seller_unknown','evidence':evidence}
 union=set.union(*sets);common=set.intersection(*sets)
 # One shared candidate is evidence, not a verified street address.
 candidate=next(iter(common)) if len(common)==1 else None
 status='seller_inferred' if candidate and not unknown else 'seller_unknown' if unknown else 'seller_conflict' if not common else 'multi_county'
 return {'county':candidate if status=='seller_inferred' else None,
         'candidateCounties':sorted(common if common else union),'status':status,'evidence':evidence}
def enrich(plan,seller_rows,territories):
 territories={norm(k):{county_key(c) for c in v} for k,v in territories.items()}
 if any(None in v for v in territories.values()):raise ValueError('Unknown county in territory reference')
 by_identity=collections.defaultdict(set)
 for identity,seller in seller_rows:by_identity[identity].add(seller)
 by_partner=collections.defaultdict(set)
 for link in plan['identityLinks']:
  for pid in link['partnerIds']:by_partner[pid].update(by_identity[link['identityId']])
 counts=collections.Counter();remaining_sellers=collections.Counter()
 for p in plan['additions']:
  if p.get('county'):
   counts['existing_county']+=1;continue
  result=infer(by_partner[p['id']],territories)
  p['historyCatalog']['geography']=result
  if result['county']:
   p['county']=COUNTIES[result['county']]
   p['historyCatalog']['countySource']='historical_seller_inferred'
  else:
   remaining_sellers.update(e['seller'] for e in result['evidence'] if e['method']=='unknown_seller')
  counts[result['status']]+=1
 plan['geographySummary']={'counts':dict(counts),'unknownSellers':dict(remaining_sellers.most_common()),
                           'note':'Inferred county is a commercial allocation, not a verified address or map pin.'}
 return plan
def main():
 p=argparse.ArgumentParser(description=__doc__)
 for flag in ['plan','history-db','territories','out']:p.add_argument('--'+flag,required=True)
 a=p.parse_args()
 c=sqlite3.connect(pathlib.Path(a.history_db).resolve().as_uri()+'?mode=ro',uri=True)
 seller_rows=c.execute("SELECT DISTINCT r.identity_id,r.tr FROM history_rows r JOIN history_imports b ON b.id=r.import_id WHERE b.state='active'").fetchall()
 plan=enrich(json.loads(pathlib.Path(a.plan).read_text()),seller_rows,json.loads(pathlib.Path(a.territories).read_text())['historicalSellers'])
 out=pathlib.Path(a.out);out.write_text(dump(plan));out.chmod(0o600)
 print(dump(plan['geographySummary']))
if __name__=='__main__':main()
