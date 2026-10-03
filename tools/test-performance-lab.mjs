import assert from 'node:assert/strict';
import {distribution,payloadBytes} from './performance/lab.mjs';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
assert.equal(distribution([1,2,3,4]).p95,undefined);
assert.equal(distribution([1,2,3,4]).min,undefined,'Short probes are observations, not a distribution');
assert.equal(distribution(Array.from({length:30},(_,i)=>i+1)).p95,29);
assert.equal(distribution(Array.from({length:30},(_,i)=>i+1)).p50,15);
assert.throws(()=>distribution([]));
const bytes=payloadBytes('ș'.repeat(1000));assert.equal(bytes.raw,2000);assert(bytes.gzip<bytes.raw);assert(bytes.brotli<bytes.raw);
const t=await clientSalesTestRuntime(),m=t.module;
try{
 m.buildActivitySnapshot(t.root,'2026-09-30');
 for(const month of ['2026-09','2026-08','2026-10']){
  const report=m.readClientSales(t.partners,month,t.root,'2026-10-02');assert.equal(report.state,'ready');
  const packed=await m.packClientSales(report,64*1024*1024);assert(packed);assert(packed.bytes>=2*(packed.header.length+packed.chunks.reduce((n,s)=>n+s.length,0)));
  assert.deepEqual(await m.unpackClientSales(packed),report,'all fields, missing amounts, zero/negative returns and comparisons round-trip');
  assert.equal(await m.packClientSales(report,packed.bytes-1),undefined,'oversized entries are not admitted');
  assert((await m.packClientSales(report,packed.bytes)),'exact bounded size is admitted');
  const empty=await m.unpackClientSales(packed,new Set());assert.equal(empty.rows.length,0);assert.equal(empty.comparisonMetrics.size,0);
  const selected=await m.unpackClientSales(packed,new Set([report.rows[0].key]));assert.deepEqual(selected.rows,[report.rows[0]]);assert.deepEqual([...selected.comparisonMetrics],[[report.rows[0].key,report.comparisonMetrics.get(report.rows[0].key)]]);
  const mutable=await m.unpackClientSales(packed);mutable.rows[0].metrics.valueCents=-99;mutable.rows[0].previous.documents=99;mutable.rows[0].points[0].name='changed';mutable.rows[0].health.reason='changed';mutable.rows[0].flags.push('visited');mutable.rows[0].counties.push('changed');mutable.comparisonMetrics.values().next().value[0].valueCents=-1;mutable.source.coverage[0].start='changed';mutable.window.from='changed';mutable.comparisons[0].from='changed';
  assert.deepEqual(await m.unpackClientSales(packed),report,'no caller mutation enters the cache');
 }
 // SQLite identity projection preserves the previous full-JSON coercion,
 // including unusual legacy JSON scalar/composite values.
 for(const cui of [undefined,null,0,123,true,false,'RO123',['RO123'],{code:'RO123'}]){
  const data=JSON.stringify({cui,notes:'Synthetic unused field '.repeat(100)});
  const projected=t.sql.prepare("SELECT ?->'$.cui' cui").get(data).cui;
  assert.equal(String(JSON.parse(projected??'null')||''),String(JSON.parse(data).cui||''));
 }
 const first=await t.call('','manager'),builds=m.clientSalesCacheStats.builds;
 assert.deepEqual(await t.call('','manager'),first);assert.equal(m.clientSalesCacheStats.builds,builds);
 const aliases=await t.call('county=Iași&q=ȘTIINȚĂ','manager');assert.deepEqual(await t.call('q=stiinta&county=RO-IS','manager'),aliases);
 console.log('PASS: LAB percentile floor, UTF-8/compression accounting, bounded report codec and exact mutable-copy equivalence.');
}finally{t.cleanup();}
