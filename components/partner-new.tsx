'use client';
import {normalizeAnafCui,validAnafCui} from '@/lib/anaf-types';
import './partner-new.css';
import {PartnerAnaf} from './partner-anaf';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, Mail, Plus, RefreshCw, Store } from 'lucide-react';
import { api, ApiError, dateLabel, errorMessage } from '@/lib/client-api';
import { rankPartnerCandidates } from '@/lib/partner-matching';
import { readLocalWork, removeLocalWork, writeLocalWork } from '@/lib/local-work';
import { bucharestReportingMonthKey } from '@/lib/bucharest-month';
import type { PartnerCompany, PartnerLocation, PartnerMail, PartnerRequest, PartnerRequestRecord } from '@/lib/types';

type PartnerResult = { partner: PartnerRequest; request: PartnerRequestRecord; mail: PartnerMail; eml: string };
const digitCui=(raw:string)=>{const compact=raw.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');return /^(?:RO)?\d+$/.test(compact)?compact.replace(/^RO/,''):'';};
const discoveryLength=(raw:string)=>digitCui(raw)?.length||raw.trim().length;
const currentMonth=()=>bucharestReportingMonthKey(new Date());
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
  const [lookup,setLookup]=useState<PartnerLocation[]>([]),[lookupBusy,setLookupBusy]=useState(false),[lookupError,setLookupError]=useState(''),[lookupCui,setLookupCui]=useState('');
  const [month,setMonth]=useState(currentMonth),[history,setHistory]=useState<PartnerRequestRecord[]>([]),[historyBusy,setHistoryBusy]=useState(true),[historyError,setHistoryError]=useState(''),[historyReload,setHistoryReload]=useState(0);
  const [conflictRequest,setConflictRequest]=useState<PartnerRequestRecord|null>(null);
  const [query,setQuery]=useState(initialDraft.discoveryQuery||initialDraft.cui||'');
  const [selectedCompany,setSelectedCompany]=useState<PartnerCompany|null>(()=>['existing','new-point'].includes(initialDraft.onboardingMode)?{name:initialDraft.company,cui:initialDraft.cui,pointCount:0}:null);
  const [mode,setMode]=useState(initialDraft.onboardingMode||(initialDraft.company?'new-company':''));
  const [selectedPoint,setSelectedPoint]=useState(initialDraft.existingPoint||'');
  const [search,setSearch]=useState<{query:string;companies:PartnerCompany[];error?:string;hasMore?:boolean}|null>(null);
  const [retry,setRetry]=useState(0);
  const [officialName,setOfficialName]=useState<{cui:string;name:string}|null>(null);
  const formRef=useRef<HTMLFormElement>(null);
  const value=(key:string,fallback='')=>initialValues[key]??fallback;

  useEffect(()=>{let cancelled=false;void api<{requests:PartnerRequestRecord[]}>(`partner/requests?month=${encodeURIComponent(month)}`).then(r=>{if(!cancelled){setHistory(r.requests);setHistoryError('');}}).catch(e=>{if(!cancelled)setHistoryError(errorMessage(e));}).finally(()=>{if(!cancelled)setHistoryBusy(false);});return()=>{cancelled=true;};},[month,historyReload]);
  useEffect(()=>{
    const controller=new AbortController(),raw=query.trim();
    if(discoveryLength(raw)<3)return()=>controller.abort();
    const timer=window.setTimeout(()=>{void api<{companies:PartnerCompany[];hasMore:boolean}>(`partner/search?q=${encodeURIComponent(raw)}`,'GET',undefined,controller.signal)
      .then(r=>{if(!controller.signal.aborted)setSearch({query:raw,...r});})
      .catch(e=>{if(!controller.signal.aborted)setSearch({query:raw,companies:[],error:errorMessage(e)});});},350);
    return()=>{controller.abort();window.clearTimeout(timer);};
  },[query,retry]);
  useEffect(()=>{
    const raw=cui.trim(),controller=new AbortController();
    const eligible=!!raw&&(validAnafCui(raw)||selectedCompany?.cui===raw);
    queueMicrotask(()=>{if(!controller.signal.aborted){setLookup([]);setLookupCui('');setLookupError('');setLookupBusy(eligible);}});
    if(!eligible)return()=>controller.abort();
    const timer=window.setTimeout(()=>{void api<{locations:PartnerLocation[]}>(`partner/lookup?cui=${encodeURIComponent(raw)}`,'GET',undefined,controller.signal)
      .then(r=>{if(!controller.signal.aborted){setLookup(r.locations);setLookupCui(raw);}})
      .catch(e=>{if(!controller.signal.aborted)setLookupError(errorMessage(e));})
      .finally(()=>{if(!controller.signal.aborted)setLookupBusy(false);});},350);
    return()=>{controller.abort();window.clearTimeout(timer);};
  },[cui,selectedCompany,retry,formEpoch]);

  function persistDraft(form:HTMLFormElement){const body=formValues(form);if(result)setResult(null);setStorageError(writeLocalWork('partner',userId,'new',body));}
  function changeMode(next:string){setMode(next);const form=formRef.current;queueMicrotask(()=>{if(form&&formRef.current===form)persistDraft(form);});}
  function setFields(fields:Record<string,string>){
    const form=formRef.current;if(!form)return;
    for(const [key,value] of Object.entries(fields)){const input=form.elements.namedItem(key);if(input instanceof HTMLInputElement)input.value=value;}
    if(fields.cui!==undefined)setCui(fields.cui);
    if(fields.location!==undefined)setLocation(fields.location);
    if(fields.county!==undefined)setCounty(fields.county);
    if(fields.address!==undefined)setAddress(fields.address);
    queueMicrotask(()=>{if(formRef.current===form)persistDraft(form);});
  }
  function discover(next:string){
    setQuery(next);setSearch(null);setSelectedCompany(null);setSelectedPoint('');setMode('');setLookup([]);setLookupError('');setError('');setConflictRequest(null);

    const fiscal=digitCui(next);
    setFields({cui:fiscal,company:'',location:'',county:'',address:''});
  }
  function chooseCompany(company:PartnerCompany){
    setSelectedCompany(company);setSelectedPoint('');setMode('');
    setFields({company:company.name,cui:company.cui,location:'',county:'',address:''});
  }
  function choosePoint(id:string){
    const point=lookup.find(p=>p.id===id);setSelectedPoint(id);
    if(point)setFields({company:point.name,location:point.city,county:point.county,address:point.address});
  }
  function resetDiscovery(next:Record<string,string>){setQuery(next.cui||'');setSearch(null);setSelectedCompany(null);setSelectedPoint('');setMode(next.company?'new-company':'');}


  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();if(busy||!mode||lookupBusy||lookupError||newCompanyIsExisting||(mode==='new-company'&&crmMustFinish)||(mode==='existing'&&!lookup.some(point=>point.id===selectedPoint)))return;setBusy(true);setError('');setConflictRequest(null);setResult(null);
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
          const refreshed=await api<{locations:PartnerLocation[]}>(`partner/lookup?cui=${encodeURIComponent(body.cui)}`).catch(()=>null);
          if(refreshed&&sameRequest()&&formValues(submittedForm).cui===body.cui)setLookup(refreshed.locations);
          try {
            const conflictId=body.requestId||'';
            const fresh=await api<{request:PartnerRequestRecord}>(`partner/requests/${encodeURIComponent(conflictId)}`);
            if(!sameRequest()||fresh.request.id!==conflictId)return;
            if(fresh.request.status==='requested'&&fresh.request.revision===Number(body.revision))return;
            setConflictRequest(fresh.request);setError('Cererea s-a modificat în altă fereastră. Alege mai jos cum continui.');
            if(month===fresh.request.createdAt.slice(0,7))setHistory(items=>items.map(item=>item.id===fresh.request.id?fresh.request:item));
          } catch {/* keep the original conflict visible */}
        }
      }
    } finally {if(formRef.current===submittedForm)setBusy(false);}
  }
  function conflictMatchesCurrent(){return !!conflictRequest&&!!formRef.current&&formValues(formRef.current).requestId===conflictRequest.id;}
  function keepLocalAfterConflict(){if(!conflictRequest||conflictRequest.status!=='requested'||!conflictMatchesCurrent()){setConflictRequest(null);return;}const rebased={...formValues(formRef.current!),requestId:conflictRequest.id,revision:String(conflictRequest.revision)};setRequestRevision(conflictRequest.revision);setStorageError(writeLocalWork('partner',userId,'new',rebased));setConflictRequest(null);setError('');}
  function loadServerAfterConflict(){if(!conflictRequest||!conflictMatchesCurrent()){setConflictRequest(null);return;}if(!window.confirm('Încarci versiunea salvată pe server? Modificările locale nesalvate vor fi înlocuite.'))return;const next={company:conflictRequest.company,location:conflictRequest.location,cui:conflictRequest.cui,storeType:conflictRequest.storeType,contact:conflictRequest.contact,phone:conflictRequest.phone,email:conflictRequest.email,address:conflictRequest.address,county:conflictRequest.county,requestId:conflictRequest.id,revision:String(conflictRequest.revision)};resetDiscovery(next);setRequestRevision(conflictRequest.revision);setInitialValues(next);setCui(conflictRequest.cui);setLocation(conflictRequest.location);setCounty(conflictRequest.county);setAddress(conflictRequest.address);setLookup([]);setStorageError(removeLocalWork('partner',userId,'new'));setFormEpoch(value=>value+1);setResult(null);setConflictRequest(null);setError('');}
  function newRequest(){if(!result&&formRef.current){const values=formValues(formRef.current);const hasUnsaved=Object.entries(values).some(([key,value])=>!['requestId','revision','storeType'].includes(key)&&value.trim());if(hasUnsaved&&!window.confirm('Pornești o cerere nouă? Datele nesalvate din formularul curent vor fi șterse.'))return;}const id=crypto.randomUUID();setBusy(false);setStorageError(removeLocalWork('partner',userId,'new'));setRequestId(id);setRequestRevision(0);setInitialValues({storeType:'MAGAZIN',requestId:id});resetDiscovery({});setCui('');setLocation('');setCounty('');setAddress('');setLookup([]);setFormEpoch(value=>value+1);setResult(null);setConflictRequest(null);setError('');requestAnimationFrame(()=>requestAnimationFrame(()=>{formRef.current?.scrollIntoView({behavior:'smooth',block:'start'});formRef.current?.querySelector<HTMLInputElement>('#partner-discovery')?.focus();}));}
  function downloadEml(){if(!result)return;const blob=new Blob([result.eml],{type:'message/rfc822;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=result.mail.emlFilename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  const candidates=rankPartnerCandidates({cui,city:location,county,address},lookup);
  const exactPoints=candidates.filter(c=>c.category==='exact').map(c=>c.point);
  const credible=candidates.filter(c=>c.category!=='distinct');
  const samePoint=exactPoints.length===1&&credible.length===1;
  const selectedExistingPoint=lookup.find(point=>point.id===selectedPoint);
  const resolutionPoints=mode==='existing'||samePoint?[]:credible.map(c=>c.point);
  const resolutionKey=JSON.stringify([cui,location,county,address,resolutionPoints.map(p=>p.id)]);
  const crmMustFinish=validAnafCui(cui)&&(lookupBusy||lookupCui!==cui.trim()||!!lookupError);
  const unresolvedCrmCompanies=search?.query===query.trim()&&!search.error&&search.companies.some(company=>!company.cui);
  const newCompanyIsExisting=mode==='new-company'&&(lookup.length>0||unresolvedCrmCompanies);
  function fillOfficialNameWhenBlank(name:string){const input=formRef.current?.elements.namedItem('company');if(input instanceof HTMLInputElement&&!input.value.trim())setFields({company:name});}
  return <div className="partner-page">
    <div className="page-heading"><div><span className="eyebrow">CLIENȚI NOI</span><h1>Partener nou</h1><p>Adaugă clientul direct în portofoliu. Managerul primește o notificare.</p></div><button type="button" className="secondary" onClick={newRequest}><Plus size={18}/> Cerere nouă</button></div>
    <form key={formEpoch} ref={formRef} className="panel partner-form" onInput={e=>persistDraft(e.currentTarget)} onSubmit={e=>void submit(e)}>
      <input type="hidden" name="requestId" value={requestId}/><input type="hidden" name="revision" value={requestRevision||""}/>
      {storageError&&<p className="error-banner" role="alert">{storageError}</p>}
      <input type="hidden" name="onboardingMode" value={mode}/><input type="hidden" name="existingPoint" value={selectedPoint}/>
      <section className="partner-discovery" aria-labelledby="partner-discovery-heading">
        <div className="section-heading"><Store size={22}/><div><h2 id="partner-discovery-heading">1. Identifică firma</h2><p>Caută în toți clienții CRM activi. Verificarea ANAF pornește doar pentru un CUI valid.</p></div></div>
        <label htmlFor="partner-discovery">Numele firmei sau CUI / CIF</label>
        <input id="partner-discovery" name="discoveryQuery" type="search" maxLength={100} autoComplete="off" value={query} placeholder="Ex. Exemplu SRL sau RO12345678" aria-describedby="partner-search-status" onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} onChange={e=>discover(e.target.value)}/>
        <output id="partner-search-status">{discoveryLength(query)<3?'Introdu minimum 3 caractere (sau 3 cifre după RO).':search?.query!==query.trim()?'Se caută în CRM…':search.error?<>Căutarea CRM este indisponibilă. {search.error} <button type="button" className="secondary" onClick={()=>{setSearch(null);setRetry(n=>n+1);}}>Reîncearcă căutarea</button></>:search.companies.length?`${search.companies.length} firme găsite${search.hasMore?' · restrânge căutarea pentru alte rezultate':''}.`:'Niciun rezultat pentru această căutare. Introdu CUI-ul pentru verificare sau continuă manual.'}</output>
        {search?.query===query.trim()&&!search.error&&search.companies.length>0&&<ul className="partner-suggestions" aria-label="Firme din CRM">{search.companies.map((company,i)=><li key={company.cui||i}>{company.cui?<button type="button" className="secondary" aria-pressed={selectedCompany?.cui===company.cui&&selectedCompany?.name===company.name} onClick={()=>chooseCompany(company)}><strong>{company.name}</strong><span>CUI {company.cui} · {company.pointCount} puncte de lucru</span></button>:<div className="partner-unresolved"><strong>{company.name}</strong><span>CUI lipsă în CRM — punct existent neidentificabil fiscal. Nu îl înregistra din nou. Solicită completarea CUI în sursa CRM înainte de asociere.</span></div>}</li>)}</ul>}
      </section>
      <section className="partner-identity" aria-label="Identitatea firmei">
        {selectedCompany&&<p><strong>{selectedCompany.name}</strong> · CUI {selectedCompany.cui} · {selectedCompany.pointCount} puncte în CRM</p>}
        <PartnerAnaf key={formEpoch} cui={cui} crmName={selectedCompany?.name||lookup[0]?.name} onFound={company=>{setOfficialName({cui:normalizeAnafCui(cui),name:company.name});if(mode==='new-company'&&!selectedCompany&&!lookup.length&&!busy)fillOfficialNameWhenBlank(company.name);}} onUseName={mode||(!selectedCompany&&!lookup.length)?company=>{if(!busy)setFields({company:company.name});}:undefined}/>
        {lookupBusy?<output>Se verifică punctele de lucru în CRM…</output>:lookupError?<p role="alert">Lista punctelor este indisponibilă. {lookupError} <button type="button" className="secondary" onClick={()=>setRetry(n=>n+1)}>Reîncearcă punctele</button></p>:lookup.length>0?<><h3>Puncte de lucru existente</h3><ul className="partner-points">{lookup.map(point=><li key={point.id}><strong>{point.name}</strong> · {point.city} · {point.county||'județ lipsă'} · {point.address}</li>)}</ul></>:lookupCui===cui.trim()&&validAnafCui(cui)?<p>Niciun punct găsit pentru acest CUI în CRM.</p>:null}
      </section>
      {lookup.length>0&&<div className="partner-lookup existing" aria-live="polite"><strong>{samePoint?'Acest punct de lucru există deja.':credible.length?'Atenție: posibil punct duplicat. Verifică locațiile de mai jos.':'Firma există deja în CRM.'}</strong><div>{candidates.map(({point,reason})=><span key={point.id}>{point.city} · {point.county} · {point.address} · {reason}</span>)}</div></div>}
      <fieldset className="partner-paths"><legend>2. Alege cum adaugi clientul</legend>
        <button type="button" className="secondary" disabled={!lookup.length||lookupBusy} aria-pressed={mode==='existing'} onClick={()=>{changeMode('existing');setSelectedPoint('');}}>Asociază un punct de lucru EXISTENT</button>
        <button type="button" className="secondary" disabled={!lookup.length||lookupBusy} aria-pressed={mode==='new-point'} onClick={()=>{changeMode('new-point');setSelectedPoint('');setFields({company:officialName?.cui===normalizeAnafCui(cui)?officialName.name:selectedCompany?.name||lookup[0].name,location:'',county:'',address:''});}}>Adaugă punct NOU pentru firma existentă</button>
        <button type="button" className="secondary" disabled={lookup.length>0||!!selectedCompany||crmMustFinish||!!unresolvedCrmCompanies} aria-pressed={mode==='new-company'} onClick={()=>{changeMode('new-company');setSelectedPoint('');if(officialName?.cui===normalizeAnafCui(cui))fillOfficialNameWhenBlank(officialName.name);}}>Firmă NOUĂ și primul punct</button>
      </fieldset>
      {newCompanyIsExisting&&<p className="partner-lookup existing" role="alert">{unresolvedCrmCompanies?'Căutarea a identificat și firme fără CUI. Restrânge rezultatele sau corectează fișa CRM înainte de înregistrare.':'Acest CUI aparține deja unei firme din CRM. Alege un punct existent sau «Adaugă punct NOU pentru firma existentă» înainte să continui.'}</p>}
      {mode==='existing'&&<label>Punctul de lucru existent<select name="locationResolution" required value={selectedPoint} onChange={e=>choosePoint(e.target.value)}><option value="">Alege localitatea și adresa…</option>{lookup.map(point=><option key={point.id} value={point.id}>{point.city} · {point.county||'județ lipsă'} · {point.address}</option>)}</select></label>}
      <div hidden={!mode} className="partner-details"><h2>3. Punctul de lucru și contactul</h2><p>Adresa magazinului se completează separat de sediul fiscal ANAF.</p>
      <div className="partner-grid">
        <label>Firma (denumirea legală)<input name="company" defaultValue={value('company')} required maxLength={200} placeholder="SC EXEMPLU SRL"/><small>Poți utiliza numele oficial ANAF sau îl poți corecta manual. Numele afișat în CRM poate fi cel al magazinului.</small></label>
        <label>Locația<input name="location" defaultValue={value('location')} required maxLength={100} placeholder="Zărnești" readOnly={mode==='existing'&&!!selectedExistingPoint?.city.trim()} onChange={e=>setLocation(e.target.value)}/></label>
        <label>CUI / CIF<input name="cui" defaultValue={value('cui')} required maxLength={40} autoCapitalize="characters" placeholder="RO12345678" readOnly={mode==='existing'||mode==='new-point'} onChange={e=>{const normal=digitCui(e.target.value),next=normal||e.target.value;if(normal)e.target.value=next;setCui(next);setLookup([]);setLookupError('');setSelectedCompany(null);}}/></label>
        <label>Tip magazin<input name="storeType" required maxLength={80} defaultValue={value('storeType','MAGAZIN')}/></label>
        <label>Persoana de contact<input name="contact" defaultValue={value('contact')} required maxLength={120} placeholder="Nume Prenume"/></label>
        <label>Nr. telefon<input name="phone" defaultValue={value('phone')} required maxLength={40} inputMode="tel" placeholder="07xxxxxxxx"/></label>
        <label>Adresa e-mail <span className="optional">opțional</span><input name="email" defaultValue={value('email')} type="email" maxLength={254} placeholder="contact@example.invalid"/></label>
        <label>Județ<input name="county" defaultValue={value('county')} required maxLength={100} placeholder="Brașov" readOnly={mode==='existing'&&!!selectedExistingPoint?.county.trim()} onChange={e=>setCounty(e.target.value)}/></label>
        <label className="partner-wide">Adresa magazin<input name="address" defaultValue={value('address')} required maxLength={500} placeholder="Stradă, număr, localitate" readOnly={mode==='existing'&&!!selectedExistingPoint?.address.trim()} onChange={e=>setAddress(e.target.value)}/></label>
      </div>

      {resolutionPoints.length>0&&<label className="partner-location-resolution">Alege punctul de lucru<select key={resolutionKey} name="locationResolution" defaultValue="" required><option value="">Alege explicit…</option>{resolutionPoints.map(item=><option key={item.id} value={item.id}>Acesta este punctul existent [{item.id}] · {item.city} · {item.county||'județ lipsă'} · {item.address}</option>)}{exactPoints.length===0&&<option value="new">Locație diferită / nouă · {county}</option>}</select><small>Datele existente sunt ambigue. Alege punctul corect înainte de adăugare.</small></label>}
      {error&&<p className="error-banner" role="alert">{error}</p>}
      {conflictRequest&&<div className="recovery-banner partner-conflict" role="alert"><div><strong>Cererea are o versiune mai nouă pe server.</strong><p>{conflictRequest.status==='confirmed'?'Clientul este deja în portofoliu. Încarcă datele salvate; modificările clientului se fac din fișa sa.':'Alege explicit dacă păstrezi editările locale peste ultima revizie sau încarci versiunea serverului.'}</p></div><div className="recovery-actions">{conflictRequest.status==='requested'&&<button type="button" className="primary" onClick={keepLocalAfterConflict}>Păstrează modificările mele</button>}<button type="button" className="secondary" onClick={loadServerAfterConflict}>Încarcă versiunea serverului</button></div></div>}
      <button className="primary partner-generate" disabled={!mode||busy||lookupBusy||!!lookupError||newCompanyIsExisting||(mode==='new-company'&&crmMustFinish)||(mode==='existing'&&!lookup.some(point=>point.id===selectedPoint))}>{busy?<LoaderCircle className="spin" size={18}/>:<Mail size={18}/>} {busy?'Se adaugă…':'Adaugă clientul'}</button>
      </div>
    </form>
    {result&&<section className="panel partner-result"><div className="partner-result-head"><span className="success-mark"><Check size={24}/></span><div><span className="eyebrow">CLIENT ADĂUGAT</span><h2>{result.mail.subject}</h2><small>Status: Disponibil în portofoliu</small></div></div><div className="partner-mail-meta"><p><b>Către:</b> {result.mail.to}</p><p><b>CC:</b> {result.mail.cc.join(', ')}</p></div><div className="partner-table-wrap"><table className="partner-preview-table"><thead><tr><th>Firma</th><th>Locația</th><th>CUI</th><th>Tip magazin</th><th>Persoana de contact</th><th>Nr. tel.</th><th>Adresa e-mail</th><th>Adresa magazin</th><th>Județ</th></tr></thead><tbody><tr><td>{result.partner.company}</td><td>{result.partner.location}</td><td>{result.partner.cui}</td><td>{result.partner.storeType}</td><td>{result.partner.contact}</td><td>{result.partner.phone}</td><td>{result.partner.email||'-'}</td><td>{result.partner.address}</td><td>{result.partner.county}</td></tr></tbody></table></div><div className="partner-actions"><a className="primary" href={result.mail.mailto}><Mail size={18}/> Deschide e-mailul</a><button type="button" className="secondary" onClick={downloadEml}><Download size={18}/> Descarcă .eml cu tabel</button><button type="button" className="secondary" onClick={newRequest}><Plus size={18}/> Cerere nouă</button></div><p className="muted partner-help">Clientul este disponibil pentru avize SIM 0 și standuri. Managerul primește doar o notificare; nu este necesară aprobarea.</p></section>}
    <section className="panel partner-history"><div className="panel-heading"><div><h2>Istoricul meu</h2><span className="count-pill">{history.length}</span></div><div className="partner-history-controls"><input type="month" aria-label="Luna istoricului partenerilor" value={month} onChange={e=>{setHistoryBusy(true);setHistoryError('');setMonth(e.target.value);}}/><button className="icon-button" aria-label="Actualizează istoricul partenerilor" onClick={()=>{setHistoryBusy(true);setHistoryError('');setHistoryReload(n=>n+1);}}><RefreshCw size={18}/></button></div></div>{historyError?<p className="error-banner">{historyError}</p>:historyBusy?<p className="portfolio-message">Se încarcă solicitările…</p>:history.length?<div className="partner-history-list">{history.filter(item=>item.status==='confirmed').map(item=><div key={item.id}><span><strong>{item.company}</strong><small>{item.cui} · {item.location} · {dateLabel(item.createdAt)}</small></span><span className="badge finalized">Adăugat</span></div>)}</div>:<p className="portfolio-message">Niciun client adăugat în luna selectată.</p>}</section>
  </div>;
}
