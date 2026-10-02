#!/usr/bin/env python3
"""Cumulative monthly uploads. Private inputs stay outside the source repository."""
import calendar, collections, datetime as dt, fcntl, json, os, pathlib, sqlite3, sys, zipfile
from zoneinfo import ZoneInfo
import client_sales_history as h

class UploadError(ValueError): pass

def emit(phase, message):
 print(h.dump({'progress':phase,'message':message}),flush=True)

def open_history(directory):
 path=pathlib.Path(directory)/'client-history'/'client-sales-history.sqlite'
 if not path.is_file():raise UploadError('Istoricul pe clienți nu este încă inițializat.')
 c=sqlite3.connect(path,timeout=30);c.row_factory=sqlite3.Row
 c.execute('PRAGMA foreign_keys=ON')
 return c

def revision(c):
 imports=[list(r) for r in c.execute("SELECT id,sha256,period_start,period_end,row_count FROM history_imports WHERE state='active' ORDER BY id")]
 ref=c.execute("SELECT value FROM history_meta WHERE key='current_reference'").fetchone()
 if not ref:raise UploadError('Referințele clienților lipsesc.')
 return h.sha(h.dump([imports,ref[0]]).encode())

def parse_upload(path):
 with zipfile.ZipFile(path) as z:
  if len(z.infolist())>4096 or sum(x.file_size for x in z.infolist())>512*1024*1024:
   raise UploadError('Fișierul Excel este prea mare după decomprimare.')
 stream=h.workbook(path,allow_inferred_period=True);_,meta=next(stream)
 rows=[]
 for _,r in stream:
  rows.append(r)
  if len(rows)>500000:raise UploadError('Maximum 500.000 de rânduri per import lunar.')
 if not rows:raise UploadError('Fișierul nu conține vânzări.')
 first=min(r['date'] for r in rows);last=max(r['date'] for r in rows)
 month=first[:7]
 if last[:7]!=month:raise UploadError('Încarcă un singur raport cumulativ lunar. Fișierul conține mai multe luni.')
 start=month+'-01';year,number=map(int,month.split('-'))
 month_end=f'{month}-{calendar.monthrange(year,number)[1]:02d}'
 if meta['start'] and (meta['start']!=start or meta['end'][:7]!=month):
  raise UploadError('Raportul trebuie să înceapă în prima zi și să acopere o singură lună.')
 through=meta['end'] or last
 today=dt.datetime.now(ZoneInfo('Europe/Bucharest')).date().isoformat()
 if last>today or through>today:raise UploadError('Raportul conține o perioadă din viitor.')
 cents=sum(r['value_cents'] or 0 for r in rows);quantity=sum(r['quantity_micros'] for r in rows)
 if max(abs(cents),abs(quantity))>9007199254740991:raise UploadError('Totalurile depășesc limita numerică acceptată.')
 summary={'month':month,'from':start,'through':through,'firstDate':first,'lastDate':last,'rows':len(rows),'valueCents':cents,'quantityMicros':quantity,'missingValues':sum(r['value_cents'] is None for r in rows),'inferredPeriod':not bool(meta['start']),'fileHash':h.file_sha(path)}
 return rows,summary,month_end

def preview(c,rows,summary,month_end):
 existing=c.execute('SELECT id,state FROM history_imports WHERE sha256=?',(summary['fileHash'],)).fetchone()
 if existing and existing['state']!='active':
  raise UploadError('Acest fișier a fost înlocuit deja de un import mai nou. Folosește exportul actual.')
 active=" FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active' WHERE r.date>=? AND r.date<=?"
 args=(summary['from'],month_end)
 old=collections.Counter({r['row_hash']:r['n'] for r in c.execute('SELECT row_hash,COUNT(*) n'+active+' GROUP BY row_hash',args)})
 incoming=collections.Counter(h.sha(h.dump(r['raw']).encode()) for r in rows)
 previous=c.execute('SELECT COUNT(*) rows,COALESCE(SUM(r.value_cents),0) valueCents,MAX(r.date) lastDate'+active,args).fetchone()
 removed=sum((old-incoming).values());added=sum((incoming-old).values())
 end=c.execute("SELECT MAX(MIN(period_end,?)) FROM history_imports WHERE state='active' AND period_start<=? AND period_end>=?",(month_end,month_end,summary['from'])).fetchone()[0]
 shorter=bool(end and summary['through']<end)
 return {**summary,'revision':revision(c),'previous':dict(previous),'addedOccurrences':added,'removedOccurrences':removed,'coverageShorter':shorter,'requiresAcknowledgement':bool(removed or shorter),'alreadyImported':bool(existing)}

def archive_projection(c,old,start,end,root):
 count,value,quantity=c.execute('SELECT COUNT(*),COALESCE(SUM(value_cents),0),COALESCE(SUM(quantity_micros),0) FROM history_rows WHERE import_id=? AND date>=? AND date<=?',(old['id'],start,end)).fetchone()
 manifest={'kind':'immutable_source_period_projection_v1','sourceImportId':old['id'],'sourceSha256':old['sha256'],'sourceOriginalPath':old['original_path'],'periodStart':start,'periodEnd':end,'rows':count,'valueCents':value,'quantityMicros':quantity}
 raw=h.dump(manifest);digest=h.sha(raw.encode());relative='client-sales-originals/projection-'+digest+'.json';path=root/relative
 if path.exists():
  if h.file_sha(path)!=digest:raise UploadError('Manifestul unei surse arhivate este invalid.')
 else:
  with open(path,'x') as f:f.write(raw);f.flush();os.fsync(f.fileno())
  os.chmod(path,0o600)
 imp=c.execute("INSERT INTO history_imports(sha256,filename,original_path,period_start,period_end,imported_at,state,row_count,value_cents,quantity_micros,reference_id) VALUES(?,?,?,?,?,?,'active',?,?,?,?)",(digest,path.name,relative,start,end,old['imported_at'],count,value,quantity,old['reference_id'])).lastrowid
 columns=[r[1] for r in c.execute('PRAGMA table_info(history_rows)')][1:]
 c.execute('INSERT INTO history_rows SELECT ?,'+','.join(columns)+' FROM history_rows WHERE import_id=? AND date>=? AND date<=?',(imp,old['id'],start,end))
 c.execute('INSERT INTO history_import_projections VALUES(?,?,?)',(imp,old['id'],raw))

def apply(c,rows,summary,month_end,request,root):
 current=preview(c,rows,summary,month_end)
 if current['alreadyImported']:return {**current,'status':'already_imported'}
 if request.get('revision')!=current['revision'] or request.get('fileHash')!=summary['fileHash']:
  raise UploadError('Datele s-au schimbat după previzualizare. Încarcă fișierul din nou.')
 if current['requiresAcknowledgement'] and request.get('allowRegression') is not True:
  raise UploadError('Confirmă explicit corecțiile sau reducerea perioadei din previzualizare.')
 emit('backup','Se păstrează copia de recuperare…')
 backup_dir=root/'upload-backups';backup_dir.mkdir(exist_ok=True,mode=0o700)
 backup=backup_dir/(request['jobId']+'.sqlite')
 if not backup.exists():
  with sqlite3.connect(backup) as out:c.backup(out)
  os.chmod(backup,0o600)
 h.archive_source(request['source'],root/'client-sales-originals')
 emit('import','Se actualizează luna și asocierile clienților…')
 c.execute('BEGIN IMMEDIATE')
 try:
  if revision(c)!=current['revision']:raise UploadError('Un alt import a modificat istoricul. Reia previzualizarea.')
  old=c.execute("SELECT * FROM history_imports WHERE state='active' AND period_start<=? AND period_end>=?",(month_end,summary['from'])).fetchall()
  c.execute("CREATE TABLE IF NOT EXISTS history_import_projections(import_id INTEGER PRIMARY KEY REFERENCES history_imports(id),source_import_id INTEGER NOT NULL REFERENCES history_imports(id),manifest_json TEXT NOT NULL)")
  for item in old:
   if item['period_start']<summary['from']:
    end=(dt.date.fromisoformat(summary['from'])-dt.timedelta(days=1)).isoformat()
    archive_projection(c,item,item['period_start'],end,root)
   if item['period_end']>month_end:
    start=(dt.date.fromisoformat(month_end)+dt.timedelta(days=1)).isoformat()
    archive_projection(c,item,start,item['period_end'],root)
  ref=c.execute("SELECT r.* FROM history_references r JOIN history_meta m ON m.key='current_reference' AND m.value=r.id").fetchone()
  imp=c.execute("INSERT INTO history_imports(sha256,filename,original_path,period_start,period_end,imported_at,state,row_count,value_cents,quantity_micros,reference_id) VALUES(?,?,?,?,?,?,'active',?,?,?,?)",(summary['fileHash'],request['filename'],'client-sales-originals/'+summary['fileHash']+'.xlsx',summary['from'],summary['through'],h.now(),summary['rows'],summary['valueCents'],summary['quantityMicros'],ref['id'])).lastrowid
  identities={(r['client_code'],r['franchise_code']):r['id'] for r in c.execute('SELECT * FROM history_identities')}
  new_identities=0
  for r in rows:
   v=r['raw'];key=(h.code_key(v['Cod Client']),h.code_key(v['Cod_Franciza']));identity=identities.get(key)
   if identity is None:
    identity=c.execute('INSERT INTO history_identities(client_code,franchise_code) VALUES(?,?)',key).lastrowid;identities[key]=identity;new_identities+=1
   raw=h.dump(v)
   values=(imp,r['sheet'],r['row'],r['date'],identity,v['SiteId'],v['TR'],v['TRVechi'],v['Regional'],v['Nr'],v['ItemCode'],v['ItemName'],v['Denumire Client'],v['Brand'],v['ItemType'],v['TipArticol'],v['Categorie'],r['quantity_micros'],r['price_cents'],r['value_cents'],r['quality_issue'],h.sha(raw.encode()),raw)
   c.execute('INSERT INTO history_rows VALUES('+','.join('?' for _ in values)+')',values)
  if new_identities:
   # Keep exactly the resolver inputs, not the unrelated CRM/UI payload on every upload.
   partners=json.loads(ref['partners_json'])
   fields=('id','cui','county','city','address','historyFranchises','historyCatalog','active')
   compact={'partners':[{k:p[k] for k in fields if k in p} for p in partners['partners']]}
   master_fields=('Cod_Franciza','CIF','PartnerCode','Judet','Oras','Street')
   master=[{k:p[k] for k in master_fields if k in p} for p in json.loads(ref['master_json'])]
   temp=pathlib.Path(request['source']).parent
   partner_path=temp/'reference-partners.json';master_path=temp/'reference-master.json'
   partner_path.write_text(h.dump(compact));master_path.write_text(h.dump(master))
   new_ref,_=h.store_reference(c,partner_path,master_path)
   c.execute('UPDATE history_imports SET reference_id=? WHERE id=?',(new_ref,imp))
   partner_path.unlink();master_path.unlink()
  for item in old:c.execute("UPDATE history_imports SET state='superseded' WHERE id=?",(item['id'],))
  stored=c.execute('SELECT COUNT(*),COALESCE(SUM(value_cents),0),COALESCE(SUM(quantity_micros),0) FROM history_rows WHERE import_id=?',(imp,)).fetchone()
  if tuple(stored)!=(summary['rows'],summary['valueCents'],summary['quantityMicros']):raise UploadError('Totalurile importului nu coincid cu fișierul.')
  if c.execute('PRAGMA foreign_key_check').fetchone():raise UploadError('Validarea asocierilor a eșuat.')
  c.commit()
 except BaseException:c.rollback();raise
 # Retain two local recovery generations; archived originals and scheduled backups remain.
 for path in sorted(backup_dir.glob('*.sqlite'),key=lambda p:p.stat().st_mtime,reverse=True)[2:]:path.unlink()
 return {**current,'status':'imported','importId':imp}

def main():
 request=json.loads(pathlib.Path(sys.argv[1]).read_text())
 root=pathlib.Path(request['directory'])/'client-history'
 emit('parsing','Se verifică fișierul cumulativ…')
 rows,summary,month_end=parse_upload(request['source'])
 with open(root/'.upload.lock','a') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise UploadError('Un alt import este în curs. Așteaptă finalizarea și reia previzualizarea.')
  c=open_history(request['directory'])
  try:
   if request['operation']=='preview':
    c.execute('BEGIN')
    result=preview(c,rows,summary,month_end)
   elif request['operation']=='import':result=apply(c,rows,summary,month_end,request,root)
   else:raise UploadError('Operațiune necunoscută.')
  finally:c.close()
 print(h.dump({'result':result}),flush=True)

if __name__=='__main__':
 try:main()
 except (UploadError,ValueError,zipfile.BadZipFile,KeyError,StopIteration) as e:
  print(h.dump({'error':str(e) or 'Fișier Excel invalid.'}),flush=True);sys.exit(1)
