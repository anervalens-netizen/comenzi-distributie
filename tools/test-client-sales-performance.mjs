// Representative synthetic scale; timings are evidence, not machine-specific gates.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createServer} from 'node:http';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
const t=await clientSalesTestRuntime({sourceRef:process.env.LAB_SOURCE_REF}),{root,sql,module:m,call}=t;
let server;
try{
 const n=35581,c=new DatabaseSync(join(root,'client-history/client-sales-history.sqlite'));
 const customer=sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)'),identity=c.prepare('INSERT INTO history_identities VALUES(?,?)'),allocation=c.prepare("INSERT INTO history_allocations VALUES(?,'ref','single_partner',?,'[]')"),row=c.prepare("INSERT INTO history_rows VALUES(1,?,?, 'synthetic-site',?,?,1000000,'Synthetic seller','x','Synthetic item',?)");
 c.exec('CREATE UNIQUE INDEX history_identity_key ON history_identities(id); CREATE UNIQUE INDEX history_import_key ON history_imports(id); CREATE UNIQUE INDEX history_allocation_key ON history_allocations(identity_id,reference_id); CREATE INDEX history_rows_identity_date ON history_rows(identity_id,date,import_id); CREATE INDEX history_rows_date ON history_rows(date,import_id); CREATE INDEX history_allocations_reference ON history_allocations(reference_id,identity_id);');
 sql.exec('BEGIN');c.exec('BEGIN');
 for(let i=0;i<n;i++){
  const id='scale-'+String(i).padStart(5,'0'),cui=String(1000000+i),owner=i%10?'g-3':'g-5';
  customer.run(id,owner,JSON.stringify({id,cui,warehouseId:owner,warehouseIds:[owner],name:('Synthetic company '+id+' with a descriptive catalogue label').padEnd(95,'x'),city:'Synthetic city',county:'Synthetic county',address:'Synthetic address',route:''}));identity.run(30000+i,cui);allocation.run(30000+i,JSON.stringify([id]));
  for(let day=0;day<7;day++)row.run(30000+i,['2026-05-01','2026-06-05','2026-07-05','2026-08-01','2026-08-20','2026-09-05','2026-09-28'][day],'document-'+day,1000+i,day);
 }
 c.exec("UPDATE history_imports SET sha256='synthetic-scale',row_count=(SELECT COUNT(*) FROM history_rows);COMMIT;");sql.exec('COMMIT');c.close();
 m.buildActivitySnapshot(root,'2026-09-30');
 server=createServer(async(req,res)=>{
  if(req.url==='/health'){res.end('ok');return;}
  try{const result=await call(req.url.slice(2),'manager');res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}catch(error){res.statusCode=error.status||500;res.end(error.message);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 async function wave(label){
  const start=performance.now(),latencies=[];let done=false;
  const light=(async()=>{while(!done){const at=performance.now();const response=await fetch(origin+'/health');assert.equal(await response.text(),'ok');latencies.push(performance.now()-at);await new Promise(resolve=>setTimeout(resolve,5));}})();
  const reports=await Promise.all(Array.from({length:4},async()=>{const response=await fetch(origin+'/?sort=value');assert.equal(response.status,200);return response.json();}));done=true;await light;
  for(const report of reports)assert.deepEqual(report,reports[0]);
  const firstName=reports[1].rows[0].name;reports[0].rows[0].name='Caller-local mutation';assert.equal(reports[1].rows[0].name,firstName,'coalesced readers receive independent rows');reports[0].rows[0].name=firstName;
  const duration=performance.now()-start,max=Math.max(...latencies);
  assert(latencies.length>=4,'light HTTP requests must complete DURING both cold and warm national work');
  assert(max<duration*.7,'light request must not wait behind the entire report wave');
  console.log(JSON.stringify({wave:label,groups:reports[0].total,ms:Math.round(duration),healthSamples:latencies.length,maxHealthMs:Math.round(max),cache:{...m.clientSalesCacheStats}}));return reports[0];
 }
 const before=m.clientSalesCacheStats.builds;const cold=await wave('cold');assert.equal(m.clientSalesCacheStats.builds-before,1,'identical cold reads are single-flight');const admittedBuilds=m.clientSalesCacheStats.builds,admittedHits=m.clientSalesCacheStats.hits;assert(m.clientSalesCacheStats.bytes>0&&m.clientSalesCacheStats.bytes<=64*1024*1024,'wide national report is admitted within the unchanged serialized cache budget');const warm=await wave('warm');assert.deepEqual(warm,cold);assert.equal(m.clientSalesCacheStats.builds,admittedBuilds,'warm wave must reuse the report, not rebuild it');assert.equal(m.clientSalesCacheStats.hits,admittedHits+4,'all four warm requests must hit the cache');
 for(const [label,query,actor,now] of [['national','','manager'],['search','q=scale-00001','manager'],['page2','page=1','manager'],['agent','','agent'],['missing','month=2026-10','manager','2026-10-02T12:00:00Z']]){
  const params=new URLSearchParams('month=2026-09');for(const [k,v] of new URLSearchParams(query))params.set(k,v);
  const start=performance.now();const result=await m.clientSalesOverview(t.user(actor),params,new Date(now||'2026-09-30T12:00:00Z'));
  assert.equal(result.state,'ready');if(label==='search')assert.equal(result.total,1);if(label==='page2')assert.deepEqual(result.totals,warm.totals);if(label==='missing'){assert.equal(result.window.imported,false);assert.equal(result.comparisons[0].valueCents,warm.totals.valueCents);}
  console.log(JSON.stringify({query:label,ms:Math.round(performance.now()-start),groups:result.total}));
 }
 assert.equal(m.clientSalesCacheStats.stampBuilds,1,'different months and scopes reuse the same verified source fingerprint');
 assert(m.clientSalesCacheStats.bytes<=64*1024*1024,'cache remains bounded');
 sql.prepare("UPDATE customers SET active=0 WHERE id='scale-00000'").run();
 const invalidated=await call('','manager');assert.equal(invalidated.total,warm.total-1,'packed national cache respects live membership revision');
 const changed=new DatabaseSync(join(root,'client-history/client-sales-history.sqlite'));changed.exec("UPDATE history_imports SET sha256='scaled-source-replaced'");changed.close();
 assert.equal((await call('','manager')).state,'unavailable','packed national cache fails closed after a source mutation');
 console.log('PASS: representative synthetic scale, single-flight cold/warm equivalence and independent HTTP responsiveness.');
}finally{if(server)await new Promise(resolve=>server.close(resolve));t.cleanup();}
