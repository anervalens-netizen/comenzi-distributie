import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve('work/qa'),history=join(root,'client-history'),origin='http://127.0.0.1:3000',api=origin+'/api/client-sales/import';
assert(!existsSync(history),'Requires absent isolated history fixture');
const app=new DatabaseSync(join(root,'mobiup.sqlite')),sessions={},hashes=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 for(const id of ['qa-manager','qa-regional','qa-agent2']){
  const token=randomUUID(),hash=createHash('sha256').update(token).digest('hex');hashes.push(hash);sessions[id]='mobiup_session='+token;
  app.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash,id,Date.now()+3600000);
 }
 const setup=spawnSync('python3',['-c',`
import sys,pathlib,json,zipfile,re
sys.path.insert(0,'tools')
import client_sales_history as h
from test_client_sales_history import fixture,row
root=pathlib.Path(sys.argv[1]);folder=root/'client-history';folder.mkdir()
p=folder/'partners.json';m=folder/'master.json'
p.write_text(json.dumps({'partners':[{'id':'history-upload-test','cui':'123','county':'County','city':'City','address':'Street 1','historyFranchises':['F001']}]}))
m.write_text(json.dumps([{'CIF':'123','PartnerCode':'123','Cod_Franciza':'F001','Judet':'County','Oras':'City','Street':'Street 1'}]))
c=h.connect(folder/'client-sales-history.sqlite')
initial=folder/'initial.xlsx';fixture(initial,[row(Data='01.01.2024')],'2024-01-01','2024-01-31');h.import_file(c,initial,p,m);c.close()
for name,records in [('daily',[row(Data='01.02.2024')]),('cumulative',[row(Data='01.02.2024'),row(Data='02.02.2024')]),('corrected',[row(Data='01.02.2024',Valoare='18',Pret='9')])]:
 path=folder/(name+'.xlsx');fixture(path,records,'2024-02-01','2024-02-29')
 with zipfile.ZipFile(path) as z:files={n:z.read(n) for n in z.namelist()}
 key='xl/worksheets/sheet1.xml';files[key]=re.sub(rb'<row r="[1-4]">.*?</row>',b'',files[key])
 with zipfile.ZipFile(path,'w') as z:
  for key,data in files.items():z.writestr(key,data)
`,root],{encoding:'utf8'});
 assert.equal(setup.status,0,setup.stderr);
 app.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run('history-upload-test','g-5',JSON.stringify({id:'history-upload-test',name:'Client sintetic import',cui:'123',warehouseIds:['g-5']}));
 async function call(path='',options={},expected=200,user='qa-manager'){
  const response=await fetch(api+path,{...options,headers:{Cookie:sessions[user],...options.headers}});
  const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));assert.equal(response.headers.get('Cache-Control'),'no-store');return body;
 }
 async function poll(id){
  for(let n=0;n<150;n++){const {job}=await call('/status?job='+id);if(job.state!=='running')return job;await sleep(100);}
  throw Error('Job did not finish');
 }
 async function upload(name='daily'){
  const {job}=await call('/preview',{method:'POST',headers:{'X-Client-Sales-Filename':name+'.xlsx'},body:readFileSync(join(history,name+'.xlsx'))},202);
  const ready=await poll(job.id);assert.equal(ready.state,'ready',ready.error);assert(!JSON.stringify(ready).includes(root),'Private paths never exposed');return ready;
 }
 async function commit(job,ack=false){
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:job.id,allowRegression:ack})};
  await call('',options,202);const done=await poll(job.id);assert.equal(done.state,'completed',done.error);
  await call('',options,200);return done;
 }
 await call('/status',{},403,'qa-agent2');
 assert.equal((await fetch(api+'/status')).status,401);
 await call('/preview',{method:'POST',headers:{Origin:'https://outside.invalid'}},403);
 await call('/preview',{method:'POST',headers:{'X-Client-Sales-Filename':'../bad.xlsx'},body:'bad'},400);
 const invalid=await call('/preview',{method:'POST',headers:{'X-Client-Sales-Filename':'bad.xlsx'},body:'bad'},202);
 assert.equal((await poll(invalid.job.id)).state,'failed');
 let ready=await upload();assert.equal(ready.preview.rows,1);assert.equal(ready.preview.requiresAcknowledgement,false);
 assert.equal((await call('/status')).job.id,ready.id,'Returning to Settings resumes persisted job');
 await call('/status?job='+ready.id,{},404,'qa-regional');
 await commit(ready);
 ready=await upload('cumulative');assert.equal(ready.preview.rows,2);assert.equal(ready.preview.addedOccurrences,1);await commit(ready);
 const c=new DatabaseSync(join(history,'client-sales-history.sqlite'));
 const facts=()=>c.prepare('SELECT date,value_cents FROM history_current ORDER BY date').all();
 assert.equal(facts().length,3);
 ready=await upload('cumulative');assert.equal(ready.preview.alreadyImported,true);
 const before=JSON.stringify(facts());await commit(ready);assert.equal(JSON.stringify(facts()),before,'Repeated cumulative source is idempotent');
 ready=await upload('corrected');assert(ready.preview.requiresAcknowledgement);assert(ready.preview.coverageShorter);
 await call('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:ready.id})},409);
 assert.equal(JSON.stringify(facts()),before,'Unconfirmed correction leaves history unchanged');
 await commit(ready,true);assert.equal(facts().length,2);assert.equal(facts()[1].value_cents,1800);
 const activity=new DatabaseSync(join(history,'partner-activity.sqlite'),{readOnly:true});
 assert.equal(JSON.parse(activity.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value).signature.length,64);
 activity.close();assert.equal(c.prepare('PRAGMA integrity_check').get().integrity_check,'ok');c.close();
 assert.equal((await call('/status')).latest.filename,'corrected.xlsx');
 console.log('PASS: authenticated HTTP upload, persisted progress, ownership, CSRF, malformed file, preview, cumulative import, repeated commit/source, explicit corrections and rebuilt snapshot.');
}finally{
 app.prepare("DELETE FROM customers WHERE id='history-upload-test'").run();
 for(const hash of hashes)app.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
 app.close();rmSync(history,{recursive:true,force:true});
}
