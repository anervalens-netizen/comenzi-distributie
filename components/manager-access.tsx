'use client';
import { useState } from 'react';
import { Plus, Pencil, LoaderCircle, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/client-api';
import type { User } from '@/lib/types';

type Target=User|'new'|null;

export function ManagerAccess({users,onUsers}:{users:User[];onUsers:(users:User[])=>void}) {
  const [target,setTarget]=useState<Target>(null),[agentIds,setAgentIds]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const managers=users.filter(user=>user.role==='manager');
  const agents=users.filter(user=>user.role==='agent'&&user.active!==0);
  const editing=target&&target!=='new'?target:null;
  const open=(manager?:User)=>{setTarget(manager||'new');setAgentIds(manager?.managedAgentIds||[]);setError('');};

  async function save(event:React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();if(!target||busy)return;
    const data=Object.fromEntries(new FormData(event.currentTarget)),rawPassword=data.password,password=typeof rawPassword==='string'?rawPassword:'';
    const body:Record<string,unknown>={name:data.name,username:data.username,agentIds};
    if(target==='new')body.password=password;
    else {body.version=target.profileVersion;if(password)body.password=password;}
    setBusy(true);setError('');
    try {
      const result=await api<{users:User[]}>(target==='new'?'admin/managers':`admin/managers/${target.id}`,target==='new'?'POST':'PUT',body);
      onUsers(result.users);setTarget(null);toast.success(target==='new'?'Managerul regional a fost creat.':'Accesul managerului a fost actualizat.');
    } catch(err) {setError(errorMessage(err));} finally {setBusy(false);}
  }
  return <>
    <section className="panel"><div className="panel-heading"><div><h2>Manageri și arii de acces</h2><span className="count-pill">{managers.length}</span></div><button className="secondary" onClick={()=>open()}><Plus size={17}/> Manager regional</button></div>
      <div className="agent-account-list">{managers.map(manager=><div className="agent-account-row" key={manager.id}><div><strong>{manager.name}</strong><small>{manager.username} · {manager.managerScope==='global'?'Acces global':`${manager.managedAgentIds?.length||0} agenți`}</small></div><button type="button" className="secondary" onClick={()=>open(manager)}><Pencil size={16}/> Editează</button></div>)}</div>
    </section>
    <Dialog open={!!target} onOpenChange={open=>{if(!open&&!busy)setTarget(null);}}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>{target==='new'?'Manager regional nou':editing?.managerScope==='global'?'Editează managerul general':'Editează managerul regional'}</DialogTitle><DialogDescription>{target==='new'?'Creează contul și selectează agenții pe care îi va vedea.':editing?.managerScope==='global'?'Poți actualiza numele și utilizatorul contului global.':'Același agent poate fi alocat mai multor manageri.'}</DialogDescription></DialogHeader>
      {error&&<p className="error-banner" role="alert">{error}</p>}
      {target&&<form className="form-stack" onSubmit={e=>void save(e)}><label>Nume<input name="name" defaultValue={editing?.name||''} required maxLength={100}/></label><label>Utilizator<input name="username" defaultValue={editing?.username||''} required minLength={3} maxLength={80} pattern={'[a-zA-Z0-9._\\-]+'} autoCapitalize="none" autoComplete="off"/></label>
        {target==='new'&&<label>Parolă<input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password"/></label>}
        {editing?.managerScope==='assigned'&&<label>Parolă nouă <span className="optional">opțional</span><input name="password" type="password" minLength={10} maxLength={128} autoComplete="new-password"/></label>}
        {(target==='new'||editing?.managerScope==='assigned')&&<fieldset className="shared-agents"><legend>Agenți vizibili</legend><p className="muted">Bifează agenții din aria acestui manager. Poți lăsa lista goală și o completezi ulterior.</p><div>{agents.map(agent=><label key={agent.id}><input type="checkbox" checked={agentIds.includes(agent.id)} onChange={event=>setAgentIds(ids=>event.target.checked?[...ids,agent.id]:ids.filter(id=>id!==agent.id))}/><span>{agent.name}<small>{agent.warehouseName||agent.siteCode||'Fără gestiune configurată'}</small></span></label>)}</div></fieldset>}
        <button className="primary" disabled={busy}>{busy?<LoaderCircle className="spin" size={18}/>:<Save size={18}/>} {target==='new'?'Creează managerul':'Salvează accesul'}</button>
      </form>}
    </DialogContent></Dialog>
  </>;
}
