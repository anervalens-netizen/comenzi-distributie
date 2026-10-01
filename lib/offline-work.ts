import {mergeConcurrentOrders,orderSaveBody,sameEditableOrder} from './order-draft.ts';
import type {Order} from './types';
/** Account-bound durable work. Transactions never evict pending mutations. */
export type PendingOperation = { id:string; userId:string; entity:string; path:string; method:string; body:unknown; created:number; attempts:number; next:number; state:'pending'|'blocked'; error?:string };
type Snapshot = {key:string;userId:string;path:string;value:unknown;at:number;bytes:number};
export const OFFLINE_EVENT='mobiup-offline-work';
let opening:Promise<IDBDatabase>|undefined;
const notify=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event(OFFLINE_EVENT));};
const request=<T>(req:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
function database(){
 if(typeof indexedDB==='undefined')return Promise.reject(new Error('Stocarea locală nu este disponibilă.'));
 return opening??=new Promise<IDBDatabase>((resolve,reject)=>{
  const req=indexedDB.open('mobiup-offline-v3',1);
  req.onupgradeneeded=()=>{const d=req.result;d.createObjectStore('snapshots',{keyPath:'key'});d.createObjectStore('work',{keyPath:'key'});d.createObjectStore('outbox',{keyPath:'id'}).createIndex('user','userId');d.createObjectStore('meta',{keyPath:'key'});};
  req.onsuccess=()=>{req.result.onversionchange=()=>{req.result.close();opening=undefined;};resolve(req.result);};req.onerror=()=>{opening=undefined;reject(req.error);};req.onblocked=()=>{opening=undefined;reject(new Error('Închide celelalte ferestre pentru actualizarea stocării locale.'));};
 });
}
async function transaction<T>(stores:string[],mode:IDBTransactionMode,run:(tx:IDBTransaction)=>Promise<T>){
 const d=await database();const tx=d.transaction(stores,mode);const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('Datele nu au fost salvate local.'));tx.onerror=()=>{};});
 try{const value=await run(tx);await done;return value;}catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
}
export async function snapshot<T>(userId:string,path:string):Promise<{value:T;at:number}|null>{if(!userId)return null;const row=await transaction(['snapshots'],'readonly',tx=>request(tx.objectStore('snapshots').get(userId+'|'+path))) as Snapshot|undefined;return row?{value:row.value as T,at:row.at}:null;}
export async function saveSnapshot(userId:string,path:string,value:unknown){
 if(!userId)return;const bytes=JSON.stringify(value).length*2;if(bytes>8*1024*1024)return;
 await transaction(['snapshots'],'readwrite',async tx=>{const s=tx.objectStore('snapshots');const rows=await request(s.getAll()) as Snapshot[];let size=rows.reduce((n,r)=>n+r.bytes,0);for(const r of rows.sort((a,b)=>a.at-b.at)){if(size+bytes<=24*1024*1024&&rows.length<250)break;await request(s.delete(r.key));size-=r.bytes;}await request(s.put({key:userId+'|'+path,userId,path,value,at:Date.now(),bytes}));});
}
export async function rememberAccount(userId:string){await transaction(['meta'],'readwrite',tx=>request(tx.objectStore('meta').put({key:'active',value:userId})));}
export async function lastAccount(){return transaction(['meta'],'readonly',async tx=>(await request(tx.objectStore('meta').get('active')))?.value as string||'');}
export async function readWork<T>(userId:string,scope:string,id:string){return transaction(['work'],'readonly',async tx=>(await request(tx.objectStore('work').get(userId+'|'+scope+'|'+id)))?.value as T|undefined);}
export async function saveWork(userId:string,scope:string,id:string,value:unknown){await transaction(['work'],'readwrite',tx=>request(tx.objectStore('work').put({key:userId+'|'+scope+'|'+id,value})));}
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
function entityFor(path:string,body:unknown){return path==='orders'?'orders/'+String((body as {id?:string})?.id):path==='partner/planning'?'plan/'+String((body as {date?:string})?.date):path.replace(/\/visits$/,'');}
export async function enqueue(userId:string,path:string,method:string,body:unknown,local?:{scope:string;id:string;value:unknown}){
 if(!userId)throw new Error('Contul trebuie pregătit online înainte de lucru offline.');
 if(!((path==='orders'&&method==='POST')||(/^orders\/[^/]+$/.test(path)&&method==='PUT')||(/^partner\/portfolio\/[^/]+$/.test(path)&&method==='PATCH')||(/^partner\/portfolio\/[^/]+\/visits$/.test(path)&&method==='POST')||(path==='partner/planning'&&method==='PUT')))throw new Error('Această operațiune necesită conexiune și confirmare pe server.');
 const operation:PendingOperation={id:crypto.randomUUID(),userId,path,method,body,entity:entityFor(path,body),created:Date.now(),attempts:0,next:0,state:'pending'};
 await transaction(['work','outbox'],'readwrite',async tx=>{
  if(local)await request(tx.objectStore('work').put({key:userId+'|'+local.scope+'|'+local.id,value:local.value}));
  const all=await request(tx.objectStore('outbox').index('user').getAll(userId)) as PendingOperation[];
  // One not-yet-sent edit per entity. Never replace an ambiguous/attempted request.
  const previous=all.filter(o=>o.entity===operation.entity&&o.path===path&&o.method===method&&o.attempts===0&&o.state==='pending').at(-1);
  if(method==='POST'&&all.some(o=>o.path===path&&o.method===method&&JSON.stringify(o.body)===JSON.stringify(body)))return;
  if(previous&&method!=='POST'){operation.id=previous.id;operation.created=previous.created;}
  await request(tx.objectStore('outbox').put(operation));
 });notify();return operation;
}
export async function removeOperation(id:string){await transaction(['outbox'],'readwrite',tx=>request(tx.objectStore('outbox').delete(id)));notify();}
async function updateOperation(op:PendingOperation){await transaction(['outbox'],'readwrite',tx=>request(tx.objectStore('outbox').put(op)));notify();}
async function claimLease(userId:string){return transaction(['meta'],'readwrite',async tx=>{const s=tx.objectStore('meta'),key='lease|'+userId;const old=await request(s.get(key));if(old?.until>Date.now())return null;const token=crypto.randomUUID();await request(s.put({key,token,until:Date.now()+45000}));return token;});}
async function releaseLease(userId:string,token:string){await transaction(['meta'],'readwrite',async tx=>{const s=tx.objectStore('meta'),key='lease|'+userId;if((await request(s.get(key)))?.token===token)await request(s.delete(key));});}
function equalDesired(remote:Record<string,unknown>,body:Record<string,unknown>){return Object.entries(body).filter(([k])=>k!=='revision').every(([k,v])=>JSON.stringify(remote[k])===JSON.stringify(v));}
let running=false;
export async function replay(userId:string,transport:(path:string,method:string,body:unknown,operationId?:string)=>Promise<unknown>,active:()=>string){
 if(running||!userId||active()!==userId||document.visibilityState==='hidden')return;
 running=true;
 const run=async()=>{const token=await claimLease(userId);if(!token)return;try{
  const blocked=new Set<string>();
  for(const op of await pendingOperations(userId)){
   if(active()!==userId)break;
   if(op.state==='blocked'||op.next>Date.now()||blocked.has(op.entity)){blocked.add(op.entity);continue;}
   // Persist the attempted identity before network submission. Lease cannot expire during a bounded request.
   op.attempts++;await updateOperation(op);
   try{
    let result:unknown;
    if(op.method==='PUT'&&op.path.startsWith('orders/')){
      const current=await transport(op.path,'GET',undefined) as {order:Order};const id=op.path.slice(7);const work=await readWork<{base:Order;local:Order}>(userId,'order',id);
      if(equalDesired(orderSaveBody(current.order,current.order.revision),op.body as Record<string,unknown>))result=current;
      else if(work){if(current.order.status!=='draft')throw Object.assign(new Error('Comanda a fost finalizată. Recuperează modificările locale.'),{status:409});const merged=mergeConcurrentOrders(work.base,work.local,current.order,'local');if(merged.conflicts.length)throw Object.assign(new Error('Conflict: '+merged.conflicts.join(', ')),{status:409});if(sameEditableOrder(merged.order,current.order))result=current;else op.body=orderSaveBody(merged.order,current.order.revision);}
    }
    if(op.method==='PATCH'&&op.path.startsWith('partner/portfolio/')){const current=await transport(op.path,'GET',undefined) as {partner:Record<string,unknown>};const desired=op.body as Record<string,unknown>;if(current.partner.canEdit!==true)throw Object.assign(new Error('Dreptul de editare s-a modificat.'),{status:403});if(['contact','phone','email','latitude','longitude','positionSource','positionAccuracy','addressFingerprint'].every(k=>JSON.stringify(current.partner[k])===JSON.stringify(desired[k])))result={partner:current.partner};}
    if(op.path==='partner/planning'){const desired=op.body as {date:string;stops:string[]};const day=new Date(desired.date+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));const current=await transport('partner/planning?week='+day.toISOString().slice(0,10),'GET',undefined) as {plans:{date:string;stops:string[]}[]};const plan=current.plans.find(p=>p.date===desired.date);if(plan&&JSON.stringify(plan.stops)===JSON.stringify(desired.stops))result=plan;}

    await transaction(['meta'],'readwrite',async tx=>{const store=tx.objectStore('meta'),key='lease|'+userId;const lease=await request(store.get(key));if(lease?.token!==token)throw new Error('Sincronizare preluată de altă fereastră.');await request(store.put({...lease,until:Date.now()+45000}));});
    result??=await transport(op.path,op.method,op.body,op.id);
    if(active()!==userId)break;
    // Leave recovery work until the UI has reconciled the confirmed server document.
    await saveSnapshot(userId,op.path,result);await removeOperation(op.id);
    window.dispatchEvent(new CustomEvent('mobiup-sync-confirmed',{detail:{path:op.path,result,userId}}));
   }catch(e){const status=(e as {status?:number}).status;op.error=e instanceof Error?e.message:'Conexiune indisponibilă';
    if(status===401){op.next=Date.now()+60000;await updateOperation(op);break;}
    if(status&&status<500){op.state='blocked';}else{op.next=Date.now()+Math.min(60000,1000*2**Math.min(op.attempts,6));}
    await updateOperation(op);blocked.add(op.entity);
   }
   // A new lease per bounded request avoids overlapping senders even with a long queue.
   break;
  }
 }finally{await releaseLease(userId,token);}};
 try{if(navigator.locks)await navigator.locks.request('mobiup-outbox-'+userId,{ifAvailable:true},lock=>lock?run():Promise.resolve());else await run();}finally{running=false;}
}
