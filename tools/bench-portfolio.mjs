// Measure the distinct portfolio activity report, not just its membership selector.
import assert from 'node:assert/strict';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
import {seedReportScale} from './performance/report-fixture.mjs';
import {lab,payloadBytes,positiveInt} from './performance/lab.mjs';
const NativeDate=Date;
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-30T12:00:00Z']));}};
const t=await clientSalesTestRuntime({profile:true,sourceRef:process.env.LAB_SOURCE_REF});
try{
 const b=lab('portfolio-report',seedReportScale(t,positiveInt(process.env.LAB_COMPANIES,35581))),samples=positiveInt(process.env.LAB_SAMPLES,30);
 for(const role of ['manager','agent']){
  const user={...t.user(role),warehouseId:role==='manager'?'':'g-5',managerScope:role==='manager'?'global':'assigned'};
  const read=()=>t.module.partnerActivityOverview(user,new URLSearchParams('salesPeriod=year:2026'));
  const cold=await b.measure('portfolio-activity',role,'first role access; cold manager projection',1,read);assert.equal(cold.result.state,'ready');cold.record.bytes=payloadBytes(cold.result);
  const warm=await b.measure('portfolio-activity',role,'warm',samples,async()=>{const result=await read();assert.deepEqual(result,cold.result);return result;});warm.record.bytes=payloadBytes(warm.result);
 }
 b.save({measuredSource:process.env.LAB_SOURCE_REF||'working-tree',sql:t.queries,limits:'Distinct activity report, real SQL/ACL, fixed synthetic calendar. No activity report implementation change. Excludes HTTP and browser rendering.'});
}finally{t.cleanup();globalThis.Date=NativeDate;}
