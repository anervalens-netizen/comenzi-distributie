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
 assert.deepEqual(manager.partners.map(r=>r.partner.id),['activity-other','activity-shared','activity-one'],'sales ranked across complete selection');
 assert.equal(manager.partners[0].metrics.valueCents,90000);assert.equal(manager.partners[0].metrics.documents,1);assert.equal(manager.partners[0].metrics.lastBilling,'2026-09-15');
 assert.deepEqual(manager.partners.find(r=>r.partner.id==='activity-shared').agents.map(a=>a.id).sort(),app.prepare("SELECT id FROM users WHERE role='agent' AND active=1 AND warehouse_id IN ('g-5','g-3')").all().map(a=>a.id).sort(),'all shared current owners shown');
 assert.deepEqual((await call('qa-manager','sort=value&direction=asc')).partners.map(r=>r.partner.id),['activity-one','activity-shared','activity-other']);
 await call('qa-manager','sort=bad',400);await call('qa-manager','direction=sideways',400);
 const scoped=await call('qa-manager','agentId=qa-agent1');assert.equal(scoped.total,2);
 await call('qa-agent1','agentId=qa-agent2',403);await call('qa-agent1','activity=unknown',400);await call('qa-agent1','page=-1',400);
 assert.equal((await call('qa-agent1','county=Different')).total,0);
 assert.equal((await call('qa-agent1','page=1')).partners.length,0);

 // Period selection must use exactly the same IDs for list, map and activity.
 insert.run('activity-old','g-5',JSON.stringify({id:'activity-old',warehouseId:'g-5',warehouseIds:['g-5'],name:'activity-old',cui:'123',county:'Test',city:'Test',address:'Synthetic address',route:''}));
 insert.run('activity-unlinked','g-5',JSON.stringify({id:'activity-unlinked',warehouseId:'g-5',warehouseIds:['g-5'],name:'activity-unlinked',cui:'456',county:'Test',city:'Test',address:'Synthetic address',route:''}));
 const edit=new DatabaseSync(join(historyDir,'client-sales-history.sqlite'));
 edit.exec("INSERT INTO history_identities VALUES(4,'123'); INSERT INTO history_allocations VALUES(4,'ref','direct_code','[\"activity-old\"]','[]'); INSERT INTO history_rows VALUES(1,4,'2023-09-15','test','old',15000,1000000); UPDATE history_imports SET period_start='2023-01-01',row_count=4;");
 edit.close();buildActivitySnapshot(root);
 const fingerprint=createHash('sha256').update(JSON.stringify(['Synthetic address','Test','Test'])).digest('hex');
 for(const id of ['activity-one','activity-shared','activity-other','activity-old','activity-unlinked'])app.prepare("INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,address_fingerprint,revision,updated_at) VALUES(?,44.4,26.1,'manual',?,1,'2026-09-30T00:00:00Z')").run(id,fingerprint);
 async function idsFor(path,period){
   const r=await fetch('http://127.0.0.1:3000/api/partner/'+path+'?q=activity-&salesPeriod='+encodeURIComponent(period),{headers:{Cookie:sessions['qa-agent1']}});
   const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));
   return (path==='map'?data.features.map(f=>f.id):data.partners.map(p=>p.id)).sort();
 }
 assert.deepEqual((await call('qa-agent1','salesPeriod=year:2026')).partners.map(p=>p.partner.id).sort(),['activity-one','activity-shared']);
 assert.deepEqual((await call('qa-agent1','salesPeriod=year:2023')).partners.map(p=>p.partner.id),['activity-old']);
 for(const [period,expected] of [['year:2026',['activity-one','activity-shared']],['year:2023',['activity-old']],['unknown',['activity-unlinked']],['older365',['activity-old']]]){
   assert.deepEqual(await idsFor('browse',period),expected);assert.deepEqual(await idsFor('map',period),expected);
 }
 const ranked=await call('qa-agent1','sort=value&direction=asc');
 assert.equal(ranked.partners.at(-1).partner.id,'activity-unlinked','unknown sales stay last in either direction');
 const oldYear=await call('qa-agent1','salesPeriod=year:2023');assert.equal(oldYear.partners[0].metrics.valueCents,15000);assert.equal(oldYear.partners[0].metrics.documents,1);
 await call('qa-agent1','salesPeriod=bad',400);
 // A currently assigned company card can read historical sellers without a point allocation.
 const moreHistory=new DatabaseSync(join(historyDir,'client-sales-history.sqlite'));
 moreHistory.exec("ALTER TABLE history_rows ADD COLUMN item_code TEXT DEFAULT 'demo'; ALTER TABLE history_rows ADD COLUMN item_name TEXT DEFAULT 'Demo product'; ALTER TABLE history_rows ADD COLUMN tr TEXT DEFAULT 'Former seller'; ALTER TABLE history_rows ADD COLUMN source_row INTEGER DEFAULT 1; INSERT INTO history_identities VALUES(5,'789'); INSERT INTO history_allocations VALUES(5,'ref','reconcile','[]','[]'); INSERT INTO history_rows(import_id,identity_id,date,site_id,document_number,value_cents,quantity_micros) VALUES(1,5,'2026-09-20','site','old-seller-bill',12300,1000000);");
 moreHistory.close();
 insert.run('activity-company','g-5',JSON.stringify({id:'activity-company',warehouseId:'g-5',warehouseIds:['g-5'],name:'Company history',cui:'789',county:'Test',city:'',address:'',route:'',historyCatalog:{kind:'company'}}));
 async function companySales(user,status){
   const r=await fetch('http://127.0.0.1:3000/api/partner/portfolio/activity-company/sales',{headers:{Cookie:sessions[user]}});
   const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;
 }
 const own=await companySales('qa-agent1',200);assert.equal(own.state,'ready');assert.equal(own.scope,'company');assert.equal(own.totals.valueCents,12300);assert.equal(own.sellers[0].seller,'Former seller');
 await companySales('qa-agent2',404);
 const defaultRequest=await fetch('http://127.0.0.1:3000/api/partner/portfolio/activity-one/sales',{headers:{Cookie:sessions['qa-agent1']}});
 assert.equal(defaultRequest.status,200);
 const allClient=await defaultRequest.json();
 assert.equal(allClient.scope,'company');assert.equal(allClient.totals.valueCents,135000,'current agent sees all company points and older sellers by default');
 assert.equal(allClient.documents.count,4);
 const pointRequest=await fetch('http://127.0.0.1:3000/api/partner/portfolio/activity-one/sales?scope=point',{headers:{Cookie:sessions['qa-agent1']}});
 assert.equal(pointRequest.status,200);assert.equal((await pointRequest.json()).totals.valueCents,10000);
 const managed=await companySales('qa-manager',200);assert.deepEqual(managed.documents,own.documents);
 console.log('PASS: activity HTTP enforces current agent scope, shared records, national scope, manager filters and validated paging.');
}finally{
 app.exec("DELETE FROM partner_profiles WHERE customer_id LIKE 'activity-%'");
 app.exec("DELETE FROM customers WHERE id LIKE 'activity-%'");app.close();
 rmSync(historyDir,{recursive:true,force:true});rmSync(temp,{recursive:true,force:true});
}
