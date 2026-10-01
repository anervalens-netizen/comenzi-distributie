// Focused R2 regressions: real catalog/inventory SQL and client queue logic.
// Synthetic file-backed SQLite; no resources, listeners, application build or installs.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const dir=mkdtempSync(join(tmpdir(),'r2-inventory-'));
const database=join(dir,'synthetic.sqlite');
let sqlite=new DatabaseSync(database),beforeRun;
sqlite.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,warehouse_id TEXT,active INTEGER);
CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
INSERT INTO users VALUES('agent-a','agent','warehouse-a',1),('agent-b','agent','warehouse-b',1);
INSERT INTO manager_agents VALUES('manager-a','agent-a');`);
const adapter={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){return sqlite.prepare(sql).get(...this.args)||null;},async all(){return {results:sqlite.prepare(sql).all(...this.args)};},async run(){const hook=beforeRun;beforeRun=undefined;hook?.(sql);return {meta:sqlite.prepare(sql).run(...this.args)};}};}};
globalThis.__r2Db=adapter;
const raw=key=>sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value??null;
const put=(key,value)=>sqlite.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));
const readRecord=id=>JSON.parse(raw('inventory-v1:'+id));
const putRecord=record=>put('inventory-v1:'+record.id,record);
function ean(number){const digits=String(200000000000+number);let sum=0;for(let i=digits.length-1,w=3;i>=0;i--,w=w===3?1:3)sum+=Number(digits[i])*w;return digits+(10-sum%10)%10;}
const [eanA,eanB,eanC,eanD,eanE]=[1,2,3,4,5].map(ean);
const product=(id,code,extra={})=>({id,code,name:'Synthetic product '+id,brand:'Synthetic',category:'Synthetic',kind:'accessories',price:2,netPrice:1,sourceRow:1,image:null,...extra});
const seed={products:[product('a','R2-A'),product('b','R2-B'),product('explicit','R2-EXPLICIT',{ean:eanC}),product('plain','R2-PLAIN'),product('code',eanD,{ean:''})]};
const defaultMappings={[eanA]:'R2-A',[eanB]:'R2-A'};
function resetCatalog(){sqlite.prepare("DELETE FROM settings WHERE key='catalog'").run();put('inventory-ean-v1',defaultMappings);}
resetCatalog();
const serverSource=readFileSync('lib/server.ts','utf8');
// Keep actual scope checks. Only infrastructure/transport are stubbed.
const authorization=serverSource.slice(serverSource.indexOf('export function isGlobalManager'),serverSource.indexOf('export function assertOrigin'));
const serverStub=`import {createHash} from 'node:crypto';
export const db=()=>globalThis.__r2Db;
export function fail(status,message){throw Object.assign(new Error(message),{status});}
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const textField=(v,n=500)=>typeof v==='string'?v.trim().slice(0,n):'';
export const jsonBody=req=>req.json();
export const response=(data,status=200)=>Response.json(data,{status});
${authorization}`;
const plugin={name:'r2-synthetic-infrastructure',setup(b){
  b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'r2'}));
  b.onResolve({filter:/^@\/resources\/seed\.json$/},()=>({path:'seed',namespace:'r2'}));
  b.onResolve({filter:/^\.\/stock-server$/},()=>({path:'stock',namespace:'r2'}));
  b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'r2'}));
  b.onLoad({filter:/.*/,namespace:'r2'},a=>({loader:'ts',contents:a.path==='server'?serverStub:a.path==='seed'?`export default ${JSON.stringify(seed)}`:a.path==='stock'?`export const stockForWarehouse=async()=>({importedAt:'2026-01-01T00:00:00.000Z',filename:'synthetic',rows:[{code:'R2-A',name:'Synthetic A',quantity:10,category:'Synthetic'}]});`:`export const useState=(...args)=>globalThis.__r2Hooks.useState(...args);export const useRef=(...args)=>globalThis.__r2Hooks.useRef(...args);export const useEffect=(...args)=>globalThis.__r2Hooks.useEffect(...args);`}));
}};
async function bundle(name,contents){const outfile=join(dir,name+'.mjs');await build({stdin:{contents,resolveDir:resolve('.'),loader:'ts'},outfile,bundle:true,format:'esm',platform:'node',plugins:[plugin],logLevel:'silent'});return outfile;}
const agent={id:'agent-a',name:'Synthetic A',role:'agent',warehouseId:'warehouse-a'};
const other={id:'agent-b',name:'Synthetic B',role:'agent',warehouseId:'warehouse-b'};
const manager={id:'manager-a',name:'Synthetic manager',role:'manager',managerScope:'assigned'};
let inventories,readCatalog,changeProduct;
async function request(method,id,body,user=agent){try{return await inventories(new Request('https://example.invalid/inventory'+(id?'/'+id:''),{method,...body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}}),user,id);}catch(error){if(!error.status)throw error;return Response.json({error:error.message},{status:error.status});}}
async function call(method,id,body,status=200,user=agent){const result=await request(method,id,body,user),data=await result.json();assert.equal(result.status,status,JSON.stringify(data));return data;}
const start=async(user=agent)=>(await call('POST',undefined,{id:randomUUID(),warehouseId:user.warehouseId,scope:'all'},200,user)).inventory;
const scan=(inventory,extra={})=>({operationId:randomUUID(),revision:inventory.revision,action:'scan',ean:eanA,quantity:1,...extra});
const catalogProduct=async id=>(await readCatalog()).products.find(p=>p.id===id);
async function rejectCatalog(id,body){const before=[raw('catalog'),raw('inventory-ean-v1')];await assert.rejects(()=>changeProduct('PUT',id,body),e=>e.status===409);assert.deepEqual([raw('catalog'),raw('inventory-ean-v1')],before);}
let checks=0;
function passed(label){checks++;console.log('PASS '+label);}

// Small deterministic hook runner: real useInventoryPending, API and local-work
// modules, with React lifecycle scheduling and browser storage simulated. Parent
// browser checks cover React rendering; these assertions exercise queue effects.
function hookRunner(client,initial){
  let active=initial,cursor=0,dirty=true,result;
  const cells=[],effects=[];
  const errors=[],messages=[];
  const hooks={
    useState(initialValue){const index=cursor++;if(!cells[index])cells[index]={value:typeof initialValue==='function'?initialValue():initialValue};return [cells[index].value,value=>{cells[index].value=typeof value==='function'?value(cells[index].value):value;dirty=true;}];},
    useRef(initialValue){const index=cursor++;if(!cells[index])cells[index]={current:initialValue};return cells[index];},
    useEffect(fn,deps){const index=cursor++,previous=cells[index];if(!previous||!deps||deps.some((v,i)=>!Object.is(v,previous.deps?.[i]))){effects.push(()=>{previous?.cleanup?.();cells[index]={deps,cleanup:fn()};});}}
  };
  const onActive=value=>{active=value;dirty=true;},onError=value=>errors.push(value),onMessage=value=>messages.push(value),onRefresh=()=>{};
  function render(){globalThis.__r2Hooks=hooks;cursor=0;dirty=false;result=client.useInventoryPending({active,onActive,onError,onMessage,onRefresh});while(effects.length)effects.shift()();}
  async function flush(){for(let i=0;i<30;i++){if(dirty)render();await new Promise(resolve=>setImmediate(resolve));if(!dirty&&!result.processing)return;}assert.fail('Hook did not settle');}
  function close(){for(const cell of cells)cell?.cleanup?.();}
  return {flush,close,errors,messages,get current(){return result;},get active(){return active;},setActive(value){active=value;dirty=true;}};
}

try {
  const serverFile=await bundle('server',`export {inventories} from './lib/inventory-server.ts';export {readCatalog,changeProduct} from './lib/catalog.ts';`);
  ({inventories,readCatalog,changeProduct}=await import(pathToFileURL(serverFile)));

  // Reject inherited EAN renames even if the submitted EAN is omitted, cleared,
  // retained explicitly or replaced. Both catalog and all mappings stay intact.
  for(const extra of [{},{ean:eanA},{ean:''},{ean:eanE}]){
    const p=await catalogProduct('a');const body={...p,code:'R2-RENAMED',...extra};if(!('ean' in extra))delete body.ean;
    await rejectCatalog(p.id,body);
  }
  assert.deepEqual((await catalogProduct('a')).eans,[eanA,eanB]);
  let p=await catalogProduct('a');const body={...p,name:'Synthetic name edit'};delete body.ean;
  await changeProduct('PUT',p.id,body);
  p=await catalogProduct('a');assert.equal(p.name,body.name);assert.deepEqual(p.eans,[eanA,eanB]);
  await changeProduct('PUT',p.id,{...p,code:'  r2-a  ',name:'Synthetic normalized edit'});
  p=await catalogProduct('a');assert.deepEqual(p.eans,[eanA,eanB]);
  assert.equal(Object.hasOwn(JSON.parse(raw('catalog')).overrides.a,'ean'),false);
  const invAfterRejectedRename=await start();
  let scanned=(await call('PATCH',invAfterRejectedRename.id,scan(invAfterRejectedRename))).inventory;
  scanned=(await call('PATCH',scanned.id,scan(scanned,{ean:eanB}))).inventory;
  assert.equal(scanned.lines[0].counted,2);
  passed('inherited multiple EAN rename rejection; name/case edits and both scans preserved');

  for(const explicit of [eanE,'']){
    p=await catalogProduct('a');await changeProduct('PUT',p.id,{...p,ean:explicit});
    p=await catalogProduct('a');await rejectCatalog(p.id,{...p,code:'R2-RENAMED',ean:''});
    assert.deepEqual(JSON.parse(raw('inventory-ean-v1')),defaultMappings);
  }
  p=await catalogProduct('explicit');await rejectCatalog(p.id,{...p,code:'R2-RENAMED',ean:''});
  await changeProduct('PUT',p.id,{...p,name:'Synthetic explicit edit'});
  assert.equal((await catalogProduct('explicit')).ean,eanC);
  p=await catalogProduct('code');await rejectCatalog(p.id,{...p,code:'R2-RENAMED'});
  p=await catalogProduct('plain');await changeProduct('PUT',p.id,{...p,code:'R2-FREE'});
  assert.equal((await catalogProduct('plain')).code,'R2-FREE');
  await rejectCatalog(p.id,{...p,name:'Stale edit'});
  p=await catalogProduct('b');await rejectCatalog(p.id,{...p,ean:eanC});
  passed('explicit, suppressed-import and barcode-as-code associations protected; free rename and conflict rollback');

  for(const existingCatalog of [false,true]){
    resetCatalog();if(existingCatalog)put('catalog',{overrides:{}});
    p=await catalogProduct('plain');const before=raw('catalog');
    beforeRun=()=>put('inventory-ean-v1',{...defaultMappings,[eanE]:'R2-PLAIN'});
    await assert.rejects(()=>changeProduct('PUT',p.id,{...p,code:'R2-FREE'}),e=>e.status===409);
    assert.equal(raw('catalog'),before);assert.equal(JSON.parse(raw('inventory-ean-v1'))[eanE],'R2-PLAIN');
  }
  resetCatalog();p=await catalogProduct('plain');const concurrent={overrides:{b:product('b','R2-B',{name:'Concurrent synthetic edit'})}};
  beforeRun=()=>put('catalog',concurrent);
  await assert.rejects(()=>changeProduct('PUT',p.id,{...p,code:'R2-FREE'}),e=>e.status===409);
  assert.deepEqual(JSON.parse(raw('catalog')),concurrent);
  passed('catalog CAS also detects concurrent mapping imports, preserving the competing write');

  resetCatalog();let inventory=await start();const original=scan(inventory);
  inventory=(await call('PATCH',inventory.id,original)).inventory;
  for(let i=0;i<2005;i++)inventory=(await call('PATCH',inventory.id,scan(inventory))).inventory;
  assert.equal(inventory.lines[0].counted,2006);assert.equal(inventory.revision,2007);
  const durable=raw('inventory-v1:'+inventory.id);
  assert.equal(readRecord(inventory.id).operations.length,2006);
  assert.equal(readRecord(inventory.id).operationHistoryVersion,1);
  assert.equal('operations' in inventory,false);assert.equal('operationHistoryVersion' in inventory,false);
  for(const revision of [original.revision,inventory.revision]){
    const replay=(await call('PATCH',inventory.id,{...original,revision})).inventory;
    assert.equal(replay.lines[0].counted,2006);assert.equal(replay.revision,2007);
  }
  assert.equal(raw('inventory-v1:'+inventory.id),durable);
  const changed=await call('PATCH',inventory.id,{...original,revision:inventory.revision,quantity:2},409);
  assert.equal(changed.code,'INVENTORY_OPERATION_CONFLICT');assert.equal(changed.retryable,false);
  assert.equal(raw('inventory-v1:'+inventory.id),durable);
  sqlite.close();sqlite=new DatabaseSync(database);
  ({inventories,readCatalog,changeProduct}=await import(pathToFileURL(serverFile)+'?restart=1'));
  const restarted=(await call('PATCH',inventory.id,{...original,revision:inventory.revision})).inventory;
  assert.equal(restarted.lines[0].counted,2006);assert.equal(raw('inventory-v1:'+inventory.id),durable);
  passed('2006 real scan operations, old/current revision replay, changed payload and reopened DB/module');

  let concurrentInventory=await start();const concurrentOps=[scan(concurrentInventory),scan(concurrentInventory,{quantity:2})];
  const parallel=await Promise.all(concurrentOps.map(op=>request('PATCH',concurrentInventory.id,op)));
  assert.deepEqual(parallel.map(r=>r.status).sort((a,b)=>a-b),[200,409]);
  const loser=parallel.findIndex(r=>r.status===409),winner=1-loser;
  let record=readRecord(concurrentInventory.id);assert.equal(record.operations.length,1);assert.equal(record.operations[0].id,concurrentOps[winner].operationId);assert.equal(record.lines[0].counted,concurrentOps[winner].quantity);
  concurrentInventory=(await call('PATCH',concurrentInventory.id,{...concurrentOps[loser],revision:record.revision})).inventory;
  assert.equal(concurrentInventory.lines[0].counted,3);assert.equal(readRecord(concurrentInventory.id).operations.length,2);
  const sameOp=scan(concurrentInventory);const same=await Promise.all([request('PATCH',concurrentInventory.id,sameOp),request('PATCH',concurrentInventory.id,sameOp)]);
  assert(same.some(r=>r.status===200));assert(same.every(r=>r.status===200||r.status===409));
  assert.equal((await call('PATCH',concurrentInventory.id,sameOp)).inventory.lines[0].counted,4);
  assert.equal(readRecord(concurrentInventory.id).operations.length,3);
  const beforeFailure=raw('inventory-v1:'+concurrentInventory.id);
  beforeRun=()=>{throw new Error('Synthetic interrupted write');};
  await assert.rejects(()=>request('PATCH',concurrentInventory.id,scan({...concurrentInventory,revision:4})),/Synthetic interrupted write/);
  assert.equal(raw('inventory-v1:'+concurrentInventory.id),beforeFailure);
  passed('simultaneous different/same IDs, CAS loser retry and count/receipt atomicity');

  // At exactly 2,000 receipts legacy revision 2001 is still complete. At 2002
  // the oldest receipt was lost; neither a stale nor rebased ID can be accepted.
  const legacy=await start();record=readRecord(inventory.id);
  const boundary={...readRecord(legacy.id),revision:2001,operations:record.operations.slice(0,2000),lines:[{...record.lines[0],counted:2000}]};
  delete boundary.operationHistoryVersion;putRecord(boundary);
  assert.equal((await call('GET',legacy.id)).inventory.canEdit,true);
  const boundaryResult=(await call('PATCH',legacy.id,scan({...legacy,revision:2001}))).inventory;
  assert.equal(boundaryResult.lines[0].counted,2001);assert.equal(readRecord(legacy.id).operations.length,2001);assert.equal(readRecord(legacy.id).operationHistoryVersion,1);
  const lostId=boundary.operations[0].id;
  const truncated={...boundary,revision:2002,operations:record.operations.slice(1,2001)};putRecord(truncated);
  const incompleteRaw=raw('inventory-v1:'+legacy.id);
  assert.equal((await call('GET',legacy.id)).inventory.canEdit,false);
  for(const revision of [1,2002]){
    const uncertain=await call('PATCH',legacy.id,{...original,operationId:lostId,revision},409);
    assert.equal(uncertain.code,'INVENTORY_HISTORY_INCOMPLETE');assert.equal(uncertain.retryable,false);
  }
  for(const action of ['scan','set','finalize','cancel'])await call('PATCH',legacy.id,scan({...legacy,revision:2002},{action,code:'R2-A'}),409);
  const known=(await call('PATCH',legacy.id,{...original,operationId:truncated.operations[0].id,revision:1})).inventory;
  assert.equal(known.lines[0].counted,2000);assert.equal(known.canEdit,false);assert.equal(raw('inventory-v1:'+legacy.id),incompleteRaw);
  for(const mutation of [r=>{delete r.operations;},r=>{r.operations=null;},r=>{r.operations=[];},r=>{r.operations=[null];},r=>{r.operationHistoryVersion=99;},r=>{r.operationHistoryVersion=1;},r=>{r.operations=[...boundary.operations.slice(0,1999),boundary.operations[0]];r.revision=2001;}]){
    const damaged=structuredClone(truncated);mutation(damaged);putRecord(damaged);const before=raw('inventory-v1:'+legacy.id);
    assert.equal((await call('GET',legacy.id)).inventory.canEdit,false);
    assert.equal((await call('PATCH',legacy.id,scan({...legacy,revision:damaged.revision}),409)).code,'INVENTORY_HISTORY_INCOMPLETE');
    assert.equal(raw('inventory-v1:'+legacy.id),before);
  }
  const emptyLegacy=await start();const emptyRecord=readRecord(emptyLegacy.id);delete emptyRecord.operationHistoryVersion;putRecord(emptyRecord);
  assert.equal((await call('PATCH',emptyLegacy.id,scan(emptyLegacy))).inventory.lines[0].counted,1);
  putRecord(truncated);
  passed('legacy exact boundary upgrade; truncated/missing/malformed history fails closed without resetting data');

  const foreign=await start(other);
  const foreignRead=(await call('GET',foreign.id,undefined,200,manager)).inventory;
  assert.equal(foreignRead.canEdit,false);assert.equal(foreignRead.canDelete,false);
  assert((await call('GET',undefined,undefined,200,{...manager,warehouseId:'warehouse-b'})).inventories.some(i=>i.id===foreign.id));
  await call('PATCH',foreign.id,scan(foreign),404,manager);
  await call('DELETE',foreign.id,{revision:foreign.revision},404,manager);
  await call('POST',undefined,{id:randomUUID(),warehouseId:'warehouse-b',scope:'all'},404,manager);
  await call('GET',foreign.id,undefined,404,agent);
  passed('national manager READ retained; foreign create/PATCH/DELETE and agent read stay scope-bound');

  // Actual client API + hook, in-memory localStorage and a fetch-to-module bridge.
  const clientFile=await bundle('client',`export {useInventoryPending} from './components/use-inventory-pending.ts';export * from './lib/local-work.ts';export * from './lib/inventory-recovery.ts';`);
  const client=await import(pathToFileURL(clientFile));
  const entries=new Map(),listeners=new Map();
  const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k),key:i=>[...entries.keys()][i]??null,get length(){return entries.size;}};
  globalThis.window={localStorage:storage,dispatchEvent:event=>{listeners.get(event.type)?.(event);return true;},addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);}};
  client.setLocalWorkUserId(agent.id);
  const fetchBefore=globalThis.fetch;
  const calls=[];let dropResponse=false;
  globalThis.fetch=async(path,options={})=>{
    const method=options.method||'GET',id=path.split('/').at(-1),body=options.body?JSON.parse(options.body):undefined;
    calls.push({method,id,body});const result=await request(method,id,body);
    if(dropResponse&&method==='PATCH'&&result.ok){dropResponse=false;throw new Error('Synthetic lost response');}
    return result;
  };
  const stored=id=>client.readLocalWork('inventory',agent.id,id).value;
  let runner;
  try {
    const localInventory=await start();const queueOp={inventoryId:localInventory.id,operationId:randomUUID(),ean:eanA,quantity:1};
    client.writeLocalWork('inventory',agent.id,localInventory.id,{warehouseId:localInventory.warehouseId,scanQueue:[queueOp],drafts:{'R2-A':{value:'7',baseCounted:null}}});
    // Another session advances revision before the restored queue is sent.
    await call('PATCH',localInventory.id,scan(localInventory,{quantity:2}));
    runner=hookRunner(client,localInventory);const before=calls.length;await runner.flush();
    const rebased=calls.slice(before);assert.deepEqual(rebased.map(c=>c.method),['PATCH','GET','PATCH']);
    assert(rebased.filter(c=>c.method==='PATCH').every(c=>c.body.operationId===queueOp.operationId));
    assert.equal(runner.active.lines[0].counted,3);assert.equal(runner.current.scanQueue.length,0);assert.equal(stored(localInventory.id).drafts['R2-A'].value,'7');
    assert(runner.messages.includes('Toate scanările au fost confirmate.'));runner.close();
    passed('client 409 revision rebase keeps the original ID and preserves manual local work');

    const lost=await start();runner=hookRunner(client,lost);await runner.flush();dropResponse=true;
    assert.equal(runner.current.enqueueScan(eanA,1),true);await runner.flush();
    const pending=stored(lost.id).scanQueue[0];assert.equal(readRecord(lost.id).lines[0].counted,1);assert.equal(runner.current.paused,true);
    assert.equal(runner.messages.includes('Toate scanările au fost confirmate.'),false);
    runner.close();runner=hookRunner(client,lost);await runner.flush();
    assert.equal(runner.active.lines[0].counted,1);assert.equal(stored(lost.id),null);
    assert.equal(readRecord(lost.id).operations[0].id,pending.operationId);runner.close();
    passed('lost response survives local reload and confirms the same durable receipt once');

    const legacyOp={inventoryId:legacy.id,operationId:lostId,ean:eanA,quantity:1};
    const legacyWork={warehouseId:legacy.warehouseId,scanQueue:[legacyOp,{...legacyOp,operationId:randomUUID()}],drafts:{'R2-A':{value:'23',baseCounted:null}}};
    client.writeLocalWork('inventory',agent.id,legacy.id,legacyWork);
    runner=hookRunner(client,{...legacy,revision:2002});const attempts=calls.length;await runner.flush();
    assert.equal(calls.length,attempts+1);assert.equal(calls.at(-1).body.operationId,lostId);
    assert.equal(runner.current.paused,true);assert.equal(runner.current.scanQueue.length,2);assert.equal(runner.messages.includes('Toate scanările au fost confirmate.'),false);
    assert(stored(legacy.id).scanQueue[0].blockedReason);assert.deepEqual(stored(legacy.id).scanQueue.map(s=>s.operationId),legacyWork.scanQueue.map(s=>s.operationId));
    assert.equal(stored(legacy.id).drafts['R2-A'].value,'23');assert.equal(raw('inventory-v1:'+legacy.id),incompleteRaw);
    runner.current.retryQueue();await runner.flush();listeners.get('online')?.();await runner.flush();assert.equal(calls.length,attempts+1);
    runner.close();runner=hookRunner(client,{...legacy,revision:2002});await runner.flush();assert.equal(calls.length,attempts+1);assert.equal(runner.current.paused,true);
    runner.setActive((await call('GET',legacy.id)).inventory);await runner.flush();
    assert.equal(runner.current.closedRecovery.scanQueue.length,2);assert.equal(runner.current.closedRecovery.drafts['R2-A'].value,'23');assert(stored(legacy.id));
    assert.equal(client.readClosedInventoryRecovery(runner.active,'different-user',storage),null);runner.close();
    passed('unsafe legacy retry pauses durably across manual retry, online and reload; all IDs/drafts survive read-only recovery');

    const conflictInv=await start();const receipt=scan(conflictInv);await call('PATCH',conflictInv.id,receipt);
    client.writeLocalWork('inventory',agent.id,conflictInv.id,{warehouseId:conflictInv.warehouseId,scanQueue:[{inventoryId:conflictInv.id,operationId:receipt.operationId,ean:eanA,quantity:2}],drafts:{}});
    runner=hookRunner(client,conflictInv);const previousCalls=calls.length;await runner.flush();
    assert.equal(calls.length,previousCalls+1);assert.equal(runner.current.paused,true);assert.equal(stored(conflictInv.id).scanQueue[0].quantity,2);assert(stored(conflictInv.id).scanQueue[0].blockedReason);
    assert.equal(readRecord(conflictInv.id).lines[0].counted,1);assert.equal(runner.messages.includes('Toate scanările au fost confirmate.'),false);runner.close();
    passed('changed payload conflict never rebases blindly, discards the queued scan or reports it saved');
  } finally {runner?.close();globalThis.fetch=fetchBefore;delete globalThis.window;delete globalThis.__r2Hooks;}
  console.log(`PASS: ${checks} focused R2 catalog/inventory regression groups.`);
} finally {sqlite.close();delete globalThis.__r2Db;rmSync(dir,{recursive:true,force:true});}
