'use client';
import {useEffect,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import {pendingOperations,removeOperation,OFFLINE_EVENT,saveSnapshot,saveWork,readWork,type PendingOperation} from '@/lib/offline-work';
import type {PartnerBrowse,PartnerSummary} from '@/lib/partner-map-types';
export function OfflineStatus({userId,agent}:{userId:string;agent:boolean}){
 const [rows,setRows]=useState<PendingOperation[]>([]),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{let alive=true;const update=()=>void pendingOperations(userId).then(r=>{if(alive)setRows(r);}).catch(e=>{if(alive)setNotice(errorMessage(e));});queueMicrotask(update);window.addEventListener(OFFLINE_EVENT,update);void readWork<string>(userId,'coverage','portfolio').then(v=>{if(alive&&v)setNotice(v);}).catch(()=>{});return()=>{alive=false;window.removeEventListener(OFFLINE_EVENT,update);};},[userId]);
 async function prepare(){setBusy(true);setNotice('Se pregătesc datele…');try{
   await api('bootstrap');const bootstrap=await api<{user:{warehouseId:string|null}}>('bootstrap');await api('clients?warehouseId='+encodeURIComponent(bootstrap.user.warehouseId||''));
   const date=new Date(),monday=new Date(date);monday.setDate(date.getDate()-((date.getDay()+6)%7));await api('partner/planning?week='+new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(monday));
   const partners:PartnerSummary[]=[];let offset:number|null=0,total=0;
   for(let page=0;page<25&&offset!==null;page++){const result:PartnerBrowse=await api<PartnerBrowse>('partner/browse?offset='+offset+'&limit=200');partners.push(...result.partners);total=result.total;offset=result.nextOffset;}
   await saveSnapshot(userId,'partner/summary',{partners});
   // Detail reads are bounded to the first route-sized group, never national history.
   for(const partner of partners.slice(0,100))await api('partner/portfolio/'+encodeURIComponent(partner.id));
   const message=`Pregătit ${new Date().toLocaleString('ro-RO')} · ${partners.length}/${total} puncte în catalog · ${Math.min(100,partners.length)} fișe · catalog și ciorne. Harta de fundal necesită conexiune.`;
   await saveWork(userId,'coverage','portfolio',message);setNotice(message);
 }catch(e){setNotice(errorMessage(e));}finally{setBusy(false);}}
 return <section className="panel" aria-label="Lucru pe telefon"><div className="panel-heading"><strong>Lucru pe telefon</strong>{agent&&<button className="secondary" disabled={busy} onClick={()=>void prepare()}>{busy?'Se pregătește…':'Pregătește pentru offline'}</button>}</div>{notice&&<p className="muted" aria-live="polite">{notice}</p>}{rows.length>0&&<details><summary>{rows.length} operațiuni locale · {rows.filter(r=>r.state==='blocked').length} necesită verificare</summary>{rows.map(row=><div key={row.id}><strong>{row.state==='blocked'?'Necesită verificare':'În așteptare'}</strong> · {row.path}<p>{row.error}</p>{row.state==='blocked'&&<button onClick={()=>{if(window.confirm('Scoți operațiunea din coadă? Copia locală rămâne disponibilă pentru recuperare.'))void removeOperation(row.id);}}>Scoate din coadă, păstrează copia locală</button>}</div>)}</details>}</section>;
}
