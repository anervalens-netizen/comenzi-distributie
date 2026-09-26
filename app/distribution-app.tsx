'use client';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Boxes, ScanBarcode, History, LockKeyhole, LogOut, Users, Settings2, Plus, Package, CalendarDays, Search, RefreshCw, Clock3, LoaderCircle, KeyRound, WifiOff, TrendingUp, Store, Bell, LayoutDashboard } from 'lucide-react';
import Image from 'next/image';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Feedback } from '@/components/feedback';
import { Choice } from '@/components/choice';
import { OrderTable } from '@/components/order-table';
import { OrderEditor } from '@/components/order-editor';
import { CombinedOrderEditor } from '@/components/combined-order-editor';
import { OrderResult } from '@/components/order-result';
import { ProductCatalog } from '@/components/product-catalog';
import { StockWorkspace } from '@/components/stock-workspace';
import { PartnerPortfolio } from '@/components/partner-portfolio';
import { OrderRecoveryDialog } from '@/components/order-recovery-dialog';
import { PushNotifications } from '@/components/push-notifications';
import { ManagerActivityDashboard } from '@/components/manager-activity-dashboard';
import { Team, SettingsPanel, ManagerMailPanel } from '@/components/admin';
import { api, ApiError, dateLabel, errorMessage, normalize, kindLabels, orderDateKey, localDateKey, SESSION_EXPIRED_EVENT } from '@/lib/client-api';
import { readFinalizedOrderRecovery, readOrphanedOrderRecoveries, type OrderRecovery } from '@/lib/order-recovery';
import type { User, Warehouse, Product, Order, Kind, Settings, OperationalMailSettings, ManagerMailSettings, ManagerRequestInbox } from '@/lib/types';

const SalesPanel = lazy(() => import('@/components/sales').then(module => ({ default: module.SalesPanel })));

type Bootstrap={user:User|null;products?:Product[];warehouses?:Warehouse[];orders?:Order[];users?:User[];settings?:Settings;managerMailSettings?:ManagerMailSettings;regionalSettings?:OperationalMailSettings;regionalSettingsMixed?:boolean;weekKey?:string;importWarnings?:{row:number;name:string;reason:string}[]};
type OrderRefresh={user:User;orders:Order[];weekKey:string};
const defaultSettings:Settings={accessoriesEmail:'',standsEmail:'',simEmail:'',accessoriesCc:[],standsCc:[],simCc:[],partnerTo:[],partnerCc:[],weeklyLimit:2};
const defaultManagerMail:ManagerMailSettings={accessories:'',stands:'',sim:'',partner:''};
function Brand() {return <div className="brand"><Image unoptimized src="/mobiup-logo.png" alt="Mobiup" width="200" height="58"/><span className="brand-label">DISTRIBUȚIE</span></div>;}
function PasswordForm({onDone}:{onDone:()=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(e:React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));
    if(data.password!==data.confirm){setError('Cele două parole noi nu coincid.');return;}
    setBusy(true);setError('');
    try{await api('auth/password','POST',data);onDone();toast.success('Parola a fost schimbată.');}catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  return <form className="form-stack" onSubmit={e=>void submit(e)}><label>Parola curentă<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128}/></label><label>Parola nouă<input name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128}/></label><label>Repetă parola nouă<input name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={128}/></label><p className="muted">Minimum 10 caractere. Parola poate fi schimbată doar de manager.</p>{error&&<p className="error-banner" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?<LoaderCircle className="spin" size={18}/>:<KeyRound size={18}/>} Salvează parola</button></form>;
}
export default function DistributionApp() {
  const [data,setData]=useState<Bootstrap>({user:null}),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [stockAgent,setStockAgent]=useState('');
  const [tab,setTab]=useState('orders'),[activeOrder,setActiveOrder]=useState<Order|null>(null),[autoDownload,setAutoDownload]=useState(false),[newKind,setNewKind]=useState<Kind|null>(null),[agentId,setAgentId]=useState('agent-g-5'),[passwordOpen,setPasswordOpen]=useState(false);
  const [search,setSearch]=useState(''),[status,setStatus]=useState('all'),[agentFilter,setAgentFilter]=useState('all'),[historyRange,setHistoryRange]=useState<'day'|'7d'|'30d'|'all'>('7d'),[historyAnchor,setHistoryAnchor]=useState(()=>Date.now());
  const [deleteTarget,setDeleteTarget]=useState<Order|null>(null),[deleting,setDeleting]=useState(false),[deleteError,setDeleteError]=useState('');
  const [editorEpoch,setEditorEpoch]=useState(0);
  const [reauthOpen,setReauthOpen]=useState(false);
  const [orderRecovery,setOrderRecovery]=useState<OrderRecovery|null>(null);
  const [requestInbox,setRequestInbox]=useState<ManagerRequestInbox>({count:0,items:[]}),[requestsOpen,setRequestsOpen]=useState(false),[focusRequestId,setFocusRequestId]=useState(''),[requestNavEpoch,setRequestNavEpoch]=useState(0);
  const createId=useRef<string|null>(null);
  const creating=useRef(false);
  const sessionUserId=useRef('');
  const loadBootstrap=useCallback(async()=>{
    try{const result=await api<Bootstrap>('bootstrap');if(result.user&&sessionUserId.current!==result.user.id){sessionUserId.current=result.user.id;setTab(result.user.role==='manager'?'activity':'orders');}setData(result);setError('');if(result.user&&result.orders){const orphaned=readOrphanedOrderRecoveries(result.orders,result.user.id);if(orphaned.recoveries[0])setOrderRecovery(current=>current||orphaned.recoveries[0]);}return result;}catch(err){setError(errorMessage(err));return undefined;}finally{setLoading(false);}
  },[]);
  const refreshOrders=useCallback(async()=>{
    try{
      const result=await api<OrderRefresh>('orders');
      setData(current=>({...current,user:result.user,orders:result.orders,weekKey:result.weekKey}));
      const orphaned=readOrphanedOrderRecoveries(result.orders,result.user.id);if(orphaned.recoveries[0])setOrderRecovery(current=>current||orphaned.recoveries[0]);
      setHistoryAnchor(Date.now());setError('');
    }catch(err){
      if(err instanceof ApiError&&err.status===401){setActiveOrder(null);sessionUserId.current='';setData({user:null});setTab('orders');}
      else setError(errorMessage(err));
    }finally{setLoading(false);}
  },[]);
  const refreshRequestInbox=useCallback(async()=>{
    if(data.user?.role!=='manager')return;
    try{setRequestInbox(await api<ManagerRequestInbox>('notifications/inbox'));}catch(err){if(!(err instanceof ApiError&&err.status===401))console.warn('Request inbox refresh failed');}
  },[data.user?.role]);
  useEffect(()=>{void (async()=>{await loadBootstrap();})();},[loadBootstrap]);
  useEffect(()=>{
    const expired=()=>{
      if(activeOrder){setReauthOpen(true);setError('Sesiunea a expirat. Reautentifică-te pentru a continua ciorna.');}
      else{sessionUserId.current='';setData({user:null});setTab('orders');}
    };
    window.addEventListener(SESSION_EXPIRED_EVENT,expired);
    return()=>window.removeEventListener(SESSION_EXPIRED_EVENT,expired);
  },[activeOrder]);
  const online=useSyncExternalStore(useCallback((notify:()=>void)=>{window.addEventListener('online',notify);window.addEventListener('offline',notify);return()=>{window.removeEventListener('online',notify);window.removeEventListener('offline',notify);};},[]),()=>navigator.onLine,()=>true);
  useEffect(()=>{
    if(!data.user||data.user.mustChangePassword||activeOrder||!['orders','sim'].includes(tab))return;
    const refreshVisible=()=>{if(document.visibilityState==='visible'){setHistoryAnchor(Date.now());void refreshOrders();}};
    const interval=setInterval(refreshVisible,30000);
    document.addEventListener('visibilitychange',refreshVisible);
    return()=>{clearInterval(interval);document.removeEventListener('visibilitychange',refreshVisible);};
  },[data.user,activeOrder,refreshOrders,tab]);
  useEffect(()=>{
    if(data.user?.role!=='manager'||data.user.mustChangePassword)return;
    const refresh=()=>{if(document.visibilityState==='visible')void refreshRequestInbox();};queueMicrotask(refresh);const interval=setInterval(refresh,30000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(interval);document.removeEventListener('visibilitychange',refresh);};
  },[data.user?.role,data.user?.mustChangePassword,refreshRequestInbox]);
  useEffect(()=>{
    if(data.user?.role!=='manager')return;const id=new URLSearchParams(window.location.search).get('request');if(!id||!/^[0-9a-f-]{36}$/i.test(id))return;queueMicrotask(()=>{setFocusRequestId(id);setRequestNavEpoch(value=>value+1);setTab('activity');});
  },[data.user?.role]);
  const orders=useMemo(()=>data.orders||[],[data.orders]);
  const user=data.user,users=data.users||[],warehouses=data.warehouses||[],cfg=data.settings||defaultSettings;
  const saved=useCallback((o:Order)=>{setData(d=>({...d,orders:[o,...(d.orders||[]).filter(x=>x.id!==o.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}));},[]);
  async function deleteOrder() {
    if(!deleteTarget||deleting)return;
    setDeleting(true);setDeleteError('');
    try {
      await api(`orders/${deleteTarget.id}`,'DELETE',{revision:deleteTarget.revision});
      setData(d=>({...d,orders:(d.orders||[]).filter(o=>o.id!==deleteTarget.id)}));
      setDeleteTarget(null);toast.success('Comanda a fost ștearsă.');void refreshOrders();
    } catch(err) {setDeleteError(errorMessage(err));} finally {setDeleting(false);}
  }
  function showOrder(order:Order,account=data.user) {
    if(order.status!=='draft'&&account) {
      const recovery=readFinalizedOrderRecovery(order,account.id);
      if(recovery){setOrderRecovery(recovery);setActiveOrder(null);setAutoDownload(false);return;}
    }
    setOrderRecovery(null);setActiveOrder(order);setAutoDownload(false);window.scrollTo(0,0);
  }
  async function login(e:React.SyntheticEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError('');try{await api('auth/login','POST',Object.fromEntries(new FormData(e.currentTarget)));const fresh=await loadBootstrap();if(reauthOpen&&activeOrder&&fresh?.user){const r=await api<{order:Order}>(`orders/${activeOrder.id}`);showOrder(r.order,fresh.user);setEditorEpoch(value=>value+1);setReauthOpen(false);setError('');}}catch(err){setError(errorMessage(err));}finally{setBusy(false);}}
  async function logout(){try{await api('auth/logout','POST',{});setActiveOrder(null);setOrderRecovery(null);setRequestInbox({count:0,items:[]});sessionUserId.current='';setData({user:null});setTab('orders');}catch(e){toast.error(errorMessage(e));}}
  async function openOrder(o:Order){try{const r=await api<{order:Order}>(`orders/${o.id}`);showOrder(r.order);}catch(e){toast.error(errorMessage(e));}}
  async function create(kind:Kind,source?:Order){
    if(creating.current)return;
    creating.current=true;setBusy(true);try{
      createId.current??=crypto.randomUUID();
      const r=await api<{order:Order}>('orders','POST',{id:createId.current,kind,agentId:source?.userId||agentId,sourceOrderId:source?.id});
      createId.current=null;saved(r.order);setActiveOrder(r.order);setAutoDownload(false);setNewKind(null);window.scrollTo(0,0);
    }catch(err){toast.error(errorMessage(err));}finally{creating.current=false;setBusy(false);}
  }
  function start(kind:Kind){createId.current=null;if(user?.role==='manager'){const available=users.filter(u=>u.role==='agent'&&u.active);if(!available.some(u=>u.id===agentId))setAgentId(available[0]?.id||'');setNewKind(kind);}else void create(kind);}
  function copy(order:Order){createId.current=null;void create(order.kind,order);}
  function openRequest(id?:string){if(activeOrder?.status==='draft')return;if(id)setFocusRequestId(id);setRequestNavEpoch(value=>value+1);setTab('activity');setRequestsOpen(false);window.scrollTo(0,0);}
  useEffect(()=>{
    if(!user||user.mustChangePassword)return;
    type ModelContext={registerTool:(tool:{name:string;description:string;inputSchema:object;annotations?:object;execute:(input:unknown)=>unknown},options:{signal:AbortSignal})=>void|Promise<void>};
    const context=(document as Document&{modelContext?:ModelContext}).modelContext;if(!context?.registerTool)return;
    const lifecycle=new AbortController();
    const tool={name:'mobiup_search_orders',description:'Caută comenzile vizibile utilizatorului curent și deschide lista relevantă filtrată; nu modifică comenzile.',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input:unknown){if(!input||typeof input!=='object'||!('query'in input)||typeof input.query!=='string')throw new Error('Este necesar query text.');if(activeOrder)throw new Error('Salvează și închide comanda curentă înainte de căutare.');const matches=orders.filter(o=>normalize(o.number+' '+o.agentName+' '+o.client?.name).includes(normalize(input.query as string)));setTab(matches[0]?.kind==='sim'?'sim':'orders');setHistoryRange('all');setSearch(input.query);return matches.map(o=>({id:o.id,number:o.number,status:o.status,pieces:o.pieces}));}};
    try{void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}
    return()=>lifecycle.abort();
  },[user,orders,activeOrder]);
  if(!user) return <><Feedback/><main className="login-page"><section className="login-story"><Brand/><div className="login-intro"><span className="eyebrow">ECHIPA DIN TEREN</span><h1>Tot ce comanzi.<br/>Într-un singur loc.</h1><p>Stocul tău, comenzile tale și clienții de pe rută.</p></div><div className="login-features"><div><Boxes/><span><strong>Comenzi accesorii & standuri</strong><small>Produse organizate. Excel în formatul cunoscut.</small></span></div><div><ScanBarcode/><span><strong>Aviz client SIM 0</strong><small>Alegi clientul, scanezi seriile, pregătești avizul.</small></span></div><div><History/><span><strong>Istoric la îndemână</strong><small>Reiei o comandă și ajustezi cantitățile.</small></span></div></div><span className="login-foot">MOBIUP · PORTAL INTERN</span></section><section className="login-panel"><form className="login-form" onSubmit={e=>void login(e)}><span className="login-lock"><LockKeyhole size={26}/></span><h2>Bine ai revenit</h2><p>Intră în contul tău de agent sau manager.</p><label>Utilizator<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required placeholder="Numele de utilizator"/></label><label>Parolă<input name="password" type="password" autoComplete="current-password" required maxLength={128} placeholder="Parola ta"/></label>{error&&<p className="error-banner" role="alert">{error}</p>}<button className="primary" type="submit" disabled={busy||loading}>{busy||loading?'Se conectează…':'Intră în cont'} <ArrowRight size={19}/></button><p className="muted login-help">Pentru acces sau resetarea parolei, contactează managerul echipei.</p></form><div className="login-bottom"><span className="status-dot"/> Mobiup · Echipa de distribuție</div></section></main></>;
  if(user.mustChangePassword) return <><Feedback/><div className="first-password"><Brand/><div className="panel"><span className="login-lock"><KeyRound size={25}/></span><h1>Alege parola ta</h1><p>Bună, {user.name}. Înlocuiește parola temporară pentru a intra în aplicație.</p><PasswordForm onDone={()=>void loadBootstrap()}/><button className="quiet" onClick={()=>void logout()}>Ieșire din cont</button></div></div></>;
  const manager=user.role==='manager';
  const globalManager=manager&&user.managerScope==='global';
  const visibleOrders=orders.filter(o=>agentFilter==='all'||o.userId===agentFilter);
  const weekly=visibleOrders.filter(o=>o.status==='finalized'&&o.finalizedAt&&localDateKey(o.finalizedAt)>=(data.weekKey||'9999'));
  const rangeDays=historyRange==='day'?0:historyRange==='7d'?6:historyRange==='30d'?29:null;
  const historyCutoff=rangeDays===null?'':localDateKey(new Date(historyAnchor-rangeDays*86_400_000).toISOString());
  const current=visibleOrders.filter(o=>(tab==='sim'?['sim','stand_client'].includes(o.kind):!['sim','stand_client'].includes(o.kind))&&(status==='all'||o.status===status)&&normalize(o.number+' '+o.agentName+' '+o.warehouseName+' '+o.client?.name+' '+o.client?.cui).includes(normalize(search))&&(o.status==='draft'||!historyCutoff||orderDateKey(o)>=historyCutoff));
  const statsOrders=visibleOrders.filter(o=>tab==='sim'?['sim','stand_client'].includes(o.kind):!['sim','stand_client'].includes(o.kind));
  return <><Feedback/><div className="app-shell"><header className="app-header"><Brand/><div className="header-right"><span className="header-date"><CalendarDays size={16}/>{new Date().toLocaleDateString('ro-RO',{day:'numeric',month:'long',year:'numeric'})}</span><span className="header-divider"/>{manager&&<button className="icon-button request-bell" onClick={()=>setRequestsOpen(true)} aria-label={`Solicitări${requestInbox.count?` (${requestInbox.count})`:``}`} title="Solicitări"><Bell size={20}/>{requestInbox.count>0&&<span className="request-count">{requestInbox.count>99?'99+':requestInbox.count}</span>}</button>}{manager?<button className="profile" onClick={()=>setPasswordOpen(true)} aria-label="Schimbă parola contului"><span className="avatar">{user.name.split(' ').slice(0,2).map(s=>s[0]).join('')}</span><span><strong>{user.name}</strong><small>{globalManager?'Manager distribuție':'Manager regional'}</small></span></button>:<div className="profile"><span className="avatar">{user.name.split(' ').slice(0,2).map(s=>s[0]).join('')}</span><span><strong>{user.name}</strong><small>{user.warehouseName?.replace(/^gestiune\s+/i,'')}</small></span></div>}<button className="icon-button logout" disabled={activeOrder?.status==='draft'} title="Ieșire din cont" aria-label="Ieșire din cont" onClick={()=>void logout()}><LogOut size={19}/></button></div></header>
    {!online&&<div className="offline-banner" role="alert"><WifiOff size={17}/> Conexiune întreruptă. Modificările curente rămân pe ecran; reconectează-te și salvează înainte să închizi pagina.</div>}
    {manager&&requestInbox.count>0&&!activeOrder&&<div className="request-callout"><Bell size={19}/><span><strong>Ai {requestInbox.count} {requestInbox.count===1?'solicitare de partener':'solicitări de partener'} de procesat</strong><small>Confirmă solicitările pentru ca punctele de lucru să devină disponibile agenților.</small></span><button className="secondary" onClick={()=>setRequestsOpen(true)}>Vezi solicitările</button></div>}
    {activeOrder?<main className="main-content">{activeOrder.status==='draft'?(activeOrder.kind==='combined'?<CombinedOrderEditor key={`${activeOrder.id}:${editorEpoch}`} initial={activeOrder} products={data.products||[]} onClose={()=>{setActiveOrder(null);void refreshOrders();}} onSaved={saved} onFinalized={o=>{saved(o);setActiveOrder(o);setAutoDownload(true);window.scrollTo(0,0);}} onRecovered={o=>{saved(o);setActiveOrder(o);setEditorEpoch(value=>value+1);window.scrollTo(0,0);}}/>:<OrderEditor partnerUserId={!manager?user.id:undefined} key={`${activeOrder.id}:${editorEpoch}`} initial={activeOrder} products={data.products||[]} onClose={()=>{setActiveOrder(null);void refreshOrders();}} onSaved={saved} onFinalized={o=>{saved(o);setActiveOrder(o);setAutoDownload(true);window.scrollTo(0,0);}} onRecovered={o=>{saved(o);setActiveOrder(o);setEditorEpoch(value=>value+1);window.scrollTo(0,0);}}/>):<OrderResult key={activeOrder.id} order={activeOrder} onClose={()=>{setActiveOrder(null);void refreshOrders();}} onCopy={copy} autoDownload={autoDownload}/>}</main>:<Tabs value={tab} onValueChange={value=>{setTab(String(value));setSearch('');setStatus('all');setHistoryRange('7d');}}><div className="nav-wrap"><TabsList className="main-nav" variant="line">{manager?<><TabsTrigger value="activity"><LayoutDashboard size={19}/>Activitate</TabsTrigger><TabsTrigger value="team"><Users size={19}/>Echipă</TabsTrigger><TabsTrigger value="sales"><TrendingUp size={19}/>Vânzări</TabsTrigger><TabsTrigger value="stock"><Package size={19}/>Stocuri</TabsTrigger><TabsTrigger value="catalog"><Package size={19}/>Catalog produse</TabsTrigger><TabsTrigger value="orders"><Boxes size={19}/>Comenzi</TabsTrigger><TabsTrigger value="sim"><ScanBarcode size={19}/>Avize</TabsTrigger><TabsTrigger value="settings"><Settings2 size={19}/>Setări</TabsTrigger></>:<><TabsTrigger value="orders"><Boxes size={19}/>Comenzi</TabsTrigger><TabsTrigger value="sim"><ScanBarcode size={19}/>Avize</TabsTrigger><TabsTrigger value="partner"><Store size={19}/>Parteneri</TabsTrigger><TabsTrigger value="sales"><TrendingUp size={19}/>Vânzări</TabsTrigger><TabsTrigger value="stock"><Package size={19}/>Stocul meu</TabsTrigger></>}</TabsList><span className="internal-label">PORTAL INTERN</span></div><main className="main-content">
      {error&&<p className="error-banner" role="alert">{error}</p>}
      {manager&&<TabsContent value="activity"><ManagerActivityDashboard key={requestNavEpoch} focusRequestId={focusRequestId} onRequestsChanged={()=>void refreshRequestInbox()}/></TabsContent>}
      {['orders','sim'].map(key=><TabsContent value={key} key={key}>
        <div className="page-heading"><div><span className="eyebrow">{manager?'ECHIPA MOBIUP':'SPAȚIUL TĂU DE LUCRU'}</span><h1>{key==='sim'?'Avize':'Comenzi'}</h1><p>{key==='sim'?'Pregătește avize SIM 0 sau standuri pentru clienți.':'Accesorii, cartele, telefoane și standuri într-o singură comandă.'}</p></div><div className="heading-controls">{manager&&<Choice label="Filtrează după agent" value={agentFilter} onChange={setAgentFilter} options={[{value:'all',label:'Toți agenții'},...users.filter(u=>u.role==='agent').map(u=>({value:u.id,label:u.name}))]}/>}<button className="icon-button refresh" aria-label="Actualizează comenzile" title="Actualizează" onClick={()=>void refreshOrders()}><RefreshCw size={19}/></button></div></div>
        <><div className="stats-strip"><div><span>FINALIZATE SĂPTĂMÂNA ASTA</span><strong>{weekly.filter(o=>key==='sim'?['sim','stand_client'].includes(o.kind):!['sim','stand_client'].includes(o.kind)).length}<small>comenzi</small></strong></div><div><span>CIORNE ÎN LUCRU</span><strong>{statsOrders.filter(o=>o.status==='draft').length}<small>de continuat</small></strong></div><div><span>PRODUSE ÎN CATALOG</span><strong>{(data.products||[]).length}<small>produse</small></strong></div><div><span>{manager?'GESTIUNI':'LIMITĂ ACCESORII'}</span><strong>{manager?warehouses.length:cfg.weeklyLimit}<small>{manager?'în echipă':'comenzi / săptămână'}</small></strong></div></div>
          <div className="quick-actions"><button className="action-card main-action order-action" onClick={()=>start(key==='sim'?'sim':'combined')} disabled={busy}><span className="action-icon"><Boxes size={29}/></span><span><span className="eyebrow">{key==='sim'?'SIM 0 VODAFONE':'COMANDĂ PENTRU STOC'}</span><h2>{key==='sim'?'Aviz pentru SIM 0':'Comandă nouă'}</h2><p>{key==='sim'?'Alege clientul din portofoliu și începe scanarea.':'Accesorii, cartele, telefoane și standuri.'}</p></span><span className="action-plus"><Plus size={23}/></span></button>{key==='sim'&&<button className="action-card main-action order-action" onClick={()=>start('stand_client')} disabled={busy}><span className="action-icon"><Boxes size={29}/></span><span><span className="eyebrow">STANDURI PENTRU CLIENT</span><h2>Aviz pentru standuri</h2><p>Alege clientul, punctul de lucru și standurile.</p></span><span className="action-plus"><Plus size={23}/></span></button>}</div></>
        <section className="panel orders-panel"><div className="panel-heading"><div><h2>{key==='sim'?'Istoric avize':'Istoric comenzi'}</h2><span className="count-pill">{current.length}</span></div></div><div className="history-range" aria-label="Perioada istoricului">{([['day','Azi'],['7d','7 zile'],['30d','30 zile'],['all','Tot']] as const).map(([value,label])=><button key={value} className={historyRange===value?'active':''} aria-pressed={historyRange===value} onClick={()=>setHistoryRange(value)}>{label}</button>)}</div><div className="panel-toolbar"><div className="search-box"><Search size={18}/><input value={search} onChange={e=>setSearch(e.target.value)} aria-label={key==='sim'?'Caută avize':'Caută comenzi'} placeholder={key==='sim'?'Caută aviz sau client…':'Caută comandă sau client…'}/></div><Choice label="Status" value={status} onChange={setStatus} options={[{value:'all',label:'Toate statusurile'},{value:'draft',label:'Ciorne'},{value:'finalized',label:'Finalizate'}]}/></div><OrderTable orders={current} onOpen={o=>void openOrder(o)} onCopy={copy} manager={manager} onDelete={o=>{setDeleteTarget(o);setDeleteError('');}}/></section>
        <div className="page-footnote"><Clock3 size={14}/>Ciornele se salvează automat și rămân vizibile indiferent de perioada selectată.</div>
      </TabsContent>)}
      {!manager&&<TabsContent value="partner"><PartnerPortfolio userId={user.id}/></TabsContent>}
      <TabsContent value="sales"><Suspense fallback={<div className="sales-loading">Se încarcă vânzările…</div>}><SalesPanel user={user} users={users}/></Suspense></TabsContent>
      <TabsContent value="stock">{manager&&<div className="page-heading"><div><h1>Stocuri agenți</h1></div></div>}{manager?<><label className="stock-agent-select">Agent<select aria-label="Agent pentru stoc" value={stockAgent} onChange={e=>setStockAgent(e.target.value)}><option value="">Selectează agentul</option>{users.filter(u=>u.role==='agent'&&u.active&&u.warehouseId).map(u=><option key={u.id} value={u.id}>{u.name} · {u.warehouseName}</option>)}</select></label>{stockAgent&&<StockWorkspace key={stockAgent} warehouseId={users.find(u=>u.id===stockAgent)?.warehouseId} title="Stoc agent" manager/>}</>:<StockWorkspace warehouseId={user.warehouseId}/>}</TabsContent>
      {manager&&<TabsContent value="team"><Team users={users} warehouses={warehouses} onUsers={users=>setData(d=>({...d,users}))} warnings={data.importWarnings||[]} canCreateAgents={globalManager}/></TabsContent>}{manager&&<TabsContent value="catalog"><ProductCatalog products={data.products||[]} onProducts={products=>setData(d=>({...d,products}))}/></TabsContent>}{manager&&<TabsContent value="settings"><div className="settings-stack"><PushNotifications/>{globalManager?<SettingsPanel settings={cfg} users={users} onSettings={settings=>setData(d=>({...d,settings}))} onUsers={users=>setData(d=>({...d,users}))}/>:<ManagerMailPanel settings={data.managerMailSettings||defaultManagerMail} regionalSettings={data.regionalSettings||cfg} mixed={!!data.regionalSettingsMixed} onSettings={managerMailSettings=>setData(d=>({...d,managerMailSettings}))} onRegionalSettings={regionalSettings=>setData(d=>({...d,regionalSettings,regionalSettingsMixed:false}))}/>}</div></TabsContent>}
    </main></Tabs>}
    <footer className="app-footer"><span>Mobiup <span>Distribuție</span></span><span>Comenzi & avize · {new Date().getFullYear()}</span></footer>
  </div><Dialog open={requestsOpen} onOpenChange={setRequestsOpen}><DialogContent className="admin-dialog request-inbox-dialog"><DialogHeader><DialogTitle>Solicitări</DialogTitle><DialogDescription>{requestInbox.count?`${requestInbox.count} solicitări de partener așteaptă confirmarea.`:'Nu ai solicitări în așteptare.'}</DialogDescription></DialogHeader>{requestInbox.items.length?<div className="request-inbox-list">{requestInbox.items.map(item=><div className="request-inbox-item" key={item.id}><span><strong>{item.title}</strong><small>{item.agentName} · {item.location}{item.county?` · ${item.county}`:''} · {dateLabel(item.createdAt)}</small></span><button className="secondary" disabled={activeOrder?.status==='draft'} onClick={()=>openRequest(item.id)}>Deschide</button></div>)}{requestInbox.count>requestInbox.items.length&&<p className="muted">Sunt afișate cele mai recente {requestInbox.items.length} solicitări.</p>}</div>:<p className="portfolio-message">Nicio solicitare de procesat.</p>}</DialogContent></Dialog><Dialog open={!!deleteTarget} onOpenChange={open=>{if(!open&&!deleting)setDeleteTarget(null);}}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>{deleteTarget?.status==='draft'?'Renunți la ciorna':'Ștergi comanda'} {deleteTarget?.number}?</DialogTitle><DialogDescription>{deleteTarget?.agentName} · {deleteTarget?.warehouseName}. {deleteTarget?.status==='draft'?'Ciorna va fi eliminată din istoricul tău.':'Comanda va dispărea din istoricul tuturor utilizatorilor.'}{deleteTarget?.status==='finalized'&&' Ștergerea nu retrage e-mailurile deja trimise.'}{deleteTarget?.kind==='sim'&&' Seriile SIM vor putea fi folosite într-un aviz nou.'}</DialogDescription></DialogHeader>{deleteError&&<p className="error-banner" role="alert">{deleteError}</p>}<div className="delete-actions"><button className="secondary" disabled={deleting} onClick={()=>setDeleteTarget(null)}>Renunță</button><button className="danger" disabled={deleting} onClick={()=>void deleteOrder()}>{deleting?(deleteTarget?.status==='draft'?'Se elimină…':'Se șterge…'):(deleteTarget?.status==='draft'?'Renunță la ciornă':'Șterge comanda')}</button></div></DialogContent></Dialog>
  <Dialog open={!!newKind} onOpenChange={open=>{if(!open&&!busy)setNewKind(null);}}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>Comandă nouă · {newKind?kindLabels[newKind]:''}</DialogTitle><DialogDescription>Alege agentul. Comanda va apărea în gestiunea și istoricul lui.</DialogDescription></DialogHeader><label htmlFor="order-agent">Agent<Choice id="order-agent" label="Agentul comenzii" value={agentId} onChange={setAgentId} options={users.filter(u=>u.role==='agent'&&u.active).map(u=>({value:u.id,label:u.name+' · '+u.warehouseName?.replace(/^gestiune\s+/i,'')}))}/></label><button className="primary" disabled={busy||!agentId} onClick={()=>newKind&&void create(newKind)}>{busy?<LoaderCircle className="spin" size={18}/>:<Plus size={18}/>} Creează ciorna</button></DialogContent></Dialog>
  <Dialog open={reauthOpen} onOpenChange={()=>{}}><DialogContent className="admin-dialog" showCloseButton={false}><DialogHeader><DialogTitle>Sesiunea a expirat</DialogTitle><DialogDescription>Reautentifică-te pentru a continua. Modificările locale ale ciornei sunt păstrate.</DialogDescription></DialogHeader><form className="form-stack" onSubmit={e=>void login(e)}><label>Utilizator<input name="username" value={user.username} readOnly autoComplete="username"/></label><label>Parolă<input name="password" type="password" autoComplete="current-password" required maxLength={128}/></label>{error&&<p className="error-banner" role="alert">{error}</p>}<div className="delete-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>{setReauthOpen(false);setActiveOrder(null);setData({user:null});setTab('orders');setError('');}}>Ieșire la autentificare</button><button className="primary" disabled={busy}>{busy?'Se conectează…':'Reautentifică-te'}</button></div><p className="muted">După autentificare, ciorna este reîncărcată de pe server și reconciliată cu modificările locale.</p></form></DialogContent></Dialog>
  <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>Schimbă parola</DialogTitle><DialogDescription>{user.username}</DialogDescription></DialogHeader><PasswordForm onDone={()=>{setPasswordOpen(false);void refreshOrders();}}/></DialogContent></Dialog>
  {orderRecovery&&<OrderRecoveryDialog recovery={orderRecovery} userId={user.id} onView={o=>{setOrderRecovery(null);setActiveOrder(o);setAutoDownload(false);window.scrollTo(0,0);}} onDiscard={o=>{setOrderRecovery(null);if(o){setActiveOrder(o);setAutoDownload(false);window.scrollTo(0,0);}}} onRecovered={o=>{setOrderRecovery(null);saved(o);setActiveOrder(o);setAutoDownload(false);setEditorEpoch(value=>value+1);window.scrollTo(0,0);}}/>}</>;
}
