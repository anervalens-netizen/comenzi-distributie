'use client';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, LoaderCircle, RefreshCw, Store } from 'lucide-react';
import { toast } from 'sonner';
import { api, dateLabel, errorMessage } from '@/lib/client-api';
import { hasPartnerCounty, partnerLegacyPointKey, partnerPointKey } from '@/lib/partner-identity';
import type { PartnerLocation, PartnerRequestRecord, TeamActivityView } from '@/lib/types';

type StatusFilter='all'|'requested'|'confirmed';
type LocationResolution={candidates:PartnerLocation[];allowNew:boolean};

function locationResolution(item:PartnerRequestRecord):LocationResolution|null {
  const wanted=partnerPointKey(item.location,item.county,item.address);
  const exact=item.existingLocations.filter(location=>partnerPointKey(location.city,location.county,location.address)===wanted);
  if(exact.length>1)return {candidates:exact,allowNew:false};
  if(exact.length===1)return null;
  const legacy=partnerLegacyPointKey(item.location,item.address);
  const incomplete=item.existingLocations.filter(location=>!hasPartnerCounty(location.county)&&partnerLegacyPointKey(location.city,location.address)===legacy);
  return incomplete.length?{candidates:incomplete,allowNew:true}:null;
}

export function PartnerActivityDetail({view,month,loading,focusRequestId,onBack,onMonthChange,onRefresh,onRequestsChanged}:{view:TeamActivityView;month:string;loading:boolean;focusRequestId?:string;onBack:()=>void;onMonthChange:(value:string)=>void;onRefresh:()=>void;onRequestsChanged:()=>void}) {
  const [status,setStatus]=useState<StatusFilter>('all'),[agentId,setAgentId]=useState('all'),[confirming,setConfirming]=useState(''),[error,setError]=useState('');
  const [resolutions,setResolutions]=useState<Record<string,string>>({});
  useEffect(()=>{
    if(!focusRequestId||!view.partnerRequests.some(item=>item.id===focusRequestId))return;
    const frame=requestAnimationFrame(()=>document.getElementById('partner-request-'+focusRequestId)?.scrollIntoView({behavior:'smooth',block:'center'}));
    return()=>cancelAnimationFrame(frame);
  },[focusRequestId,view]);

  const filtered=useMemo(()=>view.partnerRequests.filter(item=>(status==='all'||item.status===status)&&(agentId==='all'||item.agentId===agentId)),[view.partnerRequests,status,agentId]);
  const groups=useMemo(()=>view.agents.filter(agent=>agentId==='all'||agent.agentId===agentId).map(agent=>{
    const all=view.partnerRequests.filter(item=>item.agentId===agent.agentId);
    const items=filtered.filter(item=>item.agentId===agent.agentId);
    return {agent,all,items,pending:all.filter(item=>item.status==='requested').length,confirmed:all.filter(item=>item.status==='confirmed').length};
  }).filter(group=>status==='all'||group.items.length>0||Boolean(focusRequestId&&group.all.some(item=>item.id===focusRequestId))),[view.agents,view.partnerRequests,filtered,agentId,status,focusRequestId]);

  async function confirm(item:PartnerRequestRecord){
    if(confirming)return;
    const required=locationResolution(item),selected=resolutions[item.id]||'';
    if(required&&!selected){setError('Alege explicit punctul de lucru existent sau crearea unui punct nou.');return;}
    setConfirming(item.id);setError('');
    try{
      const body={revision:item.revision,...(selected?{locationResolution:selected}:{})};
      const result=await api<{request:PartnerRequestRecord}>(`partner/requests/${item.id}/confirm`,'POST',body);
      const reused=item.existingLocations.some(location=>location.id===result.request.customerId);
      toast.success(reused?'Punctul existent a fost asociat agentului.':'Punctul de lucru a fost confirmat și adăugat.');
      onRequestsChanged();
    }catch(err){setError(errorMessage(err));}finally{setConfirming('');}
  }

  const pending=view.totals.partnerRequests-view.totals.partnerConfirmed;
  return <div className="partner-activity-detail">
    <div className="activity-detail-head">
      <button className="back-link" onClick={onBack}><ArrowLeft size={17}/> Înapoi la Activitate</button>
      <div className="activity-toolbar"><label>Luna<input type="month" value={month} onChange={event=>onMonthChange(event.target.value)}/></label><button className="icon-button" aria-label="Actualizează partenerii" onClick={onRefresh}><RefreshCw size={18}/></button></div>
    </div>
    <div className="page-heading activity-detail-title"><div><span className="eyebrow">ACTIVITATE</span><h1>Parteneri noi</h1><p>Solicitările echipei, grupate pe agent.</p></div></div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    <div className="activity-detail-summary">
      <div><span>TOTAL</span><strong>{view.totals.partnerRequests}</strong></div>
      <div><span>ÎN AȘTEPTARE</span><strong>{pending}</strong></div>
      <div><span>CONFIRMAȚI</span><strong>{view.totals.partnerConfirmed}</strong></div>
    </div>
    <section className="panel partner-detail-panel">
      <div className="partner-detail-filters">
        <div className="status-filter" aria-label="Filtrează după status">{([['all','Toate'],['requested','În așteptare'],['confirmed','Confirmați']] as const).map(([value,label])=><button key={value} className={status===value?'active':''} aria-pressed={status===value} onClick={()=>setStatus(value)}>{label}</button>)}</div>
        <label className="partner-agent-filter">Agent<select value={agentId} onChange={event=>setAgentId(event.target.value)}><option value="all">Toți agenții</option>{view.agents.map(agent=><option value={agent.agentId} key={agent.agentId}>{agent.agentName}</option>)}</select></label>
      </div>
      {loading?<p className="activity-inline-loading">Se actualizează…</p>:null}
      {groups.length?<div className="partner-agent-groups">{groups.map(group=>{
        const focused=Boolean(focusRequestId&&group.all.some(item=>item.id===focusRequestId));
        return <details className="partner-agent-group" key={group.agent.agentId} open={focused||undefined}>
          <summary>
            <span className="activity-agent-avatar">{group.agent.agentName.split(' ').slice(0,2).map(part=>part[0]).join('')}</span>
            <span className="partner-agent-name"><strong>{group.agent.agentName}</strong><small>{group.agent.warehouseName}{group.agent.active?'':' · cont dezactivat'}</small></span>
            <span className="partner-agent-count"><strong>{group.all.length}</strong><small>{group.all.length===1?'partener':'parteneri'} luna aceasta</small></span>
            <span className="partner-agent-badges"><small>{group.confirmed} confirmați</small><small>{group.pending} în așteptare</small></span>
            <ChevronDown size={18}/>
          </summary>
          <div className="partner-agent-requests">
            {group.items.length?group.items.map(item=>{
              const resolution=locationResolution(item),selected=resolutions[item.id]||'';
              return <div id={'partner-request-'+item.id} className={'partner-request-row'+(focusRequestId===item.id?' request-focused':'')} key={item.id}>
                <div className="partner-request-main">
                  <strong>{item.company}</strong>
                  <span><Store size={14}/> {item.location} · {item.county}</span>
                  <span>{item.address}</span>
                  <small>CUI {item.cui} · {dateLabel(item.createdAt)}</small>
                  {item.existingLocations.length>0&&<small className="existing-company">Firmă existentă · {item.existingLocations.length} punct{item.existingLocations.length===1?'':'e'} de lucru în bază</small>}
                  {item.status==='requested'&&resolution&&<label className="partner-location-resolution">Rezolvă punctul de lucru<select aria-label={`Rezolvă punctul de lucru pentru ${item.company}`} value={selected} onChange={event=>setResolutions(current=>({...current,[item.id]:event.target.value}))}><option value="">Alege explicit…</option>{resolution.candidates.map(location=><option key={location.id} value={location.id}>{location.city} · {location.county||'județ lipsă'} · {location.address}</option>)}{resolution.allowNew&&<option value="new">Creează punct nou · {item.county}</option>}</select></label>}
                </div>
                <div className="partner-request-action"><span className={'badge '+(item.status==='confirmed'?'finalized':'draft')}>{item.status==='confirmed'?'Confirmat':'Solicitat'}</span>{item.status==='requested'&&<button className="primary" disabled={!!confirming||Boolean(resolution&&!selected)} onClick={()=>void confirm(item)}>{confirming===item.id?<LoaderCircle className="spin" size={16}/>:<Check size={16}/>} Confirmă</button>}</div>
              </div>;
            }):<p className="portfolio-message">Nicio solicitare pentru filtrul selectat.</p>}
          </div>
        </details>;
      })}</div>:<p className="portfolio-message">Nicio solicitare pentru filtrul selectat.</p>}
    </section>
  </div>;
}
