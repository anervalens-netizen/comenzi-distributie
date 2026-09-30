#!/usr/bin/env python3
"""Additive catalog sync. Never replaces a portfolio or touches coordinates/TR sales.
Back up and verify the configured application DB before the single SQLite write
transaction. A fresh whole-catalog/active-roster comparison prevents stale plans.
"""
from __future__ import annotations
import argparse,base64,json,os,pathlib,sqlite3
from client_sales_history import dump,sha,now,file_sha
def digest(rows):return sha(dump(sorted(rows,key=lambda r:r['id'])).encode())
def read_customers(c):return [dict(r) for r in c.execute('SELECT id,warehouse_id,data,active FROM customers ORDER BY id')]
def read_agents(c):return [dict(r) for r in c.execute("SELECT id,name,warehouse_id,warehouse_name,site_code,active FROM users WHERE role='agent' AND active=1 ORDER BY id")]
def other_tables(c):
 result={}
 for table, in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name!='customers' ORDER BY name"):
  quoted='"'+table.replace('"','""')+'"'
  rows=[]
  for row in c.execute('SELECT * FROM '+quoted):
   rows.append(dump([{'bytes':base64.b64encode(v).decode()} if isinstance(v,bytes) else v for v in row]))
  result[table]=sha(dump(sorted(rows)).encode())
 return result
def write_json(path,value):
 path=pathlib.Path(path);temp=path.with_suffix(path.suffix+'.pending')
 with open(temp,'w') as f:
  os.chmod(temp,0o600);f.write(dump(value));f.flush();os.fsync(f.fileno())
 os.replace(temp,path)
def expected_rows(plan,snapshot):
 original={r['id']:dict(r) for r in snapshot}
 rows={id:dict(row) for id,row in original.items()}
 for update in plan.get('membershipUpdates',[]):
  id=update['id'];before=update['before'];after=update['after']
  if id not in rows or before!=rows[id]:raise ValueError('Membership before image mismatch')
  old=json.loads(before['data']);new=json.loads(after['data'])
  for key in ('warehouseId','warehouseIds'):old.pop(key,None);new.pop(key,None)
  if old!=new or before['active']!=after['active'] or before['id']!=after['id']:
   raise ValueError('Membership update would change protected customer fields')
  rows[id]=dict(after)
 for update in plan.get('aliasUpdates',[]):
  id=update['id']
  if id not in rows or update['before']!=original.get(id):raise ValueError('Alias before image mismatch')
  value=json.loads(rows[id]['data']);codes=update['franchiseCodes']
  if not codes or any(not isinstance(v,str) or not v.strip() for v in codes):raise ValueError('Invalid franchise alias')
  value['historyFranchises']=sorted(set(value.get('historyFranchises',[]))|set(codes));rows[id]['data']=dump(value)
 for partner in plan['additions']:
  id=partner['id']
  if id in rows:raise ValueError('New customer ID already exists')
  if not id.startswith('hist-') or not partner.get('cui'):raise ValueError('Invalid historical customer identity')
  if any(key in partner for key in ('latitude','longitude','positionSource')):raise ValueError('Catalog sync cannot invent map coordinates')
  warehouses=partner.get('warehouseIds',[])
  if not isinstance(warehouses,list) or partner.get('warehouseId','')!=(warehouses[0] if warehouses else ''):raise ValueError('Inconsistent shared membership')
  rows[id]={'id':id,'warehouse_id':partner.get('warehouseId',''),'data':dump(partner),'active':1}
 return sorted(rows.values(),key=lambda r:r['id'])
def apply_plan(application,plan,snapshot,receipt_directory):
 application=pathlib.Path(application).resolve();receipt_directory=pathlib.Path(receipt_directory).resolve()
 if application.name!='mobiup.sqlite':raise ValueError('Explicit mobiup.sqlite application database required')
 if plan.get('version')!=2:raise ValueError('Use the integration-aware plan version 2')
 if digest(snapshot['customers'])!=plan['sourceSnapshotHash'] or digest(snapshot['agents'])!=plan['sourceAgentsHash']:raise ValueError('Source snapshot does not match plan')
 if plan.get('membershipUpdates') and not plan.get('rosterReviewed'):raise ValueError('Current roster must be reviewed')
 expected=expected_rows(plan,snapshot['customers']);expected_hash=digest(expected)
 c=sqlite3.connect(application.as_uri()+'?mode=rw',uri=True,timeout=30);c.row_factory=sqlite3.Row
 backup_path=receipt_directory/'mobiup-before.sqlite';receipt_path=receipt_directory/'receipt.json'
 try:
  c.execute('PRAGMA foreign_keys=ON')
  current=read_customers(c)
  if digest(current)==expected_hash:return {'state':'already_applied','customers':len(current)}
  if digest(current)!=plan['sourceSnapshotHash']:raise ValueError('Catalog changed; regenerate plan')
  if digest(read_agents(c))!=plan['sourceAgentsHash']:raise ValueError('Active roster changed; regenerate plan')
  if receipt_directory.exists():raise ValueError('A new receipt directory is required')
  receipt_directory.mkdir(parents=True,mode=0o700)
  with sqlite3.connect(backup_path) as backup:
   c.backup(backup)
   if backup.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Recovery copy integrity failed')
  os.chmod(backup_path,0o600)
  receipt={'state':'prepared','at':now(),'planHash':sha(dump(plan).encode()),'backup':str(backup_path),'backupSha256':file_sha(backup_path),'beforeCatalogHash':plan['sourceSnapshotHash'],'expectedCatalogHash':expected_hash}
  write_json(receipt_directory/'plan.json',plan);write_json(receipt_path,receipt)
  c.execute('BEGIN IMMEDIATE')
  if digest(read_customers(c))!=plan['sourceSnapshotHash'] or digest(read_agents(c))!=plan['sourceAgentsHash']:raise ValueError('Concurrent catalog/roster change; nothing imported')
  protected=other_tables(c)
  old={r['id']:r for r in current};added=updated=0
  for row in expected:
   if row['id'] not in old:
    c.execute('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,?)',(row['id'],row['warehouse_id'],row['data'],row['active']));added+=1
   elif row!=old[row['id']]:
    c.execute('UPDATE customers SET warehouse_id=?,data=? WHERE id=?',(row['warehouse_id'],row['data'],row['id']));updated+=1
  if digest(read_customers(c))!=expected_hash:raise ValueError('Customer verification failed')
  if other_tables(c)!=protected:raise ValueError('Protected tables changed; rolling back')
  if c.execute('PRAGMA foreign_key_check').fetchone() or c.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Application integrity failed')
  c.commit()
  receipt.update(state='committed',finishedAt=now(),added=added,updated=updated,customers=len(expected),protectedTablesUnchanged=True)
  write_json(receipt_path,receipt)
  return {k:receipt[k] for k in ('state','added','updated','customers','protectedTablesUnchanged','backupSha256')}
 except BaseException:
  c.rollback();raise
 finally:c.close()
def main():
 p=argparse.ArgumentParser(description=__doc__)
 for key in ('application','plan','snapshot','receipt-directory'):p.add_argument('--'+key,required=True)
 args=p.parse_args()
 result=apply_plan(args.application,json.loads(pathlib.Path(args.plan).read_text()),json.loads(pathlib.Path(args.snapshot).read_text()),args.receipt_directory)
 print(dump(result))
if __name__=='__main__':main()
