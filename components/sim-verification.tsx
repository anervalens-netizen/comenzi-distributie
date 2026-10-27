 'use client';
import {useEffect,useRef,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import type {SimSale,SimVerification} from '@/lib/sim-verification-types';
import './sim-verification.css';
const date=(value:string|null)=>value?value.split('-').reverse().join('.'):'Nespecificată';
const kind=(sale:SimSale)=>sale.kind==='agent'?'Agent / TR':sale.kind==='store'?'Magazin':'Sediu central';
export function SimVerificationPanel(){
 const [serial,setSerial]=useState(''),[result,setResult]=useState<SimVerification|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const input=useRef<HTMLInputElement>(null),request=useRef<AbortController|null>(null);
 // Opening this dedicated scanner tab is an explicit navigation action.
 useEffect(()=>{input.current?.focus();return()=>request.current?.abort();},[]);
 function change(value:string){request.current?.abort();setBusy(false);setSerial(value);setResult(null);setError('');}
 async function check(){
  const value=serial.trim();if(!/^[0-9]{18,22}$/.test(value)){setError('Scanează sau introdu o serie SIM validă (18–22 cifre).');setResult(null);return;}
  request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError('');setResult(null);
  try{const answer=await api<SimVerification>('sim/verify','POST',{serial:value},controller.signal);if(!controller.signal.aborted)setResult(answer);}
  catch(e){if(!controller.signal.aborted)setError(errorMessage(e));}
  finally{if(!controller.signal.aborted){setBusy(false);input.current?.focus();input.current?.select();}}
 }
 return <section className="panel sim-verification" aria-label="Verificare SIM Vodafone"><h2>Verificare Sim · Vodafone</h2><p>Caută în întregul istoric al agenților și magazinelor Mobiup și MobiCell, inclusiv SIM-uri neactivate. Selecțiile din rapoarte nu limitează căutarea.</p>
 <form onSubmit={e=>{e.preventDefault();void check();}}><label htmlFor="sim-serial">Seria SIM</label><div className="sim-search"><input id="sim-serial" ref={input} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={40} value={serial} placeholder="Scanează sau introdu seria" onChange={e=>change(e.target.value)} onKeyDown={e=>{if(e.key==='Tab'&&serial.trim()){void check();}}}/><button type="submit" className="primary" disabled={busy}>{busy?'Se verifică…':'Verifică'}</button></div></form>
 <div aria-live="polite" aria-busy={busy}>{error&&<p role="alert">{error}</p>}{result&&<><p className="sim-result"><strong>{result.status==='sold'?'SIM comercializat de noi':result.status==='not_found'?'Acest SIM nu a fost comercializat de noi, conform datelor disponibile.':result.status==='returned'?'SIM returnat — fără vânzare curentă confirmată':result.status==='ambiguous'?'SIM găsit — istoricul necesită verificare':'SIM găsit în evidență — fără vânzare confirmată'}</strong></p>
 {result.sale&&<dl className="sim-sale"><dt>{kind(result.sale)}</dt><dd>{result.sale.seller}</dd><dt>Companie</dt><dd>{result.sale.company}</dd><dt>Data vânzării</dt><dd>{date(result.sale.date)}</dd><dt>Nr. bon / document</dt><dd>{result.sale.receipt||'Nespecificat în sursă'}</dd></dl>}
 {result.history.length>0&&<details open={result.status!=='sold'}><summary>Istoric ({result.history.length} mișcări)</summary><div className="sim-history">{result.history.map((sale,i)=><article key={i}><strong>{sale.quantity===-1?'Retur':sale.quantity===1?'Ieșire':'Mișcare neclară'} · {date(sale.date)}</strong><span>{sale.company} · {kind(sale)}: {sale.seller}</span><span>Nr. bon / document: {sale.receipt||'Nespecificat în sursă'}</span></article>)}</div></details>}
 <p className="commerce-source">Ultima sursă de vânzări: {date(result.sourceDate||null)}. Import: {date(result.importedAt.slice(0,10)||null)}.</p></>}</div></section>;
}
