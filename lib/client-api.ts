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

export async function api<T=Record<string,unknown>>(path: string,method='GET',body?: unknown, signal?: AbortSignal): Promise<T> {
  const options:RequestInit={method,credentials:'same-origin',signal};
  if(body && method!=='GET' && method!=='HEAD'){options.headers={'Content-Type':'application/json'};options.body=JSON.stringify(body);}
  const res=await fetch('/api/'+path,options);
  let data:unknown;
  try { data=await res.json(); }
  catch { data=null; }
  if(!res.ok) {
    const message=data && typeof data==='object' && 'error' in data && typeof (data as {error?:unknown}).error==='string'
      ? (data as {error:string}).error
      : 'Operațiunea nu a reușit.';
    if(res.status===401&&path.split('/').at(-1)!=='login'&&typeof window!=='undefined')window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(res.status,message,data);
  }
  if(path==='bootstrap'&&data&&typeof data==='object'&&'user' in data) {
    const user=(data as {user?:unknown}).user;
    setLocalWorkUserId(user&&typeof user==='object'&&'id' in user&&typeof (user as {id?:unknown}).id==='string'?(user as {id:string}).id:'');
  } else if(path==='auth/logout'&&method==='POST') {
    setLocalWorkUserId('');
  } else if(method==='DELETE'&&/^orders\/[^/]+$/.test(path)) {
    const userId=currentLocalWorkUserId();
    const orderId=path.slice('orders/'.length);
    if(userId&&orderId)removeLocalWork('order',userId,orderId);
  }
  return data as T;
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
