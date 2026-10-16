'use client';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, RefreshCw, Store } from 'lucide-react';
import { dateLabel } from '@/lib/client-api';
import type { TeamActivityView } from '@/lib/types';

export function PartnerActivityDetail({view,month,loading,focusRequestId,onBack,onMonthChange,onRefresh,workspace=false}:{view:TeamActivityView;month:string;loading:boolean;focusRequestId?:string;onBack:()=>void;onMonthChange:(value:string)=>void;onRefresh:()=>void;workspace?:boolean}) {
  const [agentId,setAgentId]=useState('all');
  useEffect(()=>{
    if(!focusRequestId||!view.partnerRequests.some(item=>item.id===focusRequestId))return;
    const frame=requestAnimationFrame(()=>document.getElementById('partner-request-'+focusRequestId)?.scrollIntoView({behavior:'smooth',block:'center'}));
    return()=>cancelAnimationFrame(frame);
  },[focusRequestId,view]);
  // Ignore incomplete legacy records, including snapshots cached by an older client.
  const registrations=useMemo(()=>view.partnerRequests.filter(item=>item.status==='confirmed'),[view.partnerRequests]);
  const groups=useMemo(()=>view.agents.filter(agent=>workspace||agentId==='all'||agent.agentId===agentId).map(agent=>({
    agent,items:registrations.filter(item=>item.agentId===agent.agentId),
  })),[view.agents,registrations,agentId,workspace]);
  return <div className="partner-activity-detail">
    <div className="activity-detail-head">
      <button className="back-link" onClick={onBack}><ArrowLeft size={17}/> {workspace?'Înapoi la portofoliu':'Înapoi la Activitate'}</button>
      <div className="activity-toolbar"><label>Luna<input type="month" value={month} onChange={event=>onMonthChange(event.target.value)}/></label><button className="icon-button" aria-label="Actualizează clienții noi" onClick={onRefresh}><RefreshCw size={18}/></button></div>
    </div>
    <div className="page-heading activity-detail-title"><div><span className="eyebrow">ACTIVITATE</span><h1>Clienți noi</h1><p>Clienții adăugați de echipă, grupați pe agent.</p></div></div>
    <div className="activity-detail-summary"><div><span>TOTAL ADĂUGAȚI</span><strong>{registrations.length}</strong></div></div>
    <section className="panel partner-detail-panel">
      {!workspace&&<div className="partner-detail-filters">
        <label className="partner-agent-filter">Agent<select value={agentId} onChange={event=>setAgentId(event.target.value)}><option value="all">Toți agenții</option>{view.agents.map(agent=><option value={agent.agentId} key={agent.agentId}>{agent.agentName}</option>)}</select></label>
      </div>}
      {loading?<p className="activity-inline-loading">Se actualizează…</p>:null}
      {groups.length?<div className="partner-agent-groups">{groups.map(group=>{
        const focused=Boolean(focusRequestId&&group.items.some(item=>item.id===focusRequestId));
        return <details className="partner-agent-group" key={group.agent.agentId} open={focused||undefined}>
          <summary>
            <span className="activity-agent-avatar">{group.agent.agentName.split(' ').slice(0,2).map(part=>part[0]).join('')}</span>
            <span className="partner-agent-name"><strong>{group.agent.agentName}</strong><small>{group.agent.warehouseName}{group.agent.active?'':' · cont dezactivat'}</small></span>
            <span className="partner-agent-count"><strong>{group.items.length}</strong><small>{group.items.length===1?'client adăugat':'clienți adăugați'} {workspace?'în selecție':'luna aceasta'}</small></span>
            <ChevronDown size={18}/>
          </summary>
          <div className="partner-agent-requests">
            {group.items.length?group.items.map(item=><div id={'partner-request-'+item.id} className={'partner-request-row'+(focusRequestId===item.id?' request-focused':'')} key={item.id}>
              <div className="partner-request-main">
                <strong>{item.company}</strong><span><Store size={14}/> {item.location} · {item.county}</span><span>{item.address}</span>
                <small>CUI {item.cui} · {dateLabel(item.confirmedAt||item.createdAt)}</small>
                {item.existingLocations.length>0&&<small className="existing-company">Firmă existentă · {item.existingLocations.length} punct{item.existingLocations.length===1?'':'e'} de lucru în bază</small>}
              </div>
              <div className="partner-request-action"><span className="badge finalized">Adăugat</span></div>
            </div>):<p className="portfolio-message">Niciun client adăugat în luna selectată.</p>}
          </div>
        </details>;
      })}</div>:<p className="portfolio-message">Niciun client adăugat în selecție.</p>}
    </section>
  </div>;
}
