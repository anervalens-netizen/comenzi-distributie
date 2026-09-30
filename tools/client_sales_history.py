#!/usr/bin/env python3
"""Independent per-customer history. Never opens the application/TR sales databases.
Python standard library only. Input XLSX snapshots are immutable; repeated lines are facts.
"""
from __future__ import annotations
import argparse, collections, datetime as dt, decimal, hashlib, json, os, pathlib, re, shutil, sqlite3, tempfile, unicodedata, zipfile
import xml.etree.ElementTree as ET
D=decimal.Decimal
NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
HEADERS=['Data','Regional','TR','ItemCode','ItemName','Cantitate','Brand','Pret','Valoare','PretFD','Denumire Client','Nr','TRVechi','ItemType','Cod Client','SiteId','TipArticol','PriceWithVAT','Categorie','Cod_Franciza']
RULE_VERSION='customer-history-v1.2'
def dump(v):return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def sha(v):return hashlib.sha256(v).hexdigest()
def file_sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def norm(v):
 return re.sub(r'\s+',' ',''.join(c for c in unicodedata.normalize('NFD',str(v or '').strip().upper()) if not unicodedata.combining(c)))
def code_key(v):return str(v or '').strip().upper()
def cui_key(v):
 v=re.sub(r'[^A-Z0-9]','',code_key(v))
 return v[2:] if v.startswith('RO') else v
def place(r):return (norm(r.get('county')),norm(r.get('city')),norm(r.get('address')))
def master_place(r):return (norm(r.get('Judet')),norm(r.get('Oras')),norm(r.get('Street')))
def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def iso(v,epoch1904=False):
 v=str(v).strip()
 for fmt in ('%d.%m.%Y','%Y-%m-%d','%d/%m/%Y'):
  try:return dt.datetime.strptime(v,fmt).date().isoformat()
  except ValueError:pass
 if re.fullmatch(r'\d+(?:\.0+)?',v):
  n=int(D(v))
  if not epoch1904 and n==60:raise ValueError('Invalid Excel leap date')
  origin=dt.date(1904,1,1) if epoch1904 else dt.date(1899,12,30)
  if not epoch1904 and n<60:n+=1
  return (origin+dt.timedelta(days=n)).isoformat()
 raise ValueError('Invalid date: '+v)
def scaled(v,scale):
 try:n=D(str(v).strip().replace(',','.'))
 except decimal.InvalidOperation:raise ValueError('Invalid numeric value')
 if not n.is_finite():raise ValueError('Nonfinite numeric value')
 q=n*scale;i=q.quantize(D(1),rounding=decimal.ROUND_HALF_UP)
 if abs(q-i)>D('0.00001'):raise ValueError('Unsupported numeric precision')
 if abs(i)>2**62:raise ValueError('Numeric range overflow')
 return int(i)
def xlsx_rows(z,path,formats=None):
 strings=[]
 if 'xl/sharedStrings.xml' in z.namelist():
  with z.open('xl/sharedStrings.xml') as f:
   context=ET.iterparse(f,events=('start','end'));_,root=next(context)
   for event,e in context:
    if event=='end' and e.tag.endswith('}si'):
     strings.append(''.join(t.text or '' for t in e.iter() if t.tag.endswith('}t')))
     e.clear();root.clear()
 with z.open(path) as f:
  context=ET.iterparse(f,events=('start','end'));_,root=next(context)
  for event,e in context:
   if event!='end' or not e.tag.endswith('}row'):continue
   cells={}
   for c in e:
    ref=c.get('r','');letters=re.sub(r'\d','',ref);i=0
    for x in letters:i=i*26+ord(x)-64
    if not i:continue
    ve=c.find('s:v',NS);v=ve.text if ve is not None and ve.text is not None else ''
    typ=c.get('t','n')
    if typ=='s' and v:v=strings[int(v)]
    elif typ=='inlineStr':v=''.join(t.text or '' for t in c.iter() if t.tag.endswith('}t'))
    if typ=='e':raise ValueError('Excel error at '+ref)
    if c.find('s:f',NS) is not None and not v:raise ValueError('Uncached formula at '+ref)
    fmt=(formats or {}).get(int(c.get('s','0')),'General')
    if i-1 in (3,11,14,15,19) and typ=='n' and v:
     n=D(v)
     if n!=n.to_integral_value() or abs(n)>=D('1e15'):raise ValueError('Ambiguous numeric identifier '+ref)
     if fmt in ('General','@','0'):v=str(int(n))
     elif re.fullmatch('0{1,100}',fmt):v=str(abs(int(n))).zfill(len(fmt)) if n>=0 else '-'+str(abs(int(n))).zfill(len(fmt))
     else:raise ValueError('Unsupported identifier number format '+ref)
    cells[i-1]=v
   yield int(e.get('r')), [cells.get(i,'') for i in range(max(cells,default=-1)+1)]
   e.clear();root.clear()
def workbook(path):
 with zipfile.ZipFile(path) as z:
  if sum(x.file_size for x in z.infolist())>2_000_000_000:raise ValueError('Workbook uncompressed size limit')
  root=ET.fromstring(z.read('xl/workbook.xml'))
  prop=root.find('s:workbookPr',NS);epoch=prop is not None and prop.get('date1904') in ('1','true')
  rels={x.get('Id'):x.get('Target') for x in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
  sheets=root.find('s:sheets',NS)
  if len(sheets)!=1:raise ValueError('Provide one data sheet; refusing to silently omit other sheets')
  sheet=sheets[0];target=rels[sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
  target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
  formats={}
  if 'xl/styles.xml' in z.namelist():
   styles=ET.fromstring(z.read('xl/styles.xml'))
   custom={int(x.get('numFmtId')):x.get('formatCode') for x in styles.findall('s:numFmts/s:numFmt',NS)}
   formats={i:custom.get(int(x.get('numFmtId','0')),{0:'General',1:'0',49:'@'}.get(int(x.get('numFmtId','0')),'unsupported')) for i,x in enumerate(styles.findall('s:cellXfs/s:xf',NS))}
  header=None;start=end=None
  for rn,r in xlsx_rows(z,target,formats):
   if not any(r):continue
   if header is None:
    if r[0]=='Data Start':start=iso(r[1],epoch)
    elif r[0]=='Data Stop':end=iso(r[1],epoch)
    elif 'Cod Client' in r:
     if r!=HEADERS:raise ValueError('Unexpected or duplicate header; explicit mapping required')
     if not start or not end or start>end:raise ValueError('Declared complete reporting period required')
     header=r;yield 'metadata',{'sheet':sheet.get('name'),'start':start,'end':end,'header':r}
    elif rn>20:raise ValueError('Header not found')
    continue
   if len(r)>len(header) and any(r[len(header):]):raise ValueError('Unexpected extra columns')
   r=r+['']*(len(header)-len(r));v=dict(zip(header,r))
   date=iso(v['Data'],epoch)
   if not start<=date<=end:raise ValueError('Transaction outside declared period at row '+str(rn))
   yield 'row',{'sheet':sheet.get('name'),'row':rn,'date':date,'raw':v,'quantity_micros':scaled(v['Cantitate'],1_000_000),'price_cents':scaled(v['Pret'],100) if v['Pret'].strip() else None,'value_cents':scaled(v['Valoare'],100) if v['Valoare'].strip() else None,'quality_issue':','.join(k+'_missing' for k in ('Pret','Valoare') if not v[k].strip())}
  if header is None:raise ValueError('Header not found')
class Resolver:
 def __init__(self,partners,master,source_identities=()):
  self.partners=collections.defaultdict(list);self.master=collections.defaultdict(list);self.franchises=collections.defaultdict(list);self.aliases=collections.defaultdict(set)
  self.named_franchises=collections.defaultdict(list);self.partner_codes=collections.defaultdict(set);self.source_codes=collections.defaultdict(set)
  for p in partners:
   codes={code_key(v) for v in p.get('historyFranchises',[])}|{code_key(p.get('historyCatalog',{}).get('franchiseCode'))}
   for code in codes-{''}:self.named_franchises[code].append(p)
   self.partner_codes[cui_key(p.get('cui'))]|=codes-{''}
   if cui_key(p.get('cui')):self.partners[cui_key(p['cui'])].append(p)
  for r in master:
   key=code_key(r.get('Cod_Franciza'));cui=cui_key(r.get('CIF'));client=cui_key(r.get('PartnerCode'))
   if key:self.franchises[key].append(r)
   if cui:self.master[cui].append(r)
   if client and cui:self.aliases[client].add(cui)
  for identity in source_identities:
   client=cui_key(identity['client_code']);code=code_key(identity['franchise_code'])
   if code:
    for company in self.aliases.get(client,{client}):self.source_codes[company].add(code)
 def resolve(self,client,franchise):
  client=cui_key(client);franchise=code_key(franchise)
  def result(status,point=None,ids=(),reason='',candidates=()):
   return {'status':status,'point_key':point,'partner_ids':sorted(set(ids)),'reason':reason,'candidates':sorted(set(candidates))}
  if franchise:
   refs=self.franchises.get(franchise,[])
   named=self.named_franchises.get(franchise,[])
   possible={client}|self.aliases.get(client,set())
   named_owners={cui_key(p.get('cui')) for p in named}
   if named and (len(named_owners)!=1 or (client and client!='CLIENTGEN' and not named_owners.issubset(possible))):
    return result('reconcile',reason='Conflicting stored franchise ownership',candidates=[p['id'] for p in named])
   # Explicit code remains the direct work-point identity even outside a partial master.
   if not refs:return result('direct_code','franchise:'+franchise,[p['id'] for p in named],reason='Stored franchise association' if named else 'Code present; address/partner link absent from partial master')
   identities={(cui_key(r.get('CIF')),master_place(r)) for r in refs}
   if len(identities)!=1:return result('reconcile',reason='Conflicting master entries for franchise',candidates=[franchise])
   cui,address=next(iter(identities))
   possible={client}|self.aliases.get(client,set())
   if client and client!='CLIENTGEN' and cui and cui not in possible:return result('reconcile',reason='Franchise/client mismatch',candidates=[franchise])
   if named and named_owners!={cui}:return result('reconcile',reason='Stored franchise conflicts with master ownership',candidates=[p['id'] for p in named])
   matches=named or [p for p in self.partners.get(cui,[]) if place(p)==address and address[2]]
   return result('direct_code','franchise:'+franchise,[p['id'] for p in matches],'Explicit franchise code'+(' with exact partner address link' if matches else '; current partner address link unresolved'))
  if client=='CLIENTGEN':return result('consumer',reason='Direct fiscal receipt; no business work point')
  if not client:return result('reconcile',reason='Missing client and franchise')
  possible=self.aliases.get(client,{client})|({client} if client in self.partners else set())
  if len(possible)!=1:return result('reconcile',reason='Ambiguous client-to-tax-ID mapping')
  cui=next(iter(possible));partners=self.partners.get(cui,[])
  if not partners:return result('reconcile',reason='Client absent from Partners')
  locations={place(p) for p in partners}
  if len(locations)!=1 or any(not x[2] or not x[1] for x in locations):
   return result('reconcile',reason='Multiple or incomplete known work-point addresses',candidates=[p['id'] for p in partners])
  address=next(iter(locations))
  refs=self.master.get(cui,[]);known={master_place(r) for r in refs}
  if known and (len(known)>1 or address not in known):
   return result('reconcile',reason='Master contains other work-point addresses',candidates=[code_key(r.get('Cod_Franciza')) for r in refs])
  codes={code_key(r.get('Cod_Franciza')) for r in refs if code_key(r.get('Cod_Franciza'))}
  codes|=self.partner_codes[cui]
  if self.source_codes[cui]-codes:
   return result('reconcile',reason='Source contains work-point codes not yet associated with the known address',candidates=[p['id'] for p in partners])
  if len(codes)>1:return result('reconcile',reason='Multiple franchise identities at address',candidates=codes)
  point='franchise:'+next(iter(codes)) if codes else 'partner:'+sha(dump([cui,*address]).encode())
  return result('single_partner',point,[p['id'] for p in partners],'Unique identified Partner with complete address across current and historical references')
SCHEMA="""
CREATE TABLE IF NOT EXISTS history_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO history_meta VALUES('schema_version','1');
CREATE TABLE IF NOT EXISTS history_references(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,rule_version TEXT NOT NULL,partners_json TEXT NOT NULL,master_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history_imports(id INTEGER PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,original_path TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,imported_at TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('staged','active','superseded')),row_count INTEGER NOT NULL DEFAULT 0,value_cents INTEGER NOT NULL DEFAULT 0,quantity_micros INTEGER NOT NULL DEFAULT 0,reference_id TEXT NOT NULL REFERENCES history_references(id));
CREATE TABLE IF NOT EXISTS history_identities(id INTEGER PRIMARY KEY,client_code TEXT NOT NULL,franchise_code TEXT NOT NULL,UNIQUE(client_code,franchise_code));
CREATE TABLE IF NOT EXISTS history_allocations(identity_id INTEGER NOT NULL REFERENCES history_identities(id),reference_id TEXT NOT NULL REFERENCES history_references(id),status TEXT NOT NULL CHECK(status IN ('direct_code','single_partner','consumer','reconcile')),point_key TEXT,partner_ids_json TEXT NOT NULL,reason TEXT NOT NULL,candidates_json TEXT NOT NULL,PRIMARY KEY(identity_id,reference_id));
CREATE TABLE IF NOT EXISTS history_rows(import_id INTEGER NOT NULL REFERENCES history_imports(id),sheet TEXT NOT NULL,source_row INTEGER NOT NULL,date TEXT NOT NULL,identity_id INTEGER NOT NULL REFERENCES history_identities(id),site_id TEXT NOT NULL,tr TEXT NOT NULL,tr_old TEXT NOT NULL,regional TEXT NOT NULL,document_number TEXT NOT NULL,item_code TEXT NOT NULL,item_name TEXT NOT NULL,customer_name TEXT NOT NULL,brand TEXT NOT NULL,item_type TEXT NOT NULL,article_type TEXT NOT NULL,category TEXT NOT NULL,quantity_micros INTEGER NOT NULL,price_cents INTEGER,value_cents INTEGER,quality_issue TEXT NOT NULL,row_hash TEXT NOT NULL,raw_json TEXT NOT NULL,PRIMARY KEY(import_id,sheet,source_row));
CREATE INDEX IF NOT EXISTS history_rows_date ON history_rows(date,import_id);
CREATE INDEX IF NOT EXISTS history_rows_identity_date ON history_rows(identity_id,date,import_id);
CREATE INDEX IF NOT EXISTS history_rows_site_date ON history_rows(site_id,date,import_id);
CREATE INDEX IF NOT EXISTS history_rows_hash ON history_rows(import_id,row_hash);
CREATE INDEX IF NOT EXISTS history_allocations_point ON history_allocations(reference_id,point_key,identity_id);
CREATE VIEW IF NOT EXISTS history_current AS SELECT r.*,i.client_code,i.franchise_code,a.status allocation_status,a.point_key,a.partner_ids_json,a.reason allocation_reason FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active' JOIN history_identities i ON i.id=r.identity_id JOIN history_allocations a ON a.identity_id=r.identity_id AND a.reference_id=(SELECT value FROM history_meta WHERE key='current_reference');
"""
def connect(path):
 p=pathlib.Path(path).resolve()
 # Refuse both names and any existing unrelated schema, including copies/symlinks.
 if p.name!='client-sales-history.sqlite':raise ValueError('Dedicated filename client-sales-history.sqlite required')
 p.parent.mkdir(parents=True,exist_ok=True)
 c=sqlite3.connect(p,timeout=30);c.row_factory=sqlite3.Row
 tables={r[0] for r in c.execute("select name from sqlite_master where type='table'")}
 if tables and ('history_meta' not in tables or any(not t.startswith('history_') and t!='sqlite_sequence' for t in tables)):
  c.close();raise ValueError('Refusing unrelated/application database')
 if tables and c.execute("select value from history_meta where key='schema_version'").fetchone()[0]!='1':raise ValueError('Unsupported schema version')
 c.execute('PRAGMA foreign_keys=ON');c.execute('PRAGMA journal_mode=WAL');c.executescript(SCHEMA);c.commit()
 return c
def store_reference(c,partners_path,master_path):
 partners=json.loads(pathlib.Path(partners_path).read_text());master=json.loads(pathlib.Path(master_path).read_text())
 rows=partners['partners'] if isinstance(partners,dict) else partners
 identities=[dict(r) for r in c.execute('SELECT client_code,franchise_code FROM history_identities ORDER BY client_code,franchise_code')]
 reference_partners=dict(partners) if isinstance(partners,dict) else {'partners':partners}
 reference_partners['historySourceIdentities']=identities
 ref=sha(dump([RULE_VERSION,reference_partners,master]).encode())
 resolver=Resolver(rows,master,identities)
 c.execute('INSERT OR IGNORE INTO history_references VALUES(?,?,?,?,?)',(ref,now(),RULE_VERSION,dump(reference_partners),dump(master)))
 for r in c.execute('SELECT * FROM history_identities').fetchall():add_allocation(c,r['id'],r['client_code'],r['franchise_code'],ref,resolver)
 c.execute("INSERT INTO history_meta VALUES('current_reference',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(ref,))
 return ref,resolver
def add_allocation(c,identity,client,franchise,ref,resolver):
 a=resolver.resolve(client,franchise)
 c.execute('INSERT OR IGNORE INTO history_allocations VALUES(?,?,?,?,?,?,?)',(identity,ref,a['status'],a['point_key'],dump(a['partner_ids']),a['reason'],dump(a['candidates'])))
def archive_source(source,folder):
 source=pathlib.Path(source).resolve();folder=pathlib.Path(folder);folder.mkdir(parents=True,exist_ok=True)
 if source.suffix.lower()!='.xlsx':raise ValueError('XLSX required')
 fd,tmp=tempfile.mkstemp(dir=folder,suffix='.pending');os.close(fd)
 try:
  shutil.copyfile(source,tmp);h=file_sha(tmp);dest=folder/(h+'.xlsx')
  if dest.exists():
   if file_sha(dest)!=h:raise ValueError('Archived source checksum mismatch')
  else:
   os.chmod(tmp,0o600);os.replace(tmp,dest)
  return h,dest
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def import_file(c,source,partners,master,replace=False,allow_regression=False):
 h,original=archive_source(source,pathlib.Path(c.execute('PRAGMA database_list').fetchone()[2]).parent/'client-sales-originals')
 stream=workbook(original);kind,meta=next(stream)
 if kind!='metadata':raise ValueError('Missing metadata')
 c.execute('BEGIN IMMEDIATE')
 try:
  previous=c.execute('SELECT * FROM history_imports WHERE sha256=?',(h,)).fetchone()
  if previous:
   c.rollback()
   return {'status':'already_imported','import_id':previous['id'],'state':previous['state'],'rows':previous['row_count']}
  overlapping=c.execute("SELECT * FROM history_imports WHERE state='active' AND period_start<=? AND period_end>=?",(meta['end'],meta['start'])).fetchall()
  if overlapping and not replace:raise ValueError('Overlapping source period: explicit --replace required; no append/dedup guesses')
  if any(meta['start']>r['period_start'] or meta['end']<r['period_end'] for r in overlapping):raise ValueError('Replacement would omit an existing period')
  ref,resolver=store_reference(c,partners,master)
  imp=c.execute("INSERT INTO history_imports(sha256,filename,original_path,period_start,period_end,imported_at,state,reference_id) VALUES(?,?,?,?,?,?,'staged',?)",(h,pathlib.Path(source).name,str(pathlib.Path('client-sales-originals')/original.name),meta['start'],meta['end'],now(),ref)).lastrowid
  identities={(r['client_code'],r['franchise_code']):r['id'] for r in c.execute('SELECT * FROM history_identities')}
  count=value=quantity=0
  for kind,r in stream:
   v=r['raw'];key=(code_key(v['Cod Client']),code_key(v['Cod_Franciza']))
   identity=identities.get(key)
   if identity is None:
    identity=c.execute('INSERT INTO history_identities(client_code,franchise_code) VALUES(?,?)',key).lastrowid
    identities[key]=identity
   raw=dump(v);count+=1;value+=r['value_cents'] or 0;quantity+=r['quantity_micros']
   values=(imp,r['sheet'],r['row'],r['date'],identity,v['SiteId'],v['TR'],v['TRVechi'],v['Regional'],v['Nr'],v['ItemCode'],v['ItemName'],v['Denumire Client'],v['Brand'],v['ItemType'],v['TipArticol'],v['Categorie'],r['quantity_micros'],r['price_cents'],r['value_cents'],r['quality_issue'],sha(raw.encode()),raw)
   c.execute('INSERT INTO history_rows VALUES('+','.join('?' for _ in values)+')',values)
   if count%100000==0:print(dump({'event':'progress','file':pathlib.Path(source).name,'rows':count}),flush=True)
  if not count:raise ValueError('No transactions; empty snapshot refused')
  actual=c.execute('SELECT count(*),COALESCE(sum(value_cents),0),sum(quantity_micros) FROM history_rows WHERE import_id=?',(imp,)).fetchone()
  if tuple(actual)!=(count,value,quantity):raise ValueError('Source/store reconciliation failed')
  removed=0
  for old in overlapping:
   removed+=c.execute("""SELECT COALESCE(SUM(MAX(o.n-COALESCE(n.n,0),0)),0) FROM (SELECT row_hash,COUNT(*) n FROM history_rows WHERE import_id=? GROUP BY row_hash) o LEFT JOIN (SELECT row_hash,COUNT(*) n FROM history_rows WHERE import_id=? GROUP BY row_hash) n ON n.row_hash=o.row_hash""",(old['id'],imp)).fetchone()[0]
  if removed and not allow_regression:raise ValueError(str(removed)+' previous line occurrences missing/changed: --allow-regression required; original import remains active')
  c.execute("UPDATE history_imports SET row_count=?,value_cents=?,quantity_micros=?,state='active' WHERE id=?",(count,value,quantity,imp))
  for old in overlapping:c.execute("UPDATE history_imports SET state='superseded' WHERE id=?",(old['id'],))
  # New codes can make previously unique no-code rows ambiguous, including earlier rows in this import.
  ref,_=store_reference(c,partners,master)
  c.execute('UPDATE history_imports SET reference_id=? WHERE id=?',(ref,imp))
  c.commit()
  return {'status':'imported','import_id':imp,'rows':count,'value_cents':value,'quantity_micros':quantity,'removed_or_changed_occurrences':removed,'sha256':h}
 except BaseException:c.rollback();raise
def summary(c):
 return {'imports':[dict(r) for r in c.execute('SELECT id,filename,sha256,period_start,period_end,state,row_count,value_cents FROM history_imports ORDER BY id')],
 'years':[dict(r) for r in c.execute("SELECT substr(date,1,4) year,COUNT(*) rows,SUM(value_cents) value_cents,SUM(quantity_micros) quantity_micros,SUM(value_cents IS NULL) missing_value_rows,SUM(price_cents IS NULL) missing_price_rows FROM history_current GROUP BY 1")],
 'allocations':[dict(r) for r in c.execute("SELECT allocation_status,COUNT(*) rows,SUM(value_cents) value_cents,COUNT(DISTINCT identity_id) identities FROM history_current GROUP BY 1")],
 'reconciliation':[dict(r) for r in c.execute("SELECT allocation_reason,COUNT(*) rows,SUM(value_cents) value_cents FROM history_current WHERE allocation_status='reconcile' GROUP BY 1")],
 'unlinked_direct_rows':c.execute("SELECT COUNT(*) FROM history_current WHERE allocation_status='direct_code' AND partner_ids_json='[]'").fetchone()[0]}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--database',required=True);p.add_argument('--partners');p.add_argument('--locations');p.add_argument('--file',action='append',default=[]);p.add_argument('--replace',action='store_true');p.add_argument('--allow-regression',action='store_true');p.add_argument('--reconcile',action='store_true');p.add_argument('--summary-json')
 a=p.parse_args();c=connect(a.database)
 if a.file or a.reconcile:
  if not a.partners or not a.locations:p.error('--partners and --locations required')
 for file in a.file:print(dump(import_file(c,file,a.partners,a.locations,a.replace,a.allow_regression)),flush=True)
 if a.reconcile:
  with c:store_reference(c,a.partners,a.locations)
 s=summary(c)
 if a.summary_json:pathlib.Path(a.summary_json).write_text(json.dumps(s,ensure_ascii=False,indent=2))
 print(dump(s),flush=True)
 c.execute('PRAGMA wal_checkpoint(TRUNCATE)');c.close()
if __name__=='__main__':main()
