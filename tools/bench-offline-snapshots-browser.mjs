// Synthetic real-Chromium comparison, with no timing thresholds or private data.
// CHROME_BIN=/usr/bin/google-chrome node tools/bench-offline-snapshots-browser.mjs
// Default baseline is the exact pre-optimization PR candidate. Override with
// --baseline-ref=<commit> if deliberately comparing a different candidate.
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {browserFixture} from './offline-browser-fixture.mjs';

const baselineRef=process.argv.find(arg=>arg.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length)||'74efb8b917a3100aea1d9e9740b90835af21a534';
if(!/^[a-f0-9]{7,40}$/.test(baselineRef))throw Error('Expected an immutable baseline commit SHA');
const sources={baseline:(await promisify(execFile)('git',['show',baselineRef+':lib/offline-work.ts'],{encoding:'utf8'})).stdout,optimized:readFileSync('lib/offline-work.ts','utf8')};
const modules={};
for(const [name,contents] of Object.entries(sources)){
 const result=await build({stdin:{contents,resolveDir:resolve('lib'),loader:'ts'},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 modules['/'+name+'.mjs']=result.outputFiles[0].text;
}
const server=createServer((req,res)=>{
 res.setHeader('Content-Type',modules[req.url]?'text/javascript':'text/html');
 res.end(modules[req.url]||'<!doctype html><title>Synthetic snapshot benchmark</title>');
});
let browser;
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);
 const tabs={baseline:browser,optimized:await browser.newTab()};
 for(const [name,tab] of Object.entries(tabs))await tab.evaluate(`window.m=await import('/${name}.mjs')`);
 const cases=[
  ...[50,300,600].map(count=>({name:'steady '+count+' rows',count,chars:128,legacy:false,iterations:30})),
  ...[{count:100,chars:20000},{count:300,chars:20000},{count:600,chars:2000}].map(spec=>({...spec,name:'legacy first-save '+spec.count+' x '+spec.chars*2+' bytes',legacy:true,iterations:1})),
  {name:'prepare 400 details',count:0,chars:128,legacy:false,iterations:400,details:true},
 ];
 const results=[];
 for(const spec of cases){
  const samples={baseline:[],optimized:[]};
  // Alternate order to reduce warm-up/order bias. Legacy caches are reseeded
  // on EVERY round, so every sample measures the first post-update publish.
  for(let round=0;round<5;round++)for(const name of round%2?['optimized','baseline']:['baseline','optimized']){
   samples[name].push(await tabs[name].evaluate(`(${measure.toString()})(${JSON.stringify(spec)})`));
  }
  const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const row={case:spec.name,baselineMs:median(samples.baseline.map(s=>s.ms)),optimizedMs:median(samples.optimized.map(s=>s.ms)),samples};
  results.push(row);
  console.log(JSON.stringify(row));
 }
 console.log(JSON.stringify({baselineRef,units:'steady: ms/write; legacy: first-save ms; prepare: total ms',rounds:5,browser:await browser.evaluate('navigator.userAgent'),results},null,2));
}finally{
 await browser?.close();server.closeAllConnections();
 if(server.listening)await new Promise(resolve=>server.close(resolve));
}

async function measure(spec){
 const req=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 // Warm connection/adoption separately; these are cache-write benchmarks.
 await m.saveSnapshot('warm','warm',{ok:true});
 const db=await req(indexedDB.open('mobiup-offline-cache-v1',1));
 try{
  const tx=db.transaction(['snapshots','snapshotIndex','meta'],'readwrite');
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  tx.objectStore('snapshots').clear();tx.objectStore('snapshotIndex').clear();
  let bytes=0;
  for(let i=0;i<spec.count;i++){
   const value={padding:'x'.repeat(spec.chars)},path='detail/'+i;
   const row={key:'bench|'+path,userId:'bench',path,value,at:i+1,bytes:JSON.stringify(value).length*2};bytes+=row.bytes;
   tx.objectStore('snapshots').put(row);
   const {value:_,...metadata}=row;
   tx.objectStore('snapshotIndex').put({...metadata,pinned:false,...(spec.legacy?{}:{fragments:[]})});
  }
  tx.objectStore('meta').put({key:'compact-pin-v1',value:true});
  tx.objectStore('meta').put({key:'snapshot-stats',bytes,count:spec.count,pinnedBytes:0});
  await done;
  // Measure steady replacement after its own one-row metadata warm-up.
  if(!spec.legacy&&!spec.details)await m.saveSnapshot('bench','detail/0',{padding:'y'.repeat(128)});
  const operations={scans:0,payloadReads:0,indexWrites:0},restore=[];
  const wrap=(prototype,name,observe)=>{
   const original=prototype[name];restore.push(()=>{prototype[name]=original;});
   prototype[name]=function(...args){observe.call(this);return original.apply(this,args);};
  };
  wrap(IDBIndex.prototype,'getAll',function(){if(this.objectStore.name==='snapshotIndex')operations.scans++;});
  wrap(IDBObjectStore.prototype,'getAll',function(){if(this.name==='snapshotIndex'||this.name==='snapshots')operations.scans++;});
  wrap(IDBObjectStore.prototype,'get',function(){if(this.name==='snapshots')operations.payloadReads++;});
  wrap(IDBObjectStore.prototype,'put',function(){if(this.name==='snapshotIndex')operations.indexWrites++;});
  let elapsed;
  try{
   const started=performance.now();
   for(let i=0;i<spec.iterations;i++)await m.saveSnapshot('bench',spec.details?'prepared/'+i:spec.legacy?'first-after-update':'detail/0',{padding:'y'.repeat(128)});
   elapsed=performance.now()-started;
  }finally{for(const undo of restore)undo();}
  const stats=await req(db.transaction('meta').objectStore('meta').get('snapshot-stats'));
  const index=await req(db.transaction('snapshotIndex').objectStore('snapshotIndex').getAll());
  if(stats.count!==index.length||stats.bytes!==index.reduce((sum,row)=>sum+row.bytes,0)||stats.pinnedBytes!==0)throw Error('Benchmark accounting mismatch');
  return {ms:spec.details?elapsed:elapsed/spec.iterations,totalMs:elapsed,operations};
 }finally{db.close();}
}
