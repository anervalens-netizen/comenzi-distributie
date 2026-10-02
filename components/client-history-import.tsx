'use client';
import {useEffect,useRef,useState} from 'react';
import {Upload,FileSpreadsheet,LoaderCircle,Check,AlertTriangle} from 'lucide-react';
import {errorMessage} from '@/lib/client-api';
import type {HistoryJob,HistoryImportStatus} from '@/lib/client-history-import-types';
const endpoint='/api/client-sales/import';
const date=(value:string)=>new Date(value+'T12:00:00').toLocaleDateString('ro-RO');
const money=(cents:number)=>new Intl.NumberFormat('ro-RO',{style:'currency',currency:'RON'}).format(cents/100);
async function request<T>(url:string,options?:RequestInit):Promise<T>{
 const response=await fetch(url,{credentials:'same-origin',...options});
 const data=await response.json() as {error?:string;message?:string};if(!response.ok)throw new Error(data.error||data.message||'Importul nu a putut fi verificat.');return data as T;
}
export function ClientHistoryImport(){
 const [job,setJob]=useState<HistoryJob|null>(null),[latest,setLatest]=useState<HistoryImportStatus['latest']>(null),[error,setError]=useState(''),[sending,setSending]=useState(false),[ack,setAck]=useState(false),[loaded,setLoaded]=useState(false);
 const alive=useRef(true),announced=useRef('');
 useEffect(()=>{alive.current=true;void request<HistoryImportStatus>(endpoint+'/status').then(data=>{if(alive.current){setJob(data.job);setLatest(data.latest);setLoaded(true);}}).catch(e=>{if(alive.current){setError(errorMessage(e));setLoaded(true);}});return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  if(job?.state!=='running')return;
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const data=await request<{job:HistoryJob}>(endpoint+'/status?job='+job.id);if(!stopped){setJob(data.job);setError('');if(data.job.state==='running')timer=setTimeout(poll,1500);}}catch{if(!stopped){setError('Conexiunea a fost întreruptă. Procesarea continuă pe server; verific din nou…');timer=setTimeout(poll,4000);}}};
  timer=setTimeout(poll,800);return()=>{stopped=true;clearTimeout(timer);};
 },[job?.id,job?.state]);
 useEffect(()=>{if(job?.state==='completed'&&announced.current!==job.id){announced.current=job.id;window.dispatchEvent(new Event('client-sales-imported'));void request<HistoryImportStatus>(endpoint+'/status').then(data=>{if(alive.current)setLatest(data.latest);}).catch(()=>{});}},[job]);
 async function choose(file?:File){
  if(!file)return;setError('');setAck(false);setSending(true);
  try{if(!/\.xlsx$/i.test(file.name))throw new Error('Alege un fișier .xlsx.');if(file.size>32*1024*1024)throw new Error('Fișierul poate avea maximum 32 MB.');
   const data=await request<{job:HistoryJob}>(endpoint+'/preview',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Client-Sales-Filename':encodeURIComponent(file.name)},body:file});
   if(alive.current)setJob(data.job);
  }catch(e){if(alive.current)setError(errorMessage(e));}finally{if(alive.current)setSending(false);}
 }
 async function confirm(){
  if(!job)return;setSending(true);setError('');
  try{const data=await request<{job:HistoryJob}>(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:job.id,allowRegression:ack})});if(alive.current)setJob(data.job);}
  catch(e){if(alive.current)setError(errorMessage(e));}finally{if(alive.current)setSending(false);}
 }
 const busy=sending||job?.state==='running',preview=job?.state==='ready'?job.preview:null;
 return <section className="panel sales-import" aria-label="Import vânzări pe clienți">
  <div className="panel-heading"><div><h2><Upload size={18}/> Vânzări pe clienți</h2><p>Încarcă raportul cumulativ de la începutul lunii. Zilele deja încărcate se actualizează fără dublare.</p></div></div>
  <p className="import-last-status">{!loaded?'Se verifică ultimul import…':latest?`Ultimul import: ${latest.filename} · ${date(latest.from)} – ${date(latest.through)} · ${latest.rows.toLocaleString('ro-RO')} rânduri · ${new Date(latest.importedAt).toLocaleString('ro-RO')}`:'Nu există încă un import verificat.'}</p>
  <div className="sales-import-controls"><label className="sales-upload"><FileSpreadsheet size={19}/><span>{sending?'Se încarcă…':'Alege raportul pe clienți (.xlsx)'}</span><input aria-label="Fișier vânzări pe clienți" disabled={!!busy} type="file" accept=".xlsx" onChange={event=>{void choose(event.target.files?.[0]);event.target.value='';}}/></label></div>
  {busy&&<output className="notice"><LoaderCircle className="spin" size={17}/>{sending?'Se transmite fișierul…':job?.message} Poți reveni aici pentru progres.</output>}
  {error&&<p className="error-banner" role="alert">{error}</p>}
  {job?.state==='failed'&&<p className="error-banner" role="alert">{job.error}{job.result?' Datele au fost aplicate; reîncarcă același fișier pentru a relua centralizarea.':''}</p>}
  {job?.state==='completed'&&<output className="notice"><Check size={17}/>{job.message} {job.result?.rows.toLocaleString('ro-RO')} rânduri · {money(job.result?.valueCents||0)}.</output>}
  {preview&&<div className="sales-preview">
   <div className="sales-preview-summary"><strong>{preview.rows.toLocaleString('ro-RO')} rânduri</strong><span>{money(preview.valueCents)}</span><span>{(preview.quantityMicros/1000000).toLocaleString('ro-RO')} buc.</span><span>{date(preview.from)} – {date(preview.through)}</span></div>
   <p>{job?.filename}. {preview.alreadyImported?'Acest fișier este deja importat. Îl poți verifica din nou fără să dublezi datele.':`În această lună: ${preview.previous.rows.toLocaleString('ro-RO')} → ${preview.rows.toLocaleString('ro-RO')} rânduri; ${money(preview.previous.valueCents)} → ${money(preview.valueCents)}.`}</p>
   {preview.inferredPeriod&&<p className="muted">Perioada este identificată din vânzări. Confirmă că raportul conține toate datele de la începutul lunii.</p>}
   {preview.missingValues>0&&<p className="notice">{preview.missingValues} rânduri au valoarea necompletată. Sunt păstrate și semnalate separat în istoric.</p>}
   {preview.requiresAcknowledgement&&!preview.alreadyImported&&<div className="sales-warning compact"><AlertTriangle size={18}/><div><strong>Fișierul corectează date deja importate.</strong><p>{preview.removedOccurrences.toLocaleString('ro-RO')} rânduri existente sunt eliminate sau modificate.{preview.coverageShorter?' Perioada este mai scurtă decât cea încărcată anterior.':''}</p><label className="sales-regression-check"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/><span>Confirm înlocuirea lunii cu acest raport corectat.</span></label></div></div>}
   <div className="sales-preview-actions"><span>Se actualizează istoricul pe clienți și centralizările aferente.</span><button className="primary" disabled={!!busy||(!preview.alreadyImported&&preview.requiresAcknowledgement&&!ack)} onClick={()=>void confirm()}><Upload size={17}/>{preview.alreadyImported?'Verifică centralizările':'Confirmă importul pe clienți'}</button></div>
  </div>}
 </section>;
}
