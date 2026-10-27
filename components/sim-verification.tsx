 'use client';
import {useEffect,useRef,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import type {SimSale,SimVerification} from '@/lib/sim-verification-types';
import './sim-verification.css';
const date=(value:string|null)=>value?value.split('-').reverse().join('.'):'Nespecificată';
const kind=(sale:SimSale)=>sale.kind==='agent'?'Agent / TR':sale.kind==='store'?'Magazin':sale.kind==='inventory'?'Stoc / inventar':'Sediu central';
export function SimVerificationPanel(){
 const [access,setAccess]=useState<{digi:boolean}|null>(null),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();api<{digi:boolean}>('sim/verify','GET',undefined,controller.signal).then(setAccess).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});return()=>controller.abort();},[]);
 return <><SimOperatorPanel provider="vodafone"/>{error&&<p role="alert">{error}</p>}{access?.digi&&<SimOperatorPanel provider="digi"/>}</>;
}
function SimOperatorPanel({provider}:{provider:'vodafone'|'digi'}){
 const digi=provider==='digi',label=digi?'Digi':'Vodafone',inputId=digi?'sim-serial-digi':'sim-serial';
 const [serial,setSerial]=useState(''),[result,setResult]=useState<SimVerification|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const input=useRef<HTMLInputElement>(null),request=useRef<AbortController|null>(null);
 // Opening this dedicated scanner tab is an explicit navigation action.
 useEffect(()=>{if(!digi)input.current?.focus();return()=>request.current?.abort();},[digi]);
 function change(value:string){request.current?.abort();setBusy(false);setSerial(value);setResult(null);setError('');}
 async function check(){
  const value=serial.trim();if(!(digi?/^[0-9]{19}$/:/^[0-9]{18,22}$/).test(value)){setError(digi?'Scanează sau introdu o serie Digi validă (19 cifre).':'Scanează sau introdu o serie SIM validă (18–22 cifre).');setResult(null);return;}
  request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError('');setResult(null);
  try{const answer=await api<SimVerification>('sim/verify','POST',{serial:value,provider},controller.signal);if(!controller.signal.aborted)setResult(answer);}
  catch(e){if(!controller.signal.aborted)setError(errorMessage(e));}
  finally{if(!controller.signal.aborted){setBusy(false);input.current?.focus();input.current?.select();}}
 }
 return <section className="panel sim-verification" aria-label={"Verificare SIM "+label} data-provider={provider}><h2>Verificare Sim · {label}</h2><p>Caută în întregul istoric al agenților și magazinelor Mobiup și MobiCell, inclusiv SIM-uri neactivate. Selecțiile din rapoarte nu limitează căutarea.</p>
 <form onSubmit={e=>{e.preventDefault();void check();}}><label htmlFor={inputId}>Seria SIM</label><div className="sim-search"><input id={inputId} ref={input} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={40} value={serial} placeholder="Scanează sau introdu seria" onChange={e=>change(e.target.value)} onKeyDown={e=>{if((e.key==='Enter'||e.key==='Tab')&&serial.trim()){if(e.key==='Enter')e.preventDefault();void check();}}}/><button type="submit" className="primary" disabled={busy}>{busy?'Se verifică…':'Verifică'}</button></div></form>
 <div aria-live="polite" aria-busy={busy}>{error&&<p role="alert">{error}</p>}{result&&<><p className="sim-result"><strong>{result.status==='sold'?'SIM comercializat de noi':result.status==='not_found'?'Acest SIM nu a fost comercializat de noi, conform datelor disponibile.':result.status==='returned'?'SIM returnat — fără vânzare curentă confirmată':result.status==='ambiguous'?'SIM găsit — istoricul necesită verificare':'SIM găsit în evidență — fără vânzare confirmată'}</strong></p>
 {result.sale&&<dl className="sim-sale"><dt>{kind(result.sale)}</dt><dd>{result.sale.seller}</dd><dt>Companie</dt><dd>{result.sale.company}</dd><dt>Data vânzării</dt><dd>{date(result.sale.date)}</dd><dt>Nr. bon / document</dt><dd>{result.sale.receipt||(digi?'Numărul documentului nu este disponibil în sursa Digi.':'Nespecificat în sursă')}</dd></dl>}
 {result.history.length>0&&<details open={result.status!=='sold'}><summary>Istoric ({result.history.length} mișcări)</summary><div className="sim-history">{result.history.map((sale,i)=><article key={i}><strong>{sale.quantity===-1?'Retur':sale.quantity===1?'Ieșire':'Mișcare neclară'} · {date(sale.date)}</strong><span>{sale.company} · {kind(sale)}: {sale.seller}</span><span>Nr. bon / document: {sale.receipt||(digi?'Indisponibil în sursa Digi':'Nespecificat în sursă')}</span></article>)}</div></details>}
 <p className="commerce-source">Ultima sursă de vânzări: {date(result.sourceDate||null)}. Import: {date(result.importedAt.slice(0,10)||null)}.</p></>}</div></section>;
}
