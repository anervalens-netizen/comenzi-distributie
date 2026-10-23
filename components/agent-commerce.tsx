'use client';
import {useEffect,useState} from 'react';
import type {User} from '@/lib/types';
import {bucharestMonthKey} from '@/lib/bucharest-month';
import {ManagerAccessories,ManagerPrepay} from './manager-commerce';
import {ReportPeriod} from './report-period';

type View='current'|'history'|'clients';
/** Agents share report presentation; their account supplies the authorized seller/project. */
export function AgentCommerce({user,mode,initialView,onViewChange}:{user:User;mode:'sales'|'activations';initialView?:View;onViewChange:(view:View)=>void}){
  const [view,setView]=useState<View>(initialView||'current');
  const [months,setMonths]=useState(()=>[bucharestMonthKey(new Date())]);
  useEffect(()=>{
    let selected=[bucharestMonthKey(new Date())];
    try{const saved=JSON.parse(localStorage.getItem('agent-report-months-v1:'+user.id)||'null');if(Array.isArray(saved)&&saved.length<=36&&saved.every(month=>typeof month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)))selected=[...new Set(saved)].sort((a,b)=>a.localeCompare(b));}catch{}
    let alive=true;queueMicrotask(()=>{if(alive)setMonths(selected);});return()=>{alive=false;};
  },[user.id]);
  function selectMonths(selected:string[]){const next=[...new Set(selected)].sort((a,b)=>a.localeCompare(b));setMonths(next);try{localStorage.setItem('agent-report-months-v1:'+user.id,JSON.stringify(next));}catch{}}
  const configured=!!user.distributionConfigured;
  const query=new URLSearchParams(configured?{months:months.join(',')}:{month:months[0]||bucharestMonthKey(new Date())}).toString();
  return <div className="agent-commerce">
    {configured&&(mode==='activations'||view!=='clients')&&<div className="agent-report-scope"><ReportPeriod selected={months} onChange={selectMonths}/></div>}
    {mode==='sales'?<ManagerAccessories manager={false} userId={user.id} query={query} scopeQuery="" scopeLabel="Portofoliul meu" initialView={initialView} onViewChange={next=>{setView(next);onViewChange(next);}} onMonthChange={month=>selectMonths([month])}/>:<ManagerPrepay userId={user.id} query={query} scopeLabel="Activitatea mea" distributionConfigured={configured} canViewActivations={!!user.canViewActivations}/>}
  </div>;
}
