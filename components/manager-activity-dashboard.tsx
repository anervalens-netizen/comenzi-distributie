'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, ClipboardCheck, RefreshCw, Store, UserCheck } from 'lucide-react';
import { api, errorMessage } from '@/lib/client-api';
import type { PartnerRequestRecord, TeamActivityView } from '@/lib/types';
import { PartnerActivityDetail } from './partner-activity-detail';

const monthFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'});
const currentMonth=()=>monthFormatter.format(new Date());

export function ManagerActivityDashboard({focusRequestId,onRequestsChanged}:{focusRequestId?:string;onRequestsChanged?:()=>void}) {
  const [month,setMonth]=useState(currentMonth),[view,setView]=useState<TeamActivityView|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0),[detail,setDetail]=useState(false);
  useEffect(()=>{
    let cancelled=false;
    void api<TeamActivityView>(`activity/team?month=${encodeURIComponent(month)}`).then(result=>{if(!cancelled){setView(result);setError('');}}).catch(err=>{if(!cancelled)setError(errorMessage(err));}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[month,reload]);
  useEffect(()=>{
    if(!focusRequestId)return;
    let cancelled=false;
    void api<{request:PartnerRequestRecord}>(`partner/requests/${focusRequestId}`).then(result=>{
      if(cancelled)return;
      setMonth(monthFormatter.format(new Date(result.request.createdAt)));
      setDetail(true);
    }).catch(err=>{if(!cancelled)setError(errorMessage(err));});
    return()=>{cancelled=true;};
  },[focusRequestId]);

  const displayed=view?.month===month?view:null;
  const totals=displayed?.totals;
  const pending=(totals?.partnerRequests??0)-(totals?.partnerConfirmed??0);
  const refresh=()=>{setLoading(true);setReload(value=>value+1);};
  const requestChanged=()=>{refresh();onRequestsChanged?.();};

  if(detail&&displayed) return <PartnerActivityDetail view={displayed} month={month} loading={loading} focusRequestId={focusRequestId} onBack={()=>setDetail(false)} onMonthChange={value=>{setLoading(true);setMonth(value);}} onRefresh={refresh} onRequestsChanged={requestChanged}/>;

  return <div className="manager-activity">
    <div className="activity-dashboard-head">
      <div><span className="eyebrow">MANAGER</span><h1>Activitate</h1><p>Parteneri noi, solicitări și activitatea lunară a echipei.</p></div>
      <div className="activity-toolbar"><label>Luna<input type="month" value={month} onChange={event=>{setLoading(true);setMonth(event.target.value);}}/></label><button className="icon-button" aria-label="Actualizează activitatea" title="Actualizează" onClick={refresh}><RefreshCw size={18}/></button></div>
    </div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    <button className="activity-partners-card" onClick={()=>setDetail(true)} disabled={!displayed&&loading}>
      <span className="activity-partners-icon"><Store size={26}/></span>
      <span className="activity-partners-copy"><span>PARTENERI NOI</span><strong>{totals?.partnerRequests??0}</strong><small>{totals?.partnerConfirmed??0} confirmați · {pending} în așteptare</small></span>
      <span className="activity-partners-action">Vezi detalii <ArrowRight size={19}/></span>
    </button>
    <div className="activity-kpis">
      <div><span>SOLICITĂRI ÎN AȘTEPTARE</span><strong>{pending}</strong><small>de confirmat</small></div>
      <div><UserCheck size={18}/><span>AGENȚI ACTIVI</span><strong>{totals?.activeAgents??0}</strong><small>în scope-ul tău</small></div>
      <div><ClipboardCheck size={18}/><span>INVENTARE FINALIZATE</span><strong>{totals?.finalizedInventories??0}</strong><small>în luna selectată</small></div>
    </div>
    <section className="panel activity-agents-panel">
      <div className="panel-heading"><div><h2>Activitate pe agent</h2><span className="count-pill">{displayed?.agents.length??0}</span></div></div>
      {loading&&!displayed?<p className="portfolio-message">Se încarcă activitatea…</p>:displayed?.agents.length?<div className="activity-agent-list">{displayed.agents.map(agent=>{
        const agentPending=agent.partnerRequests-agent.partnerConfirmed;
        return <div className="activity-agent-row" key={agent.agentId}>
          <span className="activity-agent-avatar">{agent.agentName.split(' ').slice(0,2).map(part=>part[0]).join('')}</span>
          <span className="activity-agent-main"><strong>{agent.agentName}</strong><small>{agent.warehouseName}{agent.active?'':' · cont dezactivat'}</small></span>
          <span className="activity-agent-partners"><strong>{agent.partnerRequests}</strong><small>{agent.partnerRequests===1?'partener':'parteneri'} luna aceasta</small></span>
          <span className="activity-agent-state"><small>{agent.partnerConfirmed} confirmați</small><small>{agentPending} în așteptare</small></span>
        </div>;
      })}</div>:<p className="portfolio-message">Nu există agenți vizibili în acest scope.</p>}
    </section>
  </div>;
}
