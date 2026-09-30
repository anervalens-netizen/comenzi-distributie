'use client';
import {useEffect,useState} from 'react';
import {api,errorMessage,money} from '@/lib/client-api';
import type {PartnerActivityOverview,ActivityFilter} from '@/lib/partner-activity-api';
import './partner-sales.css';
const filters:{key:ActivityFilter;label:string}[]=[{key:'all',label:'Toți'},{key:'attention',label:'De contactat'},{key:'regular',label:'Constanți'},{key:'overdue',label:'Peste ritm'},{key:'inactive',label:'Inactivi'},{key:'reactivated',label:'Reactivați'},{key:'new',label:'Prima facturare recentă'},{key:'occasional',label:'Ocazionali'},{key:'incomplete',label:'Istoric insuficient'}];
const labels={no_billing:'Fără facturare comercială asociată',insufficient_history:'Istoric insuficient',occasional:'Ocazional',regular:'Constant',overdue:'Peste ritmul obișnuit',inactive:'Inactiv față de ritmul anterior'};
export function PartnerActivity({scopeQuery,onOpen,onBack}:{scopeQuery:string;onOpen:(id:string)=>void;onBack:()=>void}){
  const [filter,setFilter]=useState<ActivityFilter>('all'),[query,setQuery]=useState(''),[county,setCounty]=useState(''),[page,setPage]=useState(0),[retry,setRetry]=useState(0);
  const [response,setResponse]=useState<{key:string;data:PartnerActivityOverview}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null);
  const params=new URLSearchParams(scopeQuery);params.set('activity',filter);params.set('q',query);params.set('county',county);params.set('page',String(page));
  const request=params.toString(),key=request+'|'+retry;
  const data=response?.key===key?response.data:null,error=failure?.key===key?failure.message:'';
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{api<PartnerActivityOverview>('partner/activity?'+request,'GET',undefined,controller.signal).then(data=>{if(!controller.signal.aborted){setResponse({key,data});setFailure(null);}}).catch(e=>{if(!controller.signal.aborted)setFailure({key,message:errorMessage(e)});});},200);
    return()=>{clearTimeout(timer);controller.abort();};
  },[request,key]);
  const ready=data?.state==='ready'?data:null;
  const counties=ready?.counties||(response?.data.state==='ready'?response.data.counties:[]);
  return <section className="partner-activity">
    <button type="button" className="secondary" onClick={onBack}>← Înapoi la Parteneri</button>
    <h2>Activitatea partenerilor</h2>
    <p>Ritmul de facturare al punctelor de lucru din portofoliul actual. Deschide fișa pentru produse, tranzacții și contact.</p>
    <div className="partner-sales-filters">
      <label>Caută partener<input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
      <label>Județ<select value={county} onChange={e=>{setCounty(e.target.value);setPage(0);}}><option value="">Toate județele</option>{counties.map(c=><option key={c}>{c}</option>)}</select></label>
    </div>
    <div className="partner-activity-tabs" aria-label="Filtre de activitate">{filters.map(f=><button type="button" key={f.key} aria-pressed={filter===f.key} onClick={()=>{setFilter(f.key);setPage(0);}}>{f.label}{ready?' ('+ready.counts[f.key]+')':''}</button>)}</div>
    {!data&&!error&&<output>Se încarcă activitatea…</output>}
    {error&&<p role="alert">{error} <button type="button" onClick={()=>setRetry(v=>v+1)}>Reîncearcă</button></p>}
    {data&&data.state!=='ready'&&<p>{data.message}</p>}
    {ready&&<>
      <p>Date până la <strong>{ready.through}</strong>. Evaluare la {ready.asOf}. Valorile compară 30 de zile ({ready.recentStart} – {ready.asOf}) cu cele 30 anterioare.</p>
      {ready.stale&&<p className="partner-sales-caution">Importul nu este la zi. Semnalele descriu situația de la data indicată; lista „De contactat” este suspendată.</p>}
      <p>{ready.total.toLocaleString('ro-RO')} fișe în selecție. Categoriile „Reactivat” și „Prima facturare recentă” se pot suprapune cu ritmul de facturare. Portofoliile agenților pot fi comune.</p>
      <div className="partner-activity-list">{ready.partners.map(({partner,sales})=><article key={partner.id}>
        <button type="button" className="partner-activity-name" onClick={()=>onOpen(partner.id)}>{partner.name}</button>
        <p>{[partner.county,partner.city,partner.address].filter(Boolean).join(' · ')||'Adresă necompletată'} · CUI {partner.cui||'necompletat'}</p>
        {sales?<>
          <strong>{labels[sales.activity.status]}</strong>
          <p>{sales.activity.reason}</p>
          <p>Ultima facturare: {sales.activity.lastBilling||'Nedeterminată'} · Ritm: {sales.activity.cadenceDays===null?'Nedeterminat':sales.activity.cadenceDays+' zile'}</p>
          <p>30 zile: <strong>{money(sales.recentCents/100)}</strong> · 30 anterioare: {money(sales.previousCents/100)}{!sales.coverageComplete?' · Totaluri parțiale':''}</p>
          {sales.activity.reactivated&&<span>Reactivat · </span>}{sales.activity.isNew&&<span>Prima facturare recentă · </span>}{sales.activity.seasonalPossible&&<span>Posibil sezonier · </span>}
        </>:<p>Istoric neasociat acestei fișe. Nu înseamnă vânzări zero.</p>}
        <p className="partner-sales-source">Ultima vizită: {partner.lastVisitedAt?new Date(partner.lastVisitedAt).toLocaleDateString('ro-RO'):'Neînregistrată'}</p>
      </article>)}</div>
      {!ready.partners.length&&<p>Nicio fișă în această selecție.</p>}
      <div className="partner-sales-pagination"><button type="button" disabled={!page} onClick={()=>setPage(v=>v-1)}>Anterioare</button><span>Pagina {page+1}</span><button type="button" disabled={!ready.hasMore} onClick={()=>setPage(v=>v+1)}>Următoarele</button></div>
    </>}
  </section>;
}
