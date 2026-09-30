#!/usr/bin/env python3
"""Plan additive partner catalog completion independently of historic sellers.
Read-only source inputs; writes a reviewable private JSON plan, never live data.
County/agent assignments must come from a complete, explicit current roster.
"""
from __future__ import annotations
import argparse, collections, json, pathlib, re, sqlite3
from client_sales_history import cui_key, code_key, norm, place, master_place, dump, sha, now

COUNTIES = {
'AB':'Alba','AR':'Arad','AG':'Arges','BC':'Bacau','BH':'Bihor','BN':'Bistrita-Nasaud',
'BT':'Botosani','BV':'Brasov','BR':'Braila','B':'Bucuresti','BZ':'Buzau','CS':'Caras-Severin',
'CL':'Calarasi','CJ':'Cluj','CT':'Constanta','CV':'Covasna','DB':'Dambovita','DJ':'Dolj',
'GL':'Galati','GR':'Giurgiu','GJ':'Gorj','HR':'Harghita','HD':'Hunedoara','IL':'Ialomita',
'IS':'Iasi','IF':'Ilfov','MM':'Maramures','MH':'Mehedinti','MS':'Mures','NT':'Neamt',
'OT':'Olt','PH':'Prahova','SM':'Satu Mare','SJ':'Salaj','SB':'Sibiu','SV':'Suceava',
'TR':'Teleorman','TM':'Timis','TL':'Tulcea','VS':'Vaslui','VL':'Valcea','VN':'Vrancea'}
def county_key(value):
 value=norm(value).replace('MUNICIPIUL ','').replace('JUDETUL ','').replace('JUD. ','').replace('JUD ','')
 if value in COUNTIES:return value
 compact=lambda s:''.join(c for c in norm(s) if c.isalnum())
 for key,name in COUNTIES.items():
  if compact(value)==compact(name):return key
 return None

def roster_map(roster,agents):
 """A reviewed roster must explicitly account for every active agent (even [] counties).
 Empty county lists exclude a named agent from geographic allocation deliberately.
 """
 if roster is None:return {},False
 active={a['id']:a for a in agents if a['active']}
 entries=roster.get('agents',[])
 if not roster.get('reviewed') or len({r['agentId'] for r in entries})!=len(entries):
  raise ValueError('A reviewed, nonduplicate current roster is required')
 if {r['agentId'] for r in entries}!=set(active):
  raise ValueError('Roster must account for every currently active agent exactly once')
 out=collections.defaultdict(set)
 for r in entries:
  a=active[r['agentId']]
  if not a['warehouse_id']:raise ValueError('Agent has no warehouse')
  if r.get('warehouseId')!=a['warehouse_id']:raise ValueError('Roster warehouse changed')
  for raw in r['counties']:
   key=county_key(raw)
   if not key:raise ValueError('Unknown county: '+str(raw))
   out[key].add(a['warehouse_id'])
 # Bucharest and Ilfov are one shared portfolio, including agents assigned to either.
 combined=out['B']|out['IF']
 out['B']=combined;out['IF']=combined
 return {k:sorted(v) for k,v in out.items() if v},True

def source_identities(connection):
 connection.row_factory=sqlite3.Row
 result=[]
 for row in connection.execute("""
 SELECT i.id,i.client_code,i.franchise_code,COUNT(*) row_count,MIN(r.date) first_date,MAX(r.date) last_date
 FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active'
 JOIN history_identities i ON i.id=r.identity_id GROUP BY i.id ORDER BY i.id
 """):
  d=dict(row)
  names=connection.execute("""
  SELECT customer_name FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active'
  WHERE identity_id=? AND customer_name<>'' ORDER BY date DESC,import_id DESC,source_row DESC LIMIT 1
  """,(row['id'],)).fetchone()
  d['name']=names[0] if names else ''
  result.append(d)
 return result

def build_plan(snapshot,identities,master,roster=None):
 customers={r['id']:dict(r) for r in snapshot['customers']}
 partners={k:dict(json.loads(r['data']),id=k) for k,r in customers.items()}
 aliases=collections.defaultdict(set); refs=collections.defaultdict(list); master_locations=collections.defaultdict(set)
 for r in master:
  if cui_key(r.get('CIF')):master_locations[cui_key(r['CIF'])].add((cui_key(r['CIF']),master_place(r)))
  if cui_key(r.get('PartnerCode')) and cui_key(r.get('CIF')):
   aliases[cui_key(r['PartnerCode'])].add(cui_key(r['CIF']))
  if code_key(r.get('Cod_Franciza')):refs[code_key(r['Cod_Franciza'])].append(r)
 companies=collections.defaultdict(list)
 for p in partners.values():
  if cui_key(p.get('cui')):companies[cui_key(p['cui'])].append(p)
 territories,reviewed=roster_map(roster,snapshot['agents'])
 additions={};links=[];issues=[];represented=set()
 def company(client):
  key=cui_key(client)
  options=aliases.get(key,{key})
  return next(iter(options)) if len(options)==1 else key
 source_codes=collections.defaultdict(set)
 for i in identities:
  if i['franchise_code']:source_codes[company(i['client_code'])].add(code_key(i['franchise_code']))
 def create(i,cui,franchise,location=None,kind='work_point'):
  identity=[cui,franchise] if franchise else [cui,'company']
  key='hist-'+sha(dump(identity).encode())[:32]
  if key in additions:return key
  loc=location or {}
  p={'id':key,'name':i['name'] or cui or franchise,'cui':cui,
     'address':loc.get('Street',''),'city':loc.get('Oras',''),'county':loc.get('Judet',''),
     'route':'','warehouseId':'','warehouseIds':[],
     'historyCatalog':{'version':1,'kind':kind,'clientCode':i['client_code'],
                       'companyKey':cui,'franchiseCode':franchise,
                       'addressSource':'location-master' if location else 'missing',
                       'firstSale':i['first_date'],'lastSale':i['last_date']}}
  additions[key]=p;companies[cui].append(p)
  return key
 # Process coded points before no-code company rows so placeholders are not duplicated.
 for i in sorted(identities,key=lambda i:(not bool(i['franchise_code']),i['id'])):
  client=cui_key(i['client_code']);franchise=code_key(i['franchise_code']);cui=company(client)
  link={'identityId':i['id'],'clientCode':i['client_code'],'franchiseCode':franchise,'companyKey':cui,
        'rowCount':i['row_count'],'partnerIds':[],'status':'reconcile','reason':''}
  if client=='CLIENTGEN' and not franchise:
   link.update(status='consumer',reason='Generic fiscal receipts are not a business partner')
   links.append(link);continue
  if not client:
   link['reason']='Client identity missing; preserve transaction for reconciliation'
   issues.append({'identityId':i['id'],'reason':link['reason']});links.append(link);continue
  represented.add(cui)
  candidates=companies[cui]
  if franchise:
   records=refs[franchise]
   ref_identities={(cui_key(r.get('CIF')),master_place(r)) for r in records}
   conflict=bool(records) and (len(ref_identities)!=1 or next(iter(ref_identities))[0]!=cui)
   location=records[0] if records and not conflict else None
   # An earlier generated/linked CRM identity is stronger than an address comparison.
   matches=[p for p in candidates if p.get('historyCatalog',{}).get('franchiseCode')==franchise]
   if not matches and location and location.get('Street'):
    matches=[p for p in candidates if place(p)==master_place(location)]
   # A partial catalog cannot prove that an unlinked explicit code is the old address.
   ids=sorted({p['id'] for p in matches})
   if not ids:ids=[create(i,cui,franchise,location)]
   link.update(partnerIds=ids,status='reconcile' if conflict else 'direct_code',
               reason='Conflicting CRM ownership/address' if conflict else 'Explicit franchise identity')
   if conflict:issues.append({'identityId':i['id'],'reason':link['reason']})
  else:
   if not candidates:
    create(i,cui,'',kind='company')
    candidates=companies[cui]
   addresses={place(p) for p in candidates}
   complete=len(addresses)==1 and all(a[1] and a[2] for a in addresses)
   known=master_locations[cui]
   compatible=not known or (len(known)==1 and next(iter(known))[1] in addresses)
   if complete and compatible and len(source_codes[cui])<=1:
    link.update(partnerIds=sorted({p['id'] for p in candidates}),status='single_partner',
                reason='Single complete known work-point address')
   else:
    link.update(partnerIds=sorted({p['id'] for p in candidates}),reason='Company represented; work point unresolved')
  links.append(link)
 updates=[];allocation=collections.Counter();county_totals=collections.Counter()
 for key,p in {**partners,**additions}.items():
  county=county_key(p.get('county'))
  if key in additions:
   wh=territories.get(county,[]) if reviewed else []
   p['warehouseIds']=wh;p['warehouseId']=wh[0] if wh else ''
   state='allocated' if wh else 'county_missing' if not county else 'roster_missing' if not reviewed else 'county_unstaffed'
   p['historyCatalog']['allocationStatus']=state
   allocation[state]+=1;county_totals[county or 'UNKNOWN']+=1
  elif reviewed and customers[key]['active']:
   wh=territories.get(county,[])
   if not wh:continue # Preserve existing membership when geography/staffing is unresolved.
   old=p.get('warehouseIds') or [customers[key]['warehouse_id']]
   if sorted(old)!=wh or customers[key]['warehouse_id'] not in wh:
    p['warehouseIds']=wh;p['warehouseId']=wh[0]
    updates.append({'id':key,'before':customers[key],'after':{'id':key,'warehouse_id':wh[0],'data':dump(p),'active':customers[key]['active']}})
 # Links preserve inactive original records rather than silently reactivate closed partners.
 inactive_links=sum(1 for l in links if l['partnerIds'] and all(k in customers and not customers[k]['active'] for k in l['partnerIds']))
 agent_gaps=[]
 for a in snapshot['agents']:
  if not a['active']:continue
  # Hints only, never applied as a roster. Names cannot prove current coverage.
  hint=[key for key,name in COUNTIES.items() if re.search(r'(?<!\w)'+re.escape(norm(name))+r'(?!\w)',norm(a.get('warehouse_name','')))]
  agent_gaps.append({'agentId':a['id'],'name':a['name'],'warehouseId':a['warehouse_id'],'siteCode':a['site_code'],'countyHints':hint,'counties':[]})
 counts=collections.Counter(l['status'] for l in links)
 return {'version':1,'createdAt':now(),'sourceSnapshotHash':sha(dump(snapshot['customers']).encode()),
         'sourceAgentsHash':sha(dump(snapshot['agents']).encode()),'rosterReviewed':reviewed,
         'summary':{'sourceIdentities':len(identities),'sourceCompanies':len(represented),'additions':len(additions),
                    'newWorkPoints':sum(p['historyCatalog']['kind']=='work_point' for p in additions.values()),
                    'newCompanyOnly':sum(p['historyCatalog']['kind']=='company' for p in additions.values()),
                    'existingMembershipUpdates':len(updates),'linksByStatus':dict(counts),
                    'allocation':dict(allocation),'newByCounty':dict(sorted(county_totals.items())),
                    'conflicts':len(issues),'linksToInactiveOnly':inactive_links,
                    'sourceRows':sum(i['row_count'] for i in identities)},
         'additions':list(additions.values()),'membershipUpdates':updates,'identityLinks':links,
         'issues':issues,'rosterTemplate':{'reviewed':False,'agents':agent_gaps}}

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--snapshot',required=True);p.add_argument('--history-db',required=True)
 p.add_argument('--master',required=True);p.add_argument('--roster');p.add_argument('--out',required=True)
 args=p.parse_args()
 conn=sqlite3.connect(pathlib.Path(args.history_db).resolve().as_uri()+'?mode=ro',uri=True)
 plan=build_plan(json.loads(pathlib.Path(args.snapshot).read_text()),source_identities(conn),
                 json.loads(pathlib.Path(args.master).read_text()),
                 json.loads(pathlib.Path(args.roster).read_text()) if args.roster else None)
 path=pathlib.Path(args.out);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(dump(plan));path.chmod(0o600)
 print(dump(plan['summary']))
if __name__=='__main__':main()
