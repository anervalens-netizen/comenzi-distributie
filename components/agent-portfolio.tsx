'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, Search, Pencil, Save, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { api, errorMessage, normalize } from '@/lib/client-api';
import type { Client, User } from '@/lib/types';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { StockWorkspace } from '@/components/stock-workspace';

type ManagedClient=Client & {version:string};
export function AgentPortfolio({agent,users,onUsers,onBack,canEditSiteCode}:{agent:User;users:User[];onUsers:(users:User[])=>void;onBack:()=>void;canEditSiteCode:boolean}) {
  const [profileOpen,setProfileOpen]=useState(false),[profile,setProfile]=useState({name:agent.name,warehouseName:agent.warehouseName||'',siteCode:agent.siteCode||'',version:agent.profileVersion}),[profileError,setProfileError]=useState(''),[profileBusy,setProfileBusy]=useState(false);
  const [clients,setClients]=useState<ManagedClient[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[query,setQuery]=useState(''),[reload,setReload]=useState(0);
  const [edit,setEdit]=useState<ManagedClient|null>(null),[agentIds,setAgentIds]=useState<string[]>([]),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState('');
  useEffect(()=>{
    let cancelled=false;
    void api<{clients:ManagedClient[]}>(`clients?warehouseId=${encodeURIComponent(agent.warehouseId||'')}`).then(r=>{if(!cancelled)setClients(r.clients);}).catch(e=>{if(!cancelled)setError(errorMessage(e));}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[agent.warehouseId,reload]);
  function open(client:ManagedClient){setEdit({...client});setAgentIds(users.filter(u=>u.role==='agent'&&u.warehouseId&&(client.warehouseIds||[client.warehouseId]).includes(u.warehouseId)).map(u=>u.id));setSaveError('');}
  async function save(e:React.SyntheticEvent){
    e.preventDefault();if(!edit||saving)return;setSaving(true);setSaveError('');
    try {
      const r=await api<{client:ManagedClient;users:User[]}>(`admin/clients/${encodeURIComponent(edit.id)}`,'PUT',{...edit,agentIds,sourceWarehouseId:agent.warehouseId});
      setClients(list=>(r.client.warehouseIds||[r.client.warehouseId]).includes(agent.warehouseId||'')?list.map(c=>c.id===r.client.id?r.client:c):list.filter(c=>c.id!==r.client.id));
      onUsers(r.users);setEdit(null);toast.success((r.client.warehouseIds||[r.client.warehouseId]).includes(agent.warehouseId||'')?'Datele și portofoliile clientului au fost salvate.':'Clientul a rămas disponibil în portofoliile selectate.');
    }catch(err){setSaveError(errorMessage(err));}finally{setSaving(false);}
  }
  async function saveProfile(e:React.SyntheticEvent){
    e.preventDefault();if(profileBusy)return;setProfileBusy(true);setProfileError('');
    try{const r=await api<{users:User[]}>(`admin/users/${agent.id}`,'PUT',profile);onUsers(r.users);setProfileOpen(false);toast.success('Datele agentului au fost salvate.');}
    catch(err){setProfileError(errorMessage(err));}finally{setProfileBusy(false);}
  }
  const terms=normalize(query).trim().split(/\s+/).filter(Boolean);
  const filtered=clients.filter(c=>terms.every(term=>normalize([c.name,c.cui,c.address,c.city,c.county,c.route].join(' ')).includes(term)));
  const targets=users.filter(u=>u.role==='agent'&&u.warehouseId&&(u.active||agentIds.includes(u.id)));
  return <>
    <button className="quiet" onClick={onBack}><ArrowLeft size={18}/> Înapoi la echipă</button>
    <div className="page-heading"><div><h1>{agent.name}</h1><p>{agent.warehouseName}</p><span className="muted">SiteCode: {agent.siteCode||'—'}</span></div><div className="heading-controls"><button className="secondary" onClick={()=>{setProfile({name:agent.name,warehouseName:agent.warehouseName||'',siteCode:agent.siteCode||'',version:agent.profileVersion});setProfileError('');setProfileOpen(true);}}><Pencil size={17}/> Editează agentul</button><button className="icon-button" title="Actualizează portofoliul" aria-label="Actualizează portofoliul" disabled={loading} onClick={()=>{setLoading(true);setError('');setReload(n=>n+1);}}><RefreshCw size={19}/></button></div></div>
    <Tabs defaultValue="portfolio"><TabsList variant="line"><TabsTrigger value="portfolio">Portofoliu</TabsTrigger><TabsTrigger value="stock">Stoc</TabsTrigger></TabsList><TabsContent value="portfolio"><section className="panel"><div className="panel-heading"><div><h2>Portofoliu complet</h2><span className="count-pill">{clients.length}</span></div><span className="muted">{filtered.length} magazine afișate</span></div><div className="panel-toolbar"><div className="search-box"><Search size={18}/><input aria-label="Caută magazin după nume, CUI sau adresă" placeholder="Caută nume, CUI, adresă sau localitate…" value={query} onChange={e=>setQuery(e.target.value)}/></div></div>
    {error?<p className="error-banner" role="alert">{error}</p>:loading?<output className="portfolio-message">Se încarcă magazinele…</output>:<Table className="orders-table portfolio-table"><TableHeader><TableRow><TableHead>MAGAZIN / CUI</TableHead><TableHead>ADRESĂ</TableHead><TableHead>LOCALITATE / JUDEȚ</TableHead><TableHead>RUTĂ</TableHead><TableHead>ACȚIUNI</TableHead></TableRow></TableHeader><TableBody>{filtered.map(c=><TableRow key={c.id}><TableCell><button className="portfolio-name" onClick={()=>open(c)}>{c.name}</button><small>{c.cui}</small>{(c.warehouseIds?.length||0)>1&&<small className="shared-client-label">Comun · {c.warehouseIds!.length} gestiuni</small>}</TableCell><TableCell>{c.address||'—'}</TableCell><TableCell><strong>{c.city}</strong><small>{c.county||'—'}</small></TableCell><TableCell>{c.route||'—'}</TableCell><TableCell><button className="icon-button" aria-label={`Editează ${c.name}`} title="Editează sau mută clientul" onClick={()=>open(c)}><Pencil size={18}/></button></TableCell></TableRow>)}</TableBody></Table>}
    {!loading&&!error&&!filtered.length&&<p className="portfolio-message">{clients.length?'Niciun magazin nu corespunde căutării.':'Agentul nu are magazine în portofoliu.'}</p>}</section></TabsContent><TabsContent value="stock"><StockWorkspace warehouseId={agent.warehouseId} title="Stoc agent" manager /></TabsContent></Tabs>
    <Dialog open={profileOpen} onOpenChange={open=>{if(!profileBusy)setProfileOpen(open);}}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>Editează agentul</DialogTitle><DialogDescription>{canEditSiteCode?'Actualizează numele, denumirea gestiunii și SiteCode.':'Actualizează numele și denumirea gestiunii. SiteCode-ul este administrat global.'}</DialogDescription></DialogHeader><form className="form-stack" onSubmit={e=>void saveProfile(e)}>{([['name','Nume agent',100],['warehouseName','Gestiune',200]] as const).map(([key,label,max])=><label key={key}>{label}<input value={profile[key]} maxLength={max} required disabled={profileBusy} onChange={e=>setProfile(p=>({...p,[key]:e.target.value}))}/></label>)}{canEditSiteCode&&<label>SiteCode<input value={profile.siteCode} maxLength={80} disabled={profileBusy} onChange={e=>setProfile(p=>({...p,siteCode:e.target.value}))}/></label>}{profileError&&<p className="error-banner" role="alert">{profileError}</p>}<button className="primary" disabled={profileBusy}><Save size={18}/>{profileBusy?'Se salvează…':'Salvează datele agentului'}</button></form></DialogContent></Dialog>
    <Dialog open={!!edit} onOpenChange={open=>{if(!open&&!saving)setEdit(null);}}><DialogContent className="admin-dialog client-edit-dialog"><DialogHeader><DialogTitle>Editează clientul</DialogTitle><DialogDescription>Modifică datele și bifează toți agenții care lucrează cu acest punct de lucru. Avizele finalizate își păstrează informațiile originale.</DialogDescription></DialogHeader>{edit&&<form className="form-stack" onSubmit={e=>void save(e)}><fieldset className="client-fields" disabled={saving}>{([['name','Denumire',200],['cui','CUI',40],['address','Adresă',500],['county','Județ',100],['city','Localitate',100],['route','Rută',30]] as const).map(([key,label,max])=><label key={key} className={key==='name'||key==='address'?'client-wide':undefined}>{label}<input value={edit[key]} maxLength={max} required={['name','cui','city'].includes(key)} onChange={e=>setEdit(c=>c?{...c,[key]:e.target.value}:c)}/></label>)}</fieldset><fieldset className="shared-agents" disabled={saving}><legend>Disponibil în portofoliile</legend><p className="muted">Poți bifa mai mulți agenți. Datele punctului de lucru sunt comune; avizele fiecărui agent rămân separate.</p><div>{targets.map(u=><label key={u.id}><input type="checkbox" checked={agentIds.includes(u.id)} onChange={e=>setAgentIds(ids=>e.target.checked?[...ids,u.id]:ids.filter(id=>id!==u.id))}/><span>{u.name}<small>{u.warehouseName}</small></span></label>)}</div></fieldset>{!agentIds.length&&<p className="notice">Selectează cel puțin un agent.</p>}{saveError&&<p className="error-banner" role="alert">{saveError}</p>}<div className="delete-actions"><button type="button" className="secondary" disabled={saving} onClick={()=>setEdit(null)}>Renunță</button><button className="primary" disabled={saving||!agentIds.length}><Save size={18}/>{saving?'Se salvează…':'Salvează modificările'}</button></div></form>}</DialogContent></Dialog>
  </>;
}
