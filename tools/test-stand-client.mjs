import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,randomUUID} from 'node:crypto';
const folder=path.resolve('work/stand-client-qa');
if(process.argv.includes('--prepare')){
 fs.mkdirSync(folder,{recursive:true});assert(!fs.existsSync(folder+'/mobiup.sqlite'));
 const db=new DatabaseSync(folder+'/mobiup.sqlite');db.exec(fs.readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
 db.exec("ALTER TABLE users ADD COLUMN warehouse_name TEXT; ALTER TABLE users ADD COLUMN site_code TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'assigned'; CREATE TABLE manager_agents(manager_id TEXT NOT NULL,agent_id TEXT NOT NULL,PRIMARY KEY(manager_id,agent_id));");
 const password=randomBytes(20).toString('hex'),salt=randomBytes(16).toString('hex'),hash='scrypt:'+salt+':'+scryptSync(password,salt,32,{N:32768,r:8,p:3,maxmem:40*1024*1024}).toString('hex');
 for(const [id,role,wh] of [['qa-agent','agent','g-5'],['qa-manager','manager',null]])db.prepare('INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,warehouse_name) VALUES(?,?,?,?,?,?,0,?)').run(id,id,id,role,wh,hash,'QA warehouse');
 db.prepare("INSERT INTO manager_agents VALUES('qa-manager','qa-agent')").run();
 db.prepare("INSERT INTO settings VALUES('seed-v1','1')").run();
 db.prepare("INSERT INTO settings VALUES('manager-mail:qa-manager',?)").run(JSON.stringify({stands:'qa-manager@example.invalid'}));
 for(const [id,wh] of [['qa-client','g-5'],['foreign-client','g-3']])db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,wh,JSON.stringify({id,warehouseId:wh,name:'QA Client',cui:'123456',city:'Bucuresti',county:'Bucuresti',address:'Strada QA 1',route:''}));
 fs.writeFileSync(folder+'/credentials.json',JSON.stringify({password}),{mode:0o600});db.close();console.log('Prepared isolated stand-client QA');process.exit();
}
const setupDb=new DatabaseSync(folder+'/mobiup.sqlite');setupDb.prepare("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({standsCc:['operations@example.invalid','depozit@example.invalid']}));setupDb.close();
const base='http://127.0.0.1:3018/api/';let cookie='';
async function req(url,method='GET',body,status=200){
 const r=await fetch(base+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body&&method!=='GET'&&method!=='HEAD'?{body:JSON.stringify(body)}:{})});
 const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return data;
}
await req('auth/login','POST',{username:'qa-agent',password:JSON.parse(fs.readFileSync(folder+'/credentials.json')).password});
const boot=await req('bootstrap');const stands=boot.products.filter(p=>p.kind==='stands'&&p.category==='Standuri');assert.equal(stands.length,10);
let o=(await req('orders','POST',{id:randomUUID(),kind:'stand_client'},201)).order;
const body=(clientId='qa-client',items=[{id:stands[0].id,quantity:2}])=>({revision:o.revision,items,clientId,notes:'QA',serials:[]});
await req('orders/'+o.id,'PUT',body('foreign-client'),400);
const phone=boot.products.find(p=>p.kind==='stands'&&p.category!=='Standuri');assert(phone);
await req('orders/'+o.id,'PUT',body('qa-client',[{id:phone.id,quantity:1}]),400);
await req('orders/'+o.id,'PUT',{...body(),serials:['1234567890123456789']},400);
o=(await req('orders/'+o.id,'PUT',body(null))).order;
await req('orders/'+o.id+'/finalize','POST',{revision:o.revision},400);
o=(await req('orders/'+o.id,'PUT',body())).order;
const db=new DatabaseSync(folder+'/mobiup.sqlite');const original=db.prepare("SELECT data FROM customers WHERE id='qa-client'").get().data;db.prepare("UPDATE customers SET data=? WHERE id='qa-client'").run(JSON.stringify({...JSON.parse(original),address:'Changed'}));
await req('orders/'+o.id+'/finalize','POST',{revision:o.revision},409);db.prepare("UPDATE customers SET data=? WHERE id='qa-client'").run(original);
const done=await req('orders/'+o.id+'/finalize','POST',{revision:o.revision});
assert.equal(done.order.status,'finalized');assert(!done.order.exportKey);assert(!done.mail.cc.some(x=>x.toLowerCase()==='operations@example.invalid'));assert.equal(done.mail.to,'distribution@example.invalid');assert(done.mail.cc.includes('qa-manager@example.invalid'));assert(done.mail.body.includes('Rog avizare stand către clientul QA Client'));assert(done.mail.body.includes(stands[0].code));assert(done.mail.body.includes(stands[0].name));assert(done.mail.body.includes('2 buc.'));assert(done.mail.body.includes('Strada QA 1'));
assert.equal((await req('orders/'+o.id+'/finalize','POST',{revision:o.revision})).order.id,o.id);
await req('orders/'+o.id+'/excel','GET',undefined,400);
const eml=await fetch(base+'orders/'+o.id+'/eml',{headers:{Cookie:cookie}});assert.equal(eml.status,200);const emlText=await eml.text();assert(emlText.includes('Content-Type: text/plain'));assert(!emlText.includes('multipart/mixed'));assert(!emlText.includes('spreadsheetml'));
const sim=(await req('orders','POST',{id:randomUUID(),kind:'sim'},201)).order;assert.equal(sim.kind,'sim');
let stock=(await req('orders','POST',{id:randomUUID(),kind:'stands'},201)).order;stock=(await req('orders/'+stock.id,'PUT',{revision:stock.revision,items:[{id:stands[0].id,quantity:1}],serials:[],notes:''})).order;const stockDone=await req('orders/'+stock.id+'/finalize','POST',{revision:stock.revision});assert(stockDone.mail.cc.includes('operations@example.invalid'));assert(stockDone.order.exportKey);
await req('auth/logout','POST',{});db.close();console.log('PASS stand-client: 10 stands, scope, invalid products/serials, missing/stale client, finalization, mail To/CC/details, idempotency, SIM creation');
