'use client';
import {useEffect,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import type {PartnerActivityOverview,ActivityFilter,ActivitySort} from '@/lib/partner-activity-api';
import './partner-sales.css';
const filters:{key:ActivityFilter;label:string}[]=[{key:'all',label:'Toți clienții'},{key:'attention',label:'De contactat'},{key:'regular',label:'Comenzi constante'},{key:'inactive',label:'Nu au mai facturat'},{key:'reactivated',label:'Au revenit'},{key:'incomplete',label:'Date insuficiente'}];
const sorts:{key:ActivitySort;label:string}[]=[{key:'value',label:'Valoare vânzări'},{key:'documents',label:'Număr facturări'},{key:'lastBilling',label:'Ultima facturare'},{key:'name',label:'Client'},{key:'county',label:'Județ'},{key:'agent',label:'Agent actual'}];
const amount=new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2});
const date=(value:string|null|undefined)=>value?value.split('-').reverse().join('.'):'—';
export function PartnerActivity({scopeQuery,salesPeriod,onPeriodChange,onOpen,onBack}:{scopeQuery:string;salesPeriod:string;onPeriodChange:(value:string)=>void;onOpen:(id:string)=>void;onBack:()=>void}){
  const [filter,setFilter]=useState<ActivityFilter>('all'),[query,setQuery]=useState(''),[county,setCounty]=useState(''),[page,setPage]=useState(0),[retry,setRetry]=useState(0);
  const [sort,setSort]=useState<ActivitySort>('value'),[direction,setDirection]=useState<'asc'|'desc'>('desc');
  const [response,setResponse]=useState<{key:string;data:PartnerActivityOverview}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null);
  const params=new URLSearchParams(scopeQuery);params.set('activity',filter);params.set('q',query);params.set('county',county);params.set('page',String(page));params.set('salesPeriod',salesPeriod);params.set('sort',sort);params.set('direction',direction);
  const request=params.toString(),key=request+'|'+retry;
  const data=response?.key===key?response.data:null,error=failure?.key===key?failure.message:'';
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{api<PartnerActivityOverview>('partner/activity?'+request,'GET',undefined,controller.signal).then(data=>{if(!controller.signal.aborted){setResponse({key,data});setFailure(null);}}).catch(e=>{if(!controller.signal.aborted)setFailure({key,message:errorMessage(e)});});},200);
    return()=>{clearTimeout(timer);controller.abort();};
  },[request,key]);
  const ready=data?.state==='ready'?data:null;
  const counties=ready?.counties||(response?.data.state==='ready'?response.data.counties:[]);
  const currentYear=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Europe/Bucharest'}).format(new Date()));
  const changeSort=(value:ActivitySort)=>{setDirection(sort===value?(direction==='desc'?'asc':'desc'):['name','county','agent'].includes(value)?'asc':'desc');setSort(value);setPage(0);};
  const heading=(value:ActivitySort,label:string)=><th scope="col" aria-sort={sort===value?(direction==='asc'?'ascending':'descending'):'none'}><button type="button" onClick={()=>changeSort(value)}>{label}{sort===value?(direction==='desc'?' ↓':' ↑'):' ↕'}</button></th>;
  return <section className="partner-activity">
    <button type="button" className="secondary partner-table-back" onClick={onBack}>← Înapoi la Parteneri</button>
    <div className="partner-table-panel">
      <header className="partner-table-heading"><div><h2>Vânzări pe clienți</h2><p>Toate vânzările firmelor din portofoliul actual, indiferent de agentul care a facturat.</p></div></header>
      <div className="partner-table-filters">
        <label className="partner-table-search">Caută client<input type="search" placeholder="Nume, CUI sau localitate" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
        <label>Perioadă<select value={salesPeriod} onChange={e=>{onPeriodChange(e.target.value);setPage(0);}}><option value="">Tot istoricul</option>{Array.from({length:Math.max(1,currentYear-2022)},(_,i)=>currentYear-i).map(y=><option key={y} value={'year:'+y}>{y}</option>)}<option value="recent90">Ultimele 90 zile</option><option value="recent365">Ultimele 365 zile</option><option value="older365">Fără facturare de 365 zile</option><option value="unknown">Istoric de completat</option></select></label>
        <label>Județ<select value={county} onChange={e=>{setCounty(e.target.value);setPage(0);}}><option value="">Toate județele</option>{counties.map(c=><option key={c}>{c}</option>)}</select></label>
        <label>Clienți<select value={filter} onChange={e=>{setFilter(e.target.value as ActivityFilter);setPage(0);}}>{filters.map(f=><option key={f.key} value={f.key}>{f.label}</option>)}</select></label>
        <label>Sortează după<select value={sort} onChange={e=>changeSort(e.target.value as ActivitySort)}>{sorts.map(s=><option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <label>Ordine<select value={direction} onChange={e=>{setDirection(e.target.value as 'asc'|'desc');setPage(0);}}><option value="desc">Descrescător ↓</option><option value="asc">Crescător ↑</option></select></label>
      </div>
      {!data&&!error&&<output className="partner-table-message">Se încarcă vânzările…</output>}
      {error&&<p role="alert" className="partner-table-message">{error} <button type="button" onClick={()=>setRetry(v=>v+1)}>Reîncearcă</button></p>}
      {data&&data.state!=='ready'&&<p className="partner-table-message">{data.message}</p>}
      {ready&&<>
        <div className="partner-table-summary"><strong>{ready.total.toLocaleString('ro-RO')} clienți</strong><span>{date(ready.range.from)} – {date(ready.range.to)} · lei</span></div>
        {ready.stale&&<p className="partner-sales-caution">Ultimul import: {date(ready.through)}. Datele nu sunt la zi.</p>}
        <section className="partner-table-scroll" aria-label="Tabel vânzări pe clienți">
          <table className="partner-sales-table"><thead><tr>{heading('name','Client')}{heading('value','Vânzări (lei)')}{heading('county','Județ')}{heading('agent','Agent actual')}{heading('documents','Facturări*')}{heading('lastBilling','Ultima facturare')}</tr></thead>
          <tbody>{ready.partners.map(({partner,sales,metrics,agents,counties,scope})=><tr key={partner.id}>
            <th scope="row"><button type="button" className="partner-activity-name" onClick={()=>onOpen(partner.id)}>{partner.name}</button><small>{scope==='company'?'CUI '+partner.cui+' · Toate punctele':partner.historyCatalog?.franchiseCode?'Punct '+partner.historyCatalog.franchiseCode:'CUI '+partner.cui}</small>{partner.city&&<small>{partner.city}</small>}</th>
            <td className="numeric"><strong>{metrics?.valueCents!==null&&metrics?.valueCents!==undefined?amount.format(metrics.valueCents/100):'—'}</strong>{!sales?<small>Neasociat</small>:!sales.coverageComplete&&<small>Valoare parțială</small>}</td>
            <td>{counties?.join(', ')||partner.county||'De stabilit'}</td>
            <td>{agents.length?agents.map(a=><span className="partner-table-agent" key={a.id}>{a.name}</span>):<span className="muted">Fără agent</span>}{agents.length>1&&<small>Portofoliu comun</small>}</td>

            <td className="numeric">{metrics?metrics.documents.toLocaleString('ro-RO'):'—'}</td>
            <td className="partner-table-date">{date(metrics?.lastBilling)}</td>
          </tr>)}</tbody></table>
          {!ready.partners.length&&<p className="partner-table-message">Niciun client în această selecție.</p>}
        </section>
        <footer className="partner-table-footer"><div className="partner-sales-pagination"><button type="button" disabled={!page} onClick={()=>setPage(v=>v-1)}>← Anterior</button><span>{ready.total?`${page*50+1}–${Math.min((page+1)*50,ready.total)} din ${ready.total.toLocaleString('ro-RO')}`:'0 rezultate'}</span><button type="button" disabled={!ready.hasMore} onClick={()=>setPage(v=>v+1)}>Următor →</button></div>
          <p>* Facturări: documente distincte cu valoare netă pozitivă, identificate prin dată, gestiune și număr. Nu reprezintă un număr verificat de comenzi. Retururile sunt incluse în valoarea vânzărilor.</p><p>Fiecare firmă apare o singură dată, cu vânzările tuturor punctelor și cele fără punct completat. „—” înseamnă istoric neasociat, nu vânzări zero. Agentul este responsabilul actual; agentul care a facturat rămâne în detaliile clientului.</p>
        </footer>
      </>}
    </div>
  </section>;
}
