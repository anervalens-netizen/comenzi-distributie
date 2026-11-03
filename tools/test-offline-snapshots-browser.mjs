// Standalone, real Chrome IndexedDB; no application server or private fixtures.
// CHROME_BIN supports the same Chrome/Chromium selection as the other suites.
// For comparison only: OFFLINE_WORK_SOURCE=/tmp/baseline.ts node <this> --expect-bug
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {browserFixture} from './offline-browser-fixture.mjs';

const source=process.env.OFFLINE_WORK_SOURCE||'lib/offline-work.ts';
const compiled=await build({stdin:{contents:readFileSync(source,'utf8'),resolveDir:resolve('lib'),loader:'ts'},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
// This subset also runs in restricted environments without opening any storage.
// It cannot substitute for the browser rollback/concurrency acceptance below.
if(!process.argv.includes('--expect-bug')){
 const offline=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 const previous=globalThis.indexedDB;let opened=false;
 globalThis.indexedDB={open(){opened=true;throw Error('Preflight unexpectedly touched IndexedDB');}};
 try{
  await assert.rejects(offline.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',Array.from({length:660},(_,id)=>({id})),1),{code:'OFFLINE_CAPACITY'});
  for(const size of [0,-1,1.5,NaN,Infinity])await assert.rejects(offline.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',[],size));
  const cyclic={};cyclic.self=cyclic;
  await assert.rejects(offline.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',[{id:1},cyclic],1));
  await assert.rejects(offline.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',[{padding:'x'.repeat(4300000)}],1),{code:'SNAPSHOT_TOO_LARGE'});
  await assert.rejects(offline.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',Array.from({length:7},()=>({padding:'x'.repeat(2000000)})),1),{code:'OFFLINE_CAPACITY'});
  assert.equal(opened,false);
  console.log('PASS: 660-fragment capacity, invalid chunk sizes, serialization, per-record and aggregate byte limits reject before any IndexedDB access');
 }finally{if(previous===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=previous;}
}
if(process.argv.includes('--preflight-only'))process.exit(0);
const server=createServer((req,res)=>{
 res.setHeader('Content-Type',req.url==='/fixture.mjs'?'text/javascript':'text/html');
 res.end(req.url==='/fixture.mjs'?compiled.outputFiles[0].text:'<!doctype html><title>Synthetic snapshot regression</title>');
});
let browser;
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);
 await browser.evaluate("window.m=await import('/fixture.mjs')");
 await browser.evaluate(`window.verifyCache=${verifyCache.toString()}`);
 const reproduction=await browser.evaluate(`(${reproduce.toString()})()`);
 console.log('660 fragments, chunk=1:',JSON.stringify(reproduction));
 if(process.argv.includes('--expect-bug')){
  assert.deepEqual(reproduction,{saved:660,error:null,hasSnapshot:false,previousLost:true});
  console.log('REPRODUCED: saved=660, hasSnapshot=false, previousLost=true');
 }else{
  assert.deepEqual(reproduction,{saved:null,error:'OFFLINE_CAPACITY',hasSnapshot:true,previousLost:false});
  const checks=await browser.evaluate(`(${regressions.toString()})()`);
  for(const label of checks)console.log('PASS:',label);

  // Two actual documents/connections publish to the same account/path. Readers
  // may observe either generation, but must never observe a mixture or a hole.
  const other=await browser.newTab();
  await other.evaluate("window.m=await import('/fixture.mjs')");
  await browser.evaluate("await m.saveFragmentedSnapshot('tabs','shared','partners',Array.from({length:35},()=>({generation:'initial'})),7)");
  const writer=generation=>`(async()=>{for(let i=0;i<8;i++)await m.saveFragmentedSnapshot('tabs','shared','partners',Array.from({length:35},()=>({generation:${JSON.stringify(generation)}})),7);return true})()`;
  const reader=`(async()=>{for(let i=0;i<40;i++){const result=await m.snapshot('tabs','shared');if(!result||result.value.partners.length!==35||new Set(result.value.partners.map(row=>row.generation)).size!==1)throw Error('Mixed or missing generation');}return true})()`;
  assert.deepEqual(await Promise.all([browser.evaluate(writer('A')),other.evaluate(writer('B')),browser.evaluate(reader)]),[true,true,true]);
  await browser.evaluate(`(${verifyCache.toString()})()`);
  console.log('PASS: concurrent tab publishers/readers retain whole generations and exact accounting');
 }
}finally{
 await browser?.close();
 server.closeAllConnections();
 if(server.listening)await new Promise(resolve=>server.close(resolve));
}

async function reproduce(){
 const user='synthetic-user',path='partner/summary';
 await m.saveSnapshot(user,path,{partners:[{id:'prior-good'}]});
 let saved=null,error=null;
 try{saved=(await m.saveFragmentedSnapshot(user,path,'partners',Array.from({length:660},(_,id)=>({id})),1)).count;}
 catch(e){error=e.code||e.name;}
 const after=await m.snapshot(user,path);
 return {saved,error,hasSnapshot:!!after,previousLost:after?.value.partners[0]?.id!=='prior-good'};
}

// Runs entirely inside the disposable browser origin. Every payload is synthetic.
async function regressions(){
 const checks=[];
 const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
 const req=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 const db=await req(indexedDB.open('mobiup-offline-cache-v1',1));
 const raw=async run=>{
  const tx=db.transaction(['snapshots','snapshotIndex','meta'],'readwrite');
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  await run(tx);await done;
 };
 const state=async()=>{
  const tx=db.transaction(['snapshots','snapshotIndex','meta']);
  return JSON.stringify(await Promise.all(['snapshots','snapshotIndex','meta'].map(name=>req(tx.objectStore(name).getAll()))));
 };
 const reset=()=>raw(async tx=>{
  tx.objectStore('snapshots').clear();tx.objectStore('snapshotIndex').clear();
  tx.objectStore('meta').put({key:'snapshot-stats',count:0,bytes:0,pinnedBytes:0});
 });
 const seed=async(count,extra=[])=>raw(async tx=>{
  const store=tx.objectStore('snapshots'),index=tx.objectStore('snapshotIndex');
  for(let i=0;i<count;i++){
   const path='filler/'+i,value={i},row={key:'fill|'+path,userId:'fill',path,value,at:100+i,bytes:JSON.stringify(value).length*2};
   store.put(row);const {value:_,...metadata}=row;index.put({...metadata,pinned:false});
  }
  for(const row of extra){store.put(row);const {value:_,...metadata}=row;index.put({...metadata,pinned:false});}
  const rows=await req(index.getAll());
  tx.objectStore('meta').put({key:'snapshot-stats',bytes:rows.reduce((n,row)=>n+row.bytes,0),count:rows.length,pinnedBytes:rows.filter(row=>row.pinned).reduce((n,row)=>n+row.bytes,0)});
 });
 const rejectsUnchanged=async(action,label)=>{
  const before=await state();let rejected=false;
  try{await action();}catch{rejected=true;}
  check(rejected&&await state()===before,label);
 };
 try{
  // Warm lazy metadata maintenance before comparing full rollback state.
  await m.saveSnapshot('warm','warm',{ok:true});
  await reset();
  const list=Array.from({length:511},(_,id)=>({id}));
  let writeCount=0;
  const transaction=Reflect.get(IDBDatabase.prototype,'transaction');
  IDBDatabase.prototype.transaction=function(stores,mode,...args){if(this.name==='mobiup-offline-cache-v1'&&mode==='readwrite')writeCount++;return transaction.call(this,stores,mode,...args);};
  let first;
  try{first=await m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',list,100);}
  finally{IDBDatabase.prototype.transaction=transaction;}
  check(writeCount===1,'511 rows publish in one write transaction');
  check(JSON.stringify((await m.snapshot('synthetic-user','partner/summary')).value.partners)===JSON.stringify(list),'small fragmentation reconstructs every row');
  const marker=await req(db.transaction('snapshots').objectStore('snapshots').get('synthetic-user|partner/summary'));
  await m.saveSnapshot('synthetic-user','partner/summary',marker.value);
  check((await m.snapshot('synthetic-user','partner/summary')).value.partners.length===511,'generic marker refresh retains its still-referenced fragments');
  check(await verifyCache(),'successful publish has complete markers and exact metadata accounting');
  const prior=await state();
  await rejectsUnchanged(()=>m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',Array.from({length:660},(_,id)=>({id})),1),'660 one-row fragments preserve the entire previous fragmented snapshot');
  for(const size of [0,-1,1.5,NaN,Infinity])await rejectsUnchanged(()=>m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',list,size),'invalid chunk size '+size+' fails before mutation');
  const cyclic={};cyclic.self=cyclic;
  await rejectsUnchanged(()=>m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',[{id:'valid'},cyclic],1),'serialization failure in a later fragment preserves old data');
  await rejectsUnchanged(()=>m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',[{padding:'x'.repeat(4300000)}],1),'individual 8 MiB limit preserves old data');
  await rejectsUnchanged(()=>m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',Array.from({length:7},()=>({padding:'x'.repeat(2000000)})),1),'aggregate 24 MiB limit preserves old data');
  await rejectsUnchanged(()=>m.saveSnapshot('synthetic-user','partner/summary',{__mobiupFragments:['missing'],property:'partners',count:1}),'generic writer refuses incomplete markers');
  check(await state()===prior,'all rejected replacements leave payloads, index and stats unchanged');

  // Exercise rollback after deletion/eviction and after real requests have run.
  await seed(640);
  for(const failure of ['quota','request','interrupt']){
   const put=Reflect.get(IDBObjectStore.prototype,'put');let fragments=0,injected=false;
   IDBObjectStore.prototype.put=function(row,...args){
    if(this.name==='snapshots'&&row.userId==='synthetic-user'&&row.path.includes('#')&&++fragments===2){
     injected=true;
     if(failure==='quota')throw new DOMException('Synthetic quota','QuotaExceededError');
     if(failure==='request')return this.add({...row,key:'fill|filler/639'});
     const q=put.call(this,row,...args);q.addEventListener('success',()=>this.transaction.abort(),{once:true});return q;
    }
    return put.call(this,row,...args);
   };
   try{await rejectsUnchanged(()=>m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',list,20),failure+' rolls back eviction, previous fragments, marker, index and stats');}
   finally{IDBObjectStore.prototype.put=put;}
   check(injected,failure+' injection reached the transaction');
  }
  await m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',[{id:'replacement'}],1);
  const retired=await req(db.transaction('snapshots').objectStore('snapshots').getAll());
  check(first.fragments.every(path=>!retired.some(row=>row.key==='synthetic-user|'+path)),'successful replacement removes all retired fragments');
  await m.saveSnapshot('synthetic-user','partner/summary',{partners:[{id:'regular'}]});
  check((await m.snapshot('synthetic-user','partner/summary')).value.partners[0].id==='regular','ordinary replacement of fragmented snapshot remains readable');
  await m.saveFragmentedSnapshot('empty','summary','partners',[]);
  check((await m.snapshot('empty','summary')).value.partners.length===0,'empty fragmented snapshot is complete');

  await reset();
  const row=(path,value,at)=>({key:'old|'+path,userId:'old',path,value,at,bytes:JSON.stringify(value).length*2});
  // Pre-fix v1 metadata has no group fields. Fragment timestamps deliberately
  // precede the marker, reproducing the original partial-eviction ordering.
  await seed(647,[row('summary#old-0',[{id:0}],1),row('summary#old-1',[{id:1}],2),row('summary',{__mobiupFragments:['summary#old-0','summary#old-1'],property:'partners',count:2},3)]);
  check((await m.snapshot('old','summary')).value.partners.length===2,'pre-existing v1 fragmented snapshot is readable');
  const eviction=await m.saveSnapshot('next','cache',{next:true});
  const left=await req(db.transaction('snapshots').objectStore('snapshots').getAll());
  check(!left.some(row=>row.userId==='old')&&eviction.evicted.length===3,'later ordinary eviction removes the whole legacy group');
  check(db.version===1,'cache database version stays at v1');
  check(await verifyCache(),'legacy metadata enrichment and group eviction retain exact accounting');

  await reset();
  const pinned=await m.saveFragmentedSnapshot('pin','bootstrap','products',[{id:1},{id:2}],1);
  await seed(647);
  await m.saveSnapshot('next','cache',{next:true});
  check((await m.snapshot('pin','bootstrap')).value.products.length===2,'eviction preserves the whole group when its marker is pinned');
  check(pinned.fragments.length===2,'pinned fixture has two actual fragments');
  await rejectsUnchanged(()=>m.saveSnapshot('pin','auth/session',{padding:'x'.repeat(2100000)}),'4 MiB account pinned limit still applies');
  await reset();
  for(let i=0;i<3;i++)await m.saveSnapshot('pin-'+i,'bootstrap',{padding:'x'.repeat(2000000)});
  await rejectsUnchanged(()=>m.saveSnapshot('pin-3','bootstrap',{padding:'x'.repeat(2000000)}),'12 MiB global pinned limit still applies');

  await reset();
  await m.saveSnapshot('pin','bootstrap',{essential:true});
  await m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',[{id:'keep'}],1);
  await rejectsUnchanged(()=>m.saveFragmentedSnapshot('synthetic-user','partner/summary','partners',Array.from({length:649},(_,id)=>({id})),1),'a new group that cannot fit alongside pinned data preserves the old generation');

  await reset();
  await m.saveFragmentedSnapshot('byte-group','summary','partners',[{padding:'x'.repeat(2000000)},{padding:'x'.repeat(2000000)}],1);
  // Make the byte group oldest without changing its generation or its metadata.
  await raw(async tx=>{
   for(const name of ['snapshots','snapshotIndex']){
    const store=tx.objectStore(name);for(const row of await req(store.getAll()))store.put({...row,at:1});
   }
  });
  for(let i=0;i<3;i++)await m.saveSnapshot('byte-fill','part/'+i,{padding:'x'.repeat(2500000)});
  await m.saveSnapshot('byte-fill','last',{padding:'x'.repeat(2000000)});
  check(await m.snapshot('byte-group','summary')===null,'byte-pressure eviction removes the complete fragmented group');
  const remaining=await req(db.transaction('snapshots').objectStore('snapshots').getAll());
  check(!remaining.some(row=>row.userId==='byte-group'),'byte-pressure eviction leaves no retired group fragments');
  check(await verifyCache(),'byte-pressure eviction retains exact accounting');
  await reset();
  return checks;
 }finally{db.close();}
}

async function verifyCache(){
 const req=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 const db=await req(indexedDB.open('mobiup-offline-cache-v1',1));
 try{
  const tx=db.transaction(['snapshots','snapshotIndex','meta']);
  const [rows,index,stats]=await Promise.all([req(tx.objectStore('snapshots').getAll()),req(tx.objectStore('snapshotIndex').getAll()),req(tx.objectStore('meta').get('snapshot-stats'))]);
  const keys=new Set(rows.map(row=>row.key));
  if(index.length!==rows.length||index.some(row=>!keys.has(row.key)))throw Error('Index does not match payloads');
  if(stats.count!==rows.length||stats.bytes!==rows.reduce((sum,row)=>sum+row.bytes,0)||stats.pinnedBytes!==index.filter(row=>row.pinned).reduce((sum,row)=>sum+row.bytes,0))throw Error('Stats do not match payloads');
  if(stats.count>650||stats.bytes>24*1024*1024||stats.pinnedBytes>12*1024*1024)throw Error('Cache budget exceeded');
  for(const row of rows)if(row.value?.__mobiupFragments){
   let count=0;
   for(const path of row.value.__mobiupFragments){const fragment=rows.find(other=>other.key===row.userId+'|'+path);if(!Array.isArray(fragment?.value))throw Error('Orphan marker');count+=fragment.value.length;}
   if(count!==row.value.count)throw Error('Incomplete marker');
  }
 }finally{db.close();}
 return true;
}
