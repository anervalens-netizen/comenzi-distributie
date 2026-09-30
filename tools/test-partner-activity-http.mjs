import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=resolve('work/qa'),historyDir=join(root,'client-history'),temp=mkdtempSync(join(tmpdir(),'activity-http-'));
if(existsSync(historyDir))throw new Error('Test requires absent isolated history fixture.');
const app=new DatabaseSync(join(root,'mobiup.sqlite')),sessions={};
for(const id of ['qa-agent1','qa-agent2','qa-manager']){
 const token=randomUUID();sessions[id]='mobiup_session='+token;
 app.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
}
const insert=app.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)');
for(const [id,warehouseIds] of [['activity-one',['g-5']],['activity-shared',['g-5','g-3']],['activity-other',['g-3']]])insert.run(id,warehouseIds[0],JSON.stringify({id,warehouseId:warehouseIds[0],warehouseIds,name:id,cui:'123',county:'Test',city:'Test',address:'Synthetic address',route:''}));
try{
 mkdirSync(historyDir);
 const c=new DatabaseSync(join(historyDir,'client-sales-history.sqlite'));
 c.exec(`
 CREATE TABLE history_meta(key TEXT,value TEXT); INSERT INTO history_meta VALUES('current_reference','ref');
 CREATE TABLE history_imports(id INTEGER,sha256 TEXT,state TEXT,period_start TEXT,period_end TEXT,row_count INTEGER);
 INSERT INTO history_imports VALUES(1,'hash','active','2026-01-01','2026-09-30',3);
 CREATE TABLE history_references(id TEXT,master_json TEXT); INSERT INTO history_references VALUES('ref','[]');
 CREATE TABLE history_identities(id INTEGER,client_code TEXT); INSERT INTO history_identities VALUES(1,'123'),(2,'123'),(3,'123');
 CREATE TABLE history_allocations(identity_id INTEGER,reference_id TEXT,status TEXT,partner_ids_json TEXT,candidates_json TEXT);
 INSERT INTO history_allocations VALUES(1,'ref','direct_code','["activity-one"]','[]'),(2,'ref','direct_code','["activity-shared"]','[]'),(3,'ref','direct_code','["activity-other"]','[]');
 CREATE TABLE history_rows(import_id INTEGER,identity_id INTEGER,date TEXT,site_id TEXT,document_number TEXT,value_cents INTEGER,quantity_micros INTEGER);
 INSERT INTO history_rows VALUES(1,1,'2026-09-15','test','1',10000,1000000),(1,2,'2026-09-15','test','2',20000,1000000),(1,3,'2026-09-15','test','3',90000,1000000);
 `);c.close();
 const modulePath=join(temp,'snapshot.mjs');await build({entryPoints:['lib/partner-activity-snapshot.ts'],outfile:modulePath,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {buildActivitySnapshot}=await import(pathToFileURL(modulePath).href);buildActivitySnapshot(root);
 async function call(user,query='',status=200){
  const r=await fetch('http://127.0.0.1:3000/api/partner/activity?q=activity-&'+query,{headers:{Cookie:sessions[user]}});
  const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;
 }
 const first=await call('qa-agent1');assert.equal(first.state,'ready');assert.equal(first.total,2);assert(!JSON.stringify(first).includes('activity-other'));
 const second=await call('qa-agent2');assert.equal(second.total,2);assert(second.partners.some(p=>p.partner.id==='activity-shared'));
 const manager=await call('qa-manager');assert.equal(manager.total,3);assert.equal(manager.counts.all,3,'national records not summed across shared agents');
 const scoped=await call('qa-manager','agentId=qa-agent1');assert.equal(scoped.total,2);
 await call('qa-agent1','agentId=qa-agent2',403);await call('qa-agent1','activity=unknown',400);await call('qa-agent1','page=-1',400);
 assert.equal((await call('qa-agent1','county=Different')).total,0);
 assert.equal((await call('qa-agent1','page=1')).partners.length,0);
 console.log('PASS: activity HTTP enforces current agent scope, shared records, national scope, manager filters and validated paging.');
}finally{
 app.exec("DELETE FROM customers WHERE id LIKE 'activity-%'");app.close();
 rmSync(historyDir,{recursive:true,force:true});rmSync(temp,{recursive:true,force:true});
}
