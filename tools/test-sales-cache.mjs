import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {EventEmitter} from 'node:events';
import {mkdtempSync,renameSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'sales-cache-'));
let checks=0;
const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
try{
 const output=join(dir,'runtime.mjs');await build({entryPoints:['lib/sales-view-node.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {createSalesViewRuntime,SALES_VIEW_CACHE_TTL_MS}=await import(pathToFileURL(output));
 let clock=0,revision=1,fileStamp='file-one',path='synthetic.sqlite',starts=0,live=0,maxLive=0,hold=false,bytes=0;
 const waiting=[];
 const runtime=createSalesViewRuntime({now:()=>clock,identity:()=>({revision,dataPath:path,fileStamp}),createWorker(input){
  const worker=new EventEmitter(),atStart=revision;starts++;live++;maxLive=Math.max(maxLive,live);
  worker.terminate=async()=>{live--;};
  const emit=()=>worker.emit('message',{ok:true,view:{revision:atStart,summary:{rows:1},sample:input.siteCode,payload:'x'.repeat(bytes)}});
  if(hold)waiting.push(emit);else queueMicrotask(emit);
  return worker;
 }});
 const read=(scope='A',catalog=[],from='2026-09',to='2026-09')=>runtime('2026-09',scope,from,to,catalog);
 const view=await read();equal(starts,1,'first calculation');
 clock=5*60*1000;await read();equal(starts,1,'navigation five minutes later reuses revision-validated result');
 view.summary.rows=999;equal((await read()).summary.rows,1,'caller mutation cannot contaminate cached response');
 equal((await read([' a ','A'])).sample,['A'],'canonical same site scope');equal(starts,1,'canonical site duplicates share cache');
 await read('B');await runtime('2026-09',undefined,'2026-09','2026-09',[]);await read([]);equal(starts,4,'site/national/empty scope remain distinct');
 const warehouse=site=>({warehouseNames:['TR Oraș Test'],warehouseSites:[{warehouseName:'TR Shared',siteCode:site}],siteCodes:[],excludedWarehouseNames:[]});
 await read(warehouse('A'));await read(warehouse('B'));equal(starts,6,'constrained warehouse site changes invalidate scope');
 await read({...warehouse('A'),warehouseNames:['tr ORAS-test']});equal(starts,6,'exact normalized location variants share cache');
 await read({...warehouse('A'),excludedWarehouseNames:['TR Elsewhere']});equal(starts,7,'ownership exclusions belong to scope key');
 await read('A',[],'2026-08');equal(starts,8,'explicit history range has own cache entry');
 const catalog=[{code:'P1',name:'Synthetic item',kind:'accessories',category:'Accesorii'}];
 await read('A',catalog);catalog[0].category='Synthetic changed category';await read('A',catalog);equal(starts,10,'catalog mutation changes generation');
 revision++;equal((await read('A',catalog)).revision,2,'committed import revision invalidates');equal(starts,11,'new revision calculated');
 fileStamp='file-two';await read('A',catalog);equal(starts,12,'replacement at same path/revision invalidates');
 path='another-synthetic.sqlite';await read('A',catalog);equal(starts,13,'data path invalidates');
 clock+=SALES_VIEW_CACHE_TTL_MS+1;await read('A',catalog);equal(starts,14,'bounded age expires even unchanged revision');
 hold=true;const pending=Array.from({length:10},()=>read('PENDING',catalog));equal(waiting.length,1,'single active identical request');waiting.shift()();await Promise.all(pending);equal(starts,15,'pending identical reads coalesce');hold=false;
 hold=true;const old=read('RACE',catalog);revision++;waiting.shift()();equal((await old).revision,2,'in-flight read retains coherent old snapshot');hold=false;
 equal((await read('RACE',catalog)).revision,3,'racing import is not cached under old generation');equal(starts,17,'revision race forces new calculation');
 hold=true;const bound=Array.from({length:18},(_,i)=>read('QUEUE-'+i,catalog).then(()=>true,()=>false));
 for(let i=0;i<17;i++){while(!waiting.length)await new Promise(resolve=>setImmediate(resolve));waiting.shift()();}
 equal((await Promise.all(bound)).filter(Boolean).length,17,'one active plus sixteen distinct queued requests; excess rejected');hold=false;
 const prior=starts;await read('QUEUE-0',catalog);equal(starts,prior+1,'sixteenth-entry LRU bound evicts earliest result');equal(maxLive,1,'only one active worker');equal(live,0,'worker slot released');
 // Three 3 MiB responses exceed the shared 8 MiB byte limit.
 revision++;bytes=3*1024*1024;const byteStarts=starts;await read('BYTE-A');await read('BYTE-B');await read('BYTE-C');await read('BYTE-B');equal(starts,byteStarts+3,'recent entry remains under byte budget');await read('BYTE-A');equal(starts,byteStarts+4,'byte budget evicts old large entry');
 revision++;bytes=9*1024*1024;const hugeStarts=starts;await read('HUGE');await read('HUGE');equal(starts,hugeStarts+2,'individual response above byte limit is not cached');
 // Real identity reader: imports by another SQLite connection and an atomic
 // replacement with the same revision/path must invalidate a warmed cache.
 const previousData=process.env.MOBIUP_DATA_DIR,previousCwd=process.cwd();
 process.env.MOBIUP_DATA_DIR=dir;
 try {
  const workerOutput=join(dir,'sales-view-worker.mjs');
  await build({entryPoints:['lib/sales-view-worker.ts'],outfile:workerOutput,bundle:true,platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'synthetic-catalog',setup(b){b.onResolve({filter:/resources\/seed\.json$/},()=>({path:'seed',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'{"products":[]}',loader:'json'}));}}]});
  const databasePath=join(dir,'sales.sqlite'),fixture=new DatabaseSync(databasePath);
  fixture.exec(`CREATE TABLE sales_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE sales_imports(id INTEGER PRIMARY KEY AUTOINCREMENT,month TEXT NOT NULL,file_hash TEXT NOT NULL,filename TEXT NOT NULL,imported_at TEXT NOT NULL,imported_by TEXT NOT NULL,row_count INTEGER NOT NULL,original_path TEXT NOT NULL,revision INTEGER NOT NULL);
   CREATE TABLE sales_months(month TEXT PRIMARY KEY,import_id INTEGER NOT NULL,imported_at TEXT NOT NULL,filename TEXT NOT NULL,file_hash TEXT NOT NULL,revision INTEGER NOT NULL);
   CREATE TABLE sales_rows(import_id INTEGER NOT NULL,row_number INTEGER NOT NULL,date TEXT NOT NULL,month TEXT NOT NULL,site_code TEXT NOT NULL,item_code TEXT NOT NULL,item_name TEXT NOT NULL,quantity REAL NOT NULL,brand TEXT NOT NULL,price_cents INTEGER NOT NULL,value_cents INTEGER NOT NULL,location TEXT NOT NULL,company TEXT NOT NULL,asm TEXT NOT NULL,regional TEXT NOT NULL,order_number TEXT NOT NULL,category TEXT NOT NULL,sub_category TEXT NOT NULL,agent TEXT NOT NULL,PRIMARY KEY(import_id,row_number));
   INSERT INTO sales_meta VALUES('revision','1');
   INSERT INTO sales_imports VALUES(1,'2026-09','synthetic','synthetic.xlsx','2026-09-01','synthetic',1,'synthetic',1);
   INSERT INTO sales_months VALUES('2026-09',1,'2026-09-01','synthetic.xlsx','synthetic',1);
   INSERT INTO sales_rows VALUES(1,1,'2026-09-01','2026-09','A','P1','Synthetic item',1,'Synthetic',100,119,'TR Synthetic','Synthetic','','','Synthetic document','Accesorii','','');`);
  fixture.close();
  process.chdir(dir);
  const {getSalesViewRuntime}=await import(pathToFileURL(output).href+'?identity-test');
  const actualRead=()=>getSalesViewRuntime('2026-09',undefined,'2026-09','2026-09',[]);
  equal((await actualRead()).summary.value,1.19,'actual reader returns baseline');
  await actualRead(); // warm after one-time worker schema/index initialization
  const external=new DatabaseSync(databasePath);
  external.exec("BEGIN; UPDATE sales_rows SET value_cents=201; UPDATE sales_meta SET value='2' WHERE key='revision'; UPDATE sales_months SET revision=2; COMMIT;");
  external.close();
  equal((await actualRead()).summary.value,2.01,'external committed revision invalidates real cache immediately');
  await actualRead();
  const snapshot=new DatabaseSync(databasePath),replacementPath=join(dir,'replacement.sqlite');
  snapshot.prepare('VACUUM INTO ?').run(replacementPath);snapshot.close();
  const replacement=new DatabaseSync(replacementPath);replacement.exec('UPDATE sales_rows SET value_cents=333;');replacement.close();
  renameSync(replacementPath,databasePath);
  equal((await actualRead()).summary.value,3.33,'same path and same revision replacement invalidates cached values');
 } finally {process.chdir(previousCwd);if(previousData===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previousData;}
 console.log(`PASS: ${checks} long-lived Sales cache checks: revision/catalog/path/file/scope, mutation isolation, coalescing, race, TTL, queue and entry/byte bounds.`);
}finally{rmSync(dir,{recursive:true,force:true});}
