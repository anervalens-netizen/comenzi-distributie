'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, Mail, Plus, RefreshCw, Store } from 'lucide-react';
import { api, ApiError, dateLabel, errorMessage } from '@/lib/client-api';
import { partnerPointKey } from '@/lib/partner-identity';
import { readLocalWork, removeLocalWork, writeLocalWork } from '@/lib/local-work';
import type { PartnerLocation, PartnerMail, PartnerRequest, PartnerRequestRecord } from '@/lib/types';

type PartnerResult = { partner: PartnerRequest; request: PartnerRequestRecord; mail: PartnerMail; eml: string };
const monthFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'});
const currentMonth=()=>monthFormatter.format(new Date());
const pointKey=(city:string,county:string,address:string)=>partnerPointKey(city,county,address);
const formValues=(form:HTMLFormElement)=>Object.fromEntries([...new FormData(form)].map(([key,val])=>[key,typeof val==='string'?val:'']));
const sameSubmission=(left:Record<string,string>,right:Record<string,string>)=>{const keys=new Set([...Object.keys(left),...Object.keys(right)]);for(const key of keys)if(key!=='revision'&&(left[key]||'')!==(right[key]||''))return false;return true;};

export function PartnerNew({userId}:{userId:string}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<PartnerResult|null>(null);
  const [draft]=useState(()=>readLocalWork<Record<string,string>>('partner',userId,'new'));
  const initialDraft=draft.value||{};
  const [requestId,setRequestId]=useState(()=>initialDraft.requestId||crypto.randomUUID());
  const [requestRevision,setRequestRevision]=useState(()=>Number(initialDraft.revision)||0);
  const [initialValues,setInitialValues]=useState<Record<string,string>>(()=>({...initialDraft,storeType:initialDraft.storeType||'MAGAZIN'}));
  const [formEpoch,setFormEpoch]=useState(0),[storageError,setStorageError]=useState(draft.error);
  const [cui,setCui]=useState(initialDraft.cui||''),[location,setLocation]=useState(initialDraft.location||''),[county,setCounty]=useState(initialDraft.county||''),[address,setAddress]=useState(initialDraft.address||'');
  const [lookup,setLookup]=useState<PartnerLocation[]>([]),[lookupBusy,setLookupBusy]=useState(false),[lookupError,setLookupError]=useState('');
  const [month,setMonth]=useState(currentMonth),[history,setHistory]=useState<PartnerRequestRecord[]>([]),[historyBusy,setHistoryBusy]=useState(true),[historyError,setHistoryError]=useState(''),[historyReload,setHistoryReload]=useState(0);
  const [conflictRequest,setConflictRequest]=useState<PartnerRequestRecord|null>(null);
  const formRef=useRef<HTMLFormElement>(null);
  const value=(key:string,fallback='')=>initialValues[key]??fallback;

  useEffect(()=>{let cancelled=false;void api<{requests:PartnerRequestRecord[]}>(`partner/requests?month=${encodeURIComponent(month)}`).then(r=>{if(!cancelled){setHistory(r.requests);setHistoryError('');}}).catch(e=>{if(!cancelled)setHistoryError(errorMessage(e));}).finally(()=>{if(!cancelled)setHistoryBusy(false);});return()=>{cancelled=true;};},[month,historyReload]);
  useEffect(()=>{const raw=cui.trim();if(raw.length<3)return;const controller=new AbortController();const timer=window.setTimeout(()=>{setLookupBusy(true);setLookupError('');void api<{locations:PartnerLocation[]}>(`partner/lookup?cui=${encodeURIComponent(raw)}`).then(r=>{if(!controller.signal.aborted)setLookup(r.locations);}).catch(e=>{if(!controller.signal.aborted)setLookupError(errorMessage(e));}).finally(()=>{if(!controller.signal.aborted)setLookupBusy(false);});},350);return()=>{controller.abort();window.clearTimeout(timer);};},[cui]);

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return;setBusy(true);setError('');setConflictRequest(null);setResult(null);
    const submittedForm=event.currentTarget,body=formValues(submittedForm);
    const sameRequest=()=>formRef.current===submittedForm&&formValues(submittedForm).requestId===body.requestId;
    try {
      const response=await api<PartnerResult>('partner/mail','POST',body);
      if(!sameRequest())return;
      const current=formValues(submittedForm),unchanged=sameSubmission(current,body);
      setRequestId(response.request.id);setRequestRevision(response.request.revision);setHistoryBusy(true);setHistoryReload(n=>n+1);
      if(unchanged){
        const local=readLocalWork<Record<string,string>>('partner',userId,'new');
        if(local.value&&sameSubmission(local.value,body))setStorageError(removeLocalWork('partner',userId,'new'));
        setResult(response);
      } else {
        const rebased={...current,requestId:response.request.id,revision:String(response.request.revision)};
        setStorageError(writeLocalWork('partner',userId,'new',rebased));
      }
    }
    catch(err){
      if(sameRequest()){
        setError(errorMessage(err));
        if(err instanceof ApiError&&err.status===409){
          try {
            const conflictId=body.requestId||'';
            const fresh=await api<{request:PartnerRequestRecord}>(`partner/requests/${encodeURIComponent(conflictId)}`);
            if(!sameRequest()||fresh.request.id!==conflictId)return;
            setConflictRequest(fresh.request);setError('Cererea s-a modificat în altă fereastră. Alege mai jos cum continui.');
            if(month===fresh.request.createdAt.slice(0,7))setHistory(items=>items.map(item=>item.id===fresh.request.id?fresh.request:item));
          } catch {/* keep the original conflict visible */}
        }
      }
    } finally {if(formRef.current===submittedForm)setBusy(false);}
  }
  function persistDraft(form:HTMLFormElement){const body=formValues(form);if(result)setResult(null);setStorageError(writeLocalWork('partner',userId,'new',body));}
  function conflictMatchesCurrent(){return !!conflictRequest&&!!formRef.current&&formValues(formRef.current).requestId===conflictRequest.id;}
  function keepLocalAfterConflict(){if(!conflictRequest||conflictRequest.status!=='requested'||!conflictMatchesCurrent()){setConflictRequest(null);return;}const rebased={...formValues(formRef.current!),requestId:conflictRequest.id,revision:String(conflictRequest.revision)};setRequestRevision(conflictRequest.revision);setStorageError(writeLocalWork('partner',userId,'new',rebased));setConflictRequest(null);setError('');}
  function loadServerAfterConflict(){if(!conflictRequest||!conflictMatchesCurrent()){setConflictRequest(null);return;}if(!window.confirm('Încarci versiunea salvată pe server? Modificările locale nesalvate vor fi înlocuite.'))return;const next={company:conflictRequest.company,location:conflictRequest.location,cui:conflictRequest.cui,storeType:conflictRequest.storeType,contact:conflictRequest.contact,phone:conflictRequest.phone,email:conflictRequest.email,address:conflictRequest.address,county:conflictRequest.county,requestId:conflictRequest.id,revision:String(conflictRequest.revision)};setRequestRevision(conflictRequest.revision);setInitialValues(next);setCui(conflictRequest.cui);setLocation(conflictRequest.location);setCounty(conflictRequest.county);setAddress(conflictRequest.address);setLookup([]);setStorageError(removeLocalWork('partner',userId,'new'));setFormEpoch(value=>value+1);setResult(null);setConflictRequest(null);setError('');}
  function newRequest(){if(!result&&formRef.current){const values=formValues(formRef.current);const hasUnsaved=Object.entries(values).some(([key,value])=>!['requestId','revision','storeType'].includes(key)&&value.trim());if(hasUnsaved&&!window.confirm('Pornești o cerere nouă? Datele nesalvate din formularul curent vor fi șterse.'))return;}const id=crypto.randomUUID();setBusy(false);setStorageError(removeLocalWork('partner',userId,'new'));setRequestId(id);setRequestRevision(0);setInitialValues({storeType:'MAGAZIN',requestId:id});setCui('');setLocation('');setCounty('');setAddress('');setLookup([]);setFormEpoch(value=>value+1);setResult(null);setConflictRequest(null);setError('');requestAnimationFrame(()=>requestAnimationFrame(()=>{formRef.current?.scrollIntoView({behavior:'smooth',block:'start'});formRef.current?.querySelector<HTMLInputElement>('input[name="company"]')?.focus();}));}
  function downloadEml(){if(!result)return;const blob=new Blob([result.eml],{type:'message/rfc822;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=result.mail.emlFilename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  const samePoint=lookup.find(item=>pointKey(item.city,item.county,item.address)===pointKey(location,county,address)&&!!address.trim()&&!!location.trim()&&!!county.trim());

  return <div className="partner-page">
    <div className="page-heading"><div><span className="eyebrow">CLIENȚI NOI</span><h1>Partener nou</h1><p>Completează datele partenerului și generează mesajul către Distribuție și Depozit.</p></div><button type="button" className="secondary" onClick={newRequest}><Plus size={18}/> Cerere nouă</button></div>
    <form key={formEpoch} ref={formRef} className="panel partner-form" onInput={e=>persistDraft(e.currentTarget)} onSubmit={e=>void submit(e)}>
      <input type="hidden" name="requestId" value={requestId}/><input type="hidden" name="revision" value={requestRevision||""}/>
      <div className="section-heading"><Store size={22}/><div><h2>Date partener</h2><p>Cererea se salvează automat în evidența ta când generezi e-mailul.</p></div></div>
      <div className="partner-grid">
        <label>Firma<input name="company" defaultValue={value('company')} required maxLength={200} placeholder="SC EXEMPLU SRL"/></label>
        <label>Locația<input name="location" defaultValue={value('location')} required maxLength={100} placeholder="Zărnești" onChange={e=>setLocation(e.target.value)}/></label>
        <label>CUI / CIF<input name="cui" defaultValue={value('cui')} required maxLength={40} autoCapitalize="characters" placeholder="RO12345678" onChange={e=>{const next=e.target.value;setCui(next);setLookup([]);setLookupError('');setLookupBusy(next.trim().length>=3);}}/></label>
        <label>Tip magazin<input name="storeType" required maxLength={80} defaultValue={value('storeType','MAGAZIN')}/></label>
        <label>Persoana de contact<input name="contact" defaultValue={value('contact')} required maxLength={120} placeholder="Nume Prenume"/></label>
        <label>Nr. telefon<input name="phone" defaultValue={value('phone')} required maxLength={40} inputMode="tel" placeholder="07xxxxxxxx"/></label>
        <label>Adresa e-mail <span className="optional">opțional</span><input name="email" defaultValue={value('email')} type="email" maxLength={254} placeholder="contact@example.invalid"/></label>
        <label>Județ<input name="county" defaultValue={value('county')} required maxLength={100} placeholder="Brașov" onChange={e=>setCounty(e.target.value)}/></label>
        <label className="partner-wide">Adresa magazin<input name="address" defaultValue={value('address')} required maxLength={500} placeholder="Stradă, număr, localitate" onChange={e=>setAddress(e.target.value)}/></label>
      </div>
      {cui.trim().length>=3&&<div className={'partner-lookup '+(lookup.length?'existing':'new')} aria-live="polite">{lookupBusy?<span>Se verifică CUI/CIF în baza completă…</span>:lookupError?<span>{lookupError}</span>:lookup.length?<><strong>{samePoint?'Acest punct de lucru există deja.':'Firma există deja. Se solicită un punct de lucru nou.'}</strong><span>{samePoint?'La confirmare va fi asociat agentului, fără duplicare.':`${lookup.length} punct${lookup.length===1?'':'e'} de lucru existente în bază:`}</span>{!samePoint&&<div>{lookup.slice(0,6).map(item=><span key={item.id}>{item.city} · {item.county||'județ lipsă'} · {item.address}</span>)}</div>}</>:<strong>CUI/CIF nou în baza de date.</strong>}</div>}
      {(error||storageError)&&<p className="error-banner" role="alert">{error||storageError}</p>}
      {conflictRequest&&<div className="recovery-banner partner-conflict" role="alert"><div><strong>Cererea are o versiune mai nouă pe server.</strong><p>{conflictRequest.status==='confirmed'?'Cererea a fost deja confirmată. Încarcă versiunea serverului sau pornește o cerere nouă.':'Alege explicit dacă păstrezi editările locale peste ultima revizie sau încarci versiunea serverului.'}</p></div><div className="recovery-actions">{conflictRequest.status==='requested'&&<button type="button" className="primary" onClick={keepLocalAfterConflict}>Păstrează modificările mele</button>}<button type="button" className="secondary" onClick={loadServerAfterConflict}>Încarcă versiunea serverului</button></div></div>}
      <button className="primary partner-generate" disabled={busy}>{busy?<LoaderCircle className="spin" size={18}/>:<Mail size={18}/>} {busy?'Se generează…':'Generează e-mailul'}</button>
    </form>
    {result&&<section className="panel partner-result"><div className="partner-result-head"><span className="success-mark"><Check size={24}/></span><div><span className="eyebrow">SOLICITARE SALVATĂ</span><h2>{result.mail.subject}</h2><small>Status: Solicitat</small></div></div><div className="partner-mail-meta"><p><b>Către:</b> {result.mail.to}</p><p><b>CC:</b> {result.mail.cc.join(', ')}</p></div><div className="partner-table-wrap"><table className="partner-preview-table"><thead><tr><th>Firma</th><th>Locația</th><th>CUI</th><th>Tip magazin</th><th>Persoana de contact</th><th>Nr. tel.</th><th>Adresa e-mail</th><th>Adresa magazin</th><th>Județ</th></tr></thead><tbody><tr><td>{result.partner.company}</td><td>{result.partner.location}</td><td>{result.partner.cui}</td><td>{result.partner.storeType}</td><td>{result.partner.contact}</td><td>{result.partner.phone}</td><td>{result.partner.email||'-'}</td><td>{result.partner.address}</td><td>{result.partner.county}</td></tr></tbody></table></div><div className="partner-actions"><a className="primary" href={result.mail.mailto}><Mail size={18}/> Deschide e-mailul</a><button type="button" className="secondary" onClick={downloadEml}><Download size={18}/> Descarcă .eml cu tabel</button><button type="button" className="secondary" onClick={newRequest}><Plus size={18}/> Cerere nouă</button></div><p className="muted partner-help">Managerul vede solicitarea în Activitate. După confirmare, punctul de lucru devine disponibil automat pentru avize SIM 0 și standuri.</p></section>}
    <section className="panel partner-history"><div className="panel-heading"><div><h2>Istoricul meu</h2><span className="count-pill">{history.length}</span></div><div className="partner-history-controls"><input type="month" aria-label="Luna istoricului partenerilor" value={month} onChange={e=>{setHistoryBusy(true);setHistoryError('');setMonth(e.target.value);}}/><button className="icon-button" aria-label="Actualizează istoricul partenerilor" onClick={()=>{setHistoryBusy(true);setHistoryError('');setHistoryReload(n=>n+1);}}><RefreshCw size={18}/></button></div></div>{historyError?<p className="error-banner">{historyError}</p>:historyBusy?<p className="portfolio-message">Se încarcă solicitările…</p>:history.length?<div className="partner-history-list">{history.map(item=><div key={item.id}><span><strong>{item.company}</strong><small>{item.cui} · {item.location} · {dateLabel(item.createdAt)}</small></span><span className={'badge '+(item.status==='confirmed'?'finalized':'draft')}>{item.status==='confirmed'?'Confirmat':'Solicitat'}</span></div>)}</div>:<p className="portfolio-message">Nicio solicitare în luna selectată.</p>}</section>
  </div>;
}
