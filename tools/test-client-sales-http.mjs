import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createClientSalesFixture} from './client-sales-fixture.mjs';
const root=resolve('work/qa'),historyDir=join(root,'client-history'),temp=mkdtempSync(join(tmpdir(),'client-sales-http-'));
if(existsSync(historyDir))throw new Error('Test requires absent isolated history fixture.');
const app=new DatabaseSync(join(root,'mobiup.sqlite')),sessions={},hashes=[];
// The live isolated server can finish a background projection transaction.
// Wait for that writer without reducing any API or cleanup assertions.
app.exec('PRAGMA busy_timeout=5000');
try{
 for(const id of ['qa-agent1','qa-agent2','qa-manager','qa-regional']){const token=randomUUID(),hash=createHash('sha256').update(token).digest('hex');hashes.push(hash);sessions[id]='mobiup_session='+token;app.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash,id,Date.now()+3600000);}
 createClientSalesFixture(root,true);
 const modulePath=join(temp,'snapshot.mjs');await build({entryPoints:['lib/partner-activity-snapshot.ts'],outfile:modulePath,bundle:true,platform:'node',format:'esm',logLevel:'silent'});const {buildActivitySnapshot}=await import(pathToFileURL(modulePath));buildActivitySnapshot(root);
 async function call(user='qa-agent1',query='',status=200){const r=await fetch('http://127.0.0.1:3000/api/sales/clients?month=2026-09&q=Client+sintetic&'+query,{headers:{Cookie:sessions[user]}});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
 let first=await call();assert.equal(first.state,'ready');assert.equal(first.page,0);assert.equal(first.rows.length,50);assert.equal(first.hasMore,true);assert.equal(first.counts.all,65);assert.equal(first.totals.unknown,1);assert.equal(first.noVisitRecords,true);assert.equal(first.totals.visits,0);assert.equal(first.counts.visited,0);assert.equal(first.counts.unvisited,65);assert.equal(first.totals.billed,60);assert.equal(first.totals.documents,62);
 const second=await call('qa-agent1','page=1');assert.equal(second.rows.length,15);assert.equal(second.hasMore,false);assert.deepEqual(second.totals,first.totals);assert(!JSON.stringify([first,second]).includes('monthly-hidden'));assert.equal(new Set([...first.rows,...second.rows].map(r=>r.key)).size,65);
 assert.equal(first.rows[0].id,'monthly-page-54');assert.deepEqual(second.rows.slice(-2).map(r=>[r.id,r.metrics.valueCents]),[['monthly-unknown',null],['monthly-unlinked',null]],'both kinds of unknown values sort last with deterministic name ties');
 const asc=await call('qa-agent1','sort=value&direction=asc');assert.equal(asc.rows[0].id,'monthly-return');const ascEnd=await call('qa-agent1','sort=value&direction=asc&page=1');assert.deepEqual(ascEnd.rows.slice(-2).map(r=>[r.id,r.metrics.valueCents]),[['monthly-unknown',null],['monthly-unlinked',null]],'nulls remain last ascending too');
 const manager=await call('qa-manager');assert.equal(manager.counts.all,66);assert.equal(manager.totals.valueCents,first.totals.valueCents+900000,'national legal company totals never sum shared portfolios');
 assert.deepEqual((await call('qa-regional')).totals,manager.totals,'regional manager preserves national read scope');
 assert.equal((await call('qa-regional','agentId=qa-agent2')).counts.all,2,'national read may narrow to an agent outside write assignments');
 const scoped=await call('qa-manager','agentId=qa-agent1');assert.deepEqual(scoped.totals,first.totals);
 const other=await call('qa-agent2');assert.equal(other.counts.all,2);assert.equal(other.rows.find(r=>r.cui==='RO100').metrics.valueCents,3200,'shared authorized card includes original sellers and all company points');
 await call('qa-agent1','agentId=qa-agent2',403);await call('qa-agent1','agentId=qa-agent1',403);await call('qa-manager','agentId=missing',404);
 for(const query of ['filter=','sort=','page=','direction=','filter=bad','page=-1','page=1.5','sort=bad','direction=bad','siteCode=shared-site','month=2026-13','month=2026-09','filter=all&filter=all'])await call('qa-agent1',query,400);
 const filtered=await call('qa-agent1','filter=repeat');assert.equal(filtered.total,2);assert.deepEqual(filtered.totals,first.totals,'chip leaves selection totals unchanged');
 const geography=await call('qa-agent1','county=Unknown');assert.equal(geography.total,0);assert.equal(geography.totals.valueCents,0);assert.equal(geography.totals.perClient,null,'zero billed denominator is not a division result');
 const detail=await fetch('http://127.0.0.1:3000/api/partner/portfolio/monthly-a/sales?from=2026-09-01&to=2026-09-28',{headers:{Cookie:sessions['qa-agent1']}});assert.equal(detail.status,200);const sales=await detail.json();assert.equal(sales.scope,'company');assert.equal(sales.totals.valueCents,3200);assert.equal(sales.sellers[0].seller,'Vânzător sursă sintetic');assert.equal(sales.documents.count,1);
 const exact=await fetch('http://127.0.0.1:3000/api/partner/portfolio/monthly-a/sales?scope=point&from=2026-09-01&to=2026-09-28',{headers:{Cookie:sessions['qa-agent1']}});assert.equal(exact.status,200);assert.equal((await exact.json()).totals.valueCents,1200);
 assert.equal((await fetch('http://127.0.0.1:3000/api/partner/portfolio/monthly-a/sales',{headers:{Cookie:sessions['qa-agent2']}})).status,404,'company history does not authorize an unrelated exact point URL');
 // UTC August 31 at 21:00 is September 1 in Bucharest. The preceding second is August.
 const visit=app.prepare("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) VALUES(?,?,?,'Synthetic agent',?,'',?)");
 for(const [id,point,actor,time] of [['monthly-visit-1','monthly-unlinked','qa-agent1','2026-08-31T21:00:00.000Z'],['monthly-visit-2','monthly-a','qa-agent2','2026-09-01T00:00:00.000Z'],['monthly-visit-3','monthly-a','qa-agent1','2026-08-31T20:59:59.000Z'],['monthly-visit-4','monthly-a','qa-agent1','2026-09-30T21:00:00.000Z']])visit.run(id,point,actor,time,time);
 first=await call();assert.equal(first.noVisitRecords,false);assert.equal(first.totals.visits,1);assert.equal(first.totals.visited,1);assert.equal(first.comparisons[0].visits,1);assert.equal(first.visitRange.to,'2026-09-30');
 const absentVisit=await call('qa-agent1','filter=unvisitedPrevious');assert.equal(absentVisit.total,1);assert.equal(absentVisit.rows[0].key,'company:100','previously visited company is absent only for this actor');assert.equal((await call('qa-agent1','filter=unvisitedThree')).total,1);
 const oldest=await call('qa-agent1','sort=lastBilling&direction=asc');assert.equal(oldest.rows[0].id,'monthly-three','last-billing sort includes prior months for inactive clients');
 const visited=await call('qa-agent1','filter=visited');assert.equal(visited.rows[0].id,'monthly-unlinked','visits do not require history linkage');assert.equal(visited.rows[0].metrics.valueCents,null);
 const national=await call('qa-manager');assert.equal(national.totals.visits,2);assert.equal((await call('qa-manager','agentId=qa-agent1')).totals.visits,1,'selected actor independent of current owner');
 const missingMonth=await fetch('http://127.0.0.1:3000/api/sales/clients?month=2026-10&q=Client+sintetic',{headers:{Cookie:sessions['qa-agent1']}});assert.equal(missingMonth.status,200);const missing=await missingMonth.json();assert.equal(missing.window.imported,false);assert.equal(missing.totals.valueCents,null);assert.equal(missing.totals.billed,null);assert.equal(missing.totals.visits,1,'recorded October visits survive absent October imports');assert.equal(missing.counts.absentPrevious,0);
 for(let i=0;i<25;i++){const id='monthly-extra-'+i;app.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,'g-5',JSON.stringify({id,name:'Client sintetic extra '+i,cui:'100',city:'Oraș test',county:'Județ test',warehouseIds:['g-5'],address:'',route:''}));}
 const expanded=(await call('qa-agent1','sort=name&direction=asc')).rows.find(r=>r.id==='monthly-a');assert.equal(expanded.pointCount,27);assert.equal(expanded.points.length,20,'bounded response keeps full point count and exact authorized shortcuts');assert.equal(expanded.metrics.valueCents,3200);
 // Changed current portfolio must be enforced without rebuilding historical snapshots.
 app.prepare("UPDATE customers SET warehouse_id='g-3',data=json_set(data,'$.warehouseIds',json('[\"g-3\"]'),'$.warehouseId','g-3') WHERE id='monthly-unlinked'").run();
 const changed=await call('qa-agent1','filter=visited');assert.equal(changed.total,0);assert.equal(changed.totals.visits,0);assert.equal(changed.counts.all,64);
 app.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run('monthly-nocui','g-5',JSON.stringify({id:'monthly-nocui',name:'Client sintetic fără CUI',cui:'',city:'Oraș test',county:'Județ test',warehouseIds:['g-5'],address:'',route:''}));visit.run('monthly-visit-nocui','monthly-nocui','qa-agent1','2026-09-02T10:00:00.000Z','2026-09-02T10:00:00.000Z');
 const unidentified=await call('qa-agent1','filter=visited');assert.equal(unidentified.total,1);assert.equal(unidentified.totals.visits,1);assert.equal(unidentified.totals.visited,0);assert.equal(unidentified.totals.visitedUnidentified,1,'unidentified cards retain visits without inventing unique legal companies');
 // Canonical county selection/search leaves legal grouping and raw point identity intact.
 for(const [id,county] of [['monthly-a','OLT'],['monthly-sibling','Olt']])app.prepare("UPDATE customers SET data=json_set(data,'$.county',?) WHERE id=?").run(county,id);
 const countyA=await call('qa-manager','county=OLT'),countyB=await call('qa-manager','county=Olt');assert.deepEqual(countyA.rows,countyB.rows);assert.equal(countyA.total,1);assert.equal(countyA.rows[0].metrics.valueCents,3200);assert.deepEqual(countyA.rows[0].counties,['Județ test','Olt'],'county selects a company but retains its other current points and counties');
 async function reconcile(user='qa-manager',query='month=2026-09',status=200){const r=await fetch('http://127.0.0.1:3000/api/sales/clients/reconciliation?'+query,{headers:{Cookie:sessions[user]||''}});assert.equal(r.status,status);return r.headers.get('content-type')?.includes('application/json')?r.json():r.text();}
 await reconcile('anonymous','month=2026-09',401);await reconcile('qa-agent1','month=2026-09',403);await reconcile('qa-agent1','month=2026-09&format=csv',403);
 await reconcile('qa-manager','month=2026-09&agentId=qa-agent1',400);await reconcile('qa-manager','month=2026-09&format=xml',400);
 const baselineBridge=await reconcile();assert.equal(baselineBridge.buckets.currentPortfolio.knownCents,manager.totals.valueCents);assert.equal(baselineBridge.buckets.raw.missingValues,1);
 // Inactive/absent current CRM membership changes must apply without a historical rebuild.
 app.prepare("UPDATE customers SET active=0 WHERE id='monthly-hidden'").run();app.prepare("DELETE FROM customers WHERE id='monthly-page-54'").run();
 const moved=await reconcile();assert.equal(moved.buckets.inactive.knownCents,900000);assert.equal(moved.buckets.absent.knownCents,10054);assert.equal(moved.source.revision,baselineBridge.source.revision);assert.notEqual(moved.portfolioRevision,baselineBridge.portfolioRevision);
 const historyEdit=new DatabaseSync(join(historyDir,'client-sales-history.sqlite'));
 historyEdit.exec(`INSERT INTO history_identities VALUES(9901,'CLIENTGEN');INSERT INTO history_allocations VALUES(9901,'ref','consumer','[]','[]');INSERT INTO history_rows VALUES(1,9901,'2026-09-05','site','consumer',5000,1000000,'Synthetic seller','item','Synthetic item',9901);
 INSERT INTO history_identities VALUES(9902,'');INSERT INTO history_allocations VALUES(9902,'ref','reconcile','[]','[]');INSERT INTO history_rows VALUES(1,9902,'2026-09-05','site','unresolved',-123,-1000000,'Synthetic seller','item','Synthetic item',9902);
 INSERT INTO history_imports VALUES(2,'synthetic-october','active','2026-10-01','2026-10-03',2,'2026-10-03T09:00:00Z');INSERT INTO history_rows VALUES(2,9901,'2026-10-01','site','consumer-october',125,1000000,'Synthetic seller','item','Synthetic item',9903);INSERT INTO history_rows VALUES(2,9902,'2026-10-02','site','unknown-october',0,1000000,'Synthetic seller','item','Synthetic item',9904);UPDATE history_imports SET sha256='bridge-revision' WHERE id=1;`);historyEdit.close();
 await reconcile('qa-manager','month=2026-09',503);
 buildActivitySnapshot(root);
 const sourceBefore=readFileSync(join(historyDir,'client-sales-history.sqlite'));
 for(const month of ['2026-09','2026-10']){
   const bridge=await reconcile('qa-manager','month='+month),b=bridge.buckets;
   assert.equal(b.raw.knownCents,b.consumer.knownCents+b.linkedCompany.knownCents+b.identity.knownCents);assert.equal(b.linkedCompany.knownCents,b.currentPortfolio.knownCents+b.absent.knownCents+b.inactive.knownCents);
   assert.equal(b.raw.sourceRows,b.consumer.sourceRows+b.currentPortfolio.sourceRows+b.absent.sourceRows+b.inactive.sourceRows+b.identity.sourceRows);
   const sourceDb=new DatabaseSync(join(historyDir,'client-sales-history.sqlite'),{readOnly:true});const exact=sourceDb.prepare("SELECT SUM(value_cents) cents,COUNT(*) rows FROM history_rows r JOIN history_imports i ON i.id=r.import_id AND i.state='active' WHERE r.date>=? AND r.date<=?").get(bridge.window.from,bridge.window.to);sourceDb.close();assert.equal(b.raw.knownCents,exact.cents);assert.equal(b.raw.sourceRows,exact.rows);
   assert(bridge.exceptions.some(r=>r.category==='identity'));assert(bridge.source.revision);assert(bridge.source.coverage.length===2);
   const csv=await reconcile('qa-regional','month='+month+'&format=csv');assert(csv.includes(bridge.source.revision));assert(csv.includes('Known cents'));assert(csv.includes('identity:9902'));if(month==='2026-09')assert(csv.includes('"-123"'),'negative cents remain numeric in CSV');assert(!csv.includes('[object Object]'));
 }
 const nationalBridge=await reconcile();assert.equal(nationalBridge.buckets.consumer.knownCents,5000);assert.equal(nationalBridge.buckets.identity.knownCents,-123);assert.equal(nationalBridge.exceptions.find(r=>r.category==='inactive').companyId,'700');
 assert.deepEqual((await reconcile('qa-regional')).buckets,nationalBridge.buckets);
 assert.deepEqual(readFileSync(join(historyDir,'client-sales-history.sqlite')),sourceBefore,'read model, bridge and export never mutate historical sales');
 assert.match(nationalBridge.source.revision,/^[a-f0-9]{64}$/);assert.match(nationalBridge.portfolioRevision,/^[a-f0-9]{64}$/,'exported revisions do not expose filesystem locations');
 const inPlace=new DatabaseSync(join(historyDir,'client-sales-history.sqlite'));inPlace.exec("UPDATE history_rows SET value_cents=5001 WHERE identity_id=9901 AND import_id=1");inPlace.close();
 await reconcile('qa-manager','month=2026-09',503);buildActivitySnapshot(root);const revised=await reconcile();assert.notEqual(revised.source.revision,nationalBridge.source.revision,'source revision includes physical source generation even when an external correction retains import metadata');assert.equal(revised.buckets.consumer.knownCents,5001);

 const c=new DatabaseSync(join(historyDir,'client-sales-history.sqlite'));c.exec("UPDATE history_imports SET sha256='changed'");c.close();assert.equal((await call()).state,'unavailable');
 console.log('PASS: monthly HTTP auth, shared/legal dedup, source sellers independent of owner, live membership, sort/page/nulls, counts, validation Bucharest actor-scoped visits, canonical counties, national cents bridge, live CRM exceptions and protected CSV.');
}finally{
 app.exec("DELETE FROM partner_visits WHERE id LIKE 'monthly-visit-%'; DELETE FROM customers WHERE id LIKE 'monthly-%'");for(const hash of hashes)app.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);app.close();rmSync(historyDir,{recursive:true,force:true});rmSync(temp,{recursive:true,force:true});
}
