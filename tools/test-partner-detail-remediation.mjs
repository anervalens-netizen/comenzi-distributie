import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
const t=await clientSalesTestRuntime(),{root,module:m,partners}=t;
const history=join(root,'client-history/client-sales-history.sqlite'),snapshot=join(root,'client-history/partner-activity.sqlite');
const params=new URLSearchParams('scope=company&from=2026-09-01&to=2026-09-30');
const detail=(id='monthly-a',cui='100',query=params)=>m.readPartnerSalesAsync(id,cui,query,root);
const sync=(id='monthly-a',cui='100',query=params)=>m.readPartnerSales(id,cui,query,root);
let server;
try {
 // Legacy reference without partners_json is supported by the same batch resolver.
 assert.equal((await detail()).state,'unavailable');
 m.buildActivitySnapshot(root,'2026-09-30');assert.deepEqual(await detail(),sync());
 // A caller-owned connection can predate the pathname generation, even when it
 // supplies that generation explicitly. It may neither hit nor populate the cache.
 const old=new DatabaseSync(history,{readOnly:true});old.exec('BEGIN');old.prepare('SELECT * FROM history_meta').get();
 copyFileSync(history,history+'.new');const replacement=new DatabaseSync(history+'.new');
 replacement.exec("UPDATE history_identities SET client_code='200' WHERE client_code='100';UPDATE history_references SET master_json='[]'");replacement.close();renameSync(history+'.new',history);
 const builds=m.companyLinkCacheStats.builds,hits=m.companyLinkCacheStats.hits;
 assert(m.historyCompanyLinks(old,'ref',m.companyLinkGeneration(old)).identityIdsByCompany.get('100').length);
 assert(m.historyCompanyLinks(old,'ref').identityIdsByCompany.get('100').length);
 assert.equal(m.companyLinkCacheStats.builds,builds+2);assert.equal(m.companyLinkCacheStats.hits,hits);old.close();
 assert.equal(sync().state,'unlinked','stale attribution from unknown connection never leaks to a fresh caller');
 // Deterministically replace AFTER DatabaseSync opens, BEFORE first BEGIN/stat.
 copyFileSync(history,history+'.new');const next=new DatabaseSync(history+'.new');next.exec("UPDATE history_identities SET client_code='300' WHERE client_code='200'");next.close();
 const originalExec=DatabaseSync.prototype.exec;let replaced=false;
 DatabaseSync.prototype.exec=function(sql){if(!replaced&&sql==='BEGIN'){replaced=true;renameSync(history+'.new',history);}return originalExec.call(this,sql);};
 try {sync('monthly-repeat','200');}finally{DatabaseSync.prototype.exec=originalExec;}
 assert(replaced);assert.equal(sync('monthly-repeat','200').state,'unlinked','opened-old index cannot be cached under replacement generation');
 assert.equal((await detail()).state,'unavailable');
 // Restore synthetic identities, add exact archived-object shape and conflicts.
 const c=new DatabaseSync(history);
 c.exec(`UPDATE history_identities SET client_code='100' WHERE id=1;
   UPDATE history_identities SET client_code='200' WHERE id=2;
   UPDATE history_identities SET client_code='300' WHERE id=3;
   ALTER TABLE history_references ADD COLUMN partners_json TEXT;
   ALTER TABLE history_allocations ADD COLUMN reason TEXT NOT NULL DEFAULT '';
   ALTER TABLE history_identities ADD COLUMN franchise_code TEXT NOT NULL DEFAULT '';
   CREATE INDEX history_rows_detail ON history_rows(identity_id,date,import_id);
   INSERT INTO history_identities VALUES(20000,'400','wrong'),(20001,'100','');
   INSERT INTO history_allocations VALUES(20000,'ref','reconcile','[]','["monthly-repeat"]','Franchise/client mismatch'),(20001,'ref','reconcile','[]','["monthly-a","monthly-sibling"]','Multiple or incomplete known work-point addresses');
   INSERT INTO history_rows VALUES(1,20000,'2026-09-27','site','disputed',900000,1000000,'Synthetic seller','x','Synthetic item',20000),(1,20001,'2026-09-10','shared-site','joint',700,1000000,'Synthetic seller','x','Synthetic item',20001);`);
 c.prepare('UPDATE history_references SET master_json=?,partners_json=?').run('[{"CIF":"100","PartnerCode":"alias"}]',JSON.stringify({partners,historySourceIdentities:[],syntheticComment:'x'.repeat(1024*1024-2)+'ș😀'.repeat(Math.ceil(50*1024*1024/6))}));
 const steps=m.historyStampSteps(c);let step;do{step=steps.next();}while(!step.done);assert.deepEqual(step.value,m.historyStamp(c),'UTF-8 chunks match synchronous hash across multibyte boundaries');
 // National identity population is batch-only; reference volume generated at runtime.
 c.exec('BEGIN');const identity=c.prepare('INSERT INTO history_identities VALUES(?,?,?)'),allocation=c.prepare("INSERT INTO history_allocations VALUES(?,'ref','single_partner',?,'[]','')");
 for(let i=0;i<20000;i++){identity.run(30000+i,String(1000000+i),'');allocation.run(30000+i,JSON.stringify(['synthetic-'+i]));}
 c.exec('COMMIT');c.close();m.buildActivitySnapshot(root,'2026-09-30');
 const expected=sync();assert.equal(expected.totals.valueCents,3900);assert.equal(expected.documents.count,1);
 // Instrument SQL: all/all-reference materialization on the async path is forbidden.
 const originalPrepare=DatabaseSync.prototype.prepare,queries=[];
 DatabaseSync.prototype.prepare=function(sql){queries.push(sql);assert(!/SELECT \* FROM history_references|SELECT master_json FROM history_references|FROM history_identities i JOIN history_allocations|FROM history_allocations a/i.test(sql),'HTTP must not rebuild or scan national identities');return originalPrepare.call(this,sql);};
 server=createServer(async(req,res)=>{if(req.url==='/health'){res.end('ok');return;}try{res.setHeader('content-type','application/json');res.end(JSON.stringify(await detail()));}catch(e){res.statusCode=500;res.end(e.stack);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 async function wave(label,count){
   const start=performance.now(),latencies=[];let done=false,completedDuring=0;
   const light=(async()=>{while(!done){const at=performance.now();assert.equal(await (await fetch(origin+'/health')).text(),'ok');latencies.push(performance.now()-at);if(!done)completedDuring++;await new Promise(resolve=>setTimeout(resolve,5));}})();
   const before=m.clientSalesCacheStats.stampBuilds,indexBuilds=m.companyLinkCacheStats.builds;
   const results=await Promise.all(Array.from({length:count},async()=>{const res=await fetch(origin+'/detail');assert.equal(res.status,200);return res.json();}));
   done=true;await light;for(const result of results)assert.deepEqual(result,JSON.parse(JSON.stringify(expected)));
   assert.equal(m.companyLinkCacheStats.builds,indexBuilds,'no national index builds in cold HTTP');
   assert.equal(m.clientSalesCacheStats.stampBuilds,before+1,'cold detail stamp is single-flight');assert(completedDuring>=4,'light HTTP must complete while cold reference hashing is in flight');
   const elapsed=performance.now()-start;assert(Math.max(...latencies)<elapsed*.7,'health never waits for the entire cold request');
   console.log(JSON.stringify({label,requests:count,referenceMiB:51,elapsedMs:Math.round(elapsed),healthSamples:completedDuring,maxHealthMs:Math.round(Math.max(...latencies))}));
 }
 try {
   await wave('cold-detail',1);
   // A fresh derived generation forces another cold fingerprint without modifying raw data.
   copyFileSync(snapshot,snapshot+'.new');renameSync(snapshot+'.new',snapshot);await wave('four-cold-details',4);
   for(const [id,cui,query] of [['monthly-a','100',new URLSearchParams('scope=point')],['monthly-a','100',new URLSearchParams('scope=company&from=2026-08-01&to=2026-08-31')],['monthly-repeat','200',params],['monthly-overdue','400',params],['missing','missing',params]]){
     const actual=await detail(id,cui,query);
     DatabaseSync.prototype.prepare=originalPrepare;const batch=sync(id,cui,query);DatabaseSync.prototype.prepare=function(sql){queries.push(sql);return originalPrepare.call(this,sql);};
     assert.deepEqual(actual,batch,'company/point/date/unresolved, products/documents and original sellers preserve batch semantics');
   }
 }finally{DatabaseSync.prototype.prepare=originalPrepare;}
 assert(queries.some(q=>q.includes('company_identity_links WHERE company_id=?')));
 const indexed=new DatabaseSync(snapshot,{readOnly:true});
 for(const [table,column,key] of [['company_identity_links','company_id','100'],['point_identity_links','partner_id','monthly-a'],['company_code_aliases','company_id','100']])assert(indexed.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${column}=?`).all(key).every(row=>String(row.detail).includes('SEARCH')),'selected identities use an index');
 indexed.close();
 copyFileSync(snapshot,snapshot+'.new');renameSync(snapshot+'.new',snapshot);
 const stampBuilds=m.clientSalesCacheStats.stampBuilds;
 const [sharedDetail,monthly]=await Promise.all([detail(),m.readClientSalesAsync(partners,'2026-09',root,'2026-09-30')]);
 assert.equal(sharedDetail.totals.valueCents,3900);assert.equal(monthly.state,'ready');assert.equal(m.clientSalesCacheStats.stampBuilds,stampBuilds+1,'monthly and detail share the same cold source fingerprint flight');
 const partial=await detail('monthly-overdue','400');assert.equal(partial.coverageComplete,false);assert.equal(partial.unresolvedCompanyIdentities,1);assert.equal(partial.documents.count,0);
 // WAL content update with unchanged reference/import IDs invalidates derived identities.
 const writer=new DatabaseSync(history);writer.exec("PRAGMA journal_mode=WAL;UPDATE history_references SET master_json='[]'");
 assert.equal((await detail()).state,'unavailable');writer.close();m.buildActivitySnapshot(root,'2026-09-30');assert.equal((await detail()).state,'ready');
 // Allocation-only correction must invalidate even if the legacy content stamp is equal.
 const edit=new DatabaseSync(history);edit.exec("UPDATE history_allocations SET reason='conflict' WHERE identity_id=20001");edit.close();assert.equal((await detail()).state,'unavailable');m.buildActivitySnapshot(root,'2026-09-30');assert.equal((await detail()).coverageComplete,false);
 // Race during cooperative hashing and immediately after raw open both fail closed.
 copyFileSync(snapshot,snapshot+'.new');renameSync(snapshot+'.new',snapshot);
 const racing=detail();await new Promise(resolve=>setImmediate(resolve));copyFileSync(history,history+'.new');renameSync(history+'.new',history);assert.equal((await racing).state,'unavailable');
 m.buildActivitySnapshot(root,'2026-09-30');await detail();copyFileSync(history,history+'.new');replaced=false;
 DatabaseSync.prototype.exec=function(sql){if(!replaced&&sql==='BEGIN'){replaced=true;renameSync(history+'.new',history);}return originalExec.call(this,sql);};
 try{assert.equal((await detail()).state,'unavailable');assert(replaced);}finally{DatabaseSync.prototype.exec=originalExec;}
 // Replacement between derived open and its BEGIN is also rejected.
 m.buildActivitySnapshot(root,'2026-09-30');await detail();copyFileSync(snapshot,snapshot+'.new');let begins=0;
 DatabaseSync.prototype.exec=function(sql){if(sql==='BEGIN'&&++begins===2)renameSync(snapshot+'.new',snapshot);return originalExec.call(this,sql);};
 try{assert.equal((await detail()).state,'unavailable');assert.equal(begins,2);}finally{DatabaseSync.prototype.exec=originalExec;}
 // A mismatched derived signature/ref or an older snapshot is explicitly unavailable.
 m.buildActivitySnapshot(root,'2026-09-30');
 for(const [field,value] of [['signature','wrong'],['reference','wrong'],['version','6']]){
   const d=new DatabaseSync(snapshot),metadata=String(d.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value);d.prepare("UPDATE meta SET value=? WHERE key='snapshot'").run(JSON.stringify({...JSON.parse(metadata),[field]:value}));d.close();assert.equal((await detail()).state,'unavailable');
   const restore=new DatabaseSync(snapshot);restore.prepare("UPDATE meta SET value=? WHERE key='snapshot'").run(metadata);restore.close();
 }
 console.log('PASS: D2 opened-inode race and unknown provenance; D3 indexed cold HTTP, shared cooperative hash, scoped parity, conflict flags, WAL/source/ref/derived generation fences.');
}finally{if(server)await new Promise(resolve=>server.close(resolve));t.cleanup();}
