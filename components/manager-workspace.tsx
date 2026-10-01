'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ClipboardCheck, RefreshCw, Store, TrendingUp, Bell, Users, Boxes, ScanBarcode } from 'lucide-react';
import { api, errorMessage, money } from '@/lib/client-api';
import { bucharestReportingMonthKey } from '@/lib/bucharest-month';
import type { PartnerRequestRecord, TeamActivityView, User } from '@/lib/types';
import type { SalesView } from '@/lib/sales-types';
import { PartnerActivityDetail } from './partner-activity-detail';
import type { ManagerScope } from './manager-scope';
import './manager-workspace.css';

export type ManagerDestination = 'partner' | 'sales' | 'stock' | 'inventory' | 'orders';
type Activity = {activity: TeamActivityView; pending: number; confirmed: number; pendingByAgent: Record<string, number>; confirmedByAgent: Record<string, number>; finalizedOrders: number; finalizedNotices: number};
export const managerCurrentMonth = () => bucharestReportingMonthKey(new Date());
function useActivity(query: string, month: string, reload: number) {
  const [data, setData] = useState<{key: string; value: Activity} | null>(null);
  const [error, setError] = useState<{key: string; text: string} | null>(null);
  const [loading,setLoading]=useState(true);
  const lastReload=useRef(reload);
  const key = `${query}&month=${encodeURIComponent(month)}`;
  useEffect(() => {
    const controller = new AbortController();
    const forceRefresh=lastReload.current!==reload;
    lastReload.current=reload;
    queueMicrotask(()=>{if(!controller.signal.aborted)setLoading(true);});
    api<Activity>(`manager/activity?${key}`, 'GET', undefined, controller.signal,{preferCache:true,maxAgeMs:15000,forceRefresh})
      .then(value => {if (!controller.signal.aborted) {setData({key,value}); setError(null);}})
      .catch(err => {if (!controller.signal.aborted) setError({key,text:errorMessage(err)});})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return () => controller.abort();
  }, [key,reload]);
  return {data: data?.key === key ? data.value : null, error: error?.key === key ? error.text : '',loading};
}

function MonthControl({month,onMonth,onRefresh}: {month:string;onMonth:(value:string)=>void;onRefresh:()=>void}) {
  return <div className="activity-toolbar"><label>Luna<input aria-label="Luna sintezei" type="month" value={month} onChange={event => {if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) onMonth(event.target.value);}}/></label><button className="icon-button" aria-label="Actualizează sinteza" onClick={onRefresh}><RefreshCw size={18}/></button></div>;
}
export function ManagerOverview({scope,users,month,onMonth,onRequests,onAgent}: {scope:ManagerScope;users:User[];month:string;onMonth:(value:string)=>void;onRequests:()=>void;onAgent:(id:string,destination:ManagerDestination)=>void}) {
  const [reload,setReload] = useState(0);
  const {data,error} = useActivity(scope.query,month,reload);
  const [sales,setSales] = useState<{key:string;value:SalesView}|null>(null);
  const [salesError,setSalesError] = useState<{key:string;text:string}|null>(null);
  const key = new URLSearchParams([...new URLSearchParams(scope.query),['month',month]]).toString();
  const salesReload=useRef(reload);
  useEffect(() => {
    const controller = new AbortController();
    api<SalesView>(`sales?${key}`,'GET',undefined,controller.signal,{preferCache:true,maxAgeMs:15000,forceRefresh:salesReload.current!==reload})
      .then(value => {if (!controller.signal.aborted) {setSales({key,value});setSalesError(null);}})
      .catch(err => {if (!controller.signal.aborted) setSalesError({key,text:errorMessage(err)});});
    salesReload.current=reload;
    return () => controller.abort();
  },[key,reload]);
  useEffect(() => {const refresh=()=>setReload(value=>value+1);window.addEventListener('sales-imported',refresh);return()=>window.removeEventListener('sales-imported',refresh);},[]);
  const currentSales=sales?.key===key?sales.value:null;
  const currentSalesError=salesError?.key===key?salesError.text:'';
  const salesAvailable=!!currentSales?.filename;
  return <div className="manager-overview">
    <div className="page-heading"><div><span className="eyebrow">SPAȚIUL MANAGERULUI</span><h1>Sinteză</h1><p>{scope.label}</p></div><MonthControl month={month} onMonth={onMonth} onRefresh={()=>setReload(value=>value+1)}/></div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {currentSalesError&&<p className="error-banner" role="alert">Vânzările nu au putut fi încărcate: {currentSalesError}</p>}
    <div className="manager-summary-grid">
      <button className="manager-metric" onClick={()=>onAgent(scope.agentId,'sales')}><TrendingUp size={19}/><span>VÂNZĂRI</span><strong className="manager-sales-value">{salesAvailable?<><span className="manager-sales-amount">{new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(currentSales!.summary.value)}</span><span className="manager-sales-currency">RON</span></>:'—'}</strong><small>{salesAvailable?'Valoare în luna selectată':currentSalesError?'Încărcare nereușită':currentSales?'Fără import în această lună':'Se încarcă…'}</small></button>
      <button className="manager-metric" onClick={onRequests}><Store size={19}/><span>CLIENȚI NOI</span><strong>{data?data.confirmed:'—'}</strong><small>Puncte noi în portofoliu în luna selectată</small></button>
      <button className="manager-metric" onClick={onRequests}><Bell size={19}/><span>SOLICITĂRI ÎN AȘTEPTARE</span><strong>{data?data.pending:'—'}</strong><small>Toate cererile restante, inclusiv vechi</small></button>
      <div className="manager-metric"><ClipboardCheck size={19}/><span>INVENTARE FINALIZATE</span><strong>{data?data.activity.totals.finalizedInventories:'—'}</strong><small>Finalizate în luna selectată</small></div>
      <div className="manager-metric"><Boxes size={19}/><span>COMENZI FINALIZATE</span><strong>{data?data.finalizedOrders:'—'}</strong><small>Finalizate în luna selectată, fără ciorne</small></div>
      <div className="manager-metric"><ScanBarcode size={19}/><span>AVIZE FINALIZATE</span><strong>{data?data.finalizedNotices:'—'}</strong><small>SIM și standuri la client, fără ciorne</small></div>
    </div>
    <section className="panel manager-attention"><div><h2>Necesită atenție</h2>{!data?<p>{error?'Datele nu sunt disponibile.':'Se verifică solicitările…'}</p>:data.pending?<p><strong>{data.pending} solicitări</strong> așteaptă confirmarea punctului de lucru.</p>:<p>Nu există solicitări de partener în așteptare în selecție.</p>}</div><button className="secondary" onClick={onRequests}>Deschide solicitările <ArrowRight size={16}/></button></section>
    <section className="panel manager-team-panel"><div className="panel-heading"><div><h2>Situația pe agent</h2><span className="count-pill">{data?.activity.agents.length??'—'}</span></div></div>
      {!data?<p className="portfolio-message">{error?'Activitatea nu este disponibilă.':'Se încarcă activitatea…'}</p>:!data.activity.agents.length?<p className="portfolio-message">Nu există agenți în selecție.</p>:<div className="manager-table-scroll"><table className="manager-agent-table"><thead><tr><th>Agent / TR</th><th>Vânzări</th><th>Clienți noi</th><th>În așteptare</th><th>Inventare</th><th>Portofoliu</th></tr></thead><tbody>{data.activity.agents.map(agent=>{
        const user=users.find(user=>user.id===agent.agentId);
        const sameSite=user?.siteCode?users.filter(other=>other.role==='agent'&&other.active!==0&&other.siteCode.toUpperCase()===user.siteCode.toUpperCase()):[];
        const site=sameSite.length===1?currentSales?.sites.find(site=>site.siteCode.toUpperCase()===user?.siteCode.toUpperCase()):undefined;
        return <tr key={agent.agentId}><th><button className="manager-agent-name" onClick={()=>onAgent(agent.agentId,'sales')}>{agent.agentName}</button><small>{user?.siteCode||agent.warehouseName}{!agent.active?' · inactiv':''}</small></th><td>{salesAvailable&&site?money(site.value):'—'}</td><td>{data.confirmedByAgent[agent.agentId]||0}</td><td>{data.pendingByAgent[agent.agentId]||0}</td><td>{agent.finalizedInventories}</td><td><button className="quiet" aria-label={`Partenerii agentului ${agent.agentName}`} onClick={()=>onAgent(agent.agentId,'partner')}>{agent.clientCount} puncte <ArrowRight size={14}/></button></td></tr>;
      })}</tbody></table></div>}
      <p className="manager-data-note">Inventarele pe agent sunt atribuite autorului; totalul include și inventarele create de manager, fiecare numărat o singură dată. Punctele comune pot apărea la mai mulți agenți; totalul de clienți noi le numără o singură dată. „—” înseamnă date indisponibile, nu vânzări zero.</p>
    </section>
  </div>;
}

export function ManagerRequests({scopeQuery,month,onMonth,focusRequestId,onBack,onChanged,canConfirm}: {scopeQuery:string;month:string;onMonth:(value:string)=>void;focusRequestId?:string;onBack:()=>void;onChanged:()=>void;canConfirm?:(item:PartnerRequestRecord)=>boolean}) {
  const [reload,setReload]=useState(0);
  const {data,error}=useActivity(scopeQuery,month,reload);
  useEffect(()=>{
    if(!focusRequestId)return;
    const controller=new AbortController();
    api<{request:PartnerRequestRecord}>(`partner/requests/${encodeURIComponent(focusRequestId)}`,'GET',undefined,controller.signal).then(result=>{
      if(!controller.signal.aborted)onMonth(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'}).format(new Date(result.request.confirmedAt||result.request.createdAt)));
    }).catch(()=>{});
    return()=>controller.abort();
  },[focusRequestId,onMonth]);
  const refresh=()=>setReload(value=>value+1);
  return <div className="manager-requests">
    <p className="manager-data-note">Cererile în așteptare sunt afișate indiferent de lună. Luna selectată include solicitările create sau confirmate atunci.</p>
    {error&&<p className="error-banner" role="alert">{error} <button className="secondary" onClick={refresh}>Reîncearcă</button></p>}
    {data?<PartnerActivityDetail canConfirm={canConfirm} key={`${scopeQuery}:${focusRequestId||''}`} workspace view={data.activity} month={month} loading={false} focusRequestId={focusRequestId} onBack={onBack} onMonthChange={onMonth} onRefresh={refresh} onRequestsChanged={()=>{refresh();onChanged();}}/>:!error&&<p className="portfolio-message">Se încarcă solicitările…</p>}
  </div>;
}

export function ManagerTeamLinks({scope,onAgent}: {scope:ManagerScope;onAgent:(id:string,destination:ManagerDestination)=>void}) {
  return <section className="manager-team-links"><div className="page-heading"><div><span className="eyebrow">ECHIPA TA</span><h1>Echipă</h1><p>Deschide direct spațiul de lucru al unui agent.</p></div><Users size={24}/></div>
    {scope.selectedAgents.length?<div className="panel manager-table-scroll"><table className="manager-agent-table"><thead><tr><th>Agent / TR</th><th>Acces rapid</th></tr></thead><tbody>{scope.selectedAgents.map(agent=><tr key={agent.id}><th>{agent.name}<small>{agent.siteCode||agent.warehouseName}{agent.active===0?' · inactiv':''}</small></th><td><div className="manager-agent-actions">{([['partner','Parteneri'],['sales','Vânzări'],['stock','Stoc'],['inventory','Inventar'],['orders','Comenzi']] as const).map(([destination,label])=><button className="secondary" key={destination} onClick={()=>onAgent(agent.id,destination)}>{label}</button>)}</div></td></tr>)}</tbody></table></div>:<p className="portfolio-message">Nu există agenți în selecție.</p>}
  </section>;
}
