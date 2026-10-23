'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ClipboardCheck, RefreshCw, Store, Users, Boxes, ScanBarcode } from 'lucide-react';
import { api, errorMessage } from '@/lib/client-api';
import { bucharestReportingMonthKey } from '@/lib/bucharest-month';
import type { PartnerRequestRecord, TeamActivityView, User } from '@/lib/types';
import { PartnerActivityDetail } from './partner-activity-detail';
import type { ManagerScope } from './manager-scope';
import './manager-workspace.css';
import {ReportPeriod,periodLabel} from './report-period';

export type ManagerDestination = 'partner' | 'sales' | 'clients' | 'stock' | 'inventory' | 'orders' | 'sim';
type Activity = {activity: TeamActivityView; confirmed: number; confirmedByAgent: Record<string, number>; finalizedOrders: number; finalizedNotices: number};
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

export function ManagerOverview({scope,users,month,onMonth,onRequests,onAgent}: {scope:ManagerScope;users:User[];month:string;onMonth:(value:string)=>void;onRequests:()=>void;onAgent:(id:string,destination:ManagerDestination)=>void}) {
  const [reload,setReload] = useState(0);
  const {data,error} = useActivity(scope.query,month,reload);
  return <div className="manager-overview">
    <div className="page-heading"><div><span className="eyebrow">SPAȚIUL MANAGERULUI</span><h1>Sinteză</h1><p>{scope.label}</p></div><button className="icon-button" aria-label="Actualizează sinteza" onClick={()=>setReload(value=>value+1)}><RefreshCw size={18}/></button></div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    <ReportPeriod label="Luna activității" selected={[month]} multiple={false} onChange={months=>onMonth(months[0])}/>
    <h2 className="manager-operational-title">Activitate operațională <small>{periodLabel([month])}</small></h2>
    <div className="manager-summary-grid">
      <button className="manager-metric" onClick={onRequests}><Store size={19}/><span>CLIENȚI NOI</span><strong>{data?data.confirmed:'—'}</strong><small>Puncte noi în portofoliu în luna selectată</small></button>
      <button className="manager-metric" onClick={()=>onAgent(scope.agentId,'inventory')}><ClipboardCheck size={19}/><span>INVENTARE FINALIZATE</span><strong>{data?data.activity.totals.finalizedInventories:'—'}</strong><small>Finalizate în luna selectată</small></button>
      <button className="manager-metric" onClick={()=>onAgent(scope.agentId,'orders')}><Boxes size={19}/><span>COMENZI FINALIZATE</span><strong>{data?data.finalizedOrders:'—'}</strong><small>Finalizate în luna selectată, fără ciorne</small></button>
      <button className="manager-metric" onClick={()=>onAgent(scope.agentId,'sim')}><ScanBarcode size={19}/><span>AVIZE FINALIZATE</span><strong>{data?data.finalizedNotices:'—'}</strong><small>SIM și standuri la client, fără ciorne</small></button>
    </div>
    <section className="panel manager-team-panel"><div className="panel-heading"><div><h2>Situația pe agent</h2><span className="count-pill">{data?.activity.agents.length??'—'}</span></div></div>
      {!data?<p className="portfolio-message">{error?'Activitatea nu este disponibilă.':'Se încarcă activitatea…'}</p>:!data.activity.agents.length?<p className="portfolio-message">Nu există agenți în selecție.</p>:<div className="manager-table-scroll"><table className="manager-agent-table"><thead><tr><th>Agent / TR</th><th>Clienți noi</th><th>Inventare</th><th>Portofoliu</th></tr></thead><tbody>{data.activity.agents.map(agent=>{
        const user=users.find(user=>user.id===agent.agentId);
        return <tr key={agent.agentId}><th><button className="manager-agent-name" onClick={()=>onAgent(agent.agentId,'orders')}>{agent.agentName}</button><small>{user?.siteCode||agent.warehouseName}{!agent.active?' · inactiv':''}</small></th><td>{data.confirmedByAgent[agent.agentId]||0}</td><td>{agent.finalizedInventories}</td><td><button className="quiet" aria-label={`Partenerii agentului ${agent.agentName}`} onClick={()=>onAgent(agent.agentId,'partner')}>{agent.clientCount} puncte <ArrowRight size={14}/></button></td></tr>;
      })}</tbody></table></div>}
      <p className="manager-data-note">Inventarele sunt atribuite autorului; totalul include și inventarele managerului. Clienții comuni sunt numărați o singură dată în total.</p>
    </section>
  </div>;
}

export function ManagerRequests({scopeQuery,month,onMonth,focusRequestId,onBack}: {scopeQuery:string;month:string;onMonth:(value:string)=>void;focusRequestId?:string;onBack:()=>void;}) {
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
    <p className="manager-data-note">Clienții noi sunt disponibili imediat, fără aprobare. Luna selectată include clienții adăugați atunci.</p>
    {error&&<p className="error-banner" role="alert">{error} <button className="secondary" onClick={refresh}>Reîncearcă</button></p>}
    {data?<PartnerActivityDetail key={`${scopeQuery}:${focusRequestId||''}`} workspace view={data.activity} month={month} loading={false} focusRequestId={focusRequestId} onBack={onBack} onMonthChange={onMonth} onRefresh={refresh}/>:!error&&<p className="portfolio-message">Se încarcă clienții noi…</p>}
  </div>;
}

export function ManagerTeamLinks({scope,onAgent}: {scope:ManagerScope;onAgent:(id:string,destination:ManagerDestination)=>void}) {
  return <section className="manager-team-links"><div className="page-heading"><div><span className="eyebrow">ECHIPA TA</span><h1>Echipă</h1><p>Deschide direct spațiul de lucru al unui agent.</p></div><Users size={24}/></div>
    {scope.selectedAgents.length?<div className="panel manager-table-scroll"><table className="manager-agent-table"><thead><tr><th>Agent / TR</th><th>Acces rapid</th></tr></thead><tbody>{scope.selectedAgents.map(agent=><tr key={agent.id}><th>{agent.name}<small>{agent.siteCode||agent.warehouseName}{agent.active===0?' · inactiv':''}</small></th><td><div className="manager-agent-actions">{([['partner','Parteneri'],['sales','Accesorii'],['clients','Vânzări pe clienți'],['stock','Stoc'],['inventory','Inventar'],['orders','Comenzi']] as const).map(([destination,label])=><button className="secondary" key={destination} onClick={()=>onAgent(agent.id,destination)}>{label}</button>)}</div></td></tr>)}</tbody></table></div>:<p className="portfolio-message">Nu există agenți în selecție.</p>}
  </section>;
}
