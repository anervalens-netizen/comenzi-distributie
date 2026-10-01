#!/usr/bin/env python3
"""Rebuild derived customer/history links from stored CRM without changing sales facts."""
import argparse,json,pathlib,sqlite3
from client_sales_history import connect,store_reference,dump,code_key,cui_key,summary
from crm_master_reconcile import write_json,company_key

def export_reference(application,history,output):
 out=pathlib.Path(output);out.mkdir(parents=True,exist_ok=True)
 app=sqlite3.connect(pathlib.Path(application).resolve().as_uri()+'?mode=ro',uri=True);app.row_factory=sqlite3.Row
 h=sqlite3.connect(pathlib.Path(history).resolve().as_uri()+'?mode=ro',uri=True)
 try:
  master=[];bycode={}
  for row in app.execute('SELECT source_json FROM crm_locations ORDER BY address_id'):
   r=json.loads(row[0]);r['_crmOriginalCIF']=r.get('CIF','');r['CIF']=company_key(r)
   master.append(r);bycode[code_key(r['Cod_Franciza'])]=r
  old=h.execute("SELECT master_json FROM history_references WHERE id=(SELECT value FROM history_meta WHERE key='current_reference')").fetchone()
  for r in json.loads(old[0]) if old else []:
   if not code_key(r.get('Cod_Franciza')) or code_key(r['Cod_Franciza']) not in bycode:master.append(r)
  partners=[];conflicts=[]
  for row in app.execute('SELECT id,active,data FROM customers ORDER BY id'):
   p=json.loads(row['data']);p['active']=row['active'];p['id']=row['id']
   codes={code_key(v) for v in p.get('historyFranchises',[])}|{code_key(p.get('historyCatalog',{}).get('franchiseCode'))}
   denied={f for f in codes if f in bycode and cui_key(p.get('cui'))!=cui_key(bycode[f]['CIF'])}
   if denied:
    conflicts.append({'customerId':p['id'],'codes':sorted(denied),'reason':'Historical franchise ownership differs from current CRM; original catalog evidence retained'})
    p['historyFranchises']=[f for f in p.get('historyFranchises',[]) if code_key(f) not in denied]
    if code_key(p.get('historyCatalog',{}).get('franchiseCode')) in denied:p['historyCatalog']={**p['historyCatalog'],'franchiseCode':''}
   partners.append(p)
  write_json(out/'partners.json',{'partners':partners});write_json(out/'locations.json',master);write_json(out/'ownership-conflicts.json',conflicts)
  return {'partners':len(partners),'locations':len(master),'ownershipConflicts':len(conflicts)}
 finally:app.close();h.close()
def facts(c):
 return [list(r) for r in c.execute('SELECT import_id,COUNT(*),SUM(value_cents),SUM(quantity_micros),SUM(value_cents IS NULL),MIN(date),MAX(date) FROM history_rows GROUP BY import_id ORDER BY import_id')]
def main():
 p=argparse.ArgumentParser(description=__doc__)
 for key in ['application','database','output']:p.add_argument('--'+key,required=True)
 p.add_argument('--apply',action='store_true');a=p.parse_args()
 result=export_reference(a.application,a.database,a.output)
 if a.apply:
  c=connect(a.database)
  try:
   before=facts(c);ids=[list(r) for r in c.execute('SELECT * FROM history_identities ORDER BY id')]
   previous=c.execute("SELECT value FROM history_meta WHERE key='current_reference'").fetchone()[0]
   with c:
    reference,_=store_reference(c,pathlib.Path(a.output)/'partners.json',pathlib.Path(a.output)/'locations.json')
    if facts(c)!=before or [list(r) for r in c.execute('SELECT * FROM history_identities ORDER BY id')]!=ids:raise ValueError('Sales facts/identities changed')
    if c.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('Broken history reference')
   result.update(previousReference=previous,reference=reference,rawFactsPreserved=True,summary=summary(c))
   write_json(pathlib.Path(a.output)/'reconciliation.json',result)
  finally:c.close()
 print(dump(result))
if __name__=='__main__':main()
