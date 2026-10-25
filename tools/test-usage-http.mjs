import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
const root=process.cwd(),folder=root+'/work/usage-http',origin='http://127.0.0.1:3098';rmSync(folder,{recursive:true,force:true});mkdirSync(folder,{recursive:true});
const child=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:folder,HOST:'127.0.0.1',PORT:'3098'},stdio:'ignore'});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,{method='GET',cookie,body,headers={}}={}){const r=await fetch(origin+'/api/'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
try{
for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/bootstrap')).ok)break;}catch{}await sleep(100);}
const db=new DatabaseSync(folder+'/mobiup.sqlite'),password=randomBytes(20).toString('hex'),salt=randomBytes(16).toString('hex'),hash='scrypt:'+salt+':'+scryptSync(password,salt,32,{N:32768,r:8,p:3,maxmem:40*1024*1024}).toString('hex');
for(const [id,role] of [['usage-agent','agent'],['usage-manager','manager']])db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active) VALUES(?,?,?,?,'global',?,0,1)").run(id,id,id,role,hash);
const manager=await request('auth/login',{method:'POST',body:{username:'usage-manager',password},headers:{'CF-Connecting-IP':'192.0.2.10','User-Agent':'Synthetic usage test'}}),agent=await request('auth/login',{method:'POST',body:{username:'usage-agent',password}});assert.equal(manager.status,200);assert.equal(agent.status,200);
assert.equal((await request('usage/report')).status,401);assert.equal((await request('usage/report',{cookie:agent.cookie})).status,403);
const pulse={owner:'usage-agent',id:randomUUID(),seq:1,screen:'orders',closed:false,spans:[{from:30000,to:0,active:true}]};assert.equal((await request('usage/pulse',{method:'POST',body:pulse})).status,401);
assert.equal((await request('usage/pulse',{method:'POST',cookie:manager.cookie,body:pulse})).status,409);
assert.equal((await request('usage/pulse',{method:'POST',cookie:agent.cookie,body:pulse,headers:{Origin:'https://invalid.example'}})).status,403);
assert.equal((await request('usage/pulse',{method:'POST',cookie:agent.cookie,body:{...pulse,spans:[{from:1e20,to:0,active:true}]}})).status,400);
assert.equal((await request('usage/pulse',{method:'POST',cookie:agent.cookie,body:pulse})).body.recorded,true);
let report=await request('usage/report?userId=usage-agent',{cookie:manager.cookie});assert.equal(report.status,200);assert.equal(report.body.users.find(u=>u.id==='usage-agent').visibleMs,30000);assert.equal(report.body.users.find(u=>u.id==='usage-agent').opens,1);assert.equal(report.body.visits.length,1);
assert.equal((await request('usage/report?userId=missing',{cookie:manager.cookie})).status,404);assert.equal((await request('usage/report?from=invalid',{cookie:manager.cookie})).status,400);
const managerReport=await request('usage/report?userId=usage-manager',{cookie:manager.cookie});assert.equal(managerReport.body.events[0].ip,'192.0.2.10');assert.equal(managerReport.body.events[0].device,'Synthetic usage test');
const usageDb=new DatabaseSync(folder+'/usage.sqlite');usageDb.exec('BEGIN IMMEDIATE');assert.equal((await request('usage/pulse',{method:'POST',cookie:agent.cookie,body:{...pulse,id:randomUUID()}})).body.recorded,false);assert.equal((await request('auth/session',{cookie:agent.cookie})).status,200);usageDb.exec('ROLLBACK');
assert.equal((await request('auth/logout',{method:'POST',cookie:agent.cookie,body:{}})).status,200);assert.equal((await request('usage/pulse',{method:'POST',cookie:agent.cookie,body:pulse})).status,401);report=await request('usage/report?userId=usage-agent',{cookie:manager.cookie});assert.equal(report.body.events[0].event,'logout');assert(report.body.visits[0].closed_at);
usageDb.close();db.close();console.log('PASS: usage HTTP authentication, authorization, account fence, CSRF, bounds, IP, report, locked-store isolation and logout.');
}finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
