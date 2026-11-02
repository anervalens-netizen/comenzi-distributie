#!/usr/bin/env python3
"""Read-only SIM previews and receipt-backed atomic activation publication."""
import contextlib,datetime,fcntl,gzip,hashlib,json,os,shutil,sqlite3,sys,time,uuid,zipfile,xml.etree.ElementTree as ET
from pathlib import Path
import activations
import activation_job
import activation_projection

NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
publication_possible=False

def digest(path):
 with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def metadata_period(path,sheet_name='SIM'):
 # Metadata is optional, but a partial declaration is rejected.
 with zipfile.ZipFile(path) as z:
  book=ET.fromstring(z.read('xl/workbook.xml'))
  sheets=[s for s in book.findall(NS+'sheets/'+NS+'sheet') if s.get('name')==sheet_name]
  if len(sheets)!=1:raise ValueError('Source worksheet missing')
  rel_id=sheets[0].get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
  rel=next((x for x in ET.fromstring(z.read('xl/_rels/workbook.xml.rels')) if x.get('Id')==rel_id),None)
  if rel is None or rel.get('TargetMode')=='External':raise ValueError('Invalid worksheet relationship')
  target=rel.get('Target','')
  if '..' in target.split('/'):raise ValueError('Invalid worksheet path')
  target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
  cells={};wanted={}
  with z.open(target) as stream:
   for _,element in ET.iterparse(stream,events=('end',)):
    if element.tag!=NS+'row':continue
    n=int(element.get('r','0'))
    if n in (1,2):
     for cell in element:
      ref=cell.get('r')
      if ref not in ('A1','A2','B1','B2'):continue
      if cell.find(NS+'f') is not None:raise ValueError('Formula in metadata')
      if cell.get('t')=='s':
       value=cell.findtext(NS+'v');wanted.setdefault(int(value),[]).append(ref)
      else:cells[ref]=''.join(cell.itertext())
    element.clear()
    if n>=2:break
  if wanted:
   with z.open('xl/sharedStrings.xml') as stream:
    index=0
    for _,element in ET.iterparse(stream,events=('end',)):
     if element.tag==NS+'si':
      if index in wanted:
       for ref in wanted[index]:cells[ref]=''.join(element.itertext())
      element.clear();index+=1
      if index>max(wanted):break
  start=cells.get('A1')=='Data Start';end=cells.get('A2')=='Data Stop'
  if start!=end:raise ValueError('Incomplete period metadata')
  if not start:return None
  return datetime.date.fromisoformat(cells.get('B1','')).isoformat(),datetime.date.fromisoformat(cells.get('B2','')).isoformat()

def json_records(path):
 # Incremental JSON array decoder; bounded single-record buffer and no full extraction.
 decoder=json.JSONDecoder();buffer='';started=False;expect_value=True;ended=False;index=0;after_comma=False
 with gzip.open(path,'rt',encoding='utf8') as stream:
  eof=False
  while True:
   if not eof and len(buffer)<1048576:
    chunk=stream.read(65536);eof=not chunk;buffer+=chunk
   buffer=buffer.lstrip()
   if not started:
    if not buffer and not eof:continue
    if not buffer.startswith('['):raise ValueError('Invalid operator array')
    started=True;buffer=buffer[1:];continue
   if ended:
    if buffer.strip():raise ValueError('Trailing operator data')
    if eof:return
    continue
   if not buffer:
    if eof:raise ValueError('Incomplete operator array')
    continue
   if expect_value:
    if buffer[0]==']':
     if after_comma:raise ValueError('Invalid array')
     ended=True;buffer=buffer[1:];continue
    try:value,pos=decoder.raw_decode(buffer)
    except json.JSONDecodeError:
     if eof or len(buffer)>16*1024*1024:raise ValueError('Invalid operator record')
     chunk=stream.read(65536);eof=not chunk;buffer+=chunk;continue
    if not isinstance(value,dict):raise ValueError('Invalid operator record')
    index+=1
    if index>1_000_000:raise ValueError('Operator row limit')
    yield index,value;buffer=buffer[pos:];expect_value=False;after_comma=False
   elif buffer[0]==',':buffer=buffer[1:];expect_value=True;after_comma=True
   elif buffer[0]==']':ended=True;buffer=buffer[1:]
   else:raise ValueError('Invalid operator separator')

def published(root):
 pointer=root/'current'
 if not pointer.is_symlink():raise ValueError('Current generation unavailable')
 current=pointer.resolve(strict=True)
 if current.parent!=(root/'generations').resolve() or not current.is_dir():raise ValueError('Invalid current generation')
 return current

def ro(path):return contextlib.closing(sqlite3.connect(path.resolve(strict=True).as_uri()+'?mode=ro',uri=True))

def environment(job):
 kind=job['kind'];provider='digi' if kind.endswith('_digi') else 'vodafone'
 internal=kind.startswith('sim_sales_')
 base=Path(os.environ.get('MOBIUP_ACTIVATIONS_DIR') or os.environ['MOBIUP_DATA_DIR']).resolve(strict=True)
 root=(base/'digi' if provider=='digi' else base).resolve(strict=True)
 current=published(root);settings=Path(os.environ['MOBIUP_DATA_DIR']).resolve(strict=True)/'mobiup.sqlite'
 with ro(settings) as c:row=c.execute("SELECT value FROM settings WHERE key='distribution-rules-v1'").fetchone()
 if not row:raise ValueError('Missing distribution rules')
 rules=json.loads(row[0]);activation_projection.validate_rules(rules)
 with ro(current/'activations.sqlite') as c:
  providers={x[0] for x in c.execute('SELECT DISTINCT operator FROM activation_imports')}
  if providers and providers!={provider}:raise ValueError('Provider mismatch')
  aliases=None
  if provider=='digi':
   alias_row=c.execute("SELECT value FROM activation_meta WHERE key='digi_site_aliases'").fetchone()
   if not alias_row:raise ValueError('Digi aliases unavailable')
   values=json.loads(alias_row[0]);aliases={(a,b):site for a,b,site in values}
   if len(aliases)!=len(values):raise ValueError('Ambiguous Digi aliases')
 return provider,internal,root,current,settings,row[0],rules,aliases

def run(request):
 global publication_possible
 publication_possible=False
 job=request['job'];source=job['source'];action=request['action'];action_id=request['action_id']
 if str(uuid.UUID(job['id']))!=job['id'] or str(uuid.UUID(action_id))!=action_id:raise ValueError('Invalid operation ID')
 provider,internal,root,current,settings,raw_rules,rules,aliases=environment(job)
 if request['mode']=='reconcile':
  if action=='preview':return {'state':'not_committed'}
  with ro(current/'activations.sqlite') as c:row=c.execute('SELECT value FROM activation_meta WHERE key=?',('import_action_receipt:'+action_id,)).fetchone()
  if row:
   receipt=json.loads(row[0])
   if receipt.get('verified') is True and receipt.get('source_sha256')==source['sha256']:
    return {'state':'completed','receipt':receipt,'result':{'generation':receipt.get('generation'),'provider':provider}}
  return {'state':'uncertain','error':{'code':'reconciliation_required','message':'Rezultatul necesită verificare; importul nu a fost reluat.'}}
 start=datetime.date.fromisoformat(source['date_start']).isoformat();end=datetime.date.fromisoformat(source['date_end']).isoformat();source_at=datetime.date.fromisoformat(source['source_at']).isoformat()
 if start>end or end>source_at:raise ValueError('Invalid period')
 folder=Path(os.environ['MOBIUP_DATA_DIR']).resolve(strict=True)/'import-engine-spool'/job['id']
 if folder.is_symlink() or not folder.is_dir() or folder.parent.is_symlink():raise ValueError('Invalid source directory')
 suffix='.json.gz' if source['filename'].lower().endswith('.json.gz') else '.xlsx'
 path=folder/('source'+suffix)
 if path.is_symlink() or not path.is_file() or path.stat().st_size!=source['size'] or digest(path)!=source['sha256']:raise ValueError('Invalid frozen source')
 company=(job.get('payload') or {}).get('company','')
 if not internal and (not isinstance(company,str) or not company.strip() or company!=company.strip()):raise ValueError('Missing company')
 if suffix=='.xlsx':
  period=metadata_period(path,'SIM' if internal else 'activari' if provider=='digi' else 'Detailed SIM')
  if period is not None and period!=(start,end):raise ValueError('Workbook period mismatch')
 if action=='preview':
  count=0;earliest=None;latest=None;issues=0
  if internal:
   records=activations.workbook(path)
   for rownum,record in records:
    values=activations.normalized(record,source['sha256'],rownum,provider,aliases);movement=values[6]
    if movement and not start<=movement<=end:raise ValueError('Movement outside declared period')
    if movement:earliest=min(earliest or movement,movement);latest=max(latest or movement,movement)
    if json.loads(values[15]):issues+=1
    count+=1
  else:
   records=json_records(path) if suffix=='.json.gz' else activations.versions.operator_records(path,activations.workbook,provider)
   for _,record in records:
    _,observed,_,_=activations.versions.operator_values(record,provider,company)
    if not start<=observed<=end:raise ValueError('Activation outside declared period')
    earliest=min(earliest or observed,observed);latest=max(latest or observed,observed);count+=1
  if not count:raise ValueError('Empty source')
  with ro(current/'activations.sqlite') as c:
   prior=c.execute('SELECT source_kind,source_at,period_start,period_end,company FROM activation_imports WHERE sha256=? AND status=\'complete\'',(source['sha256'],)).fetchone()
  provenance=('internal' if internal else 'operator',source_at,start,end,'' if internal else company)
  if prior and tuple(prior)!=provenance:raise ValueError('Source provenance conflict')
  return {'state':'ready','preview':{'provider':provider,'sourceKind':provenance[0],'sourceAt':source_at,**({'company':company} if not internal else {}),'rows':count,'rowsWithIssues':issues,'observedStart':earliest,'observedEnd':latest,'alreadyImported':bool(prior),'generation':current.name,'rulesSha256':hashlib.sha256(raw_rules.encode()).hexdigest()}}
 if action!='commit':raise ValueError('Invalid action')
 preview=job.get('preview') or {}
 if preview.get('provider')!=provider or preview.get('generation')!=current.name or preview.get('rulesSha256')!=hashlib.sha256(raw_rules.encode()).hexdigest():raise ValueError('Preview expired')
 auth=(job.get('payload') or {}).get('commit_authorization')
 if not isinstance(auth,dict) or auth.get('userId')!=job['actor']['id']:raise ValueError('Missing authorization')
 def before_stage(locked_current):
  if locked_current!=current:raise ValueError('Generation changed before staging')
  projected=2*sum((current/name).stat().st_size for name in ('activations.sqlite','activation-report.sqlite'))+3*path.stat().st_size
  if shutil.disk_usage(root).free<40*1024**3+projected:raise ValueError('Insufficient storage reserve')
 batch={'operator':provider,'files':[str(path)],'source_kind':'internal' if internal else 'operator','source_at':source_at,'period_start':start,'period_end':end,'company':'' if internal else company}
 if provider=='digi':batch['site_aliases']=aliases
 receipt={'verified':True,'effect':'published','action_id':action_id,'source_sha256':source['sha256'],'actor':job['actor'],'declared_period':{'start':start,'end':end},'source_at':source_at,'provider':provider,'source_kind':batch['source_kind']}
 if not internal:receipt['company']=company
 def before_publish(stage):
  receipt['generation']=stage.name
  with contextlib.closing(sqlite3.connect(stage/'activations.sqlite')) as c:
   item=c.execute("SELECT source_kind,source_at,period_start,period_end,company FROM activation_imports WHERE sha256=? AND status='complete'",(source['sha256'],)).fetchone()
   if item!=(batch['source_kind'],source_at,start,end,batch['company']):raise ValueError('Source provenance mismatch')
   generation=c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0]
   c.execute('INSERT INTO activation_meta(key,value) VALUES(?,?)',('import_action_receipt:'+action_id,json.dumps(receipt,sort_keys=True,separators=(',',':'))));c.commit();c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  with ro(stage/'activation-report.sqlite') as report:
   if report.execute("SELECT value FROM report_meta WHERE key='sourceGeneration'").fetchone()[0]!=generation or report.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Invalid activation report')
 @contextlib.contextmanager
 def guard(stage):
  global publication_possible
  with activation_job.authorized_publication(settings,auth) as db:
   if published(root)!=current or digest(path)!=source['sha256']:raise ValueError('Source or generation changed')
   fresh=db.execute("SELECT value FROM settings WHERE key='distribution-rules-v1'").fetchone()
   if not fresh or fresh[0]!=raw_rules:raise ValueError('Rules changed')
   valid=db.execute('''SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.role='manager' AND u.active=1 AND u.must_change_password=0 AND u.profile_revision=? AND u.manager_scope='global' AND s.token_hash=? AND s.expires_at>?''',(auth.get('userId'),auth.get('profileVersion'),auth.get('tokenHash'),int(time.time()*1000))).fetchone()
   if not valid:raise PermissionError('Authorization expired')
   publication_possible=True
   yield
 # Share the admission lock with HTTP uploads so their growth cannot race the
 # staged-generation reserve calculation. The engine serializes other jobs.
 admission_fd=os.open(folder.parent/'.admission.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 with os.fdopen(admission_fd,'a') as admission:
  fcntl.flock(admission,fcntl.LOCK_EX)
  result=activation_job.run_job(root,[batch],rules,before_publish=before_publish,publication_guard=guard,before_stage=before_stage)
 active=published(root)
 if active.name!=result['generation']:raise ValueError('Published generation changed before readback')
 with ro(active/'activations.sqlite') as ledger:
  saved=ledger.execute('SELECT value FROM activation_meta WHERE key=?',('import_action_receipt:'+action_id,)).fetchone()
  generation=ledger.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()
 if not saved or json.loads(saved[0])!=receipt or not generation:raise ValueError('Published receipt missing')
 with ro(active/'activation-report.sqlite') as report:
  report_generation=report.execute("SELECT value FROM report_meta WHERE key='sourceGeneration'").fetchone()
  if not report_generation or report_generation[0]!=generation[0] or report.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Published report mismatch')
 return {'state':'completed','receipt':json.loads(saved[0]),'result':{'generation':active.name,'provider':provider}}

if __name__=='__main__':
 value=None
 try:
  value=json.load(sys.stdin)
  with contextlib.redirect_stdout(sys.stderr):out=run(value)
  print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
 except Exception as error:
  print(str(error),file=sys.stderr)
  rejected=isinstance(value,dict) and value.get('mode')=='execute' and not publication_possible
  print(json.dumps({'state':'failed' if rejected else 'uncertain','error':{'code':'validation_failed' if rejected else 'execution_uncertain','message':'Fișierul, perioada sau drepturile nu au putut fi validate.' if rejected else 'Rezultatul necesită verificare; importul nu a fost reluat.'}}))
