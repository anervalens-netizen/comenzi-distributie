'use client';
import { useEffect, useState } from 'react';
import { api, errorMessage, money } from '@/lib/client-api';
import type { PartnerSalesResult } from '@/lib/partner-sales-store';
import './partner-sales.css';
const amount=(cents:number|null)=>cents===null?'Valoare lipsă':money(cents/100);
const date=(value:string|null)=>value?value.split('-').reverse().join('.'):'—';
const quantity=(value:number)=> (value/1e6).toLocaleString('ro-RO');
const labels={no_billing:'Fără facturare comercială în datele asociate',insufficient_history:'Istoric insuficient',occasional:'Ocazional',regular:'Constant',overdue:'Peste ritmul obișnuit',inactive:'Inactiv față de ritmul anterior'};
type Product={code:string;name:string;quantityMicros:number;valueCents:number|null};
function Products({items}:{items:Product[]}){
  return <div className="partner-sales-scroll"><table><thead><tr><th>Produs</th><th className="numeric">Cant.</th><th className="numeric">Valoare</th></tr></thead><tbody>{items.map(p=><tr key={p.code}><td>{p.name}<small>{p.code}</small></td><td className="numeric">{quantity(p.quantityMicros)}</td><td className="numeric">{amount(p.valueCents)}</td></tr>)}</tbody></table></div>;
}
export function PartnerSales({id,initialRange}:{id:string;initialRange?:{from:string;to:string}}) {
  const [open,setOpen]=useState(true),[scope,setScope]=useState('auto'),[from,setFrom]=useState(initialRange?.from||''),[to,setTo]=useState(initialRange?.to||''),[page,setPage]=useState(0),[retry,setRetry]=useState(0);
  const [data,setData]=useState<{key:string;value:PartnerSalesResult}|null>(null),[failure,setFailure]=useState<{key:string;text:string}|null>(null),[transactionsOpen,setTransactionsOpen]=useState(false);
  const key=JSON.stringify([id,scope,from,to,page,retry]);
  const result=data?.key===key?data.value:null,error=failure?.key===key?failure.text:'',loading=open&&!result&&!error;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const query=new URLSearchParams({page:String(page),scope});
    if(from)query.set('from',from);if(to)query.set('to',to);
    api<PartnerSalesResult>(`partner/portfolio/${encodeURIComponent(id)}/sales?${query}`,'GET',undefined,controller.signal)
      .then(value=>{if(!controller.signal.aborted){setData({key,value});setFailure(null);}})
      .catch(err=>{if(!controller.signal.aborted)setFailure({key,text:errorMessage(err)});});
    return()=>controller.abort();
  },[id,open,scope,from,to,page,key]);
  const ready=result?.state==='ready'?result:null;
  return <details className="partner-sales partner-sales-overview" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Vânzări</summary>
    {open&&<div className="partner-sales-body">
      {loading&&<output>Se încarcă istoricul…</output>}
      {error&&<p role="alert">{error} <button type="button" onClick={()=>setRetry(v=>v+1)}>Reîncearcă</button></p>}
      {result&&result.state!=='ready'&&<p>{result.message}</p>}
      <details className="partner-sales-period"><summary>{from||to?'Perioadă personalizată':'Tot istoricul'} · Schimbă perioada</summary>
        <div className="partner-sales-filters">
          <label>De la<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setPage(0);}}/></label>
          <label>Până la<input type="date" value={to} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label>
          {(from||to)&&<button type="button" onClick={()=>{setFrom('');setTo('');setPage(0);}}>Tot istoricul</button>}
        </div>
      </details>
      {ready&&<>
        {ready.pointHistoryAvailable&&ready.companyHistoryAvailable&&<label className="partner-sales-scope">Istoric afișat<select value={ready.scope} onChange={e=>{setScope(e.target.value);setPage(0);}}><option value="company">Clientul · toate vânzările</option><option value="point">Doar acest punct de lucru</option></select></label>}
        {ready.scope==='company'&&<p className="partner-sales-company"><strong>Istoricul firmei</strong><br/>{'Include toate punctele de lucru și vânzările fără punct completat, indiferent de agentul care a facturat.'}</p>}
        <div className="partner-sales-kpis">
          <div><small>Ultima facturare</small><strong>{date(ready.documents.lastBilling)}</strong></div>
          <div><small>{ready.coverageComplete?(ready.scope==='company'?'Vânzări firmă cu TVA':'Vânzări punct cu TVA'):'Vânzări asociate · parțial'}</small><strong>{ready.totals.rows?amount(ready.totals.valueCents):money(0)}</strong></div>
          <div><small>Facturi în perioadă*</small><strong>{ready.documents.count.toLocaleString('ro-RO')}</strong></div>
        </div>
        <p className="partner-sales-source">{date(ready.from)} – {date(ready.to)} · Import până la {date(ready.through)}. Retururile sunt incluse în vânzări.</p>
        {!ready.coverageComplete&&<p className="partner-sales-caution">Istoric parțial: sunt incluse doar vânzările asociate sigur acestei fișe.</p>}
        {!!ready.totals.missingValues&&<p className="partner-sales-caution">{ready.totals.missingValues} linii au valoarea lipsă și nu sunt incluse în suma cunoscută.</p>}

        {ready.documents.count===0&&ready.totals.rows>0&&<p>Există mișcări în istoric, fără facturi cu valoare netă pozitivă. Ultima înregistrare: <strong>{date(ready.totals.lastMovement)}</strong>. Detaliile sunt disponibile la produse și tranzacții.</p>}
        <h4>Ultimele 5 facturi</h4>
        {ready.latestDocuments.length?<div className="partner-invoices">
          {ready.latestDocuments.map(d=><details className="partner-invoice" key={JSON.stringify([d.date,d.site,d.document])}>
            <summary><span><strong>{date(d.date)}</strong><small>Nr. {d.document}</small></span><strong>{amount(d.valueCents)}</strong></summary>
            <div className="partner-invoice-body"><p>Gestiune: {d.site} · Agent la facturare: {d.sellers.filter(Boolean).join(', ')||'Nespecificat'}</p>
              <Products items={d.products}/>
              {d.hasMoreProducts&&<p>Primele 20 de produse după valoare. Restul liniilor sunt disponibile în „Tranzacții”.</p>}
            </div>
          </details>)}
          <p className="partner-invoices-total">Total facturi afișate ({ready.latestDocuments.length}): <strong>{amount(ready.latestDocuments.reduce((sum,d)=>sum+d.valueCents,0))}</strong></p>
        </div>:<p>Nu există facturi cu valoare pozitivă în perioada selectată.</p>}

        <h4>Produse cumpărate · top după valoare</h4>
        {ready.products.length?<><Products items={ready.products.slice(0,5)}/>{ready.products.length>5&&<details><summary>Mai multe produse · top {ready.products.length}</summary><Products items={ready.products.slice(5)}/></details>}</>:<p>Nu există produse asociate în această perioadă.</p>}

        {!initialRange&&<details className="partner-sales-cadence"><summary>Ritmul de facturare · {labels[ready.activity.status]}</summary>
          <div className="partner-sales-health">
            <p>{ready.activity.reason}</p>
            {ready.activity.cadenceDays!==null&&<p>Ritm obișnuit: aproximativ <strong>{ready.activity.cadenceDays} zile</strong>.</p>}
            {ready.activity.isNew&&<span>Prima facturare recentă</span>}
            {ready.activity.reactivated&&<span>Reactivat</span>}
            {ready.activity.seasonalPossible&&<span>Posibil sezonier</span>}
            <p>Evaluare pe întregul istoric, până la {date(ready.activity.asOf)}.</p>
          </div>
        </details>}
        <details><summary>Evoluție lunară</summary>
          {ready.monthly.length?<div className="partner-sales-scroll"><table><thead><tr><th>Luna</th><th>Cantitate</th><th>Valoare</th></tr></thead><tbody>{ready.monthly.map(m=><tr key={m.month}><td>{m.month}</td><td>{quantity(m.quantityMicros)}</td><td>{amount(m.valueCents)}{m.missingValues?' *':''}</td></tr>)}</tbody></table></div>:<p>Nu există tranzacții asociate în perioada selectată.</p>}
        </details>
        <details><summary>Agenții care au facturat</summary><div className="partner-sales-scroll"><table><thead><tr><th>Agent din istoric</th><th>Valoare</th></tr></thead><tbody>{ready.sellers.map(s=><tr key={s.seller}><td>{s.seller||'Agent lipsă'}</td><td>{amount(s.valueCents)}</td></tr>)}</tbody></table></div></details>
        <details open={transactionsOpen} onToggle={event=>setTransactionsOpen(event.currentTarget.open)}><summary>Toate tranzacțiile ({ready.totals.rows.toLocaleString('ro-RO')})</summary><div className="partner-sales-scroll"><table><thead><tr><th>Data / document</th><th>Produs / agent</th><th>Cantitate</th><th>Valoare</th></tr></thead><tbody>{ready.transactions.map((t,i)=><tr key={i}><td>{date(t.date)}<small>{t.document} · {t.site}</small></td><td>{t.itemName}<small>{t.seller}</small></td><td>{quantity(t.quantityMicros)}</td><td>{amount(t.valueCents)}</td></tr>)}</tbody></table></div><div className="partner-sales-pagination"><button type="button" disabled={page===0} onClick={()=>setPage(v=>v-1)}>Anterioare</button><span>Pagina {page+1}</span><button type="button" disabled={!ready.hasMore} onClick={()=>setPage(v=>v+1)}>Următoarele</button></div></details>
        <p className="partner-sales-footnote">* Documente distincte cu valoare netă pozitivă, identificate prin dată, gestiune și număr. Documentele anulate și retururile separate rămân în tranzacții.</p>
      </>}
    </div>}
  </details>;
}
