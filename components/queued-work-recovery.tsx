'use client';
import {useEffect,useState} from 'react';
import {networkApi,errorMessage} from '@/lib/client-api';
import {currentLocalWorkUserId} from '@/lib/local-work';
import {OFFLINE_EVENT,pendingOperations,retryBlockedOperation,resolveQueuedWork,type PendingOperation} from '@/lib/offline-work';

type RecoveryChoice={expectedWork?:unknown;remote:Record<string,unknown>;body:Record<string,unknown>;local:{scope:string;id:string;value:unknown}};
/** Shown only at the affected document, including queues from older clients. */
export function QueuedWorkRecovery({path,date,prepare,onResolved}:{path:string;date?:string;prepare?:(choice:'local'|'remote',remote:Record<string,unknown>)=>RecoveryChoice;onResolved?:(choice:'local'|'remote',remote:Record<string,unknown>)=>void}){
 const owner=currentLocalWorkUserId();
 const [rows,setRows]=useState<PendingOperation[]>([]),[remote,setRemote]=useState<Record<string,unknown>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let alive=true;const update=()=>{void pendingOperations(owner).then(all=>{if(alive&&currentLocalWorkUserId()===owner)setRows(all.filter(op=>op.path===path&&(!date||(op.body as {date?:string}).date===date)&&op.state==='blocked'));}).catch(e=>{if(alive)setError(errorMessage(e));});};update();window.addEventListener(OFFLINE_EVENT,update);return()=>{alive=false;window.removeEventListener(OFFLINE_EVENT,update);};},[owner,path,date]);
 if(!rows.length)return null;
 const transport=(p:string,method:string,body:unknown,id?:string)=>networkApi(p,method,body,undefined,id,owner);
 const verify=async()=>{setBusy(true);setError('');try{
  if(!prepare){for(const row of rows)await retryBlockedOperation(owner,row.id);return;}
  if(date){const day=new Date(date+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));const result=await transport('partner/planning?week='+day.toISOString().slice(0,10),'GET',undefined) as {plans:Record<string,unknown>[]};setRemote(result.plans.find(p=>p.date===date)??{date,stops:[],revision:0});}
  else{const result=await transport(path,'GET',undefined) as {partner:Record<string,unknown>};if(result.partner.canEdit!==true)throw new Error('Acces retras. Copia locală este păstrată, fără retrimitere.');setRemote(result.partner);}
 }catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 const choose=async(choice:'local'|'remote')=>{if(!remote||!prepare)return;setBusy(true);setError('');try{const next=prepare(choice,remote);await resolveQueuedWork({expectedWork:next.expectedWork,userId:owner,path,method:date?'PUT':'PATCH',remote,body:choice==='local'?next.body:null,local:next.local,transport,active:currentLocalWorkUserId});onResolved?.(choice,remote);setRemote(null);}catch(e){setError(errorMessage(e));setRemote(null);}finally{setBusy(false);}};
 return <aside className="recovery-banner" aria-label="Recuperare locală"><strong>Modificări locale de verificat</strong><p>{rows[0].error||'Operațiunea anterioară nu a fost confirmată.'}</p><p>Copia locală este păstrată. Accesul curent și versiunea serverului sunt verificate înainte de retrimitere.</p>{error&&<p role="alert">{error}</p>}{remote?<><p>Server: {date?JSON.stringify(remote.stops):[remote.contact,remote.phone,remote.email,remote.latitude,remote.longitude].filter((v):v is string|number=>typeof v==='string'||typeof v==='number').join(' · ')||'Fără date de contact'}</p><button disabled={busy} onClick={()=>void choose('remote')}>Folosește versiunea serverului</button><button disabled={busy} onClick={()=>void choose('local')}>Păstrează modificările mele</button></>:<button disabled={busy} onClick={()=>void verify()}>{prepare?'Compară cu serverul':'Reverifică operațiunea'}</button>}</aside>;
}
