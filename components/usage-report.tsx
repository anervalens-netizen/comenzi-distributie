'use client';
import {useEffect,useState} from 'react';
import {networkApi,errorMessage} from '@/lib/client-api';
import type {UsageSnapshot} from '@/lib/usage-model';
import './usage-report.css';
type Account={id:string;name:string;username:string;role:string;active:number;visibleMs:number;activeMs:number;opens:number;days:number;lastSeen:number;logins:number};
type Report=UsageSnapshot&{from:string;to:string;generatedAt:number;users:Account[]};
const day=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const stamp=(at:number)=>at?new Date(at).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'}):'—';
const duration=(ms:number)=>ms<60_000?`${Math.floor(ms/1000)} s`:`${Math.floor(ms/3600000)} h ${Math.floor(ms/60000)%60} min`;
const screenLabels:Record<string,string>={orders:'Comenzi',sim:'Avize',transfers:'Transferuri',partner:'Parteneri',sales:'Vânzări',activations:'Activări',stock:'Stoc',catalog:'Catalog',activity:'Sinteză',team:'Echipă',settings:'Setări',editor:'Editor',result:'Document'};
export function UsageReport({scopeQuery}:{scopeQuery:string}){
  const [from,setFrom]=useState(()=>day(new Date(Date.now()-6*86400000))),[to,setTo]=useState(()=>day(new Date())),[role,setRole]=useState('agent'),[detail,setDetail]=useState(''),[reload,setReload]=useState(0);
  const requestKey=[from,to,detail,reload,scopeQuery].join('|');
  const [result,setResult]=useState<{key:string;data:Report|null;error:string}|null>(null);
  const data=result?.key===requestKey?result.data:null,error=result?.key===requestKey?result.error:'',loading=result?.key!==requestKey;
  useEffect(()=>{let live=true;
    const p=new URLSearchParams(scopeQuery);p.set('from',from);p.set('to',to);if(detail)p.set('userId',detail);
    void networkApi<Report>('usage/report?'+p).then(data=>{if(live)setResult({key:requestKey,data,error:''});}).catch(e=>{if(live)setResult({key:requestKey,data:null,error:errorMessage(e)});});
    return ()=>{live=false;};
  },[from,to,detail,reload,scopeQuery,requestKey]);
  const accounts=(data?.users||[]).filter(u=>role==='all'||u.role===role),selected=data?.users.find(u=>u.id===detail);
  function download(){if(!data)return;const rows=[['Cont','Nume','Rol','Activ','Autentificări','Deschideri','Zile cu utilizare','Vizibil (secunde)','Activ estimat (secunde)','Ultima prezență'],...accounts.map(u=>[u.username,u.name,u.role,u.active?'Da':'Nu',u.logins,u.opens,u.days,Math.floor(u.visibleMs/1000),Math.floor(u.activeMs/1000),stamp(u.lastSeen)])];
    const csv='\ufeff'+rows.map(row=>row.map(value=>'"'+String(value).replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"').join(';')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`utilizare-${from}-${to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section className="usage-report" aria-label="Utilizarea aplicației">
    <div className="page-heading"><div><span className="eyebrow">ACCES ȘI UTILIZARE</span><h1>Utilizarea aplicației</h1><p>Conturi autentificate, frecvență și timp observat în aplicație.</p></div><button className="secondary" onClick={()=>setReload(n=>n+1)} disabled={loading}>Actualizează</button></div>
    <div className="usage-filters"><label>De la<input aria-label="Utilizare de la" type="date" value={from} max={to} onChange={e=>{setFrom(e.target.value);setDetail('');}}/></label><label>Până la<input aria-label="Utilizare până la" type="date" value={to} min={from} max={day(new Date())} onChange={e=>{setTo(e.target.value);setDetail('');}}/></label><label>Conturi<select value={role} onChange={e=>{setRole(e.target.value);setDetail('');}}><option value="agent">Agenți</option><option value="manager">Manageri</option><option value="all">Toate conturile</option></select></label><button className="secondary" disabled={!data||loading} onClick={download}>Export CSV</button></div>
    <p className="muted">Vizibil = aplicația în prim-plan. Activ estimat = timp vizibil în maximum 2 minute de la o interacțiune. Filele și dispozitivele suprapuse se numără o singură dată pe cont. Durata nu dovedește atenția sau munca efectivă.</p>
    {loading&&<output aria-live="polite">Se încarcă utilizarea…</output>}{error&&<p className="error-banner" role="alert">{error}</p>}
    {data&&<><p className="muted">Măsurare disponibilă din {stamp(data.since)} · păstrare {data.retentionDays} zile · ore București · actualizat {stamp(data.generatedAt)}. Datele lipsă, perioadele offline și versiunile vechi ale aplicației nu pot fi reconstruite.</p>
      <div className="stats-strip"><div><span>CONTURI CU UTILIZARE</span><strong>{accounts.filter(u=>u.visibleMs>0).length}<small>din {accounts.length}</small></strong></div><div><span>TIMP VIZIBIL</span><strong>{duration(accounts.reduce((n,u)=>n+u.visibleMs,0))}</strong></div><div><span>ACTIV ESTIMAT</span><strong>{duration(accounts.reduce((n,u)=>n+u.activeMs,0))}</strong></div><div><span>AUTENTIFICĂRI</span><strong>{accounts.reduce((n,u)=>n+u.logins,0)}</strong></div></div>
      <div className="usage-table"><table><caption>Utilizare pe cont în perioada selectată</caption><thead><tr><th>Cont</th><th>Autentificări</th><th>Deschideri</th><th>Zile</th><th>Vizibil</th><th>Activ estimat</th><th>Ultima prezență</th><th>Detalii</th></tr></thead><tbody>{accounts.map(u=><tr key={u.id}><th scope="row">{u.name}<small>{u.username}{!u.active?' · dezactivat':''}</small></th><td>{u.logins}</td><td>{u.opens}</td><td>{u.days}</td><td>{duration(u.visibleMs)}</td><td>{duration(u.activeMs)}</td><td>{stamp(u.lastSeen)}</td><td><button className="quiet" aria-label={`Detalii utilizare ${u.name}`} onClick={()=>setDetail(u.id)}>Vezi</button></td></tr>)}</tbody></table></div>
      {!accounts.length&&<p>Niciun cont în selecție.</p>}
      {selected&&<section className="panel usage-detail"><div className="page-heading"><h2>{selected.name} · acces și sesiuni</h2><button className="quiet" onClick={()=>setDetail('')}>Închide detaliile</button></div><p className="muted">Autentificările sunt intrările cu parolă. Deschiderile includ revenirea în aplicație cu sesiune existentă. Închiderea unei file poate lipsi; ultima prezență este ultimul semnal primit. IP-ul indică rețeaua, nu identifică sigur o persoană.</p>
        <h3>Autentificări și ieșiri explicite</h3>{!data.events.length?<p>Nu sunt evenimente în perioada selectată.</p>:<div className="usage-table"><table><thead><tr><th>Moment</th><th>Eveniment</th><th>IP</th><th>Dispozitiv / browser</th></tr></thead><tbody>{data.events.map(e=><tr key={e.id}><td>{stamp(e.at)}</td><td>{e.event==='login'?'Autentificare':'Ieșire din cont'}</td><td>{e.ip||'Indisponibil'}</td><td className="usage-device">{e.device||'Necunoscut'}</td></tr>)}</tbody></table></div>}
        <h3>Sesiuni de utilizare</h3><p className="muted">Durate pe deschidere/filă; acestea se pot suprapune. Totalurile de mai sus elimină suprapunerile. O sesiune care traversează limita perioadei este afișată integral aici.</p>
        {!data.visits.length?<p>Nu sunt sesiuni măsurate în perioada selectată.</p>:<div className="usage-table"><table><thead><tr><th>Deschidere</th><th>Ultima prezență</th><th>Vizibil</th><th>Activ estimat</th><th>IP</th><th>Ultimul ecran</th><th>Stare</th></tr></thead><tbody>{data.visits.map(v=><tr key={v.id}><td>{stamp(v.started_at)}</td><td>{stamp(v.last_seen)}</td><td>{duration(v.visible_ms)}</td><td>{duration(v.active_ms)}</td><td>{v.ip||'Indisponibil'}</td><td>{screenLabels[v.screen]||v.screen}</td><td>{v.closed_at?'Încheiată / ascunsă':data.generatedAt-v.last_seen<75_000?'Semnal recent':'Fără semnal recent'}</td></tr>)}</tbody></table></div>}
        {data.detailsLimited&&<p>Sunt afișate cele mai recente 100 de înregistrări din fiecare listă. Restrânge perioada pentru detalii mai vechi.</p>}
      </section>}
    </>}
  </section>;
}
