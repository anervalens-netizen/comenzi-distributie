'use client';
import {useEffect,useRef,useState} from 'react';
import {CheckCircle2,Clock3,RefreshCw,ScanBarcode,TrendingUp} from 'lucide-react';
import {api,errorMessage} from '@/lib/client-api';
import {bucharestMonthKey} from '@/lib/bucharest-month';
import type {ActivationReport,ActivationProvider} from '@/lib/activation-types';
import {Tabs,TabsContent,TabsList,TabsTrigger} from './ui/tabs';
import './activations.css';
const number=(n:number)=>n.toLocaleString('ro-RO');
const monthLabel=(month:string)=>new Date(month+'-01T12:00:00Z').toLocaleDateString('ro-RO',{month:'long',year:'numeric',timeZone:'Europe/Bucharest'});
const dateLabel=(date:string)=>new Date(date+'T12:00:00Z').toLocaleDateString('ro-RO',{day:'2-digit',month:'long',year:'numeric',timeZone:'Europe/Bucharest'});
export function ActivationsPanel({userId,scopeQuery='',scopeLabel='Activările mele'}:{userId:string;scopeQuery?:string;scopeLabel?:string}){
  const current=bucharestMonthKey(new Date());
  const [view,setView]=useState('current'),[selected,setSelected]=useState(current),[reload,setReload]=useState(0);
  const [provider,setProvider]=useState<ActivationProvider>('vodafone');
  const [result,setResult]=useState<{key:string;data:ActivationReport}|null>(null),[error,setError]=useState<{key:string;message:string}|null>(null);
  const sequence=useRef(0);
  const month=view==='current'?current:selected;
  const params=new URLSearchParams(scopeQuery);params.set('month',month);params.set('provider',provider);
  const query=params.toString(),key=userId+'|'+query+'|'+reload;
  const data=result?.key===key?result.data:null,message=error?.key===key?error.message:'';
  useEffect(()=>{
    const id=++sequence.current,controller=new AbortController();
    api<ActivationReport>('activations?'+query,'GET',undefined,controller.signal)
      .then(data=>{if(id===sequence.current)setResult({key,data});})
      .catch(e=>{if(id===sequence.current&&e?.name!=='AbortError')setError({key,message:errorMessage(e)});});
    return()=>controller.abort();
  },[key,query]);
  const months=[...new Set([current,selected,...(data?.months.map(m=>m.month)||[])])].sort().reverse();
  const body=message?<div className="activation-empty" role="alert"><strong>{message}</strong><button className="secondary" onClick={()=>setReload(v=>v+1)}>Încearcă din nou</button></div>:!data?<output className="activation-empty">Se încarcă activările…</output>:!data.available?<div className="activation-empty"><ScanBarcode size={30}/><h2>Nu sunt încă date de activare</h2><p>Activările vor apărea aici după încărcarea rapoartelor.</p></div>:<>
    <div className="activation-period"><div><span className="eyebrow">{scopeLabel}</span><h2>{provider==='digi'?'Digi':'Vodafone'} · {monthLabel(month)}</h2></div>{data.latestDate&&<span className="activation-through"><CheckCircle2 size={16}/>Ultima activare din sursă: {dateLabel(data.latestDate)}</span>}</div>
    <div className="activation-cards">
      <div className="activation-card activation-primary"><span>Activări în lună</span><strong>{number(data.totals.total)}</strong><small>Serii distincte activate</small></div>
      <div className="activation-card"><span>SIM</span><strong>{number(data.totals.sim)}</strong><small>Cartele SIM</small></div>
      <div className="activation-card"><span>TELSIM</span><strong>{number(data.totals.telsim)}</strong><small>Pachete cu telefon</small></div>
      {!data.scoped&&<div className="activation-card"><span>De repartizat</span><strong>{number(data.totals.unassigned)}</strong><small>Incluse în totalul lunii</small></div>}
    </div>
    {data.totals.other>0&&<p className="muted">Alte produse: {number(data.totals.other)} activări.</p>}
    {!data.totals.total?<div className="activation-empty"><ScanBarcode size={28}/><h3>Nicio activare în selecția curentă</h3><p>Poți consulta o altă lună din Istoric.</p></div>:<section className="panel activation-table-panel"><div className="panel-heading"><div><h2>Activări pe TR</h2><span className="count-pill">{data.sites.filter(s=>s.site).length} TR</span></div></div><div className="activation-scroll"><table className="activation-table"><thead><tr><th>Agent / TR</th><th>SIM</th><th>TELSIM</th><th>Total</th></tr></thead><tbody>{data.sites.map(site=><tr key={site.site||'unassigned'}><th>{site.label}<small>{site.site||'Necesită verificarea repartizării'}</small></th><td>{number(site.sim)}</td><td>{number(site.telsim)}</td><td><strong>{number(site.total)}</strong></td></tr>)}</tbody></table></div></section>}
    <p className="activation-note">Luna este stabilită după data activării, inclusiv pentru cartele vândute anterior.{data.scoped?' Sunt afișate activările repartizate TR-ului selectat.':' Activările de repartizat sunt numărate o singură dată în total.'}</p>
    {view==='history'&&data.history.length>0&&<section className="panel activation-table-panel"><div className="panel-heading"><h2>Istoric lunar</h2></div><div className="activation-scroll"><table className="activation-table"><thead><tr><th>Luna</th><th>SIM</th><th>TELSIM</th><th>Total</th></tr></thead><tbody>{data.history.map(row=><tr key={row.month} className={row.month===month?'activation-selected':''}><th><button className="activation-month" aria-pressed={row.month===month} onClick={()=>setSelected(row.month)}>{monthLabel(row.month)}</button></th><td>{number(row.sim)}</td><td>{number(row.telsim)}</td><td><strong>{number(row.total)}</strong></td></tr>)}</tbody></table></div></section>}
  </>;
  return <div className="activation-workspace"><div className="page-heading"><div><span className="eyebrow">ACTIVĂRI SIM</span><h1>Activări</h1></div><button className="icon-button refresh" aria-label="Actualizează activările" onClick={()=>setReload(v=>v+1)}><RefreshCw size={19}/></button></div><div className="activation-toolbar"><label>Operator<select aria-label="Operator" value={provider} onChange={e=>setProvider(e.target.value as ActivationProvider)}><option value="vodafone">Vodafone</option><option value="digi">Digi</option></select></label></div><Tabs value={view} onValueChange={value=>setView(String(value))}><TabsList className="activation-subnav" variant="line" aria-label="Activări"><TabsTrigger value="current"><TrendingUp size={17}/>Luna curentă</TabsTrigger><TabsTrigger value="history"><Clock3 size={17}/>Istoric</TabsTrigger></TabsList><TabsContent value={view}>{view==='history'&&<div className="activation-toolbar"><label>Luna activării<select aria-label="Luna activării" value={selected} onChange={e=>setSelected(e.target.value)}>{months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}</select></label></div>}{body}</TabsContent></Tabs></div>;
}
