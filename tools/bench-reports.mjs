import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
import {seedReportScale} from './performance/report-fixture.mjs';
import {lab,payloadBytes,positiveInt,distribution} from './performance/lab.mjs';
const n=positiveInt(process.env.LAB_COMPANIES,35581),samples=positiveInt(process.env.LAB_SAMPLES,30);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const semanticDigest=value=>{
 const copy=structuredClone(value);
 if(copy.source){if('builtAt' in copy.source)copy.source.builtAt='<run-local>';if('revision' in copy.source)copy.source.revision='<run-local>';}
 if('portfolioRevision' in copy)copy.portfolioRevision='<run-local>';
 return digest(copy);
};
const freshnessShape=value=>({builtAt:!Number.isNaN(Date.parse(value.source?.builtAt)),sourceRevision:value.source?.revision===undefined||/^[a-f0-9]{64}$/.test(value.source.revision),portfolioRevision:value.portfolioRevision===undefined||value.portfolioRevision===null||/^[a-f0-9]{64}$/.test(value.portfolioRevision)});
const t=await clientSalesTestRuntime({profile:true,sourceRef:process.env.LAB_SOURCE_REF}),m=t.module;
try{
 const source=seedReportScale(t,n),b=lab('reports',source);
 const profile=async(name,role,state,count,fn)=>{for(const k of Object.keys(t.queries))delete t.queries[k];const out=await b.measure(name,role,state,count,fn);out.record.sql=structuredClone(t.queries);return out;};
 const cold=await profile('national','manager','cold process caches + dirty projection; OS cache unspecified',1,()=>t.call('','manager'));assert.equal(cold.result.state,'ready');cold.record.bytes=payloadBytes(cold.result);cold.record.semanticResultSha256=semanticDigest(cold.result);cold.record.freshnessShape=freshnessShape(cold.result);assert.deepEqual(cold.record.freshnessShape,{builtAt:true,sourceRevision:true,portfolioRevision:true});
 const portfolio=await profile('portfolio','manager','warm',samples,()=>m.clientSalesPortfolio(t.user('manager')));
 const directBefore={...m.clientSalesCacheStats};
 const direct=await profile('report-cache-delivery','manager','warm key; baseline rebuild/copy or candidate compact decode',samples,()=>m.readClientSalesAsync(portfolio.result,'2026-09',t.root,'2026-09-30'));
 assert.equal(direct.result.state,'ready');
 direct.record.cacheDelta=Object.fromEntries(Object.entries(m.clientSalesCacheStats).map(([key,value])=>[key,value-(directBefore[key]||0)]));
 direct.record.note='Direct report-store delivery after current portfolio selection; zero application DB queries isolates retained report rebuild/copy versus compact decode.';
 const warm=await profile('national','manager','warm',samples,async()=>{const r=await t.call('','manager');assert.deepEqual(r,cold.result);return r;});warm.record.bytes=payloadBytes(warm.result);
 const readerSamples=[];
 const readers=await profile('four-readers','manager','warm; one sample = complete four-reader wave',samples,async()=>{const rows=await Promise.all(Array.from({length:4},async()=>{const at=performance.now();const result=await t.call('','manager');readerSamples.push(performance.now()-at);return result;}));for(const r of rows)assert.deepEqual(r,cold.result);});
 readers.record.perRequest={samples:readerSamples,distribution:distribution(readerSamples),note:'Four correlated readers per wave'};
 await profile('national','agent','first role access',1,()=>t.call());
 const agent=await profile('national','agent','warm',samples,()=>t.call());agent.record.bytes=payloadBytes(agent.result);
 const searches=['q=ȘTIINȚĂ&county=RO-IS','county=Iași&q=stiinta'];
 const a=await t.call(searches[0],'manager'),z=await t.call(searches[1],'manager');assert.deepEqual(a,z);assert.equal(a.total,n);
 await profile('search-equivalent','manager','warm; alternating equivalent filters',samples,i=>t.call(searches[i%2],'manager'));
 const recon=()=>m.clientSalesReconciliation(t.user('manager'),new URLSearchParams('month=2026-09'),new Date('2026-09-30T12:00:00Z')).then(r=>r.json());
 const first=await profile('reconciliation','manager','cold facts',1,recon);first.record.bytes=payloadBytes(first.result);first.record.semanticResultSha256=semanticDigest(first.result);first.record.freshnessShape=freshnessShape(first.result);assert.deepEqual(first.record.freshnessShape,{builtAt:true,sourceRevision:true,portfolioRevision:true});
 await profile('reconciliation','manager','warm facts; live membership',samples,async()=>{const r=await recon();assert.deepEqual(r,first.result);return r;});
 await assert.rejects(()=>m.clientSalesReconciliation(t.user('agent'),new URLSearchParams('month=2026-09')),e=>e.status===403);
 t.sql.prepare("UPDATE customers SET active=0 WHERE id='scale-00000'").run();
 const invalidated=await profile('national','manager','invalidated membership',1,()=>t.call('','manager'));assert.equal(invalidated.result.total,cold.result.total-1);
 const history=new DatabaseSync(join(t.root,'client-history/client-sales-history.sqlite'));history.exec("UPDATE history_imports SET sha256='synthetic-reimport'");history.close();assert.equal((await t.call('','manager')).state,'unavailable');
 m.buildActivitySnapshot(t.root,'2026-09-30');
 await profile('national','manager','after source rebuild',1,()=>t.call('','manager'));
 b.save({queryPlans:{membership:t.sql.prepare('EXPLAIN QUERY PLAN SELECT m.id FROM portfolio_read_rows m JOIN customers c ON c.id=m.id WHERE c.active=1 AND m.id>? ORDER BY m.id LIMIT 512').all(''),reconciliation:t.sql.prepare("EXPLAIN QUERY PLAN SELECT id,active,data->'$.cui' cui FROM customers WHERE id>? ORDER BY id LIMIT 512").all('')},measuredSource:process.env.LAB_SOURCE_REF||'working-tree',cache:{...m.clientSalesCacheStats},readModel:{...m.readModelMetrics},limits:'API/module + SQLite LAB; excludes HTTP transport, browser rendering and physical mobile. Single cold/invalidated samples have no percentiles.'});
}finally{t.cleanup();}
