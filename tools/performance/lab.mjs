// LAB only: no payloads, search text, account IDs or endpoints in artifacts.
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {cpus,loadavg} from 'node:os';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
const WallDate=Date;
const affinity=()=>{try{return readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]||null;}catch{return null;}};
export function distribution(samples){
 if(!samples.length)throw new Error('No observations');
 const n=samples.length;
 if(n<30)return {n,percentiles:'insufficient_samples'};
 const sorted=[...samples].sort((a,b)=>a-b);
 return {n,min:sorted[0],max:sorted.at(-1),mean:samples.reduce((a,b)=>a+b,0)/n,p50:sorted[Math.ceil(n*.5)-1],p95:sorted[Math.ceil(n*.95)-1]};
}
export function payloadBytes(value){const raw=Buffer.from(typeof value==='string'?value:JSON.stringify(value));return {raw:raw.length,gzip:gzipSync(raw).length,brotli:brotliCompressSync(raw).length,compression:'offline estimate; not measured network transfer'};}
export function lab(suite,source){
 const cases=[],started=new WallDate().toISOString(),startLoad=loadavg(),delay=monitorEventLoopDelay({resolution:10});delay.enable();
 return {cases,async measure(name,role,state,n,fn){
  const samples=[],cpu=process.cpuUsage(),memoryBefore=process.memoryUsage();let result;
  for(let i=0;i<n;i++){const at=performance.now();result=await fn(i);samples.push(performance.now()-at);}
  const record={name,role,state,unit:'ms',n,...n>=30?{samples,distribution:distribution(samples)}:{observationsMs:samples,percentiles:'insufficient_samples'},cpu:process.cpuUsage(cpu),memoryBefore,memoryAfter:process.memoryUsage()};cases.push(record);console.log(JSON.stringify({name,n,...n>=30?record.distribution:{observationsMs:samples}}));return {record,result};
 },save(extra={}){
  delay.disable();const label=process.env.LAB_LABEL||'candidate';if(!/^[a-zA-Z0-9_-]+$/.test(label))throw new Error('Invalid LAB_LABEL');
  const dir=resolve('work/performance');mkdirSync(dir,{recursive:true});const path=join(dir,`${suite}-${label}.json`);
  const data={schema:1,suite,label,processMetricsScope:'harness process; HTTP server child excluded; event-loop monitor also spans setup and offline compression',environment:'synthetic LAB; shared host, no production SLA',started,finished:new WallDate().toISOString(),source,revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),node:process.version,cpuAffinity:affinity(),cpuCount:cpus().length,loadStart:startLoad,loadEnd:loadavg(),eventLoop:{meanMs:delay.mean/1e6,maxMs:delay.max/1e6},cases,...extra};writeFileSync(path,JSON.stringify(data,null,2)+'\n',{mode:0o600});console.log('LAB artifact: '+path);return data;
 }};
}
export function positiveInt(value,fallback){const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<1||n>100000)throw new Error('Invalid LAB size');return n;}
