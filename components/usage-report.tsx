'use client';
import {useEffect,useRef,useState} from 'react';
import {networkApi,errorMessage} from '@/lib/client-api';
import type {UsageSnapshot} from '@/lib/usage-model';
import './usage-report.css';
type Account={id:string;name:string;username:string;role:string;active:number;visibleMs:number;activeMs:number;opens:number;days:number;lastSeen:number;logins:number};
type Report=UsageSnapshot&{from:string;to:string;generatedAt:number;users:Account[]};
const day=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const stamp=(at:number)=>at?new Date(at).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'}):'—';
const duration=(ms:number)=>ms<60_000?`${Math.floor(ms/1000)} s`:`${Math.floor(ms/3600000)} h ${Math.floor(ms/60000)%60} min`;
const screenLabels:Record<string,string>={orders:'Comenzi',sim:'Avize',transfers:'Transferuri',partner:'Parteneri',sales:'Accesorii / vânzări',activations:'Prepay / activări',stock:'Stoc',catalog:'Catalog',activity:'Sinteză',team:'Echipă',settings:'Setări',editor:'Editor',result:'Document'};
export function UsageReport({scopeQuery}:{scopeQuery:string}){
  const [from,setFrom]=useState(()=>day(new Date(Date.now()-6*86400000))),[to,setTo]=useState(()=>day(new Date())),[role,setRole]=useState('agent'),[detail,setDetail]=useState(''),[reload,setReload]=useState(0);
  const requestKey=[from,to,reload,scopeQuery].join('|');
  const detailKey=[from,to,detail,reload,scopeQuery].join('|');
  const [result,setResult]=useState<{key:string;data:Report|null;error:string}|null>(null);
  const [detailResult,setDetailResult]=useState<{key:string;data:Report|null;error:string}|null>(null);
  const dialogRef=useRef<HTMLDialogElement>(null);
  const data=result?.key===requestKey?result.data:null,error=result?.key===requestKey?result.error:'',loading=result?.key!==requestKey;
  const detailData=detailResult?.key===detailKey?detailResult.data:null,detailError=detailResult?.key===detailKey?detailResult.error:'';
  useEffect(()=>{let live=true;
    const p=new URLSearchParams(scopeQuery);p.set('from',from);p.set('to',to);
    void networkApi<Report>('usage/report?'+p).then(data=>{if(live)setResult({key:requestKey,data,error:''});}).catch(e=>{if(live)setResult({key:requestKey,data:null,error:errorMessage(e)});});
    return ()=>{live=false;};
  },[from,to,reload,scopeQuery,requestKey]);
  useEffect(()=>{if(!detail)return;let live=true;
    const p=new URLSearchParams(scopeQuery);p.set('from',from);p.set('to',to);p.set('userId',detail);
    void networkApi<Report>('usage/report?'+p).then(data=>{if(live)setDetailResult({key:detailKey,data,error:''});}).catch(e=>{if(live)setDetailResult({key:detailKey,data:null,error:errorMessage(e)});});
    return ()=>{live=false;};
  },[from,to,detail,reload,scopeQuery,detailKey]);
  useEffect(()=>{if(!detail)return;const dialog=dialogRef.current;if(dialog&&!dialog.open)dialog.showModal();return ()=>{if(dialog?.open)dialog.close();};},[detail]);
  const accounts=(data?.users||[]).filter(u=>role==='all'||u.role===role),selected=data?.users.find(u=>u.id===detail);
  const activeUsers=accounts.filter(u=>u.opens>0||u.logins>0||u.visibleMs>0||u.activeMs>0).length;
  function download(){if(!data)return;const rows=[['Cont','Nume','Rol','Activ','Autentificări','Deschideri','Zile cu utilizare','Vizibil (secunde)','Activ estimat (secunde)','Ultima prezență'],...accounts.map(u=>[u.username,u.name,u.role,u.active?'Da':'Nu',u.logins,u.opens,u.days,Math.floor(u.visibleMs/1000),Math.floor(u.activeMs/1000),stamp(u.lastSeen)])];
    const csv='\ufeff'+rows.map(row=>row.map(value=>'"'+String(value).replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"').join(';')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`utilizare-${from}-${to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section className="usage-report" aria-label="Utilizarea aplicației">
    <div className="page-heading"><div><span className="eyebrow">ACCES ȘI UTILIZARE</span><h1>Utilizarea aplicației</h1><p>Conturi autentificate, frecvență și timp observat în aplicație.</p></div><button className="secondary" onClick={()=>setReload(n=>n+1)} disabled={loading}>Actualizează</button></div>
    <div className="usage-filters"><label>De la<input aria-label="Utilizare de la" type="date" value={from} max={to} onChange={e=>{setFrom(e.target.value);setDetail('');}}/></label><label>Până la<input aria-label="Utilizare până la" type="date" value={to} min={from} max={day(new Date())} onChange={e=>{setTo(e.target.value);setDetail('');}}/></label><label>Conturi<select value={role} onChange={e=>{setRole(e.target.value);setDetail('');}}><option value="agent">Agenți</option><option value="manager">Manageri</option><option value="all">Toate conturile</option></select></label><button className="secondary" disabled={!data||loading} onClick={download}>Export CSV</button></div>
    <p className="muted">Totalurile folosesc perioada și tipul de cont selectate. Utilizator cu activitate = cel puțin o deschidere, autentificare sau timp măsurat. Vizibil = aplicația în prim-plan. Activ estimat = timp vizibil în maximum 2 minute de la o interacțiune. Filele și dispozitivele suprapuse se numără o singură dată pe cont. Durata nu dovedește atenția sau munca efectivă.</p>
    {loading&&<output aria-live="polite">Se încarcă utilizarea…</output>}{error&&<p className="error-banner" role="alert">{error}</p>}
    {data&&<><p className="muted">Măsurare disponibilă din {stamp(data.since)} · păstrare {data.retentionDays} zile · ore București · actualizat {stamp(data.generatedAt)}. Datele lipsă, perioadele offline și versiunile vechi ale aplicației nu pot fi reconstruite.</p>
      <div className="stats-strip" aria-label="Totaluri pentru conturile și perioada selectate"><div><span>UTILIZATORI CU ACTIVITATE</span><strong>{activeUsers}<small>din {accounts.length}</small></strong></div><div><span>DESCHIDERI</span><strong>{accounts.reduce((n,u)=>n+u.opens,0)}</strong></div><div><span>TIMP VIZIBIL</span><strong>{duration(accounts.reduce((n,u)=>n+u.visibleMs,0))}</strong></div><div><span>ACTIV ESTIMAT</span><strong>{duration(accounts.reduce((n,u)=>n+u.activeMs,0))}</strong></div></div>
      <div className="usage-table"><table><caption>Utilizare pe cont în perioada selectată</caption><thead><tr><th>Cont</th><th>Autentificări</th><th>Deschideri</th><th>Zile</th><th>Vizibil</th><th>Activ estimat</th><th>Ultima prezență</th><th>Detalii</th></tr></thead><tbody>{accounts.map(u=><tr key={u.id}><th scope="row">{u.name}<small>{u.username}{!u.active?' · dezactivat':''}</small></th><td>{u.logins}</td><td>{u.opens}</td><td>{u.days}</td><td>{duration(u.visibleMs)}</td><td>{duration(u.activeMs)}</td><td>{stamp(u.lastSeen)}</td><td><button type="button" className="quiet usage-detail-trigger" aria-label={`Detalii utilizare ${u.name}`} onClick={()=>setDetail(u.id)}>Vezi detalii</button></td></tr>)}</tbody></table></div>
      {!accounts.length&&<p>Niciun cont în selecție.</p>}
      {selected&&<dialog ref={dialogRef} className="usage-detail-dialog" aria-label={`Detalii utilizare ${selected.name}`} onClose={()=>setDetail('')}><div className="usage-detail"><div className="page-heading"><h2>{selected.name} · acces și sesiuni</h2><button type="button" className="secondary" onClick={()=>setDetail('')}>Închide</button></div><p className="muted">Autentificările sunt intrările cu parolă. Deschiderile includ revenirea în aplicație cu sesiune existentă. Închiderea unei file poate lipsi; ultima prezență este ultimul semnal primit. IP-ul indică rețeaua, nu identifică sigur o persoană.</p>
        {!detailData&&!detailError&&<output>Se încarcă detaliile…</output>}{detailError&&<p className="error-banner" role="alert">{detailError}</p>}
        {detailData&&<><h3>Autentificări și ieșiri explicite</h3>{!detailData.events.length?<p>Nu sunt evenimente în perioada selectată.</p>:<div className="usage-table"><table><thead><tr><th>Moment</th><th>Eveniment</th><th>IP</th><th>Dispozitiv / browser</th></tr></thead><tbody>{detailData.events.map(e=><tr key={e.id}><td>{stamp(e.at)}</td><td>{e.event==='login'?'Autentificare':'Ieșire din cont'}</td><td>{e.ip||'Indisponibil'}</td><td className="usage-device">{e.device||'Necunoscut'}</td></tr>)}</tbody></table></div>}
        <h3>Sesiuni de utilizare</h3><p className="muted">Durate pe deschidere/filă; acestea se pot suprapune. Sumarul principal elimină suprapunerile. O sesiune care traversează limita perioadei este afișată integral aici.</p>
        {!detailData.visits.length?<p>Nu sunt sesiuni măsurate în perioada selectată.</p>:<div className="usage-table"><table><thead><tr><th>Deschidere</th><th>Ultima prezență</th><th>Vizibil</th><th>Activ estimat</th><th>IP</th><th>Ultimul ecran</th><th>Stare</th></tr></thead><tbody>{detailData.visits.map(v=><tr key={v.id}><td>{stamp(v.started_at)}</td><td>{stamp(v.last_seen)}</td><td>{duration(v.visible_ms)}</td><td>{duration(v.active_ms)}</td><td>{v.ip||'Indisponibil'}</td><td>{screenLabels[v.screen]||v.screen}</td><td>{v.closed_at?'Încheiată / ascunsă':detailData.generatedAt-v.last_seen<75_000?'Semnal recent':'Fără semnal recent'}</td></tr>)}</tbody></table></div>}
        {detailData.detailsLimited&&<p>Sunt afișate cele mai recente 100 de înregistrări din fiecare listă. Restrânge perioada pentru detalii mai vechi.</p>}</>}
      </div></dialog>}
    </>}
  </section>;
}
