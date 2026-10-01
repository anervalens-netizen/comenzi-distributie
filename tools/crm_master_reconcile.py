#!/usr/bin/env python3
"""Preservation-first CRM master reconciliation. Explicit paths; no network.
Raw workbook values are retained. Manager fields are never allocation inputs.
Plan on a read-only snapshot, validate on a copy, apply with a verified backup.
"""
from __future__ import annotations
import argparse, collections, json, pathlib, sqlite3, zipfile, re, os
import xml.etree.ElementTree as ET
from client_sales_history import dump,sha,file_sha,now,norm,cui_key,code_key,xlsx_rows,NS
from client_catalog_apply import read_customers,read_agents,digest,write_json
from client_catalog_plan import roster_map,county_key,COUNTIES

FIELDS=['Cod_Franciza','SyntheticName','PartnerName','PartnerCode','Street','LocalNumber','BuildingNumber','FlatNumber','Oras','Judet','ManagerZona','Merchandiser','PartnerAddressId','PartnerId','Part','SiteId','CodTelekom','TradeReprezentative','ASMM','J','CIF']
MANAGERS={'ManagerZona','ASMM'}
SCHEMA=[
"""CREATE TABLE IF NOT EXISTS crm_imports (source_hash TEXT PRIMARY KEY, source_path TEXT NOT NULL, imported_at TEXT NOT NULL, row_count INTEGER NOT NULL)""",
"""CREATE TABLE IF NOT EXISTS crm_companies (partner_id TEXT PRIMARY KEY,partner_code TEXT NOT NULL,name TEXT NOT NULL,cif TEXT NOT NULL,registration TEXT NOT NULL,source_json TEXT NOT NULL,source_hash TEXT NOT NULL REFERENCES crm_imports(source_hash))""",
"""CREATE TABLE IF NOT EXISTS crm_locations (address_id TEXT PRIMARY KEY,partner_id TEXT NOT NULL REFERENCES crm_companies(partner_id),franchise_code TEXT NOT NULL UNIQUE,synthetic_name TEXT NOT NULL,street TEXT NOT NULL,local_number TEXT NOT NULL,building_number TEXT NOT NULL,flat_number TEXT NOT NULL,city TEXT NOT NULL,county TEXT NOT NULL,source_json TEXT NOT NULL,source_hash TEXT NOT NULL REFERENCES crm_imports(source_hash))""",
"""CREATE TABLE IF NOT EXISTS crm_customer_links (customer_id TEXT NOT NULL REFERENCES customers(id),address_id TEXT NOT NULL REFERENCES crm_locations(address_id),method TEXT NOT NULL,PRIMARY KEY(customer_id,address_id))""",
"""CREATE INDEX IF NOT EXISTS crm_locations_partner ON crm_locations(partner_id)""",
"""CREATE INDEX IF NOT EXISTS crm_customer_links_address ON crm_customer_links(address_id)""",
"""CREATE TABLE IF NOT EXISTS crm_reconciliation_runs (source_hash TEXT PRIMARY KEY REFERENCES crm_imports(source_hash),before_hash TEXT NOT NULL,after_hash TEXT NOT NULL,receipt_json TEXT NOT NULL)"""
]
def load_master(path):
 with zipfile.ZipFile(path) as z:
  root=ET.fromstring(z.read('xl/workbook.xml'));sheets=root.find('s:sheets',NS)
  if len(sheets)!=1:raise ValueError('Expected one CRM data sheet')
  rels={r.get('Id'):r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
  target=rels[sheets[0].get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
  target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
  it=iter(xlsx_rows(z,target));_,header=next(it)
  if header!=FIELDS:raise ValueError('Unexpected CRM headers')
  result=[]
  for rn,values in it:
   if not any(values):continue
   if len(values)>len(FIELDS):raise ValueError('Unexpected cells')
   raw=dict(zip(FIELDS,values+['']*(len(FIELDS)-len(values))))
   row={k:str(v).strip() for k,v in raw.items()}
   for k in ['PartnerId','PartnerAddressId','Cod_Franciza','PartnerCode']:
    if not row[k]:raise ValueError('Missing identity at row '+str(rn))
   result.append({'row':rn,'raw':raw,'value':row})
  for key in ['Cod_Franciza','PartnerAddressId']:
   if len({code_key(r['value'][key]) for r in result})!=len(result):raise ValueError('Duplicate '+key)
  return result
def address_good(value):
 return bool(re.search(r'[\w\d]',str(value or ''),re.UNICODE)) and norm(value) not in {'N/A','NA','NECUNOSCUT','FARA ADRESA'}
def address_key(county,city,address):
 return (county_key(county) or norm(county),norm(city),norm(address).lstrip('- ').rstrip(' .'))
def composed_address(r):
 street=r['Street'] if address_good(r['Street']) else ''
 out=[street] if street else []
 for key,label in [('LocalNumber','Nr.'),('BuildingNumber','Bl.'),('FlatNumber','Ap.')]:
  v=r[key]
  if address_good(v) and not re.search(r'(?<!\w)'+re.escape(norm(v))+r'(?!\w)',norm(street)):out.append(label+' '+v)
 return ', '.join(out)
def snapshot(c):
 c.row_factory=sqlite3.Row
 tables={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
 profiles=[dict(r) for r in c.execute('SELECT * FROM partner_profiles ORDER BY customer_id')] if 'partner_profiles' in tables else []
 return {'customers':read_customers(c),'agents':read_agents(c),'profiles':profiles}
def company_key(r):return cui_key(r['CIF'] or r['PartnerCode'])
def build_plan(snap,master,roster,source_hash,source_path):
 territories,_=roster_map(roster,snap['agents'])
 original={r['id']:r for r in snap['customers']}
 values={k:json.loads(v['data']) for k,v in original.items()}
 profiles={r['customer_id']:r for r in snap['profiles']}
 companies={};alias=collections.defaultdict(set);locations=collections.defaultdict(list);keys={}
 for item in master:
  r=item['value'];pid=r['PartnerId'];ck=company_key(r)
  company={k:r[k] for k in ['PartnerId','PartnerCode','PartnerName','CIF','J']}
  if pid in companies and any((cui_key(companies[pid][k])!=cui_key(company[k]) if k=='CIF' else companies[pid][k]!=company[k]) for k in company):raise ValueError('Inconsistent CRM company '+pid)
  if ck in keys and keys[ck]!=pid:raise ValueError('Ambiguous fiscal identity across CRM companies')
  keys[ck]=pid;companies.setdefault(pid,company);locations[pid].append(r)
  for k in [r['PartnerCode'],r['CIF']]:
   if cui_key(k):alias[cui_key(k)].add(pid)
 def owner(p):
  opts=alias.get(cui_key(p.get('cui')),set())
  return next(iter(opts)) if len(opts)==1 else None
 def codes(p):
  return ({code_key(v) for v in p.get('historyFranchises',[])}|{code_key(p.get('historyCatalog',{}).get('franchiseCode'))})-{''}
 by_code=collections.defaultdict(list);by_address=collections.defaultdict(list);by_company=collections.defaultdict(list)
 for id,p in values.items():
  pid=owner(p)
  if pid:by_company[pid].append(id)
  for f in codes(p):by_code[f].append(id)
  if pid and address_good(p.get('address')):
   by_address[(pid,address_key(p.get('county'),p.get('city'),p.get('address')))].append(id)
 links=[];updates={};additions={};issues=[];linked=collections.defaultdict(set);matched_ids=set();kept_position_addresses=[]
 def bind(id,r,method):
  pid=r['PartnerId'];aid=r['PartnerAddressId'];code=code_key(r['Cod_Franciza'])
  if linked[id] and aid not in linked[id]:
   issues.append({'kind':'multiple_crm_locations_for_existing_record','customerId':id,'addressId':aid});return False
  p=dict(updates.get(id,additions.get(id,values.get(id,{}))))
  p['crm']={'version':1,'sourceHash':source_hash,'partnerId':pid,'partnerAddressId':aid,'partnerCode':r['PartnerCode'],'franchiseCode':code,'cif':r['CIF'],'registration':r['J'],'syntheticName':r['SyntheticName'],'matchMethod':method}
  p['historyFranchises']=sorted(codes(p)|{code})
  p['cui']=company_key(r);p['name']=r['PartnerName']
  addr=composed_address(r)
  desired={'address':addr,'city':r['Oras'],'county':r['Judet']}
  # Changing address fields triggers deliberate invalidation of saved positions.
  # Keep the operational address on profiles; exact CRM address lives in crm_locations.
  if id in profiles:
   if any(desired[k] and desired[k]!=p.get(k,'') for k in desired):
    p['crm']['addressStatus']='saved_position_address_preserved'
    kept_position_addresses.append({'customerId':id,'addressId':aid,'local':{k:p.get(k,'') for k in desired},'crm':desired})
  else:
   for k,v in desired.items():
    if (address_good(v) if k=='address' else bool(v)):p[k]=v
   p['crm']['addressStatus']='crm' if address_good(p.get('address')) else 'missing'
  wh=territories.get(county_key(r['Judet']) or county_key(p.get('county')),[])
  if wh:p['warehouseIds']=wh;p['warehouseId']=wh[0]
  elif id not in original:p['warehouseIds']=[];p['warehouseId']=''
  if p.get('historyCatalog'):
   p['historyCatalog']={**p['historyCatalog'],'companyKey':company_key(r),'franchiseCode':code,'addressSource':'crm-master','countySource':'crm-master','allocationStatus':'allocated' if wh else 'county_unstaffed'}
  if id in original:updates[id]=p
  else:additions[id]=p
  links.append({'customerId':id,'addressId':aid,'method':method});linked[id].add(aid);matched_ids.add(id);return True
 for item in master:
  r=item['value'];pid=r['PartnerId'];code=code_key(r['Cod_Franciza'])
  explicit=by_code.get(code,[])
  valid=[id for id in explicit if owner(values[id])==pid]
  for id in explicit:
   if id not in valid:issues.append({'kind':'stored_franchise_owner_conflict','customerId':id,'franchiseCode':code,'oldCui':values[id].get('cui'),'crmPartnerId':pid})
  addr=composed_address(r);key=address_key(r['Judet'],r['Oras'],addr)
  exact=by_address.get((pid,key),[]) if address_good(addr) else []
  # Existing points with another explicit code must remain distinct locations.
  exact=[id for id in exact if not codes(values[id]) or code in codes(values[id])]
  match=sorted(set(valid+exact),key=lambda id:(not original[id]['active'],id))
  success=[]
  for id in match:
   if bind(id,r,'franchise' if id in valid else 'company_exact_address'):success.append(id)
  if not success:
   # A company-only shell is safe to enrich only with exactly one known CRM point.
   shells=[id for id in by_company[pid] if original[id]['active'] and id not in matched_ids and not codes(values[id]) and not address_good(values[id].get('address')) and id not in profiles]
   if len(locations[pid])==1 and len(shells)==1:
    bind(shells[0],r,'single_crm_location');success=shells
  if not success:
   id='crm-'+r['PartnerAddressId']
   if id in original:raise ValueError('Unrecognized reserved CRM customer ID')
   additions[id]={'id':id,'name':r['PartnerName'],'cui':company_key(r),'address':'','city':'','county':'','route':'','warehouseId':'','warehouseIds':[]}
   bind(id,r,'new_crm_location')
 # Enrich other company-only shells only when *all* known CRM locations agree.
 # Never assign a multi-location firm's arbitrary first address to a no-code record.
 for id,p in values.items():
  if id in matched_ids or owner(p) is None:continue
  pid=owner(p)
  cp=dict(p);cp['crmCompany']={'partnerId':pid,'partnerCode':companies[pid]['PartnerCode'],'cif':companies[pid]['CIF'],'registration':companies[pid]['J'],'sourceHash':source_hash}
  updates[id]=cp
 # Recover legacy addresses only from one unambiguous complete local/CRM location.
 # This never fabricates a franchise code or picks one of several work points.
 known=collections.defaultdict(dict)
 def entity(p):return owner(p) or 'legacy:'+cui_key(p.get('cui'))
 for id,p in {**values,**updates,**additions}.items():
  if address_good(p.get('address')) and p.get('city') and county_key(p.get('county')):
   key=address_key(p['county'],p['city'],p['address'])
   known[entity(p)][key]=(id,{k:p[k] for k in ['address','city','county']})
 for id,p0 in values.items():
  p=updates.get(id,p0)
  if id in profiles or codes(p) or address_good(p.get('address')):continue
  candidates=known.get(entity(p),{})
  if len(candidates)!=1:continue
  origin,addr=next(iter(candidates.values()))
  pid=owner(p)
  master_keys={address_key(r['Judet'],r['Oras'],composed_address(r)) for r in locations.get(pid,[]) if address_good(composed_address(r))}
  if master_keys and (len(master_keys)!=1 or next(iter(master_keys)) not in candidates):continue
  p=dict(p);p.update(addr);p['addressProvenance']={'source':'unique_existing_company_location','customerId':origin,'sourceHash':source_hash}
  wh=territories.get(county_key(p['county']),[])
  if wh:p['warehouseIds']=wh;p['warehouseId']=wh[0]
  updates[id]=p
 # Build every active unresolved address into an explicit queue.
 expected={id:dict(v) for id,v in original.items()}
 for id,p in updates.items():expected[id]={**original[id],'warehouse_id':p.get('warehouseId',''),'data':dump(p)}
 for id,p in additions.items():expected[id]={'id':id,'warehouse_id':p['warehouseId'],'data':dump(p),'active':1}
 missing=[]
 for id,row in expected.items():
  p=json.loads(row['data'])
  if row['active'] and (not address_good(p.get('address')) or not p.get('city') or not p.get('county')):
   pid=owner(p);missing.append({'customerId':id,'name':p.get('name'),'cui':p.get('cui'),'franchiseCodes':sorted(codes(p)),'address':p.get('address'),'city':p.get('city'),'county':p.get('county'),'crmCompanyId':pid,'knownCrmLocations':len(locations.get(pid,[])),'reason':'multiple_crm_locations' if len(locations.get(pid,[]))>1 else 'crm_address_incomplete' if pid else 'not_in_crm_export'})
 changed=[{'before':original[id],'after':r} for id,r in expected.items() if id in original and r!=original[id]]
 before_missing=sum(r['active'] and not address_good(json.loads(r['data']).get('address')) for r in original.values())
 after_missing=sum(r['active'] and not address_good(json.loads(r['data']).get('address')) for r in expected.values())
 return {'version':1,'createdAt':now(),'sourceHash':source_hash,'sourcePath':str(source_path),'sourceSnapshotHash':digest(snap['customers']),'sourceAgentsHash':digest(snap['agents']),'sourceProfilesHash':sha(dump(snap['profiles']).encode()),'expectedHash':digest(list(expected.values())),'companies':list(companies.values()),'master':master,'links':links,'changes':changed,'additions':[expected[id] for id in additions],'issues':issues,'addressReview':kept_position_addresses,'missingAddresses':missing,'summary':{'crmRows':len(master),'crmCompanies':len(companies),'existingUpdated':len(changed),'newRecords':len(additions),'linkedLocations':len({x['addressId'] for x in links}),'linkedExistingRecords':len(matched_ids-set(additions)),'beforeMissingStreet':before_missing,'afterMissingStreet':after_missing,'existingStreetCompleted':sum(not address_good(json.loads(x['before']['data']).get('address')) and address_good(json.loads(x['after']['data']).get('address')) for x in changed),'savedPositionAddressesPreserved':len(kept_position_addresses),'addressQueue':len(missing),'conflicts':len(issues)}}
def protected(c):
 out={}
 for table, in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name!='customers' AND name NOT LIKE 'crm_%' ORDER BY name"):
  q='"'+table.replace('"','""')+'"'
  out[table]=sha(dump(sorted(dump(list(r)) for r in c.execute('SELECT * FROM '+q))).encode())
 return out
def apply_plan(path,plan,receipt):
 p=pathlib.Path(path).resolve();folder=pathlib.Path(receipt)
 if p.name!='mobiup.sqlite':raise ValueError('Explicit application filename required')
 c=sqlite3.connect(p.as_uri()+'?mode=rw',uri=True,timeout=30);c.row_factory=sqlite3.Row
 try:
  c.execute('PRAGMA foreign_keys=ON')
  if c.execute("SELECT 1 FROM sqlite_master WHERE name='crm_reconciliation_runs'").fetchone():
   applied=c.execute('SELECT after_hash FROM crm_reconciliation_runs WHERE source_hash=?',(plan['sourceHash'],)).fetchone()
   if applied:
    if applied[0]!=plan['expectedHash']:raise ValueError('Source already applied with a different plan')
    return {'state':'already_applied'}
  def check():
   s=snapshot(c)
   if digest(s['customers'])!=plan['sourceSnapshotHash'] or digest(s['agents'])!=plan['sourceAgentsHash'] or sha(dump(s['profiles']).encode())!=plan['sourceProfilesHash']:raise ValueError('Concurrent catalog/roster/profile change; regenerate plan')
  check()
  folder.mkdir(mode=0o700,parents=True,exist_ok=False)
  backup=folder/'mobiup-before.sqlite'
  with sqlite3.connect(backup) as b:
   c.backup(b)
   if b.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Backup failed')
  os.chmod(backup,0o600)
  write_json(folder/'plan.json',plan)
  c.execute('BEGIN IMMEDIATE');check();before=protected(c)
  for sql in SCHEMA:c.execute(sql)
  c.execute('INSERT INTO crm_imports VALUES(?,?,?,?)',(plan['sourceHash'],plan['sourcePath'],now(),len(plan['master'])))
  for r in plan['companies']:
   c.execute('INSERT INTO crm_companies VALUES(?,?,?,?,?,?,?) ON CONFLICT(partner_id) DO UPDATE SET partner_code=excluded.partner_code,name=excluded.name,cif=excluded.cif,registration=excluded.registration,source_json=excluded.source_json,source_hash=excluded.source_hash',(r['PartnerId'],r['PartnerCode'],r['PartnerName'],r['CIF'],r['J'],dump(r),plan['sourceHash']))
  for item in plan['master']:
   r=item['value'];raw={k:v for k,v in item['raw'].items() if k not in MANAGERS}
   c.execute('INSERT INTO crm_locations VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET partner_id=excluded.partner_id,franchise_code=excluded.franchise_code,synthetic_name=excluded.synthetic_name,street=excluded.street,local_number=excluded.local_number,building_number=excluded.building_number,flat_number=excluded.flat_number,city=excluded.city,county=excluded.county,source_json=excluded.source_json,source_hash=excluded.source_hash',(r['PartnerAddressId'],r['PartnerId'],code_key(r['Cod_Franciza']),r['SyntheticName'],r['Street'],r['LocalNumber'],r['BuildingNumber'],r['FlatNumber'],r['Oras'],r['Judet'],dump(raw),plan['sourceHash']))
  for change in plan['changes']:
   r=change['after']
   if change['before']['active']!=r['active']:raise ValueError('Cannot change active status')
   c.execute('UPDATE customers SET warehouse_id=?,data=? WHERE id=?',(r['warehouse_id'],r['data'],r['id']))
  for r in plan['additions']:c.execute('INSERT INTO customers VALUES(?,?,?,?)',(r['id'],r['warehouse_id'],r['data'],r['active']))
  for r in plan['links']:c.execute('INSERT INTO crm_customer_links VALUES(?,?,?) ON CONFLICT(customer_id,address_id) DO UPDATE SET method=excluded.method',(r['customerId'],r['addressId'],r['method']))
  if digest(read_customers(c))!=plan['expectedHash']:raise ValueError('Catalog digest mismatch')
  if protected(c)!=before:raise ValueError('Protected table changed; rollback')
  if c.execute('PRAGMA foreign_key_check').fetchone() or c.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Integrity failed')
  result={'state':'committed','at':now(),**plan['summary'],'backup':str(backup),'backupSha256':file_sha(backup),'protectedTablesUnchanged':True}
  c.execute('INSERT INTO crm_reconciliation_runs VALUES(?,?,?,?)',(plan['sourceHash'],plan['sourceSnapshotHash'],plan['expectedHash'],dump(result)))
  c.commit();write_json(folder/'receipt.json',result);return result
 except BaseException:c.rollback();raise
 finally:c.close()
def main():
 p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='mode',required=True)
 q=sub.add_parser('plan')
 for key in ['application','workbook','roster','output']:q.add_argument('--'+key,required=True)
 q=sub.add_parser('apply')
 for key in ['application','plan','receipt']:q.add_argument('--'+key,required=True)
 a=p.parse_args()
 if a.mode=='plan':
  c=sqlite3.connect(pathlib.Path(a.application).resolve().as_uri()+'?mode=ro',uri=True)
  try:s=snapshot(c)
  finally:c.close()
  out=build_plan(s,load_master(a.workbook),json.loads(pathlib.Path(a.roster).read_text()),file_sha(a.workbook),a.workbook)
  write_json(a.output,out);print(dump(out['summary']))
 else:print(dump(apply_plan(a.application,json.loads(pathlib.Path(a.plan).read_text()),a.receipt)))
if __name__=='__main__':main()
