// Loopback-only standalone LAB. Never accepts a URL, credential or data-directory override.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {lab,payloadBytes,positiveInt} from './performance/lab.mjs';
assert.equal(JSON.parse(readFileSync('resources/resource-mode.json','utf8')).mode,'synthetic','Build with public synthetic resources first');
const samples=positiveInt(process.env.LAB_SAMPLES,30);mkdirSync('work',{recursive:true});const root=mkdtempSync(resolve('work/http-lab-'));
let child,origin,serverOutput='';
const seed=JSON.parse(readFileSync('resources/seed.json','utf8'));
const b=lab('http',{orders:10000,products:seed.products.length,customers:seed.clients.length}),payloads=[];
const sizeLater=({record,result})=>payloads.push({record,result});
async function start(){
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));origin='http://127.0.0.1:'+port;
 child=spawn(process.execPath,[resolve('dist/standalone/server.js')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),MOBIUP_DATA_DIR:root,NODE_ENV:'production'},stdio:['ignore','ignore','pipe']});serverOutput='';child.stderr.on('data',chunk=>{serverOutput=(serverOutput+chunk).slice(-20000);});
 for(let i=0;i<150;i++){try{if((await fetch(origin+'/api/health')).ok)return;}catch{}if(child.exitCode!==null)throw new Error('LAB server exited: '+serverOutput);await delay(100);}throw new Error('LAB server readiness timeout');
}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([done,delay(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}
async function get(path,cookie){try{const r=await fetch(origin+path,{headers:cookie?{cookie}:{}});assert.equal(r.status,200);return await r.text();}catch(cause){throw new Error('LAB request failed; server exit='+child.exitCode+' signal='+child.signalCode+' stderr='+serverOutput,{cause});}}
try{
 await start();
 const initial=await b.measure('initial-document','anonymous','cold process; OS cache unspecified; document only',1,()=>get('/'));sizeLater(initial);initial.record.sourceSize={orders:0};
 const init=await b.measure('bootstrap','anonymous','first database initialization',1,()=>get('/api/bootstrap'));sizeLater(init);init.record.sourceSize={orders:0};
 const sql=new DatabaseSync(join(root,'mobiup.sqlite')),cookies={};
 for(const [id,role,warehouse] of [['lab-manager','manager',''],['lab-agent','agent','g-5']]){
  sql.prepare("INSERT INTO users(id,username,name,role,warehouse_id,manager_scope,password_hash,must_change_password,active) VALUES(?,?,?,?,?,'global','synthetic-disabled',0,1)").run(id,id,'Synthetic user',role,warehouse);
  const token=randomUUID();cookies[role]='mobiup_session='+token;sql.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
 }
 const insert=sql.prepare("INSERT INTO orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,revision) VALUES(?,?,'lab-agent','g-5','accessories','draft',?,'2026-09-01T12:00:00Z',1)");sql.exec('BEGIN');
 for(let i=0;i<10000;i++)insert.run('lab-order-'+i,'LAB-'+i,JSON.stringify({customerName:'Synthetic customer',customerCui:'',items:[],standItems:[],serials:[],notes:'Synthetic draft'}));sql.exec('COMMIT');sql.close();
 await stop();await start();
 for(const role of ['manager','agent']){
  const compact=await b.measure('bootstrap-compact',role,'current startup; first role access',1,()=>get('/api/bootstrap?compact=1',cookies[role]));sizeLater(compact);assert.ok(JSON.parse(compact.result).orders.length<=40);
  const compactWarm=await b.measure('bootstrap-compact',role,'warm',samples,()=>get('/api/bootstrap?compact=1',cookies[role]));sizeLater(compactWarm);
  const cold=await b.measure('bootstrap-legacy',role,'legacy full bootstrap after compact startup',1,()=>get('/api/bootstrap',cookies[role]));sizeLater(cold);assert.equal(JSON.parse(cold.result).orders.length,10000);
  const warm=await b.measure('bootstrap-legacy',role,'warm',samples,()=>get('/api/bootstrap',cookies[role]));sizeLater(warm);
  const search=await b.measure('portfolio-search',role,'first query',1,()=>get('/api/partner/browse?q=demonstrativ',cookies[role]));sizeLater(search);
  const repeated=await b.measure('portfolio-search',role,'warm',samples,()=>get('/api/partner/browse?q=demonstrativ',cookies[role]));sizeLater(repeated);
 }
 // Synchronous offline compression can outlast HTTP keep-alive. Do it only
 // after all requests so the LAB cannot reuse an idle socket closed during compression.
 for(const {record,result} of payloads)record.bytes=payloadBytes(result);
 b.save({limits:'Loopback HTTP API/document timings include transfer and body read, exclude JS/CSS execution, UI render and real network. Compression is offline estimate. Current compact startup and legacy full bootstrap are labeled separately.'});
}finally{await stop();rmSync(root,{recursive:true,force:true});}
