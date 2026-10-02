import { snapshot, saveSnapshot, rememberAccount, lastAccount, migrateLegacy, replay, pendingOperations, OFFLINE_CACHE_INVALIDATED_EVENT } from './offline-work.ts';
import { currentLocalWorkGeneration, currentLocalWorkUserId, LOCAL_WORK_USER_EVENT, removeLocalWork, restoreLocalWorkUserId, setLocalWorkUserId } from './local-work.ts';

export const SESSION_EXPIRED_EVENT='mobiup-session-expired';
export const DATA_FRESHNESS_EVENT='mobiup-data-freshness';
export type ApiReadOptions={preferCache?:boolean;maxAgeMs?:number;forceRefresh?:boolean};

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name='ApiError';
    this.status=status;
    this.data=data;
  }
}

// A definitive session loss also fences requests started while already anonymous.
let sessionEpoch=0,sessionRejected=false;
async function rejectSession(){
 sessionEpoch++;sessionRejected=true;setLocalWorkUserId('');invalidateApiReadCache();
 const epoch=sessionEpoch,generation=currentLocalWorkGeneration();
 await rememberAccount('').catch(()=>{});
 if(epoch!==sessionEpoch)throw scopeError();
 assertScope('',generation);
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const array=(value:unknown)=>Array.isArray(value);
function validGetContract(path:string,data:unknown){
 if(path==='bootstrap')return record(data)&&(data.user===null||(record(data.user)&&typeof data.user.id==='string'));
 if(path==='auth/session')return record(data)&&(data.user===null||(record(data.user)&&typeof data.user.id==='string'));
 if(path==='orders')return record(data)&&record(data.user)&&array(data.orders)&&typeof data.weekKey==='string';
 if(/^orders\/[^/?]+$/.test(path))return record(data)&&record(data.order)&&typeof data.order.id==='string';
 if(path==='partner/summary')return record(data)&&array(data.partners);
 if(/^partner\/browse(?:\?|$)/.test(path))return record(data)&&array(data.partners)&&typeof data.total==='number'&&record(data.facets)&&array(data.facets.counties)&&array(data.facets.cities)&&array(data.facets.routes);
 if(/^partner\/map(?:\?|$)/.test(path))return record(data)&&data.type==='FeatureCollection'&&array(data.features);
 if(/^partner\/portfolio\/[^/?]+$/.test(path))return record(data)&&record(data.partner)&&array(data.visits);
 if(/^partner\/planning(?:\?|$)/.test(path))return record(data)&&array(data.plans);
 if(/^stock(?:\?|\/|$)/.test(path))return record(data)&&typeof data.warehouseId==='string'&&array(data.rows)&&record(data.depot);
 if(/^sales\/clients(?:\?|$)/.test(path))return record(data)&&(data.state==='unavailable'?typeof data.message==='string':data.state==='ready'&&typeof data.month==='string'&&record(data.totals)&&record(data.source)&&array(data.rows)&&array(data.comparisons)&&record(data.counts));
 if(/^sales(?:\?|\/|$)/.test(path))return record(data)&&typeof data.month==='string'&&record(data.summary)&&array(data.sites)&&array(data.daily)&&array(data.products);
 return true;
}
function scopeError(){return new ApiError(409,'Contul s-a schimbat. Reîncarcă datele.',null);}
function assertScope(owner:string,generation:number){
 if(currentLocalWorkUserId()!==owner||currentLocalWorkGeneration()!==generation)throw scopeError();
}
type ReadCacheEntry={userId:string;generation:number;path:string;value:unknown;at:number;bytes:number};
const readCache=new Map<string,ReadCacheEntry>();
const READ_CACHE_MAX_ENTRIES=96,READ_CACHE_MAX_BYTES=4*1024*1024;
let readCacheBytes=0,lastCacheGeneration=currentLocalWorkGeneration();
const clone=<T>(value:T):T=>typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value)) as T;
function synchronizeReadCache(){
 const generation=currentLocalWorkGeneration();
 if(generation!==lastCacheGeneration){readCache.clear();readCacheBytes=0;lastCacheGeneration=generation;}
}
export function invalidateApiReadCache(prefix?:string){
 for(const [key,row] of readCache)if(!prefix||row.path.startsWith(prefix)){readCache.delete(key);readCacheBytes-=row.bytes;}
}
function rememberRead(userId:string,generation:number,path:string,value:unknown,at=Date.now()){
 if(!userId)return;
 let bytes=0;try{bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;}catch{return;}
 if(bytes>1024*1024)return;
 const key=userId+'|'+generation+'|'+path,old=readCache.get(key);if(old)readCacheBytes-=old.bytes;
 readCache.delete(key);readCache.set(key,{userId,generation,path,value:clone(value),at,bytes});readCacheBytes+=bytes;
 while(readCache.size>READ_CACHE_MAX_ENTRIES||readCacheBytes>READ_CACHE_MAX_BYTES){const first=readCache.entries().next().value as [string,ReadCacheEntry]|undefined;if(!first)break;readCache.delete(first[0]);readCacheBytes-=first[1].bytes;}
}
function emitFreshness(userId:string,path:string,source:'network'|'offline',at:number){
 if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(DATA_FRESHNESS_EVENT,{detail:{userId,path,source,at}}));
}
if(typeof window!=='undefined'){
 window.addEventListener(LOCAL_WORK_USER_EVENT,()=>{synchronizeReadCache();invalidateApiReadCache();});
 window.addEventListener(OFFLINE_CACHE_INVALIDATED_EVENT,event=>{const detail=(event as CustomEvent<{prefixes?:string[]}>).detail;for(const prefix of detail?.prefixes||[])invalidateApiReadCache(prefix);});
}

export async function networkApi<T=Record<string,unknown>>(path: string,method='GET',body?: unknown, signal?: AbortSignal, operationId?:string, operationUser?:string): Promise<T> {
  const requestEpoch=sessionEpoch;
  const requestOwner=currentLocalWorkUserId();
  const requestGeneration=currentLocalWorkGeneration();
  method=method.toUpperCase();
  const controller=new AbortController();
  const cancel=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const timer=setTimeout(()=>controller.abort(new Error('Cererea a depășit timpul de așteptare.')),20000);
  const headers:Record<string,string>={};if(operationUser)headers['X-Operation-User']=operationUser;
  const options:RequestInit={method,credentials:'same-origin',signal:controller.signal,headers};
  if(body && method!=='GET' && method!=='HEAD'){headers['Content-Type']='application/json';if(operationId)headers['X-Operation-Id']=operationId;options.body=JSON.stringify(body);}
  let res:Response;try{res=await fetch('/api/'+path,options);}catch(error){clearTimeout(timer);signal?.removeEventListener('abort',cancel);throw error;}
  let data:unknown;
  try { data=await res.json(); }
  catch(error) {if(controller.signal.aborted)throw error;if(res.ok)throw new ApiError(502,'Serverul a trimis un răspuns care nu poate fi citit.',null);data=null;}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  if(!res.ok) {
    const message=data && typeof data==='object' && 'error' in data && typeof (data as {error?:unknown}).error==='string'
      ? (data as {error:string}).error
      : 'Operațiunea nu a reușit.';
    if(res.status===401&&path.split('/').at(-1)!=='login'&&requestEpoch===sessionEpoch&&requestOwner===currentLocalWorkUserId()&&requestGeneration===currentLocalWorkGeneration()){
      await rejectSession();
      if(typeof window!=='undefined')window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(res.status,message,data);
  }
  if(method==='GET'&&!validGetContract(path,data))throw new ApiError(502,'Serverul a trimis date incompatibile cu această pagină.',data);
  if((path==='bootstrap'||path==='auth/session'||path==='auth/logout')&&(requestEpoch!==sessionEpoch||requestOwner!==currentLocalWorkUserId()||requestGeneration!==currentLocalWorkGeneration()))throw scopeError();
  if((path==='bootstrap'||path==='auth/session')&&data&&typeof data==='object'&&'user' in data) {
    const user=(data as {user?:unknown}).user;
    if(user===null)await rejectSession();
    else if(record(user)&&typeof user.id==='string'){sessionRejected=false;setLocalWorkUserId(user.id);}
  } else if(path==='auth/logout'&&method==='POST') {
    await rejectSession();
  } else if(method==='DELETE'&&/^orders\/[^/]+$/.test(path)) {
    const userId=currentLocalWorkUserId();
    const orderId=path.slice('orders/'.length);
    if(userId&&orderId)removeLocalWork('order',userId,orderId);
  }
  return data as T;
}
const cacheable=(path:string)=>path==='bootstrap'||path==='auth/session'||path==='orders'||/^orders\/[^/]+$/.test(path)||/^partner\/(browse|map|summary|portfolio|planning)([/?]|$)/.test(path)||/^clients[?]/.test(path)||/^stock[/?]/.test(path);
export async function api<T=Record<string,unknown>>(path:string,method='GET',body?:unknown,signal?:AbortSignal,options:ApiReadOptions={}):Promise<T>{
 method=method.toUpperCase();synchronizeReadCache();
 if(signal?.aborted)throw signal.reason??new DOMException('Cerere anulată.','AbortError');
 const epoch=sessionEpoch;
 const owner=currentLocalWorkUserId();
 const generation=currentLocalWorkGeneration();
 if(method==='GET'&&path!=='bootstrap'&&path!=='auth/session'&&options.preferCache&&!options.forceRefresh&&owner){
  const key=owner+'|'+generation+'|'+path,entry=readCache.get(key),maxAge=Math.max(0,options.maxAgeMs??30000);
  if(entry&&Date.now()-entry.at<=maxAge){readCache.delete(key);readCache.set(key,entry);return clone(entry.value) as T;}
 }
 try{
  const result=await networkApi<T>(path,method,body,signal);
  if(path==='auth/logout')return result;
  if(!path.startsWith('auth/')&&path!=='bootstrap')assertScope(owner,generation);
  const user=(result as {user?:{id:string}|null})?.user;
  const responseOwner=currentLocalWorkUserId(),responseGeneration=currentLocalWorkGeneration();
  if((path==='bootstrap'||path==='auth/session')&&user!==undefined){
   if(user)await rememberAccount(user.id).catch(()=>{});assertScope(responseOwner,responseGeneration);
   if(user)await migrateLegacy(user.id).catch(()=>{});assertScope(responseOwner,responseGeneration);
  }
  const account=user===null?'':user?.id||owner||currentLocalWorkUserId();
  if(method!=='GET')invalidateApiReadCache();
  if(typeof window!=='undefined'&&method==='GET'&&cacheable(path)&&account)await saveSnapshot(account,path,result).catch(error=>{window.dispatchEvent(new CustomEvent('mobiup-storage-error',{detail:error instanceof Error?error.message:'Datele primite nu au putut fi pregătite pentru offline.'}));});
  assertScope(responseOwner,responseGeneration);
  if(method==='GET'&&account){rememberRead(account,responseGeneration,path,result);emitFreshness(account,path,'network',Date.now());}
  return result;
 }catch(e){
  if(typeof window==='undefined'||method!=='GET'||signal?.aborted||(e instanceof ApiError&&e.status<500))throw e;
  assertScope(owner,generation);
  if(epoch!==sessionEpoch||sessionRejected)throw e;
  let account=owner;
  const authRestore=path==='bootstrap'||path==='auth/session';
  if(!account&&authRestore){
   assertScope(owner,generation);
   account=await lastAccount();
   assertScope(owner,generation);
  }
  if(cacheable(path)&&account){
   assertScope(owner,generation);
   const stored=await snapshot<T>(account,path);
   assertScope(owner,generation);
   if(stored&&validGetContract(path,stored.value)){
    if(authRestore&&record(stored.value)&&record(stored.value.user)&&stored.value.user.id!==account)throw scopeError();
    if(authRestore&&!owner){
     const cachedUser=(stored.value as {user?:{id?:unknown}|null})?.user;
     if(!cachedUser||cachedUser.id!==account||!restoreLocalWorkUserId(account,generation))throw scopeError();
    }
    rememberRead(account,currentLocalWorkGeneration(),path,stored.value,stored.at);
    window.dispatchEvent(new CustomEvent('mobiup-offline-snapshot',{detail:{path,at:stored.at}}));
    emitFreshness(account,path,'offline',stored.at);
    return stored.value;
   }
   if(path.startsWith('partner/browse?')){
    const params=new URLSearchParams(path.split('?')[1]);
    if(!params.get('salesPeriod')&&!params.get('managerId')&&!params.get('agentId')){
     assertScope(owner,generation);
     const prepared=await snapshot<{partners:import('./partner-map-types').PartnerSummary[]}>(account,'partner/summary');
     assertScope(owner,generation);
     if(prepared&&record(prepared.value)&&Array.isArray(prepared.value.partners)){const all=prepared.value.partners,q=normalize(params.get('q')||''),county=params.get('county')||'',city=normalize(params.get('city')||''),route=params.get('route')||'',position=params.get('position')||'',days=params.get('days')||'';
      const selected=all.filter(p=>(!q||normalize([p.id,p.name,p.cui,p.address,p.city,p.county].join(' ')).includes(q))&&(!county||p.county===county)&&(!city||normalize(p.city||'').includes(city))&&(!route||p.route===route)&&(!position||(position==='yes'?p.latitude!==null:p.latitude===null))&&(!days||(days==='never'?!p.lastVisitedAt:!!p.lastVisitedAt&&Date.now()-Date.parse(p.lastVisitedAt)>=Number(days)*86400000)));
      const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||100),inCounty=all.filter(p=>!county||p.county===county),unique=(items:string[])=>[...new Set(items.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ro'));
      window.dispatchEvent(new CustomEvent('mobiup-offline-snapshot',{detail:{path,at:prepared.at}}));
      const value={partners:selected.slice(offset,offset+limit),total:selected.length,located:selected.filter(p=>p.latitude!==null).length,geocoded:selected.filter(p=>p.positionSource==='geocoding').length,nextOffset:offset+limit<selected.length?offset+limit:null,bounds:null,facets:{counties:unique(all.map(p=>p.county)),cities:unique(inCounty.map(p=>p.city)),routes:unique(inCounty.map(p=>p.route))},styleUrl:'https://tiles.openfreemap.org/styles/positron',observedAt:new Date(prepared.at).toISOString()} as T;
      rememberRead(account,currentLocalWorkGeneration(),path,value,prepared.at);emitFreshness(account,path,'offline',prepared.at);return value;
     }
    }
   }
  }
  throw e;
 }
}
export function startOfflineSync(accountChanged?:()=>void){
 let checking=false,stopped=false;
 const sync=()=>{if(stopped||checking||document.visibilityState==='hidden'||!navigator.onLine)return;
  const owner=currentLocalWorkUserId(),generation=currentLocalWorkGeneration();if(!owner)return;checking=true;
  void (async()=>{
   const pending=await pendingOperations(owner);
   assertScope(owner,generation);
   if(!pending.some(op=>op.state==='pending'&&op.next<=Date.now()))return;
   const session=await networkApi<{user:{id:string}|null}>('auth/session');
   if(currentLocalWorkUserId()!==owner||session.user?.id!==owner){accountChanged?.();return;}
   if(stopped)return;
   await replay(owner,(path,method,body,id)=>networkApi(path,method,body,undefined,id,owner),currentLocalWorkUserId);
  })().catch(()=>{}).finally(()=>{checking=false;});
 };
 window.addEventListener('online',sync);document.addEventListener('visibilitychange',sync);const timer=setInterval(sync,4000);sync();
 return()=>{stopped=true;clearInterval(timer);window.removeEventListener('online',sync);document.removeEventListener('visibilitychange',sync);};
}
export function errorMessage(err: unknown) { return err instanceof Error?err.message:'Conexiunea a fost întreruptă. Încearcă din nou.'; }
export function normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
export const money=(n:number)=>new Intl.NumberFormat('ro-RO',{style:'currency',currency:'RON'}).format(n);
const dateKeyFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});
export const localDateKey=(s:string)=>dateKeyFormatter.format(new Date(s));
export const orderEffectiveDate=(o:{createdAt:string;finalizedAt:string|null})=>o.finalizedAt||o.createdAt;
export const orderDateKey=(o:{createdAt:string;finalizedAt:string|null})=>localDateKey(orderEffectiveDate(o));
export const dateLabel=(s:string)=>new Date(s).toLocaleDateString('ro-RO',{day:'2-digit',month:'short',year:'numeric',timeZone:'Europe/Bucharest'});
export const kindLabels={accessories:'Accesorii',stands:'Standuri, cartele & telefoane',sim:'Aviz SIM 0',stand_client:'Aviz pentru standuri',combined:'Comandă combinată'};
export const timeLabel=(s:string)=>new Date(s).toLocaleTimeString('ro-RO',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/Bucharest'});
