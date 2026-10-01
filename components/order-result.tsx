'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Download, Mail, Copy, FileSpreadsheet, LoaderCircle } from 'lucide-react';
import { api, errorMessage, kindLabels, money, dateLabel } from '@/lib/client-api';
import type { Order, Mail as MailData } from '@/lib/types';
type PreparedResult = {key:string;mail:MailData|null;file:File|null;url:string;error:string;canShareFile:boolean};
const emptyResult:PreparedResult={key:'',mail:null,file:null,url:'',error:'',canShareFile:false};
export function OrderResult({order,onClose,onCopy,autoDownload=false,canCopy=false}:{order:Order;onClose:()=>void;onCopy:(o:Order)=>void;autoDownload?:boolean;canCopy?:boolean}) {
  const draft=order.status==='draft';
  const emailOnly=order.kind==='stand_client';
  const resourceKey=JSON.stringify([order.id,autoDownload,emailOnly,draft]);
  const [prepared,setPrepared]=useState<PreparedResult>(()=>({...emptyResult,key:resourceKey})),[shareUnavailable,setShareUnavailable]=useState(false);
  if(prepared.key!==resourceKey){setPrepared({...emptyResult,key:resourceKey});setShareUnavailable(false);}
  const {mail,file,url,error,canShareFile}=prepared.key===resourceKey?prepared:emptyResult;
  useEffect(()=>{
    if(draft)return;
    let cancelled=false,objectUrl='';
    const controller=new AbortController();
    async function load() {
      try {
        // History consultation needs only mail metadata. Native sharing needs a
        // prepared File before its click to retain transient user activation.
        const needsFile=!emailOnly&&(autoDownload||(!!navigator.share&&!!navigator.canShare));
        const mailRequest=api<{mail:MailData}>(`orders/${order.id}/mail`,'GET',undefined,controller.signal).then(({mail})=>{
          if(!cancelled)setPrepared(previous=>({...previous,mail}));
          return mail;
        });
        const fileRequest=needsFile?fetch(`/api/orders/${order.id}/excel`,{signal:controller.signal}).then(async res=>{
          if(!res.ok)throw new Error('Excelul nu a putut fi încărcat. Încearcă din nou din istoric.');
          return res.blob();
        }):Promise.resolve(null);
        const [mail,blob]=await Promise.all([mailRequest,fileRequest]);
        if(cancelled||!blob)return;
        const f=new File([blob],mail.filename,{type:blob.type});
        if(cancelled) return;
        let canShareFile=false;
        try {canShareFile=!!navigator.share&&!!navigator.canShare?.({files:[f]});}catch{}
        objectUrl=URL.createObjectURL(f);
        setPrepared(previous=>({...previous,file:f,url:objectUrl,canShareFile}));
        if(autoDownload) {const a=document.createElement('a');a.href=objectUrl;a.download=f.name;a.click();}
      } catch(err) { if(!cancelled)setPrepared(previous=>({...previous,error:errorMessage(err)})); }
    }
    void load();return()=>{cancelled=true;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[order.id,autoDownload,emailOnly,draft,resourceKey]);
  async function share() {
    if(!file||!mail) return;
    if(!canShareFile) { window.location.href=mail.mailto; return; }
    try {
      await navigator.share({files:[file],title:mail.subject,text:mail.body});
    } catch(err) { if(!(err instanceof Error&&err.name==='AbortError')) {setPrepared(previous=>({...previous,canShareFile:false}));setShareUnavailable(true);} }
  }
  return <div className="result-page"><button className="quiet back-link" onClick={onClose}><ArrowLeft size={19}/> Înapoi la comenzi</button><div className="result-layout"><section className="result-card">
    <span className="success-mark"><Check size={30}/></span><span className="eyebrow">{order.number}</span><h1>{draft?'Ciornă · doar consultare':(order.kind==='sim'||order.kind==='stand_client')?'Avizul este pregătit':'Comanda este finalizată'}</h1><p>{draft?'Poți consulta această comandă. Modificarea este disponibilă în aria ta de lucru.':'Salvată în istoric. Pregătește mesajul pentru departamentul de comenzi.'}</p>
    <div className="result-meta"><div><small>GESTIUNE</small><strong>{order.warehouseName}</strong></div><div><small>AGENT</small><strong>{order.agentName}</strong></div><div><small>DATA</small><strong>{dateLabel(order.finalizedAt||order.createdAt)}</strong></div><div><small>{order.kind==='sim'?'SIM-URI SCANATE':order.kind==='combined'?'BUCĂȚI COMANDATE':'BUCĂȚI COMANDATE'}</small><strong>{order.pieces}</strong></div></div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {!draft&&<><div className="result-buttons"><button className="primary" disabled={!mail} onClick={()=>{if(mail)window.location.href=mail.mailto;}}>{mail?<Mail size={19}/>:<LoaderCircle size={19} className="spin"/>} Deschide e-mailul</button>{!emailOnly&&<a className="secondary" href={url||`/api/orders/${order.id}/excel`} download={file?.name||true}><Download size={18}/> Descarcă Excel</a>}</div>
    {emailOnly?<p className="muted">Detaliile avizului sunt în corpul e-mailului. Nu este necesar niciun atașament.</p>:file&&!canShareFile?<div className="share-help" role={shareUnavailable?'status':undefined}><strong>{shareUnavailable?'Folosește atașarea din e-mail':'Trimite comanda în 2 pași'}</strong>Descarcă Excelul, apoi deschide e-mailul pregătit și atașează fișierul din „Descărcări”. Browserul nu permite întotdeauna atașarea directă a fișierelor Excel.</div>:<p className="muted">„Deschide e-mailul” completează To și CC; atașează Excelul descărcat. „Distribuie Excelul” transferă fișierul, dar destinatarii trebuie completați în aplicația aleasă.</p>}
    {mail&&!mail.to&&<p className="notice">Destinatarul nu este încă setat. Îl poți completa în e-mail; managerul îl poate salva în Setări.</p>}
    {file&&canShareFile&&<button className="secondary" onClick={()=>void share()}><FileSpreadsheet size={18}/> Distribuie Excelul</button>}
    <div className="alternative-actions">{mail&&<a href={mail.mailto}>E-mail cu subiect și text <ArrowLeft className="rotate-180" size={14}/></a>}<a href={`/api/orders/${order.id}/eml`} download>{emailOnly?'Descarcă mesaj .eml':'Descarcă mesaj .eml cu atașament'}</a></div>
    </>}<button className="secondary" disabled={!canCopy} onClick={()=>onCopy(order)}><Copy size={17}/> Copiază pentru o comandă nouă</button>
  </section><section className="document-preview"><div className="document-title"><FileSpreadsheet size={21}/><h2>{kindLabels[order.kind]}</h2><span className={"badge "+order.status}>{draft?'Ciornă':'Finalizată'}</span></div>
    {order.client&&<div className="client-summary"><strong>{order.client.name}</strong><span>CUI {order.client.cui}</span><span>{order.client.city}, {order.client.county}</span><span>{order.client.address}</span></div>}
    {order.kind==='sim'?<><p className="muted">sim 0 vodafone · {order.serials.length} buc.</p><ol className="serial-list result-serials">{order.serials.map(s=><li key={s}><code>{s}</code><Check size={15}/></li>)}</ol></>:order.kind==='combined'?<div>{order.items.length>0&&<div className="combined-result-section"><h3>Accesorii</h3><div className="summary-lines">{order.items.map(l=><div key={l.id}><span><strong>{l.name}</strong><small>{l.code}</small></span><b>{l.quantity} buc.</b></div>)}</div></div>}{(order.standItems||[]).length>0&&<div className="combined-result-section"><h3>Cartele, telefoane & standuri</h3><div className="summary-lines">{(order.standItems||[]).map(l=><div key={l.id}><span><strong>{l.name}</strong><small>{l.code}</small></span><b>{l.quantity} buc.</b></div>)}</div></div>}{order.serials.length>0&&<div className="combined-result-section"><h3>SIM 0 Vodafone · {order.serials.length} buc.</h3><ol className="serial-list result-serials">{order.serials.map(s=><li key={s}><code>{s}</code><Check size={15}/></li>)}</ol></div>}</div>:<div className="summary-lines">{order.items.map(l=><div key={l.id}><span><strong>{l.name}</strong><small>{l.code}</small></span><b>{l.quantity} buc.</b></div>)}</div>}
    {order.kind==='accessories'&&order.items.length>0&&<div className="summary-total"><span>Total accesorii cu TVA</span><strong>{money(order.total)}</strong></div>}{order.notes&&<p className="notice">{order.notes}</p>}
    {mail&&<details className="email-preview"><summary>Vezi mesajul de e-mail</summary><p><b>Către:</b> {mail.to||'De completat'}</p>{mail.cc.length>0&&<p><b>CC:</b> {mail.cc.join(', ')}</p>}<p><b>Subiect:</b> {mail.subject}</p><pre>{mail.body}</pre></details>}
  </section></div></div>;
}
