// Real built HTTP adapter, isolated synthetic data only. Run after build:server.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,copyFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {createClientSalesFixture} from './client-sales-fixture.mjs';
const root=mkdtempSync(resolve('work/detail-http-'));
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const origin='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:root,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',v=>{log+=v;});child.stderr.on('data',v=>{log+=v;});
let app;
try {
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await delay(100);}assert(ready,log);
 app=new DatabaseSync(join(root,'mobiup.sqlite'));const {partners}=createClientSalesFixture(root,true),cookies={};
 for(const [id,warehouse,role] of [['detail-agent','g-5','agent'],['detail-other','g-3','agent'],['detail-manager','','manager']]){
   app.prepare("INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,manager_scope) VALUES(?,?,?,?,?,'synthetic-not-a-credential',0,1,'global')").run(id,id,'Synthetic '+id,role,warehouse);
   const token=randomUUID();cookies[id]='mobiup_session='+token;app.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
 }
 const history=join(root,'client-history/client-sales-history.sqlite'),snapshot=join(root,'client-history/partner-activity.sqlite'),c=new DatabaseSync(history);
 c.exec('ALTER TABLE history_references ADD COLUMN partners_json TEXT; CREATE INDEX detail_rows ON history_rows(identity_id,date,import_id)');
 c.prepare('UPDATE history_references SET partners_json=?').run(JSON.stringify({partners,syntheticComment:'ș😀'.repeat(Math.ceil(50*1024*1024/6))}));c.close();
 const bundle=join(root,'batch.mjs');await build({entryPoints:['lib/partner-activity-snapshot.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'});const {buildActivitySnapshot}=await import(pathToFileURL(bundle));buildActivitySnapshot(root,'2026-09-30');
 const get=(user='detail-agent',id='monthly-a',query='scope=company&from=2026-09-01&to=2026-09-30')=>fetch(origin+'/api/partner/portfolio/'+id+'/sales?'+query,{headers:{Cookie:cookies[user]}});
 let done=false,samples=0,maxHealthMs=0;
 const light=(async()=>{while(!done){const start=performance.now();assert.equal((await fetch(origin+'/api/health')).status,200);maxHealthMs=Math.max(maxHealthMs,performance.now()-start);if(!done)samples++;await delay(5);}})();
 const start=performance.now(),responses=await Promise.all(Array.from({length:4},()=>get()));done=true;await light;
 const results=await Promise.all(responses.map(async r=>{assert.equal(r.status,200);return r.json();}));for(const result of results){assert.equal(result.totals.valueCents,3200);assert.equal(result.documents.count,1);assert.deepEqual(result,results[0]);}
 assert(samples>=4);assert(maxHealthMs<(performance.now()-start)*.7);console.log(JSON.stringify({adapter:'built HTTP',concurrent:4,referenceMiB:50,elapsedMs:Math.round(performance.now()-start),healthSamples:samples,maxHealthMs:Math.round(maxHealthMs)}));
 assert.equal((await get('detail-other')).status,404);assert.equal((await (await get('detail-other','monthly-sibling')).json()).totals.valueCents,3200);
 assert.equal((await (await get('detail-agent','monthly-a','scope=point&from=2026-09-01&to=2026-09-30')).json()).totals.valueCents,1200);
 assert.equal((await (await get('detail-manager','monthly-hidden')).json()).totals.valueCents,900000);
 // Force a fresh fingerprint, then revoke ownership while the HTTP thread yields.
 copyFileSync(snapshot,snapshot+'.new');renameSync(snapshot+'.new',snapshot);
 const pending=get();await delay(100);app.exec("UPDATE customers SET warehouse_id='g-3',data=json_set(data,'$.warehouseIds',json('[\"g-3\"]')) WHERE id='monthly-a'");
 assert([404,503].includes((await pending).status),'a yielding detail cannot publish facts after ownership is revoked');
 app.exec("UPDATE customers SET warehouse_id='g-5',data=json_set(data,'$.warehouseIds',json('[\"g-5\"]')) WHERE id='monthly-a'");
 copyFileSync(snapshot,snapshot+'.new');renameSync(snapshot+'.new',snapshot);
 const revoked=get();await delay(100);app.prepare('DELETE FROM sessions WHERE user_id=?').run('detail-agent');assert.equal((await revoked).status,401,'session revoked during hashing is rechecked before response');
 console.log('PASS: real detail HTTP cold concurrency, light responsiveness, current company/point ACL and session/ownership revocation during cooperative reads.');
}finally{app?.close();child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));rmSync(root,{recursive:true,force:true});}
