import {mergeConcurrentOrders,orderSaveBody,sameEditableOrder} from './order-draft.ts';
import type {Order} from './types';
import {readLocalWork,removeLocalWork} from './local-work.ts';
/** Account-bound durable work. Transactions never evict pending mutations. */
export type PendingOperation = { id:string; userId:string; entity:string; path:string; method:string; body:unknown; created:number; attempts:number; next:number; state:'pending'|'blocked'; error?:string; status?:number; orderWork?:{base:Order;local:Order} };
type Snapshot = {key:string;userId:string;path:string;value:unknown;at:number;bytes:number};
type SnapshotMetadata = {key:string;userId:string;path:string;at:number;bytes:number;pinned:boolean};
type SnapshotStats = {key:'snapshot-stats';bytes:number;count:number;pinnedBytes:number};
type FragmentMarker = {__mobiupFragments:string[];property:string;count:number};
export type CoverageManifest = {
 version:1;
 preparedAt:number;
 paths:string[];
 valid:boolean;
 missing:string[];
 dataOnly:true;
 partners:{saved:number;total:number;limited:boolean};
 details:number;
 shellRequested:boolean;
};
export type SnapshotSaveResult = {saved:true;bytes:number;evicted:string[]};
export const OFFLINE_EVENT='mobiup-offline-work';
export const OFFLINE_CACHE_INVALIDATED_EVENT='mobiup-offline-cache-invalidated';
// Durable work stays at the original v1 format so an older installed PWA remains compatible.
const CACHE_DATABASE='mobiup-offline-cache-v1';
const MAX_SNAPSHOT_BYTES=8*1024*1024;
const MAX_TOTAL_BYTES=24*1024*1024;
const MAX_SNAPSHOTS=650;
const MAX_PINNED_ACCOUNT_BYTES=4*1024*1024;
const MAX_PINNED_TOTAL_BYTES=12*1024*1024;
const openings:Partial<Record<'cache'|'work',Promise<IDBDatabase>>>={};
const workChannel=typeof window!=='undefined'&&window.BroadcastChannel?new BroadcastChannel('mobiup-outbox-changes'):null;
const localNotify=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event(OFFLINE_EVENT));};
if(workChannel)workChannel.onmessage=localNotify;
const notify=()=>{localNotify();workChannel?.postMessage('changed');};
const request=<T>(req:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
const isPinnedPath=(path:string)=>path==='bootstrap'||path==='bootstrap?compact=1'||path==='auth/session';
const isFragmentMarker=(value:unknown):value is FragmentMarker=>!!value&&typeof value==='object'&&Array.isArray((value as FragmentMarker).__mobiupFragments)&&typeof (value as FragmentMarker).property==='string';
export class OfflineSnapshotCapacityError extends Error {
 code:'SNAPSHOT_TOO_LARGE'|'OFFLINE_CAPACITY';
 bytes:number;
 constructor(code:'SNAPSHOT_TOO_LARGE'|'OFFLINE_CAPACITY',message:string,bytes:number){super(message);this.name='OfflineSnapshotCapacityError';this.code=code;this.bytes=bytes;}
}
function database(kind:'cache'|'work'='work'):Promise<IDBDatabase>{
 if(typeof indexedDB==='undefined')return Promise.reject(new Error('Stocarea locală nu este disponibilă.'));
 return openings[kind]??=new Promise<IDBDatabase>((resolve,reject)=>{
  let settled=false;
  const req=indexedDB.open(kind==='cache'?CACHE_DATABASE:'mobiup-offline-v3',1);
  req.onupgradeneeded=()=>{
   const d=req.result;
   d.createObjectStore('snapshots',{keyPath:'key'});
   d.createObjectStore('meta',{keyPath:'key'});
   if(kind==='work'){
    d.createObjectStore('work',{keyPath:'key'});
    d.createObjectStore('outbox',{keyPath:'id'}).createIndex('user','userId');
   }else{
    const index=d.createObjectStore('snapshotIndex',{keyPath:'key'});index.createIndex('at','at');index.createIndex('user','userId');
   }
  };
  req.onsuccess=()=>{
   if(settled){req.result.close();return;}settled=true;
   const d=req.result;d.onversionchange=()=>{d.close();delete openings[kind];};
   void(kind==='cache'?adoptLegacyCache(d):Promise.resolve()).then(()=>resolve(d),error=>{d.close();delete openings[kind];reject(error);});
  };
  req.onerror=()=>{if(settled)return;settled=true;delete openings[kind];reject(req.error);};
  req.onblocked=()=>{if(settled)return;settled=true;delete openings[kind];reject(new Error('Stocarea locală este ocupată de o altă fereastră. Reîncearcă.'));};
 });
}
/** One-time cache-only adoption. The old database, work/outbox and old-client snapshots are never rewritten. */
async function adoptLegacyCache(cache:IDBDatabase){
 if(await request(cache.transaction('meta','readonly').objectStore('meta').get('legacy-cache-adopted')))return;
 const legacy=await database('work');
 const rows=await request(legacy.transaction('snapshots','readonly').objectStore('snapshots').getAll()) as Snapshot[];
 const selected=rows.filter(row=>row&&typeof row.key==='string'&&typeof row.path==='string'&&row.bytes<=MAX_SNAPSHOT_BYTES).sort((a,b)=>Number(isPinnedPath(b.path))-Number(isPinnedPath(a.path))||b.at-a.at);
 const tx=cache.transaction(['snapshots','snapshotIndex','meta'],'readwrite');
 const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
 const meta=tx.objectStore('meta');
 if(!await request(meta.get('legacy-cache-adopted'))){
  let bytes=0,count=0,pinnedBytes=0;
  for(const row of selected){
   if(count>=MAX_SNAPSHOTS||bytes+row.bytes>MAX_TOTAL_BYTES)continue;
   const pinned=isPinnedPath(row.path);tx.objectStore('snapshots').put(row);tx.objectStore('snapshotIndex').put({key:row.key,userId:row.userId,path:row.path,at:row.at,bytes:row.bytes,pinned});bytes+=row.bytes;count++;if(pinned)pinnedBytes+=row.bytes;
  }
  meta.put({key:'snapshot-stats',bytes,count,pinnedBytes});meta.put({key:'legacy-cache-adopted',at:Date.now()});
 }
 await done;
}
async function transaction<T>(stores:string[],mode:IDBTransactionMode,run:(tx:IDBTransaction)=>Promise<T>,retry=true):Promise<T>{
 const kind=stores.some(store=>store==='snapshots'||store==='snapshotIndex')?'cache':'work';
 const d=await database(kind);let tx:IDBTransaction;
 try{tx=d.transaction(stores,mode);}
 catch(error){if(retry&&error instanceof DOMException&&error.name==='InvalidStateError'){delete openings[kind];return transaction(stores,mode,run,false);}throw error;}
 const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('Datele nu au fost salvate local.'));tx.onerror=()=>{};});
 try{const value=await run(tx);await done;return value;}catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
}
async function rawSnapshot(userId:string,path:string){
 return transaction(['snapshots'],'readonly',tx=>request(tx.objectStore('snapshots').get(userId+'|'+path))) as Promise<Snapshot|undefined>;
}
export async function snapshot<T>(userId:string,path:string):Promise<{value:T;at:number}|null>{
 if(!userId)return null;
 const row=await rawSnapshot(userId,path);
 if(!row)return null;
 if(!isFragmentMarker(row.value))return {value:row.value as T,at:row.at};
 const values:unknown[]=[];
 for(const fragmentPath of row.value.__mobiupFragments){
  const fragment=await rawSnapshot(userId,fragmentPath);
  if(!fragment||!Array.isArray(fragment.value))return null;
  values.push(...fragment.value);
 }
 if(values.length!==row.value.count)return null;
 return {value:{[row.value.property]:values} as T,at:row.at};
}
async function statsFor(tx:IDBTransaction){
 const meta=tx.objectStore('meta'),stored=await request(meta.get('snapshot-stats')) as SnapshotStats|undefined;
 if(stored&&await request(meta.get('compact-pin-v1')))return stored;
 const index=tx.objectStore('snapshotIndex');
 const rows=await request(index.getAll()) as SnapshotMetadata[];
 for(const row of rows)if(row.pinned!==isPinnedPath(row.path)){row.pinned=isPinnedPath(row.path);await request(index.put(row));}
 await request(meta.put({key:'compact-pin-v1',value:true}));
 const stats:SnapshotStats={key:'snapshot-stats',bytes:rows.reduce((sum,row)=>sum+row.bytes,0),count:rows.length,pinnedBytes:rows.filter(row=>row.pinned).reduce((sum,row)=>sum+row.bytes,0)};
 await request(meta.put(stats));return stats;
}
export async function saveSnapshot(userId:string,path:string,value:unknown):Promise<SnapshotSaveResult|undefined>{
 if(!userId)return;
 let encoded:string;
 try{encoded=JSON.stringify(value);}catch{throw new Error('Datele primite nu pot fi serializate pentru folosire offline.');}
 if(encoded===undefined)throw new Error('Datele primite nu pot fi păstrate offline.');
 const bytes=encoded.length*2;
 if(bytes>MAX_SNAPSHOT_BYTES)throw new OfflineSnapshotCapacityError('SNAPSHOT_TOO_LARGE','Setul de date este prea mare pentru stocarea offline într-o singură bucată.',bytes);
 const pinned=isPinnedPath(path),key=userId+'|'+path,evicted:string[]=[];
 const result=await transaction(['snapshots','snapshotIndex','meta'],'readwrite',async tx=>{
  const snapshots=tx.objectStore('snapshots'),index=tx.objectStore('snapshotIndex'),meta=tx.objectStore('meta');
  const stats=await statsFor(tx);
  const previous=await request(index.get(key)) as SnapshotMetadata|undefined;
  let projectedBytes=stats.bytes-(previous?.bytes||0)+bytes;
  let projectedCount=stats.count-(previous?1:0)+1;
  const projectedPinned=stats.pinnedBytes-(previous?.pinned?previous.bytes:0)+(pinned?bytes:0);
  if(pinned){
   const accountRows=await request(index.index('user').getAll(userId)) as SnapshotMetadata[];
   const accountPinned=accountRows.filter(row=>row.pinned&&row.key!==key).reduce((sum,row)=>sum+row.bytes,0)+bytes;
   if(accountPinned>MAX_PINNED_ACCOUNT_BYTES||projectedPinned>MAX_PINNED_TOTAL_BYTES)throw new OfflineSnapshotCapacityError('OFFLINE_CAPACITY','Datele minime de pornire depășesc bugetul offline sigur.',bytes);
  }
  const candidates=projectedBytes>MAX_TOTAL_BYTES||projectedCount>MAX_SNAPSHOTS?(await request(index.index('at').getAll()) as SnapshotMetadata[]).filter(row=>!row.pinned&&row.key!==key):[];
  for(const row of candidates){
   if(projectedBytes<=MAX_TOTAL_BYTES&&projectedCount<=MAX_SNAPSHOTS)break;
   await request(snapshots.delete(row.key));await request(index.delete(row.key));
   projectedBytes-=row.bytes;projectedCount--;evicted.push(row.key);
  }
  if(projectedBytes>MAX_TOTAL_BYTES||projectedCount>MAX_SNAPSHOTS)throw new OfflineSnapshotCapacityError('OFFLINE_CAPACITY','Spațiul offline sigur este ocupat de date esențiale. Setul nou nu a fost salvat.',bytes);
  const at=Date.now();
  await request(snapshots.put({key,userId,path,value,at,bytes}));
  await request(index.put({key,userId,path,at,bytes,pinned}));
  await request(meta.put({key:'snapshot-stats',bytes:projectedBytes,count:projectedCount,pinnedBytes:projectedPinned}));
  return {saved:true as const,bytes,evicted};
 });
 if(evicted.length)notify();
 return result;
}
export async function saveFragmentedSnapshot(userId:string,path:string,property:string,values:unknown[],chunkSize=250){
 const stamp=crypto.randomUUID(),fragmentPaths:string[]=[];
 for(let offset=0;offset<values.length;offset+=chunkSize){
  const fragmentPath=path+'#'+stamp+'-'+fragmentPaths.length;
  await saveSnapshot(userId,fragmentPath,values.slice(offset,offset+chunkSize));
  fragmentPaths.push(fragmentPath);
 }
 await saveSnapshot(userId,path,{__mobiupFragments:fragmentPaths,property,count:values.length});
 return {fragments:fragmentPaths,count:values.length};
}
export async function saveCoverageManifest(userId:string,manifest:CoverageManifest){
 await saveWork(userId,'coverage','portfolio',manifest);
}
export async function readCoverageManifest(userId:string):Promise<CoverageManifest|null>{
 const manifest=await readWork<CoverageManifest>(userId,'coverage','portfolio');
 if(!manifest||manifest.version!==1)return null;
 const missing:string[]=[];
 for(const path of manifest.paths)if(!await snapshot(userId,path))missing.push(path);
 if(!missing.length&&manifest.valid)return manifest;
 const checked={...manifest,valid:missing.length===0,missing};
 if(JSON.stringify(checked)!==JSON.stringify(manifest))await saveCoverageManifest(userId,checked);
 return checked;
}
// Shared session authority uses only metadata in the original v1 store.
export type SessionFence={epoch:string;rejected:boolean;userId?:string;admissionEpoch?:string};
let memoryFence:SessionFence={epoch:'',rejected:false};
let durableSession=true;
export const sessionStorageAvailable=()=>durableSession;
const sessionStorageError=()=>new Error('Verificarea stocării locale nu este disponibilă. Modul offline este dezactivat în această filă.');
// A blocked open or stalled transaction must never hold online login hostage.
// Once degraded, this document cannot read or publish authentication snapshots.
async function sessionMetadata<T>(run:(store:IDBObjectStore)=>Promise<T>,fallback:()=>T):Promise<T>{
 if(!durableSession)return fallback();
 let active=true,tx:IDBTransaction|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const operation=(async()=>{
  const db=await database();
  if(!active)throw sessionStorageError();
  tx=db.transaction('meta','readwrite');
  const done=new Promise<void>((resolve,reject)=>{tx!.oncomplete=()=>resolve();tx!.onabort=()=>reject(tx!.error||sessionStorageError());tx!.onerror=()=>{};});
  try{const result=await run(tx.objectStore('meta'));await done;return result;}
  catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
 })();
 try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{active=false;try{tx?.abort();}catch{}reject(sessionStorageError());},1000);})]);}
 catch{
  if(durableSession){durableSession=false;if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('mobiup-storage-error',{detail:sessionStorageError().message}));}
  return fallback();
 }finally{active=false;clearTimeout(timer);}
}
export async function sessionFence():Promise<SessionFence>{
 const value=await sessionMetadata(async store=>(await request(store.get('session-fence')))?.value??{epoch:'',rejected:false},()=>memoryFence);
 memoryFence=value;return value;
}
function admittedFence(current:SessionFence,expected:SessionFence,userId:string):SessionFence|null{
 // Concurrent positives may join the same uninterrupted account admission.
 // Rejection or A -> B -> A starts a new admission, fencing older positives.
 const sameAccount=!current.rejected&&current.userId===userId;
 if(current.epoch!==expected.epoch&&!(sameAccount&&current.admissionEpoch!==undefined&&(current.admissionEpoch===expected.epoch||(expected.userId===userId&&expected.admissionEpoch===current.admissionEpoch))))return null;
 return {epoch:crypto.randomUUID(),rejected:false,userId,admissionEpoch:sameAccount?current.admissionEpoch??current.epoch:current.epoch};
}
export async function rejectSessionFence(expected?:SessionFence,confirmedAdmissionUser?:string){
 const value:SessionFence={epoch:crypto.randomUUID(),rejected:true};
 const matches=(current:SessionFence)=>!expected||current.epoch===expected.epoch||(
  !!confirmedAdmissionUser&&!current.rejected&&!expected.rejected&&current.userId===confirmedAdmissionUser&&current.admissionEpoch!==undefined&&(
   expected.userId===confirmedAdmissionUser&&expected.admissionEpoch===current.admissionEpoch||
   !expected.userId&&current.admissionEpoch===expected.epoch));
 // Only a server-confirmed logout may supersede refreshes of its captured
 // admission. The comparison and rejection share one metadata transaction;
 // a new login, A -> B -> A or rejection never joins that old admission.
 const accepted=await sessionMetadata(async store=>{
  const current=(await request(store.get('session-fence')))?.value as SessionFence|undefined;
  if(!matches(current??{epoch:'',rejected:false}))return false;
  await request(store.put({key:'session-fence',value}));return true;
 },()=>matches(memoryFence));
 if(accepted)memoryFence=value;return accepted?value:null;
}
export async function acceptSessionFence(expected:SessionFence,userId:string){
 const value=await sessionMetadata(async store=>{
  const current=(await request(store.get('session-fence')))?.value??{epoch:'',rejected:false};
  const next=admittedFence(current,expected,userId);if(!next)return null;
  await request(store.put({key:'session-fence',value:next}));
  await request(store.put({key:'active',value:userId}));return next;
 },()=>admittedFence(memoryFence,expected,userId));
 if(value)memoryFence=value;return !!value;
}
let sessionGateTail:Promise<unknown>=Promise.resolve();
function documentSessionGate<T>(run:()=>Promise<T>):Promise<T>{
 const result=sessionGateTail.then(run,run);sessionGateTail=result.catch(()=>{});return result;
}
export async function withSessionGate<T>(run:()=>Promise<T>,online=false):Promise<T>{
 if(typeof navigator==='undefined'||!navigator.locks){if(online)return documentSessionGate(run);throw sessionStorageError();}
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),1000);
 let entered=false;
 try{return await navigator.locks.request('mobiup-session-binding',{signal:controller.signal},()=>{entered=true;clearTimeout(timer);return run();});}
 catch(error){if(entered||!online)throw error;return documentSessionGate(run);}
 finally{clearTimeout(timer);}
}
// All cooperating tabs serialize queue additions with worker activation. Legacy
// installed clients do not honor this lock; retaining their assets remains vital.
export function withOutboxGate<T>(run:()=>Promise<T>,activation=false):Promise<T>{
 if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request('mobiup-outbox-activation',run);
 if(activation)return Promise.reject(new Error('Actualizarea sigură între file nu este disponibilă. Sincronizează lucrul și redeschide aplicația într-un browser actualizat.'));
 return run(); // Saving remains available; this browser cannot offer activation.
}
export async function pendingOperationCount(){return transaction(['outbox'],'readonly',tx=>request(tx.objectStore('outbox').count()));}
export async function rememberAccount(userId:string,expected?:SessionFence){
 await sessionMetadata(async store=>{
  if(expected&&(await request(store.get('session-fence')))?.value?.epoch!==expected.epoch)return;
  await request(store.put({key:'active',value:userId}));
 },()=>undefined);
}
export async function lastAccount(){return transaction(['meta'],'readonly',async tx=>(await request(tx.objectStore('meta').get('active')))?.value as string||'');}
export async function readWork<T>(userId:string,scope:string,id:string){return transaction(['work'],'readonly',async tx=>(await request(tx.objectStore('work').get(userId+'|'+scope+'|'+id)))?.value as T|undefined);}
export async function saveWork(userId:string,scope:string,id:string,value:unknown){await transaction(['work'],'readwrite',tx=>request(tx.objectStore('work').put({key:userId+'|'+scope+'|'+id,value})));}
export async function saveOrderWork(userId:string,id:string,value:{base:Order;local:Order}){
 await transaction(['work'],'readwrite',async tx=>{const store=tx.objectStore('work'),key=userId+'|order|'+id;
  // A comparison base belongs to this editor's content, not to another tab.
  await request(store.put({key,value}));
 });
}
export async function clearConfirmedOrderWork(userId:string,id:string,confirmed:Order){
 await transaction(['work','outbox'],'readwrite',async tx=>{
  const work=tx.objectStore('work'),key=userId+'|order|'+id,row=await request(work.get(key));
  const pending=await request(tx.objectStore('outbox').index('user').getAll(userId)) as PendingOperation[];
  if(row?.value?.local&&row.value.base?.revision===confirmed.revision&&sameEditableOrder(row.value.local,confirmed)&&!pending.some(op=>entityFor(op.path,op.body)==='orders/'+id))await request(work.delete(key));
 });
}
// Clean recovery copies can be retired against a live document, but an older
// response must never erase a newer comparison base or queued/unsaved edits.
function cleanOrderWork(value:{base:Order;local:Order}|undefined,remote:Order){
 return !!value?.base&&!!value.local&&value.base.id===remote.id&&value.local.id===remote.id
  &&value.base.revision<=remote.revision
  &&(sameEditableOrder(value.base,value.local)||sameEditableOrder(value.local,remote));
}
export async function acceptAuthoritativeOrder(userId:string,order:Order){
 const pending=await transaction(['work','outbox'],'readwrite',async tx=>{
  const store=tx.objectStore('work'),key=userId+'|order-list|confirmed';
  const projection=(await request(store.get(key)))?.value as Record<string,Order>||{};
  const previous=projection[order.id];
  if(!previous||(previous.status==='draft'&&order.status!=='draft')||(previous.status===order.status&&previous.revision<=order.revision))projection[order.id]=order;
  await request(store.put({key,value:projection}));
  await reconcileOrderListInTransaction(tx,userId,[order],false);
  const rows=await request(tx.objectStore('outbox').index('user').getAll(userId)) as PendingOperation[];
  const pending=rows.some(op=>entityFor(op.path,op.body)==='orders/'+order.id);
  const workKey=userId+'|order|'+order.id,stored=await request(store.get(workKey));
  if(!pending&&cleanOrderWork(stored?.value,order))await request(store.delete(workKey));
  return pending;
 });
 // Re-read the legacy mirror after the transaction; do not remove a different
 // tab's edit captured before an await. Keep it when any request is unresolved.
 if(!pending&&cleanOrderWork(readLocalWork<{base:Order;local:Order}>('order',userId,order.id).value??undefined,order)){
  const error=removeLocalWork('order',userId,order.id);if(error)throw new Error(error);
 }
}
export async function unlockVisitWork(userId:string,id:string,expected:unknown){
 await transaction(['work'],'readwrite',async tx=>{
  const store=tx.objectStore('work'),key=userId+'|visit|'+id,current=await request(store.get(key));
  if(JSON.stringify(current?.value)!==JSON.stringify(expected))throw new Error('Vizita locală s-a schimbat. Redeschide fișa înainte de corectare.');
  await request(store.put({key:userId+'|visit-edit|'+id,value:expected}));
  await request(store.delete(key));
 });
 if(JSON.stringify(readLocalWork('visit',userId,id).value)===JSON.stringify(expected)){
  const error=removeLocalWork('visit',userId,id);if(error)throw new Error(error);
 }
}
export async function removeWork(userId:string,scope:string,id:string){await transaction(['work'],'readwrite',tx=>request(tx.objectStore('work').delete(userId+'|'+scope+'|'+id)));}
export async function migrateLegacy(userId:string){
 if(!userId||typeof localStorage==='undefined')return;
 const prefix='mobiup-work-v1:';
 const rows: {key:string;value:unknown}[]=[];
 for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key?.startsWith(prefix))continue;try{const raw=JSON.parse(localStorage.getItem(key)||'null');const parts=key.split(':');if(raw?.version===1&&raw.userId===userId)rows.push({key:userId+'|'+decodeURIComponent(parts[1])+'|'+raw.documentId,value:raw.value});}catch{}}
 await transaction(['work'],'readwrite',async tx=>{for(const row of rows){if(!await request(tx.objectStore('work').get(row.key)))await request(tx.objectStore('work').put(row));}});
 // Legacy copies remain as an additional recovery source; never delete on migration.
}
export async function pendingOperations(userId:string){return transaction(['outbox'],'readonly',async tx=>(await request(tx.objectStore('outbox').index('user').getAll(userId)) as PendingOperation[]).sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id)));}
function entityFor(path:string,body:unknown){return path==='orders'?'orders/'+String((body as {id?:string})?.id):path==='partner/planning'?'plan/'+String((body as {date?:string})?.date):path;}
export async function enqueue(userId:string,path:string,method:string,body:unknown,local?:{scope:string;id:string;value:unknown}){
 if(!userId)throw new Error('Contul trebuie pregătit online înainte de lucru offline.');
 if(!((path==='orders'&&method==='POST')||(/^orders\/[^/]+$/.test(path)&&method==='PUT')||(/^partner\/portfolio\/[^/]+$/.test(path)&&method==='PATCH')||(/^partner\/portfolio\/[^/]+\/visits$/.test(path)&&method==='POST')||(path==='partner/planning'&&method==='PUT')))throw new Error('Această operațiune necesită conexiune și confirmare pe server.');
 const operation:PendingOperation={id:crypto.randomUUID(),userId,path,method,body,entity:entityFor(path,body),created:Date.now(),attempts:0,next:0,state:'pending'};
 await withOutboxGate(()=>transaction(['work','outbox'],'readwrite',async tx=>{
  if(local){
   const key=userId+'|'+local.scope+'|'+local.id;
   await request(tx.objectStore('work').put({key,value:local.value}));
  }
  const all=await request(tx.objectStore('outbox').index('user').getAll(userId)) as PendingOperation[];
  if(local?.scope==='order'&&object(local.value)&&object(local.value.base)&&object(local.value.local))operation.orderWork=local.value as {base:Order;local:Order};
  operation.created=Math.max(operation.created,...all.map(row=>row.created+1));
  // One not-yet-sent edit per entity. Never replace an ambiguous/attempted request.
  const previous=all.filter(o=>o.entity===operation.entity&&o.path===path&&o.method===method&&o.attempts===0&&o.state==='pending').at(-1);
  if(method==='POST'&&all.some(o=>o.path===path&&o.method===method&&JSON.stringify(o.body)===JSON.stringify(body)))return;
  if(previous&&method!=='POST'){operation.id=previous.id;operation.created=previous.created;}
  await request(tx.objectStore('outbox').put(operation));
 }));notify();return operation;
}
export async function removeOperation(id:string){await transaction(['outbox'],'readwrite',tx=>request(tx.objectStore('outbox').delete(id)));notify();}
async function updateOperation(op:PendingOperation,expected?:PendingOperation){
 const updated=await withOutboxGate(()=>transaction(['outbox'],'readwrite',async tx=>{
  const store=tx.objectStore('outbox'),current=await request(store.get(op.id));
  // A legacy tab may remove an in-flight row. An ambiguous failure must
  // restore that exact request under the activation gate, never lose it.
  if(current&&expected&&JSON.stringify(current)!==JSON.stringify(expected))return false;
  await request(store.put(op));return true;
 }));notify();return updated;
}
// Reconstruct a legacy operation from its own payload, never from a newer edit.
function operationOrder(op:PendingOperation,work:{base:Order;local:Order}):Order{
 if(op.orderWork)return op.orderWork.local;
 const body=op.body as ReturnType<typeof orderSaveBody>;
 const lines=(values:{id:string;quantity:number}[]|undefined,key:'items'|'standItems')=>(values||[]).map(value=>{
  const line=[...(work.local[key]||[]),...(work.base[key]||[])].find(line=>line.id===value.id);
  if(!line)throw new Error('Copia locală necesită verificare înainte de sincronizare.');
  return {...line,quantity:value.quantity};
 });
 const client=body.clientId===work.local.client?.id?work.local.client:body.clientId===work.base.client?.id?work.base.client:null;
 if(body.clientId&&!client)throw new Error('Clientul operațiunii vechi necesită verificare.');
 return {...work.base,items:lines(body.items,'items'),standItems:body.standItems?lines(body.standItems,'standItems'):work.base.standItems,serials:body.serials,client,notes:body.notes};
}
/** Confirmation and comparison-base advancement commit together with queue removal. */
async function acknowledgeOperation(op:PendingOperation,result:unknown,token:string){
 return transaction(['work','outbox','meta'],'readwrite',async tx=>{
  const outbox=tx.objectStore('outbox'),store=tx.objectStore('work');
  if((await request(tx.objectStore('meta').get('lease|'+op.userId)))?.token!==token)throw new Error('Sincronizare preluată de altă fereastră.');
  let submitted:Order|undefined;
  if(object(result)&&object(result.order)){
   const saved=result.order as unknown as Order,key=op.userId+'|order|'+saved.id;
   const row=await request(store.get(key));
   if(row?.value?.base&&row.value.local){
    submitted=op.method==='POST'?row.value.base:operationOrder(op,row.value);
    // Changes since the submitted snapshot survive, including an explicit revert.
    const local=mergeConcurrentOrders(submitted!,row.value.local,saved,'local').order;
    await request(store.put({key,value:{base:saved,local}}));
   }
   const all=await request(outbox.index('user').getAll(op.userId)) as PendingOperation[];
   for(const later of all){
    if(later.id===op.id||later.path!=='orders/'+saved.id||later.attempts||later.state!=='pending')continue;
    const basis=later.orderWork??row?.value;
    if(basis){const desired=operationOrder(later,basis);const local=submitted?mergeConcurrentOrders(submitted,desired,saved,'local').order:desired;later.orderWork={base:saved,local};later.body=orderSaveBody(local,saved.revision);await request(outbox.put(later));}
   }
   const projectionKey=op.userId+'|order-list|confirmed';
   const projection=(await request(store.get(projectionKey)))?.value||{};
   if(!projection[saved.id]||(projection[saved.id].status==='draft'&&projection[saved.id].revision<=saved.revision))projection[saved.id]=saved;
   await request(store.put({key:projectionKey,value:projection}));
   await reconcileOrderListInTransaction(tx,op.userId,[saved],false);
  }
  await request(outbox.delete(op.id));return submitted;
 });
}
// Lists retain only unconfirmed local creates. Absence from a page is never a tombstone.
async function reconcileOrderListInTransaction(tx:IDBTransaction,userId:string,remote:Order[],includeLocal=true){
 const store=tx.objectStore('work'),key=userId+'|draft-list|all',markerKey=userId+'|order-list|settled';
 const local=(await request(store.get(key)))?.value as Order[]|undefined;
 const settled=(await request(store.get(markerKey)))?.value as Record<string,'confirmed'|'deleted'|'finalized'>||{};
 for(const order of remote)if(settled[order.id]!=='deleted'&&settled[order.id]!=='finalized')settled[order.id]=order.status==='draft'?'confirmed':'finalized';
 const remaining=(local||[]).filter(order=>order.status==='draft'&&!settled[order.id]);
 await request(store.put({key,value:remaining}));await request(store.put({key:markerKey,value:settled}));
 const rows=[...(includeLocal?remaining:[]),...remote.filter(order=>settled[order.id]!=='deleted'&&(settled[order.id]!=='finalized'||order.status!=='draft'))];
 return [...new Map(rows.map(order=>[order.id,order])).values()];
}
export async function reconcileOrderList(userId:string,remote:Order[],offline=false){
 return transaction(['work'],'readwrite',async tx=>{
  const rows=await reconcileOrderListInTransaction(tx,userId,remote);
  if(!offline){
   const store=tx.objectStore('work'),key=userId+'|order-list|confirmed';
   const projection=(await request(store.get(key)))?.value as Record<string,Order>|undefined;
   if(projection){for(const order of remote)if(projection[order.id]&&(projection[order.id].status==='draft'||order.status!=='draft')&&order.revision>=projection[order.id].revision)projection[order.id]=order;await request(store.put({key,value:projection}));}
   return rows;
  }
  // Separate confirmed-local documents from server pages: never assert page or
  // filter membership, nor rewrite a cursor/count. The UI filters these copies.
  const store=tx.objectStore('work');
  const confirmed=(await request(store.get(userId+'|order-list|confirmed')))?.value as Record<string,Order>||{};
  const settled=(await request(store.get(userId+'|order-list|settled')))?.value||{};
  const byId=new Map(rows.map(order=>[order.id,order]));
  for(const order of Object.values(confirmed)){
   if(settled[order.id]==='deleted'||settled[order.id]==='finalized'||order.status!=='draft'){if(byId.get(order.id)?.status==='draft')byId.delete(order.id);continue;}
   if(!byId.has(order.id)||byId.get(order.id)!.revision<order.revision)byId.set(order.id,order);
  }
  return [...byId.values()];
 });
}
export async function markOrderDeleted(userId:string,id:string){
 await transaction(['work'],'readwrite',async tx=>{const store=tx.objectStore('work'),key=userId+'|order-list|settled';const value=(await request(store.get(key)))?.value||{};value[id]='deleted';await request(store.put({key,value}));await reconcileOrderListInTransaction(tx,userId,[]);});
}

type ReplayTransport=(path:string,method:string,body:unknown,operationId?:string)=>Promise<unknown>;
/** Resolve only a freshly reviewed version. Attempted requests are verified with
 * their original identity; ambiguous replies and revoked access retain the queue. */
export async function resolveQueuedWork(options:{expectedWork?:unknown;expectedOrder?:Order;userId:string;path:string;method:string;remote:unknown;body:unknown;local:{scope:string;id:string;value:unknown};transport:ReplayTransport;active:()=>string}){
 const {userId,path,method,remote,body,local,transport,active}=options;
 const entity=entityFor(path,body??remote);
 const run=async()=>{
  const token=await claimLease(userId);if(!token)throw new Error('Sincronizarea este în curs. Reîncearcă.');
  try{
   const assertOwner=()=>{if(active()!==userId)throw new Error('Contul s-a schimbat. Redeschide documentul.');};assertOwner();
   const rows=(await pendingOperations(userId)).filter(op=>entityFor(op.path,op.body)===entity);
   const stored=await readWork<{local?:Order}>(userId,local.scope,local.id);
   if(options.expectedWork!==undefined&&JSON.stringify(options.expectedWork)!==JSON.stringify(stored))throw new Error('Lucrul local s-a schimbat în altă filă. Redeschide documentul.');
   if(options.expectedOrder&&stored?.local&&!sameEditableOrder(options.expectedOrder,stored.local))throw new Error('Modificările locale s-au schimbat în altă filă. Redeschide documentul.');
   const readRemote=async()=>{
    if(path==='partner/planning'){
     const date=(remote as {date:string}).date,day=new Date(date+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));
     const result=await transport('partner/planning?week='+day.toISOString().slice(0,10),'GET',undefined) as {plans:{date:string;stops:string[];revision:number}[]};
     return result.plans.find(plan=>plan.date===date)??{date,stops:[],revision:0};
    }
    const result=await transport(path,'GET',undefined) as {order?:Order;partner?:{canEdit?:boolean}};
    if(result.partner&&result.partner.canEdit!==true)throw Object.assign(new Error('Acces retras. Copia locală rămâne păstrată; nu poate fi retrimisă.'),{status:403});
    return result.order??result.partner;
   };
   const checkRemote=async()=>{const current=await readRemote();assertOwner();if(JSON.stringify(current)!==JSON.stringify(remote))throw new Error('Documentul s-a schimbat din nou. Reîncarcă și compară înainte de rezolvare.');};
   await checkRemote();
   for(const op of rows){
    if(!op.attempts)continue;
    // A matching authoritative document already proves the desired write.
    const comparable=path.startsWith('orders/')?orderSaveBody(remote as Order,(remote as Order).revision):remote as Record<string,unknown>;
    if(equalDesired(comparable,op.body as Record<string,unknown>))continue;
    try{const result=await transport(op.path,op.method,op.body,op.id);requireReplayContract(op,result);throw new Error('Operațiunea anterioară a fost confirmată. Reîncarcă documentul înainte de alegere.');}
    catch(error){if(![400,409,422].includes((error as {status?:number}).status??0))throw error;}
   }
   await checkRemote();
   await withOutboxGate(()=>transaction(['work','outbox','meta'],'readwrite',async tx=>{
    if((await request(tx.objectStore('meta').get('lease|'+userId)))?.token!==token)throw new Error('Sincronizare preluată de altă fereastră.');
    assertOwner();const outbox=tx.objectStore('outbox'),work=tx.objectStore('work'),key=userId+'|'+local.scope+'|'+local.id;
    const current=(await request(outbox.index('user').getAll(userId)) as PendingOperation[]).filter(op=>entityFor(op.path,op.body)===entity);
    if(current.length!==rows.length||current.some(row=>JSON.stringify(row)!==JSON.stringify(rows.find(expected=>expected.id===row.id)))||JSON.stringify((await request(work.get(key)))?.value)!==JSON.stringify(stored))throw new Error('Lucrul local s-a schimbat în altă filă. Redeschide documentul.');
    for(const op of rows){await request(work.put({key:userId+'|resolved-operation|'+op.id,value:op}));await request(outbox.delete(op.id));}
    if(local.scope==='order'&&body===null)await request(work.delete(key));
    else await request(work.put({key,value:local.value}));
    if(body!==null){const op:PendingOperation={id:crypto.randomUUID(),userId,path,method,body,entity,created:Date.now(),attempts:0,next:0,state:'pending',...(local.scope==='order'?{orderWork:local.value as {base:Order;local:Order}}:{})};await request(outbox.put(op));}
   }));notify();
  }finally{await releaseLease(userId,token);}
 };
 if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request('mobiup-outbox-'+userId,run);
 return run();
}
/** Terminal recovery archives the original work and requests, never an ambiguous create. */
export async function retireOrderWork(userId:string,id:string,transport:ReplayTransport,active:()=>string){
 const run=async()=>{
  const token=await claimLease(userId);if(!token)throw new Error('Sincronizarea este în curs. Reîncearcă.');
  try{
   if(active()!==userId)throw new Error('Contul s-a schimbat.');
   let remote:Order|null=null;
   try{remote=(await transport('orders/'+id,'GET',undefined) as {order:Order}).order;}
   catch(error){if((error as {status?:number}).status!==404)throw error;}
   if(remote?.status==='draft')throw new Error('Comanda este încă editabilă. Compară versiunile înainte de rezolvare.');
   await withOutboxGate(()=>transaction(['work','outbox','meta'],'readwrite',async tx=>{
    if((await request(tx.objectStore('meta').get('lease|'+userId)))?.token!==token)throw new Error('Sincronizare preluată de altă fereastră.');
    if(active()!==userId)throw new Error('Contul s-a schimbat.');
    const outbox=tx.objectStore('outbox'),work=tx.objectStore('work');
    const rows=(await request(outbox.index('user').getAll(userId)) as PendingOperation[]).filter(op=>entityFor(op.path,op.body)==='orders/'+id);
    if(rows.some(op=>op.method==='POST'))throw new Error('Crearea comenzii nu este confirmată. Copia și operațiunea rămân păstrate.');
    for(const op of rows){await request(work.put({key:userId+'|resolved-operation|'+op.id,value:op}));await request(outbox.delete(op.id));}
    const key=userId+'|order|'+id,row=await request(work.get(key));
    if(row)await request(work.put({key:userId+'|recovered-order|'+id,value:row.value}));
    await request(work.delete(key));
    const markerKey=userId+'|order-list|settled',value=(await request(work.get(markerKey)))?.value||{};
    value[id]=remote?'finalized':'deleted';await request(work.put({key:markerKey,value}));await reconcileOrderListInTransaction(tx,userId,[]);
   }));notify();
  }finally{await releaseLease(userId,token);}
 };
 if(navigator.locks)return navigator.locks.request('mobiup-outbox-'+userId,run);
 return run();
}
/** Explicit retry retains the original identity and payload, including old queues. */
export async function retryBlockedOperation(userId:string,id:string){
 await withOutboxGate(()=>transaction(['outbox'],'readwrite',async tx=>{const store=tx.objectStore('outbox'),op=await request(store.get(id)) as PendingOperation|undefined;
  if(op?.userId===userId&&op.state==='blocked')await request(store.put({...op,state:'pending',next:0}));
 }));notify();
}
const invalidateReplayCache=(userId:string,prefixes:string[])=>{if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(OFFLINE_CACHE_INVALIDATED_EVENT,{detail:{userId,prefixes}}));};
async function claimLease(userId:string){return transaction(['meta'],'readwrite',async tx=>{const s=tx.objectStore('meta'),key='lease|'+userId;const old=await request(s.get(key));if(old?.until>Date.now())return null;const token=crypto.randomUUID();await request(s.put({key,token,until:Date.now()+45000}));return token;});}
async function releaseLease(userId:string,token:string){await transaction(['meta'],'readwrite',async tx=>{const s=tx.objectStore('meta'),key='lease|'+userId;if((await request(s.get(key)))?.token===token)await request(s.delete(key));});}
function equalDesired(remote:Record<string,unknown>,body:Record<string,unknown>){return Object.entries(body).filter(([k])=>k!=='revision').every(([k,v])=>JSON.stringify(remote[k])===JSON.stringify(v));}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function visitRecord(value:unknown):value is Record<string,unknown>{
 return object(value)&&['id','customerId','agentId','agentName','notes','visitedAt','createdAt'].every(key=>typeof value[key]==='string')&&Number.isFinite(Date.parse(value.visitedAt as string))&&Number.isFinite(Date.parse(value.createdAt as string));
}
function confirmedVisit(op:PendingOperation,result:unknown){
 if(!object(result)||!object(op.body)||typeof op.body.id!=='string')return null;
 const body=op.body;
 const customerId=decodeURIComponent(op.path.split('/')[2]);
 const matches=(visit:unknown)=>visitRecord(visit)&&visit.id===body.id&&visit.customerId===customerId&&visit.agentId===op.userId&&visit.notes===(typeof body.notes==='string'?body.notes.trim().slice(0,2000):'');
 // Older servers confirm through the history page; never assume its first row is ours.
 return matches(result.visit)?result.visit:Array.isArray(result.visits)?result.visits.find(matches)??null:null;
}
function requireReplayContract(op:PendingOperation,result:unknown){
 const value=object(result)?result:null;
 let valid=true;
 if(/^orders(?:\/[^/]+)?$/.test(op.path))valid=!!value&&object(value.order)&&value.order.id===(op.path==='orders'?(op.body as {id?:string})?.id:op.path.slice(7));
 else if(/^partner\/portfolio\/[^/]+$/.test(op.path))valid=!!value&&object(value.partner)&&typeof value.partner.id==='string';
 else if(/^partner\/portfolio\/[^/]+\/visits$/.test(op.path))valid=!!value&&object(value.partner)&&value.partner.id===decodeURIComponent(op.path.split('/')[2])&&Array.isArray(value.visits)&&value.visits.every(v=>visitRecord(v)&&v.customerId===decodeURIComponent(op.path.split('/')[2]))&&Number.isInteger(value.visitCount)&&(value.visitCount as number)>0&&(value.visitCount as number)>=value.visits.length&&(value.nextCursor===null||typeof value.nextCursor==='string')&&!!confirmedVisit(op,value);
 else if(op.path==='partner/planning')valid=!!value&&typeof value.date==='string'&&Array.isArray(value.stops);
 if(!valid)throw Object.assign(new Error('Confirmarea serverului este incompletă. Operațiunea rămâne în coadă pentru verificare.'),{status:502});
}
async function reconcileReplaySnapshot(userId:string,op:PendingOperation,result:unknown){
 requireReplayContract(op,result);
 const prefixes=new Set<string>();
 if(/^orders(?:\/[^/]+)?$/.test(op.path)){
  const order=object(result)&&object(result.order)?result.order:null;
  if(order&&typeof order.id==='string'){
   await saveSnapshot(userId,'orders/'+order.id,{order});
   const list=await snapshot<{user:unknown;orders:Record<string,unknown>[];weekKey:string}>(userId,'orders');
   if(list&&Array.isArray(list.value.orders)&&typeof list.value.weekKey==='string'){
    await saveSnapshot(userId,'orders',{...list.value,orders:[...list.value.orders.filter(row=>row.id!==order.id),order]});
   }
  }
  prefixes.add('orders');
 }else if(/^partner\/portfolio\/[^/]+$/.test(op.path)&&op.method==='PATCH'){
  const cached=await snapshot<{partner:Record<string,unknown>;visits:unknown[]}>(userId,op.path);
  const partner=object(result)&&object(result.partner)?result.partner:null;
  if(cached&&object(cached.value.partner)&&Array.isArray(cached.value.visits)&&partner)await saveSnapshot(userId,op.path,{...cached.value,partner:{...cached.value.partner,...partner},visits:cached.value.visits});
  prefixes.add(op.path);prefixes.add('partner/browse');prefixes.add('partner/summary');
 }else if(/^partner\/portfolio\/[^/]+\/visits$/.test(op.path)&&op.method==='POST'){
  const parent=op.path.replace(/\/visits$/,'');
  if(object(result)){
   // Keep the authoritative first page, count and cursor together. The explicit
   // confirmation can be older than that page and must not corrupt pagination.
   const {partner,visits,visitCount,nextCursor}=result;
   await saveSnapshot(userId,parent,{partner,visits,visitCount,nextCursor});
  }
  prefixes.add(parent);prefixes.add('partner/browse');prefixes.add('partner/summary');
 }else if(op.path==='partner/planning'&&object(result)&&typeof result.date==='string'&&Array.isArray(result.stops)){
  const day=new Date(result.date+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));
  const path='partner/planning?week='+day.toISOString().slice(0,10);
  const cached=await snapshot<{week:string;plans:Record<string,unknown>[];visits:unknown[]}>(userId,path);
  if(cached&&Array.isArray(cached.value.plans))await saveSnapshot(userId,path,{...cached.value,plans:[...cached.value.plans.filter(plan=>plan.date!==result.date),result]});
  prefixes.add('partner/planning');
 }
 invalidateReplayCache(userId,[...prefixes]);
}
let running=false;
export async function replay(userId:string,transport:(path:string,method:string,body:unknown,operationId?:string)=>Promise<unknown>,active:()=>string){
 if(running||!userId||active()!==userId||document.visibilityState==='hidden')return;
 running=true;
 const run=async()=>{const token=await claimLease(userId);if(!token)return;try{
  const blocked=new Set<string>();
  for(const op of await pendingOperations(userId)){
   if(active()!==userId)break;
   const dependency=entityFor(op.path,op.body);
   if(op.state==='blocked'||op.next>Date.now()||blocked.has(dependency)){blocked.add(dependency);continue;}
   const expected=structuredClone(op);
   try{
    let result:unknown;
    if(op.method==='PUT'&&op.path.startsWith('orders/')){
      const current=await transport(op.path,'GET',undefined) as {order:Order};const id=op.path.slice(7);const work=await readWork<{base:Order;local:Order}>(userId,'order',id);
      if(current.order.status!=='draft')throw Object.assign(new Error('Comanda a fost finalizată. Recuperează modificările locale.'),{status:409});
      if(equalDesired(orderSaveBody(current.order,current.order.revision),op.body as Record<string,unknown>))result=current;
      else if(!op.attempts&&work){
       const local=operationOrder(op,work),base=op.orderWork?.base??work.base;
       const merged=mergeConcurrentOrders(base,local,current.order,'local');
       if(merged.conflicts.length)throw Object.assign(new Error('Conflict: '+merged.conflicts.join(', ')),{status:409});
       op.orderWork??={base,local};
       if(sameEditableOrder(merged.order,current.order))result=current;
       else op.body=orderSaveBody(merged.order,current.order.revision);
      }
    }
    if(op.method==='PATCH'&&op.path.startsWith('partner/portfolio/')){const current=await transport(op.path,'GET',undefined) as {partner:Record<string,unknown>};const desired=op.body as Record<string,unknown>;if(current.partner.canEdit!==true)throw Object.assign(new Error('Dreptul de editare s-a modificat.'),{status:403});if(['contact','phone','email','latitude','longitude','positionSource','positionAccuracy','addressFingerprint'].every(k=>JSON.stringify(current.partner[k])===JSON.stringify(desired[k])))result={partner:current.partner};}
    if(op.path==='partner/planning'){const desired=op.body as {date:string;stops:string[]};const day=new Date(desired.date+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));const current=await transport('partner/planning?week='+day.toISOString().slice(0,10),'GET',undefined) as {plans:{date:string;stops:string[]}[]};const plan=current.plans.find(p=>p.date===desired.date);if(plan&&JSON.stringify(plan.stops)===JSON.stringify(desired.stops))result=plan;}

    await transaction(['meta'],'readwrite',async tx=>{const store=tx.objectStore('meta'),key='lease|'+userId;const lease=await request(store.get(key));if(lease?.token!==token)throw new Error('Sincronizare preluată de altă fereastră.');await request(store.put({...lease,until:Date.now()+45000}));});
    if(active()!==userId)break;
    // Freeze the exact wire payload before sending; retries never rewrite it.
    op.attempts++;if(!await updateOperation(op,expected))break;
    result??=await transport(op.path,op.method,op.body,op.id);
    if(active()!==userId)break;
    // Leave recovery work until the UI has reconciled the confirmed server document.
    await reconcileReplaySnapshot(userId,op,result);
    const submitted=await acknowledgeOperation(op,result,token);notify();
    window.dispatchEvent(new CustomEvent('mobiup-sync-confirmed',{detail:{path:op.path,result,userId,submitted}}));
   }catch(e){const status=(e as {status?:number}).status;op.error=e instanceof Error?e.message:'Conexiune indisponibilă';op.status=status;
    if(status===401){op.next=Date.now()+60000;await updateOperation(op,op.attempts===expected.attempts?expected:undefined);break;}
    if(status&&status<500){op.state='blocked';}else{op.next=Date.now()+Math.min(60000,1000*2**Math.min(op.attempts,6));}
    await updateOperation(op,op.attempts===expected.attempts?expected:undefined);blocked.add(dependency);
   }
   // A new lease per bounded request avoids overlapping senders even with a long queue.
   break;
  }
 }finally{await releaseLease(userId,token);}};
 try{if(navigator.locks)await navigator.locks.request('mobiup-outbox-'+userId,{ifAvailable:true},lock=>lock?run():Promise.resolve());else await run();}finally{running=false;}
}
