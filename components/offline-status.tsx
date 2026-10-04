'use client';
import {useEffect,useRef,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import {currentLocalWorkGeneration,currentLocalWorkUserId,LOCAL_WORK_USER_EVENT} from '@/lib/local-work';
import {pendingOperations,removeOperation,OFFLINE_EVENT,readCoverageManifest,saveCoverageManifest,saveFragmentedSnapshot,type CoverageManifest,type PendingOperation} from '@/lib/offline-work';
import {preparePartnerPages} from '@/lib/prepare-partner-pages';
import type {PartnerBrowse} from '@/lib/partner-map-types';
import {prepareOfflineShell} from './pwa';
export function OfflineStatus({userId,agent}:{userId:string;agent:boolean}){
 const [rows,setRows]=useState<PendingOperation[]>([]),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const preparing=useRef(false),active=useRef<AbortController|null>(null);
 useEffect(()=>{
  let alive=true,checking=false;
  const update=()=>{if(checking)return;checking=true;void Promise.all([pendingOperations(userId),readCoverageManifest(userId)]).then(([operations,manifest])=>{
   if(!alive)return;setRows(operations);
   if(preparing.current||!manifest)return;
   setNotice(manifest.valid?`Date locale pregătite ${new Date(manifest.preparedAt).toLocaleString('ro-RO')} · ${manifest.partners.saved}/${manifest.partners.total} puncte · ${manifest.details} fișe. Disponibilitatea interfeței offline se verifică la pregătire.`:`Pregătirea offline nu mai este completă: lipsesc ${manifest.missing.length} seturi de date. Pregătește din nou.`);
  }).catch(e=>{if(alive&&!preparing.current)setNotice(errorMessage(e));}).finally(()=>{checking=false;});};
  const accountChanged=()=>active.current?.abort();
  queueMicrotask(update);window.addEventListener(OFFLINE_EVENT,update);window.addEventListener(LOCAL_WORK_USER_EVENT,accountChanged);
  return()=>{alive=false;active.current?.abort();window.removeEventListener(OFFLINE_EVENT,update);window.removeEventListener(LOCAL_WORK_USER_EVENT,accountChanged);};
 },[userId]);
 async function prepare(){
  if(preparing.current)return;
  const controller=new AbortController(),generation=currentLocalWorkGeneration();active.current=controller;preparing.current=true;setBusy(true);setNotice('Se pregătesc datele și interfața…');
  const guard=()=>{if(controller.signal.aborted||currentLocalWorkUserId()!==userId||currentLocalWorkGeneration()!==generation)throw new Error('Pregătirea a fost oprită deoarece contul sau pagina s-a schimbat.');};
  const read=async<T,>(path:string)=>{guard();const result=await api<T>(path,'GET',undefined,controller.signal,{forceRefresh:true});guard();return result;};
  // Handle rejection immediately while the account-bound data reads continue.
  const shell=prepareOfflineShell().then(()=>'',e=>errorMessage(e));
  try{
   guard();const paths:string[]=[];
   const bootstrap=await read<{user:{id:string;warehouseId:string|null}}>('bootstrap');if(bootstrap.user.id!==userId)throw new Error('Contul s-a schimbat.');paths.push('bootstrap');
   const clientsPath='clients?warehouseId='+encodeURIComponent(bootstrap.user.warehouseId||'');await read(clientsPath);paths.push(clientsPath);
   const monday=new Date();monday.setDate(monday.getDate()-((monday.getDay()+6)%7));
   const planningPath='partner/planning?week='+new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(monday);
   const weekPlans=await read<{plans:{stops:string[]}[]}>(planningPath);paths.push(planningPath);
   const {partners,total}=await preparePartnerPages(path=>read<PartnerBrowse>(path));
   guard();await saveFragmentedSnapshot(userId,'partner/summary','partners',partners);guard();paths.push('partner/summary');
   const priority=[...new Set(weekPlans.plans.flatMap(plan=>plan.stops))];const details=[...new Set([...priority,...partners.slice(0,100).map(p=>p.id)])].slice(0,500);
   for(const id of details){const path='partner/portfolio/'+encodeURIComponent(id);await read(path);paths.push(path);}
   if(bootstrap.user.warehouseId){const path='stock?warehouseId='+encodeURIComponent(bootstrap.user.warehouseId);await read(path);paths.push(path);}
   const manifest:CoverageManifest={version:1,preparedAt:Date.now(),paths,valid:true,missing:[],dataOnly:true,partners:{saved:partners.length,total,limited:partners.length<total},details:details.length,shellRequested:true};
   guard();await saveCoverageManifest(userId,manifest);guard();
   const checked=await readCoverageManifest(userId);guard();
   if(!checked?.valid)throw new Error(`Pregătirea nu încape integral în spațiul offline: lipsesc ${checked?.missing.length||1} seturi de date.`);
   const shellError=await shell;guard();
   setNotice(`Date locale pregătite ${new Date(checked.preparedAt).toLocaleString('ro-RO')} · ${partners.length}/${total} puncte${partners.length<total?' (acoperire limitată)':''} · ${details.length} fișe. ${shellError?'Interfața offline NU este confirmată: '+shellError:'Interfața offline este pregătită.'} Harta de fundal poate necesita conexiune.`);
  }catch(e){if(!controller.signal.aborted)setNotice(errorMessage(e));}finally{preparing.current=false;if(active.current===controller){active.current=null;if(!controller.signal.aborted)setBusy(false);}}
 }
 return <section className="panel" aria-label="Lucru pe telefon"><div className="panel-heading"><strong>Lucru pe telefon</strong>{agent&&<button className="secondary" disabled={busy} onClick={()=>void prepare()}>{busy?'Se pregătește…':'Pregătește pentru offline'}</button>}</div>{notice&&<p className="muted" aria-live="polite">{notice}</p>}{rows.length>0&&<details><summary>{rows.length} operațiuni locale · {rows.filter(r=>r.state==='blocked').length} necesită verificare</summary>{rows.map(row=><div key={row.id}><strong>{row.state==='blocked'?'Necesită verificare':'În așteptare'}</strong> · {row.path}<p>{row.error}</p>{row.state==='blocked'&&<button onClick={()=>{if(window.confirm('Scoți operațiunea din coadă? Copia locală rămâne disponibilă pentru recuperare.'))void removeOperation(row.id);}}>Scoate din coadă, păstrează copia locală</button>}</div>)}</details>}</section>;
}
