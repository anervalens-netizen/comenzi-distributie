import { snapshot, saveSnapshot, rememberAccount, lastAccount, migrateLegacy, replay } from './offline-work.ts';
import { currentLocalWorkUserId, removeLocalWork, setLocalWorkUserId } from './local-work.ts';

export const SESSION_EXPIRED_EVENT='mobiup-session-expired';

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

export async function networkApi<T=Record<string,unknown>>(path: string,method='GET',body?: unknown, signal?: AbortSignal, operationId?:string): Promise<T> {
  const requestOwner=currentLocalWorkUserId();
  const controller=new AbortController();
  const cancel=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const timer=setTimeout(()=>controller.abort(new Error('Cererea a depășit timpul de așteptare.')),20000);
  const options:RequestInit={method,credentials:'same-origin',signal:controller.signal};
  if(body && method!=='GET' && method!=='HEAD'){options.headers={'Content-Type':'application/json',...(operationId?{'X-Operation-Id':operationId}:{})};options.body=JSON.stringify(body);}
  let res:Response;try{res=await fetch('/api/'+path,options);}catch(error){clearTimeout(timer);signal?.removeEventListener('abort',cancel);throw error;}
  let data:unknown;
  try { data=await res.json(); }
  catch(error) {if(controller.signal.aborted)throw error;data=null;}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  if(!res.ok) {
    const message=data && typeof data==='object' && 'error' in data && typeof (data as {error?:unknown}).error==='string'
      ? (data as {error:string}).error
      : 'Operațiunea nu a reușit.';
    if(res.status===401&&path.split('/').at(-1)!=='login'&&typeof window!=='undefined')window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(res.status,message,data);
  }
  if((path==='bootstrap'||path==='auth/session')&&requestOwner!==currentLocalWorkUserId())throw new ApiError(409,'Contul s-a schimbat. Reîncarcă datele.',null);
  if((path==='bootstrap'||path==='auth/session')&&data&&typeof data==='object'&&'user' in data) {
    const user=(data as {user?:unknown}).user;
    setLocalWorkUserId(user&&typeof user==='object'&&'id' in user&&typeof (user as {id?:unknown}).id==='string'?(user as {id:string}).id:'');
  } else if(path==='auth/logout'&&method==='POST') {
    if(requestOwner===currentLocalWorkUserId())setLocalWorkUserId('');
  } else if(method==='DELETE'&&/^orders\/[^/]+$/.test(path)) {
    const userId=currentLocalWorkUserId();
    const orderId=path.slice('orders/'.length);
    if(userId&&orderId)removeLocalWork('order',userId,orderId);
  }
  return data as T;
}
const cacheable=(path:string)=>path==='bootstrap'||path==='auth/session'||path==='orders'||/^orders\/[^/]+$/.test(path)||/^partner\/(browse|map|summary|portfolio|planning)([/?]|$)/.test(path)||/^clients[?]/.test(path)||/^stock[/?]/.test(path);
export async function api<T=Record<string,unknown>>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
 const owner=currentLocalWorkUserId();
 try{
  const result=await networkApi<T>(path,method,body,signal);
  if(path==='auth/logout'){await rememberAccount('').catch(()=>{});return result;}
  if(!path.startsWith('auth/')&&path!=='bootstrap'&&owner&&owner!==currentLocalWorkUserId())throw new ApiError(409,'Contul s-a schimbat. Reîncarcă datele.',null);
  const user=(result as {user?:{id:string}|null})?.user;
  if((path==='bootstrap'||path==='auth/session')&&user!==undefined){await rememberAccount(user?.id||'').catch(()=>{});if(user)await migrateLegacy(user.id).catch(()=>{});}
  const account=user?.id||owner||currentLocalWorkUserId();
  if(typeof window!=='undefined'&&method==='GET'&&cacheable(path)&&account)await saveSnapshot(account,path,result).catch(()=>{window.dispatchEvent(new CustomEvent('mobiup-storage-error',{detail:'Datele primite nu au putut fi pregătite pentru offline.'}));});
  return result;
 }catch(e){
  if(typeof window==='undefined'||method!=='GET'||signal?.aborted||(e instanceof ApiError&&e.status<500))throw e;
  const account=owner||((path==='bootstrap'||path==='auth/session')?await lastAccount():'');
  if(cacheable(path)&&account){const stored=await snapshot<T>(account,path);if(stored){setLocalWorkUserId(account);window.dispatchEvent(new CustomEvent('mobiup-offline-snapshot',{detail:{path,at:stored.at}}));return stored.value;}
   if(path.startsWith('partner/browse?')){
    const params=new URLSearchParams(path.split('?')[1]);
    if(!params.get('salesPeriod')&&!params.get('managerId')&&!params.get('agentId')){
     const prepared=await snapshot<{partners:import('./partner-map-types').PartnerSummary[]}>(account,'partner/summary');
     if(prepared){const all=prepared.value.partners,q=normalize(params.get('q')||''),county=params.get('county')||'',city=normalize(params.get('city')||''),route=params.get('route')||'',position=params.get('position')||'',days=params.get('days')||'';
      const selected=all.filter(p=>(!q||normalize([p.id,p.name,p.cui,p.address,p.city,p.county].join(' ')).includes(q))&&(!county||p.county===county)&&(!city||normalize(p.city||'').includes(city))&&(!route||p.route===route)&&(!position||(position==='yes'?p.latitude!==null:p.latitude===null))&&(!days||(days==='never'?!p.lastVisitedAt:!!p.lastVisitedAt&&Date.now()-Date.parse(p.lastVisitedAt)>=Number(days)*86400000)));
      const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||100),inCounty=all.filter(p=>!county||p.county===county),unique=(items:string[])=>[...new Set(items.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ro'));
      window.dispatchEvent(new CustomEvent('mobiup-offline-snapshot',{detail:{path,at:prepared.at}}));
      return {partners:selected.slice(offset,offset+limit),total:selected.length,located:selected.filter(p=>p.latitude!==null).length,geocoded:selected.filter(p=>p.positionSource==='geocoding').length,nextOffset:offset+limit<selected.length?offset+limit:null,bounds:null,facets:{counties:unique(all.map(p=>p.county)),cities:unique(inCounty.map(p=>p.city)),routes:unique(inCounty.map(p=>p.route))},styleUrl:'https://tiles.openfreemap.org/styles/positron',observedAt:new Date(prepared.at).toISOString()} as T;
     }
    }
   }
  }
  throw e;
 }
}
export function startOfflineSync(){
 const sync=()=>{if(document.visibilityState!=='hidden')void replay(currentLocalWorkUserId(),(path,method,body,id)=>networkApi(path,method,body,undefined,id),currentLocalWorkUserId).catch(()=>{});};
 window.addEventListener('online',sync);document.addEventListener('visibilitychange',sync);const timer=setInterval(sync,4000);sync();
 return()=>{clearInterval(timer);window.removeEventListener('online',sync);document.removeEventListener('visibilitychange',sync);};
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
