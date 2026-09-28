'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { User } from '@/lib/types';

export type RegionOption = {value: string; label: string; agentIds: string[]};
export function managerRegions(users: User[]): RegionOption[] {
  const groups = new Map<string, {managers: User[]; agentIds: string[]}>();
  const agentIds = new Set(users.filter(user => user.role === 'agent').map(user => user.id));
  for (const manager of users.filter(user => user.role === 'manager' && user.managerScope === 'assigned' && user.active !== 0).sort((a,b) => a.id.localeCompare(b.id))) {
    const ids = [...new Set(manager.managedAgentIds || [])].filter(id => agentIds.has(id)).sort();
    if (!ids.length) continue;
    const key = JSON.stringify(ids), group = groups.get(key) || {managers: [], agentIds: ids};
    group.managers.push(manager); groups.set(key, group);
  }
  const regions = [...groups.values()].map(group => ({value: group.managers[0].id, label: group.managers.map(manager => manager.name).join(' / '), agentIds: group.agentIds}));
  const assigned = new Set(regions.flatMap(region => region.agentIds));
  const unassigned = [...agentIds].filter(id => !assigned.has(id));
  if (unassigned.length) regions.push({value: '__unassigned', label: 'Fără regiune alocată', agentIds: unassigned});
  return regions;
}

type Selection = {userId: string; managerId: string; agentId: string};
export function useManagerScope(user: User | null, users: User[]) {
  const [stored, setStored] = useState<Selection>({userId: '', managerId: '', agentId: ''});
  const global = user?.role === 'manager' && user.managerScope === 'global';
  const regions = useMemo(() => managerRegions(users), [users]);
  const agents = useMemo(() => users.filter(item => item.role === 'agent').sort((a,b) => a.name.localeCompare(b.name,'ro')), [users]);
  const own = stored.userId === user?.id ? stored : {managerId: '', agentId: ''};
  const managerId = global && regions.some(region => region.value === own.managerId) ? own.managerId : '';
  const region = regions.find(item => item.value === managerId);
  const regionAgents = region ? agents.filter(agent => region.agentIds.includes(agent.id)) : agents;
  const agentId = regionAgents.some(agent => agent.id === own.agentId) ? own.agentId : '';
  const selectedAgents = agentId ? regionAgents.filter(agent => agent.id === agentId) : regionAgents;
  const userId=user?.id,role=user?.role;
  useEffect(() => {
    if (!userId || role !== 'manager') return;
    let next: Selection = {userId, managerId: '', agentId: ''};
    try {const focusedRequest=new URLSearchParams(window.location.search).get('request');const parsed = focusedRequest?null:JSON.parse(localStorage.getItem(`manager-selection-v1:${userId}`) || 'null'); if (parsed && typeof parsed.managerId === 'string' && typeof parsed.agentId === 'string') next = {...next, managerId: parsed.managerId, agentId: parsed.agentId};} catch {}
    let alive = true;
    queueMicrotask(() => {if (alive) setStored(next);});
    return () => {alive = false;};
  }, [userId, role]);
  function write(nextManager: string, nextAgent: string) {
    if (!user) return;
    const next = {userId: user.id, managerId: nextManager, agentId: nextAgent};
    setStored(next);
    try {localStorage.setItem(`manager-selection-v1:${user.id}`, JSON.stringify(next));} catch {}
  }
  const query = new URLSearchParams({...managerId ? {managerId} : {}, ...agentId ? {agentId} : {}}).toString();
  return {global, regions, agents: regionAgents, selectedAgents, managerId, agentId, query,
    label: agentId ? regionAgents.find(agent => agent.id === agentId)!.name : region?.label || (global ? 'Toată distribuția' : 'Echipa mea'),
    selectRegion: (value: string) => write(value, ''),
    selectAgent: (value: string) => write(managerId, value === 'all' ? '' : value),
    openAgent: (value: string) => write('', value),
  };
}
export type ManagerScope = ReturnType<typeof useManagerScope>;

export function SearchScopeChoice({label, value, options, onChange}: {label: string; value: string; options: {value: string; label: string}[]; onChange: (value: string) => void}) {
  const [query, setQuery] = useState('');
  const host = useRef<HTMLDetailsElement>(null);
  const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('ro');
  const visible = options.filter(option => normalized(option.label).includes(normalized(query)));
  useEffect(()=>{
    const closeOutside=(event:PointerEvent)=>{if(host.current&&event.target instanceof Node&&!host.current.contains(event.target))host.current.open=false;};
    const closeOnFocus=(event:FocusEvent)=>{if(host.current&&event.target instanceof Node&&!host.current.contains(event.target))host.current.open=false;};
    document.addEventListener('pointerdown',closeOutside);document.addEventListener('focusin',closeOnFocus);
    return()=>{document.removeEventListener('pointerdown',closeOutside);document.removeEventListener('focusin',closeOnFocus);};
  },[]);
  return <details ref={host} className="manager-scope-choice">
    <summary aria-label={label}><span><small>{label}</small><strong>{options.find(option => option.value === value)?.label || 'Toți'}</strong></span><ChevronDown size={16}/></summary>
    <div className="manager-scope-popover"><label className="manager-scope-search"><Search size={16}/><input onKeyDown={event => {if(event.key==='Escape'&&host.current){host.current.open=false;host.current.querySelector('summary')?.focus();}}} aria-label={`Caută ${label.toLocaleLowerCase('ro')}`} value={query} placeholder="Caută…" onChange={event => setQuery(event.target.value)}/></label>
      <div className="manager-scope-options">{visible.map(option => <button type="button" key={option.value} data-value={option.value} aria-pressed={option.value === value} onClick={() => {onChange(option.value); setQuery(''); if (host.current) {host.current.open = false; host.current.querySelector('summary')?.focus();}}}>{option.label}</button>)}{!visible.length && <p>Niciun rezultat.</p>}</div>
    </div>
  </details>;
}
export function ManagerScopeBar({scope}: {scope: ManagerScope}) {
  return <div className="manager-scope-bar" aria-label="Selecția managerului">
    {scope.global && <SearchScopeChoice label="Regiune" value={scope.managerId} onChange={scope.selectRegion} options={[{value:'',label:'Toate regiunile'},...scope.regions]}/>}
    <SearchScopeChoice label="Agent / TR" value={scope.agentId} onChange={scope.selectAgent} options={[{value:'',label:'Toată echipa'},...scope.agents.map(agent => ({value:agent.id,label:`${agent.name}${agent.siteCode?` · ${agent.siteCode}`:''}${agent.active===0?' · inactiv':''}`}))]}/>
    <span className="manager-scope-note">Selecția se păstrează între secțiuni.</span>
  </div>;
}
