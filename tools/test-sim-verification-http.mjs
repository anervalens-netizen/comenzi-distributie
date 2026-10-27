import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const folder=mkdtempSync(join(tmpdir(),'sim-verification-http-')),origin='http://127.0.0.1:3098',serial='1000000000000000001';
const ledger=new DatabaseSync(join(folder,'activations.sqlite'));
ledger.exec(`CREATE TABLE activation_meta(key TEXT PRIMARY KEY,value);INSERT INTO activation_meta VALUES('schema_version','3');
CREATE TABLE activation_imports(imported_at,source_at,status,operator,source_kind);INSERT INTO activation_imports VALUES('2026-10-27','2026-10-26','complete','vodafone','internal');
CREATE TABLE activation_movements(id INTEGER PRIMARY KEY,movement_key,company,provider,imei,item_type);CREATE INDEX activation_movements_identity ON activation_movements(company,provider,imei);
CREATE TABLE activation_effective_movements(movement_id INTEGER PRIMARY KEY,company,provider,imei,serial,movement_date,site,is_tr,item_code,customer_key,quantity,raw_json);CREATE INDEX effective_serial ON activation_effective_movements(company,provider,serial);`);
ledger.prepare('INSERT INTO activation_movements VALUES(1,?,?,?,?,?)').run('test','MobiCell','vodafone',serial,'SIM');
ledger.prepare('INSERT INTO activation_effective_movements VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run('MobiCell','vodafone',serial,'','2024-01-03','STORE',0,'SIM-TEST','private-client',1,JSON.stringify({TR:'Example Store',Nr:'TEST-99'}));ledger.close();
const child=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:folder,MOBIUP_ACTIVATIONS_DIR:folder,MOBIUP_USAGE_DISABLED:'1',HOST:'127.0.0.1',PORT:'3098'},stdio:'ignore'});let browser,db;
async function check(token,body={serial},extra={}){const r=await fetch(origin+'/api/sim/verify',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Cookie:'mobiup_session='+token}:{}),...extra},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
try{
 await waitFor(async()=>{try{return(await fetch(origin+'/api/bootstrap')).ok;}catch{return false;}},'startup');
 db=new DatabaseSync(join(folder,'mobiup.sqlite'));const tokens={};
 for(const [id,role] of [['lookup-manager','manager'],['lookup-agent','agent']]){db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active,site_code) VALUES(?,?,?,?,'global','invalid-test-only',0,1,'OTHER')").run(id,id,id,role);const token=randomBytes(24).toString('hex');tokens[id]=token;db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);}
 assert.equal((await check()).status,401);
 for(const token of Object.values(tokens)){const answer=await check(token);assert.equal(answer.status,200);assert.equal(answer.body.sale.seller,'Example Store');assert.equal(answer.body.sale.date,'2024-01-03');assert.equal(answer.body.sale.receipt,'TEST-99');assert(!JSON.stringify(answer.body).includes('private-client'));assert.equal((await check(token,{serial:'123'})).status,400);assert.equal((await check(token,{serial,provider:'digi'})).status,400);assert.equal((await check(token,{serial:'9999999999999999999'})).body.status,'not_found');}
 assert.equal((await check(tokens['lookup-agent'],{serial},{Origin:'https://invalid.example'})).status,403);
 db.prepare("UPDATE users SET active=0 WHERE id='lookup-agent'").run();assert.equal((await check(tokens['lookup-agent'])).status,401);db.prepare("UPDATE users SET active=1 WHERE id='lookup-agent'").run();
 browser=await browserFixture(origin);await browser.send('Network.setCookie',{name:'mobiup_session',value:tokens['lookup-manager'],url:origin});await browser.send('Page.navigate',{url:origin});
 await waitFor(()=>browser.evaluate('!!document.querySelector(".main-nav")'),'navigation');
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(x=>x.textContent==="Prepay").click()');
 await waitFor(()=>browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].some(x=>x.textContent==="Verificare Sim")'),'SIM tab');
 await browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].find(x=>x.textContent==="Verificare Sim").click()');
 await waitFor(()=>browser.evaluate('!!document.querySelector("#sim-serial")'),'scanner input');
 await browser.send('Input.insertText',{text:serial});await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await waitFor(()=>browser.evaluate('document.querySelector(".sim-sale")?.textContent.includes("TEST-99")'),'scanner Enter result');
 assert(await browser.evaluate('document.querySelector(".sim-sale").textContent.includes("03.01.2024")'));
 await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),'mobile fits viewport');
 mkdirSync('work/evidence',{recursive:true});const shot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('work/evidence/sim-verification-mobile.png',Buffer.from(shot.data,'base64'));
 await browser.send('Input.insertText',{text:'9999999999999999999'});await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 await waitFor(()=>browser.evaluate('document.querySelector(".sim-result")?.textContent.includes("nu a fost comercializat")'),'scanner Tab no match');assert(!(await browser.evaluate('!!document.querySelector(".sim-sale")')),'previous seller cleared');
 console.log('PASS: SIM HTTP auth, both roles, global exact lookup, CSRF, validation, revocation, scanner Enter/Tab, stale-result clearing and mobile');
}finally{db?.close();await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));rmSync(folder,{recursive:true,force:true});}
