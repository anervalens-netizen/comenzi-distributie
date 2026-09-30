'use client';
import { useEffect, useState } from 'react';
import { api, errorMessage, money } from '@/lib/client-api';
import type { PartnerSalesResult } from '@/lib/partner-sales-store';
import './partner-sales.css';
const amount=(cents:number|null)=>cents===null?'Valoare lipsă':money(cents/100);
const labels={no_billing:'Fără facturare comercială în datele asociate',insufficient_history:'Istoric insuficient',occasional:'Ocazional',regular:'Constant',overdue:'Peste ritmul obișnuit',inactive:'Inactiv față de ritmul anterior'};
export function PartnerSales({id}:{id:string}) {
  const [open,setOpen]=useState(false),[from,setFrom]=useState(''),[to,setTo]=useState(''),[page,setPage]=useState(0);
  const [data,setData]=useState<{key:string;value:PartnerSalesResult}|null>(null),[failure,setFailure]=useState<{key:string;text:string}|null>(null),[transactionsOpen,setTransactionsOpen]=useState(false);
  const key=JSON.stringify([id,from,to,page]);
  const result=data?.key===key?data.value:null,error=failure?.key===key?failure.text:'',loading=open&&!result&&!error;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const query=new URLSearchParams({page:String(page)});
    if(from)query.set('from',from);if(to)query.set('to',to);
    api<PartnerSalesResult>(`partner/portfolio/${encodeURIComponent(id)}/sales?${query}`,'GET',undefined,controller.signal)
      .then(value=>{if(!controller.signal.aborted){setData({key,value});setFailure(null);}})
      .catch(err=>{if(!controller.signal.aborted)setFailure({key,text:errorMessage(err)});});
    return()=>controller.abort();
  },[id,open,from,to,page,key]);
  const ready=result?.state==='ready'?result:null;
  return <details className="partner-sales" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Vânzări și ritmul de facturare</summary>
    {open&&<div className="partner-sales-body">
      <p>Istoricul facturat pe acest punct de lucru. Portofoliul poate fi comun; fiecare tranzacție păstrează agentul care a vândut.</p>
      <div className="partner-sales-filters">
        <label>De la<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setPage(0);}}/></label>
        <label>Până la<input type="date" value={to} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label>
      </div>
      {loading&&<output>Se încarcă istoricul…</output>}
      {error&&<p role="alert">{error}</p>}
      {result&&result.state!=='ready'&&<p>{result.message}</p>}
      {ready&&<>
        <p className="partner-sales-source">Date importate până la <strong>{ready.through}</strong>. Perioada afișată: {ready.from} – {ready.to}.</p>
        <div className="partner-sales-health">
          <strong>{labels[ready.activity.status]}</strong>
          {ready.activity.isNew&&<span>Prima facturare recentă</span>}
          {ready.activity.reactivated&&<span>Reactivat</span>}
          {ready.activity.seasonalPossible&&<span>Posibil sezonier</span>}
          <p>{ready.activity.reason}</p>
          <p>Ultima facturare: <strong>{ready.activity.lastBilling||'Nedeterminată'}</strong>{ready.activity.cadenceDays!==null&&<> · Ritm: aproximativ <strong>{ready.activity.cadenceDays} zile</strong></>}</p>
        </div>
        {!ready.coverageComplete&&<p className="partner-sales-caution">Asocierea sau acoperirea istoricului este incompletă. Totalurile de mai jos includ numai tranzacțiile asociate acestei fișe; alertele de inactivitate sunt suspendate.</p>}
        <div className="partner-sales-kpis">
          <div><small>Valoare facturată cu TVA</small><strong>{ready.totals.rows?amount(ready.totals.valueCents):money(0)}</strong></div>
          <div><small>Cantitate netă</small><strong>{((ready.totals.quantityMicros||0)/1e6).toLocaleString('ro-RO')}</strong></div>
          <div><small>Linii în istoric</small><strong>{ready.totals.rows.toLocaleString('ro-RO')}</strong></div>
        </div>
        {!!ready.totals.missingValues&&<p className="partner-sales-caution">{ready.totals.missingValues} linii au valoarea lipsă și nu sunt incluse în suma cunoscută.</p>}
        {!!ready.totals.returnsCents&&<p>Poziții cu valoare negativă, incluse în total: {amount(ready.totals.returnsCents)}.</p>}
        <h4>Evoluție lunară</h4>
        {ready.monthly.length?<div className="partner-sales-scroll"><table><thead><tr><th>Luna</th><th>Cantitate</th><th>Valoare</th></tr></thead><tbody>{ready.monthly.map(m=><tr key={m.month}><td>{m.month}</td><td>{(m.quantityMicros/1e6).toLocaleString('ro-RO')}</td><td>{amount(m.valueCents)}{m.missingValues?' *':''}</td></tr>)}</tbody></table></div>:<p>Nu există tranzacții asociate în perioada selectată.</p>}
        <details><summary>Produse cu cea mai mare valoare</summary><div className="partner-sales-scroll"><table><thead><tr><th>Produs</th><th>Cantitate</th><th>Valoare</th></tr></thead><tbody>{ready.products.map(p=><tr key={p.code}><td>{p.name}<small>{p.code}</small></td><td>{(p.quantityMicros/1e6).toLocaleString('ro-RO')}</td><td>{amount(p.valueCents)}</td></tr>)}</tbody></table></div></details>
        <details><summary>Agenții care au facturat</summary><div className="partner-sales-scroll"><table><thead><tr><th>Agent din istoric</th><th>Valoare</th></tr></thead><tbody>{ready.sellers.map(s=><tr key={s.seller}><td>{s.seller||'Agent lipsă'}</td><td>{amount(s.valueCents)}</td></tr>)}</tbody></table></div></details>
        <details open={transactionsOpen} onToggle={event=>setTransactionsOpen(event.currentTarget.open)}><summary>Tranzacții</summary><div className="partner-sales-scroll"><table><thead><tr><th>Data / document</th><th>Produs / agent</th><th>Cantitate</th><th>Valoare</th></tr></thead><tbody>{ready.transactions.map((t,i)=><tr key={i}><td>{t.date}<small>{t.document} · {t.site}</small></td><td>{t.itemName}<small>{t.seller}</small></td><td>{(t.quantityMicros/1e6).toLocaleString('ro-RO')}</td><td>{amount(t.valueCents)}</td></tr>)}</tbody></table></div><div className="partner-sales-pagination"><button type="button" disabled={page===0} onClick={()=>setPage(v=>v-1)}>Anterioare</button><span>Pagina {page+1}</span><button type="button" disabled={!ready.hasMore} onClick={()=>setPage(v=>v+1)}>Următoarele</button></div></details>
      </>}
    </div>}
  </details>;
}
