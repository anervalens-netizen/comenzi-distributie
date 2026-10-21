import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as XLSX from 'xlsx';

const directory=mkdtempSync(join(tmpdir(),'transfer-qa-')),port=Number(process.env.TRANSFER_TEST_PORT||3067),origin=`http://127.0.0.1:${port}`,base=origin+'/api/';
const server=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:directory,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
let logs='',db,checks=0;server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
const check=(value,label)=>{assert.ok(value,label);checks++;};
const hash=value=>createHash('sha256').update(value).digest('hex');
const cookies={};
async function call(path,user='ta',method='GET',body,expected=200,extraHeaders={}){
 const options={method,headers:{...(cookies[user]?{Cookie:cookies[user]}:{}),...(body?{'Content-Type':'application/json'}:{}),...extraHeaders}};if(body&&method!=='GET')options.body=JSON.stringify(body);const response=await fetch(base+path,options);
 const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data).slice(0,400)}`);checks++;return data;
}
const bodyFor=(record,extra={})=>({revision:record.revision,destinationAgentId:'tb',lines:record.lines,notes:record.notes,...extra});
try{
 for(let i=0;i<120;i++){try{const response=await fetch(base+'bootstrap');if(response.ok)break;}catch{}if(i===119)throw new Error('QA server unavailable: '+logs.slice(-1000));await new Promise(resolve=>setTimeout(resolve,200));}
 db=new DatabaseSync(join(directory,'mobiup.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 for(const [id,role,warehouse,scope] of [['ta','agent','qa-wa','assigned'],['tb','agent','qa-wb','assigned'],['tc','agent','qa-wc','assigned'],['tm-a','manager',null,'assigned'],['tm-b','manager',null,'assigned'],['tm-global','manager',null,'global']]){
  db.prepare('INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,password_hash,must_change_password,active) VALUES(?,?,?,?,?,?,?,?,0,1)').run(id,id,`Synthetic ${id}`,role,scope,warehouse,warehouse?`Warehouse ${warehouse}`:null,'disabled');
  const token=randomUUID();cookies[id]=`mobiup_session=${token}`;db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token),id,Date.now()+3600000);
 }
 db.prepare('INSERT INTO manager_agents(manager_id,agent_id) VALUES(?,?)').run('tm-a','ta');db.prepare('INSERT INTO manager_agents(manager_id,agent_id) VALUES(?,?)').run('tm-b','tb');
 for(const [key,value] of [['transfer-mail-v1',{to:'distribution@example.invalid'}],['manager-mail:tm-a',{stands:'manager-a@example.invalid'}],['manager-mail:tm-b',{accessories:'manager-b@example.invalid'}],['agent-mail:ta',{standsCc:['Manager-A@example.invalid']}],['agent-mail:tb',{standsCc:['manager-b@example.invalid']}],['agent-stock-v1',{warehouses:{},depot:{},history:[]}]])db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value));
 const snapshot=()=>({stock:db.prepare("SELECT value FROM settings WHERE key='agent-stock-v1'").get().value,orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,inventory:db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'inventory-v1:%'").get().n});
 const before=snapshot();
 await call('transfers','anonymous','GET',undefined,401);
 const list=await call('transfers');check(list.targets.length>=3,'Destination list includes active agents nationwide');check(list.sources.length===1&&list.sources[0].agentId==='ta','Agent source is fixed to own warehouse');
 const managers=await call('transfers','tm-a');check(managers.sources.some(source=>source.agentId==='tc'),'Regional manager can use unassigned source');
 await call('transfers/config','tm-a','GET',undefined,403);await call('transfers/config','ta','GET',undefined,403);
 await call('transfers/config','tm-global','PUT',{to:'bad\r\nBcc: x@example.invalid'},400);
 await call('transfers/config','tm-global','PUT',{to:'distribution@example.invalid'});
 let record=(await call('transfers','ta','POST',{id:randomUUID(),sourceAgentId:'tc'})).transfer;check(record.source.agentId==='ta','Agent cannot spoof source');
 const repeated=(await call('transfers','ta','POST',{id:record.id})).transfer;check(repeated.id===record.id&&repeated.revision===1,'Creation retry does not duplicate transfer');
 await call(`transfers/${record.id}`,'tb','GET',undefined,404);
 await call(`transfers/${record.id}/excel`,'ta','GET',undefined,409);
 await call(`transfers/${record.id}/finalize`,'ta','POST',bodyFor(record),400);
 const products=(await call('catalog')).products;
 const accessory=products.find(product=>product.kind==='accessories'),phone=products.find(product=>product.category==='Telefoane'),sim=products.find(product=>product.category==='Cartele'),stand=products.find(product=>product.category==='Standuri');
 check(accessory&&phone&&sim&&stand,'Synthetic catalog has all four product types');
 const lines=[{id:accessory.id,quantity:7,serials:[]},{id:phone.id,quantity:1,serials:['012345678901234']},{id:sim.id,quantity:1,serials:['00123456789012345678']},{id:stand.id,quantity:2,serials:[]}];
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{destinationAgentId:'ta',lines}),400);
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{destinationAgentId:'missing',lines}),400);
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{lines:[{id:phone.id,quantity:1,serials:[123456789012345]}]}),400);
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{lines:[{id:phone.id,quantity:2,serials:['012345678901234','012345678901234']}]}),400);
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{lines:[...lines,lines[0]]}),400);
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{lines:[{id:accessory.id,quantity:0,serials:[]}]}),400);
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{lines}),403,{Origin:'https://cross-site.example.invalid'});
 record=(await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{lines,notes:'Synthetic <&> transfer'}))).transfer;
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record,{revision:1}),409);
 await call(`transfers/${record.id}/finalize`,'ta','POST',bodyFor(record,{lines:lines.map(line=>line.id===phone.id?{...line,quantity:2}:line)}),400);
 const raced=await Promise.all([fetch(base+`transfers/${record.id}`,{method:'PUT',headers:{Cookie:cookies.ta,'Content-Type':'application/json'},body:JSON.stringify(bodyFor(record,{notes:'First'}))}),fetch(base+`transfers/${record.id}`,{method:'PUT',headers:{Cookie:cookies.ta,'Content-Type':'application/json'},body:JSON.stringify(bodyFor(record,{notes:'Second'}))})]);check(raced.map(response=>response.status).sort((a,b)=>a-b).join(',')==='200,409','Concurrent edits have a single CAS winner');
 record=(await call(`transfers/${record.id}`)).transfer;
 record=(await call(`transfers/${record.id}/finalize`,'ta','POST',bodyFor(record))).transfer;
 check(record.status==='finalized','Finalization persists request');
 check(record.mail.to==='distribution@example.invalid','Distribution To is configured independently');
 check(record.mail.cc.length===2&&record.mail.cc.map(value=>value.toLowerCase()).includes('manager-a@example.invalid')&&record.mail.cc.includes('manager-b@example.invalid'),'Both regional manager groups in CC with case-insensitive dedup and personal-address fallback');
 check(record.mail.subject==='Transfer din gestiunea Warehouse qa-wa către Warehouse qa-wb','Simple subject names source and destination');
 check(['accesorii','telefoane','standuri','sim-uri'].every(word=>record.mail.body.includes(word)),'Mail names only included categories');
 check(!record.mail.body.includes('012345678901234'),'Mail leaves detailed series in Excel');
 await call(`transfers/${record.id}`,'ta','PUT',bodyFor(record),409);
 await call(`transfers/${record.id}`,'ta','DELETE',{revision:record.revision},409);
 const replay=(await call(`transfers/${record.id}/finalize`,'ta','POST',{revision:1})).transfer;check(replay.revision===record.revision,'Finalization replay is idempotent');
 const excel=await fetch(base+`transfers/${record.id}/excel`,{headers:{Cookie:cookies.ta}});check(excel.ok&&excel.headers.get('content-type').includes('spreadsheetml'),'Excel endpoint exports XLSX');
 const workbook=XLSX.read(Buffer.from(await excel.arrayBuffer()),{type:'buffer'}),sheet=workbook.Sheets.Transfer,rows=XLSX.utils.sheet_to_json(sheet,{header:1});
 check(sheet.E12.t==='s'&&sheet.E12.v==='012345678901234','IMEI is text with leading zero preserved');
 check(sheet.E13.t==='s'&&sheet.E13.v==='00123456789012345678','SIM serial is text without numeric rounding');
 check(rows.at(-1)[3]===11,'Export totals match mixed request');
 const eml=await fetch(base+`transfers/${record.id}/eml`,{headers:{Cookie:cookies.ta}}).then(response=>response.text());check(eml.includes('X-Unsent: 1')&&eml.includes('Content-Disposition: attachment'),'Unsent eml includes Excel attachment');
 const mailSnapshot=record.mail;db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({to:'new@example.invalid'}),'transfer-mail-v1');check(JSON.stringify((await call(`transfers/${record.id}/mail`)).mail)===JSON.stringify(mailSnapshot),'Historical mail recipients remain stable after config changes');
 let regional=(await call('transfers','tm-a','POST',{id:randomUUID(),sourceAgentId:'tc'})).transfer;
 regional=(await call(`transfers/${regional.id}`,'tm-b','PUT',bodyFor(regional,{destinationAgentId:'ta',lines:[lines[0]]}))).transfer;check(regional.canEdit,'Other regional manager can edit an unassigned source transfer');
 regional=(await call(`transfers/${regional.id}/finalize`,'tm-b','POST',bodyFor(regional,{destinationAgentId:'ta',lines:[lines[0]]}))).transfer;check(regional.status==='finalized','Regional manager finalizes transfer outside own region');
 const draft=(await call('transfers','tm-b','POST',{id:randomUUID(),sourceAgentId:'ta'})).transfer;await call(`transfers/${draft.id}`,'tm-a','DELETE',{revision:draft.revision});await call(`transfers/${draft.id}`,'tm-a','GET',undefined,404);
 check(JSON.stringify(snapshot())===JSON.stringify(before),'Transfer creation, finalization and deletion do not change stock, orders or inventories');
 if(process.env.CHROME_BIN){const {testTransferBrowser}=await import('./test-transfers-browser.mjs');await testTransferBrowser(origin,cookies);}
 console.log(`PASS: ${checks} transfer API/export/authorization/concurrency checks.`);
}finally{db?.close();server.kill();await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);});rmSync(directory,{recursive:true,force:true});}
