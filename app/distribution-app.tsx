'use client';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Boxes, ScanBarcode, History, LockKeyhole, LogOut, Users, Settings2, Plus, Package, CalendarDays, Search, RefreshCw, Clock3, LoaderCircle, KeyRound, WifiOff, TrendingUp, Store, Bell, LayoutDashboard } from 'lucide-react';
import Image from 'next/image';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Feedback } from '@/components/feedback';
import { Choice } from '@/components/choice';
import { writePermissions } from '@/lib/types';
import { OrderTable } from '@/components/order-table';
import { OrderRecoveryDialog } from '@/components/order-recovery-dialog';
import { PushNotifications } from '@/components/push-notifications';
import type { ManagerDestination } from '@/components/manager-workspace';
import { ManagerScopeBar, useManagerScope } from '@/components/manager-scope';
import { api, networkApi, ApiError, dateLabel, errorMessage, normalize, kindLabels, orderDateKey, localDateKey, SESSION_EXPIRED_EVENT, startOfflineSync } from '@/lib/client-api';
import { bucharestReportingMonthKey } from '@/lib/bucharest-month';
import { enqueue, pendingOperations, readWork, reconcileOrderList, markOrderDeleted, OFFLINE_EVENT } from '@/lib/offline-work';
import { readFinalizedOrderRecovery, readOrphanedOrderRecoveries, type OrderRecovery } from '@/lib/order-recovery';
import type { User, Warehouse, Product, Order, Kind, Settings, OperationalMailSettings, ManagerMailSettings, ManagerRequestInbox } from '@/lib/types';

const SalesPanel = lazy(() => import('@/components/sales').then(module => ({ default: module.SalesPanel })));
const OrderEditor = lazy(() => import('@/components/order-editor').then(module => ({ default: module.OrderEditor })));
const CombinedOrderEditor = lazy(() => import('@/components/combined-order-editor').then(module => ({ default: module.CombinedOrderEditor })));
const OrderResult = lazy(() => import('@/components/order-result').then(module => ({ default: module.OrderResult })));
const ProductCatalog = lazy(() => import('@/components/product-catalog').then(module => ({ default: module.ProductCatalog })));
const StockWorkspace = lazy(() => import('@/components/stock-workspace').then(module => ({ default: module.StockWorkspace })));
const PartnerPortfolio = lazy(() => import('@/components/partner-portfolio').then(module => ({ default: module.PartnerPortfolio })));
const ManagerOverview = lazy(() => import('@/components/manager-workspace').then(module => ({ default: module.ManagerOverview })));
const ManagerRequests = lazy(() => import('@/components/manager-workspace').then(module => ({ default: module.ManagerRequests })));
const ManagerTeamLinks = lazy(() => import('@/components/manager-workspace').then(module => ({ default: module.ManagerTeamLinks })));
const Team = lazy(() => import('@/components/admin').then(module => ({ default: module.Team })));
const SettingsPanel = lazy(() => import('@/components/admin').then(module => ({ default: module.SettingsPanel })));
const ManagerMailPanel = lazy(() => import('@/components/admin').then(module => ({ default: module.ManagerMailPanel })));

type Bootstrap={user:User|null;products?:Product[];warehouses?:Warehouse[];orders?:Order[];users?:User[];settings?:Settings;managerMailSettings?:ManagerMailSettings;regionalSettings?:OperationalMailSettings;regionalSettingsMixed?:boolean;weekKey?:string;importWarnings?:{row:number;name:string;reason:string}[]};
type OrderRefresh={user:User;orders:Order[];weekKey:string};
const defaultSettings:Settings={accessoriesEmail:'',standsEmail:'',simEmail:'',accessoriesCc:[],standsCc:[],simCc:[],partnerTo:[],partnerCc:[],weeklyLimit:2};
const defaultManagerMail:ManagerMailSettings={accessories:'',stands:'',sim:'',partner:''};
const managerCurrentMonth = () => bucharestReportingMonthKey(new Date());
const freshnessDataset = (path:string) => path.split('?')[0];
function Brand() {return <div className="brand"><Image unoptimized src="/mobiup-logo.webp" alt="Mobiup" width="200" height="58"/><span className="brand-label">DISTRIBUȚIE</span></div>;}
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
  const [partnerView,setPartnerView]=useState<'portfolio'|'requests'>('portfolio');
  const [partnerOpened,setPartnerOpened]=useState(false);
  const [stockMode,setStockMode]=useState<'stock'|'inventory'>('stock');
  const [managerMonth,setManagerMonth]=useState(managerCurrentMonth);
  const [tab,setTab]=useState('orders'),[activeOrder,setActiveOrder]=useState<Order|null>(null),[autoDownload,setAutoDownload]=useState(false),[newKind,setNewKind]=useState<Kind|null>(null),[agentId,setAgentId]=useState('agent-g-5'),[passwordOpen,setPasswordOpen]=useState(false);
  const [search,setSearch]=useState(''),[status,setStatus]=useState('all'),[historyRange,setHistoryRange]=useState<'day'|'7d'|'30d'|'all'>('7d'),[historyAnchor,setHistoryAnchor]=useState(()=>Date.now());
  const [deleteTarget,setDeleteTarget]=useState<Order|null>(null),[deleting,setDeleting]=useState(false),[deleteError,setDeleteError]=useState('');
  const [editorEpoch,setEditorEpoch]=useState(0);
  const [reauthOpen,setReauthOpen]=useState(false);
  const [orderRecovery,setOrderRecovery]=useState<OrderRecovery|null>(null);
  const [requestInbox,setRequestInbox]=useState<ManagerRequestInbox>({count:0,items:[]}),[requestsOpen,setRequestsOpen]=useState(false),[focusRequestId,setFocusRequestId]=useState(''),[requestNavEpoch,setRequestNavEpoch]=useState(0);
  const [sessionState,setSessionState]=useState<'checking'|'authenticated'|'unauthenticated'|'network-error'|'offline-local'>('checking');
  const [offlineNotices,setOfflineNotices]=useState<Record<string,number>>({});
  const [pendingCount,setPendingCount]=useState(0);
  const [blockedOrderIds,setBlockedOrderIds]=useState<string[]>([]);
  const createId=useRef<string|null>(null);
  const creating=useRef(false);
  const sessionUserId=useRef('');
  const bootstrapEpoch=useRef(0);
  const openIntent=useRef(0),listIntent=useRef(0);
  const offlineSources=useRef<Record<string,number>>({});
  const offerRecovery=useCallback(async(owner:string,recoveries:OrderRecovery[],valid:()=>boolean)=>{
    const intent=openIntent.current;
    const current=()=>valid()&&sessionUserId.current===owner&&openIntent.current===intent;
    // Missing from a list/page is only a candidate. Require a live terminal
    // response before offering deleted/finalized recovery after a reload.
    for(const recovery of recoveries.slice(0,5)){
      if(!current())return;
      try{const {order}=await networkApi<{order:Order}>(`orders/${recovery.local.id}`);if(!current())return;if(order.status!=='draft'){setOrderRecovery(previous=>previous||{remote:order,local:recovery.local});return;}}
      catch(error){if(!current())return;if(error instanceof ApiError&&error.status===404){setOrderRecovery(previous=>previous||{remote:null,local:recovery.local});return;}}
    }
  },[]);
  const loadBootstrap=useCallback(async()=>{
    const epoch=++bootstrapEpoch.current,listRequest=++listIntent.current;
    try{const session=await api<{user:User|null}>('auth/session');if(epoch!==bootstrapEpoch.current)return undefined;if(!session.user){setSessionState('unauthenticated');setData({user:null});return {user:null};}const changedAccount=sessionUserId.current!==session.user.id;if(changedAccount){openIntent.current++;offlineSources.current={};setOfflineNotices({});setPendingCount(0);setBlockedOrderIds([]);sessionUserId.current=session.user.id;setActiveOrder(null);setPartnerOpened(false);setPartnerView('portfolio');setTab(session.user.role==='manager'?'activity':'orders');}setSessionState(current=>current==='offline-local'?'offline-local':'authenticated');setData(current=>changedAccount?{user:session.user}:({...current,user:session.user}));const result=await api<Bootstrap>('bootstrap');if(epoch!==bootstrapEpoch.current)return undefined;if(result.user){result.orders=await reconcileOrderList(result.user.id,result.orders||[]);if(epoch!==bootstrapEpoch.current||listRequest!==listIntent.current)return undefined;}setData(result);setError('');if(result.user&&result.orders){const orphaned=readOrphanedOrderRecoveries(result.orders,result.user.id);if(orphaned.recoveries.length){setBlockedOrderIds(current=>[...new Set([...current,...orphaned.recoveries.map(row=>row.local.id)])]);void offerRecovery(result.user.id,orphaned.recoveries,()=>epoch===bootstrapEpoch.current&&listRequest===listIntent.current);}}return result;}catch(err){if(epoch!==bootstrapEpoch.current)return undefined;setError(errorMessage(err));setSessionState(current=>current==='authenticated'||current==='offline-local'?current:'network-error');return undefined;}finally{if(epoch===bootstrapEpoch.current)setLoading(false);}
  },[offerRecovery]);
  const refreshOrders=useCallback(async()=>{
    const request=++listIntent.current,owner=sessionUserId.current,accountEpoch=bootstrapEpoch.current;
    const current=()=>request===listIntent.current&&owner===sessionUserId.current&&accountEpoch===bootstrapEpoch.current;
    try{
      const result=await api<OrderRefresh>('orders');
      if(!current()||result.user.id!==owner)return;
      result.orders=await reconcileOrderList(owner,result.orders);if(!current())return;
      setData(current=>({...current,user:result.user,orders:result.orders,weekKey:result.weekKey}));
      const orphaned=readOrphanedOrderRecoveries(result.orders,result.user.id);if(orphaned.recoveries.length){setBlockedOrderIds(current=>[...new Set([...current,...orphaned.recoveries.map(row=>row.local.id)])]);void offerRecovery(owner,orphaned.recoveries,current);}
      setHistoryAnchor(Date.now());setError('');
    }catch(err){
      if(!current())return;
      if(err instanceof ApiError&&err.status===401){setActiveOrder(null);sessionUserId.current='';setSessionState('unauthenticated');setData({user:null});setTab('orders');}
      else setError(errorMessage(err));
    }finally{if(current())setLoading(false);}
  },[offerRecovery]);
  const refreshRequestInbox=useCallback(async()=>{
    if(data.user?.role!=='manager')return;
    try{setRequestInbox(await api<ManagerRequestInbox>('notifications/inbox'));}catch(err){if(!(err instanceof ApiError&&err.status===401))console.warn('Request inbox refresh failed');}
  },[data.user?.role]);
  useEffect(()=>{queueMicrotask(()=>void loadBootstrap());return startOfflineSync(()=>void loadBootstrap());},[loadBootstrap]);
  useEffect(()=>{
    const update=()=>{const owner=sessionUserId.current;if(owner)void pendingOperations(owner).then(rows=>{if(owner===sessionUserId.current){setPendingCount(rows.length);setBlockedOrderIds([...new Set(rows.filter(op=>op.state==='blocked'&&op.path.startsWith('orders/')).map(op=>op.path.slice(7)))]);}}).catch(()=>{});};
    const freshness=(event:Event)=>{
      const detail=(event as CustomEvent<{userId:string;path:string;source:'network'|'offline';at:number}>).detail;
      if(!detail||detail.userId!==sessionUserId.current)return;
      const dataset=freshnessDataset(detail.path);
      const next={...offlineSources.current};
      if(detail.source==='offline')next[dataset]=detail.at;else delete next[dataset];
      offlineSources.current=next;setOfflineNotices(next);
      if(detail.source==='offline')setSessionState('offline-local');
      else if(!Object.keys(next).length)setSessionState('authenticated');
    };
    const confirmed=(event:Event)=>{const d=(event as CustomEvent).detail;if(d.userId===sessionUserId.current){update();if(d.result?.order)void refreshOrders();}};
    window.addEventListener('mobiup-data-freshness',freshness);
    window.addEventListener(OFFLINE_EVENT,update);
    window.addEventListener('mobiup-sync-confirmed',confirmed);
    const accountChanged=(event:StorageEvent)=>{if(event.key==='mobiup-work-user-v1'){bootstrapEpoch.current++;openIntent.current++;listIntent.current++;offlineSources.current={};setActiveOrder(null);setOfflineNotices({});setPendingCount(0);setBlockedOrderIds([]);setData({user:null});setSessionState('checking');void loadBootstrap();}};
    window.addEventListener('storage',accountChanged);
    update();
    return()=>{
      window.removeEventListener('mobiup-data-freshness',freshness);
      window.removeEventListener(OFFLINE_EVENT,update);
      window.removeEventListener('mobiup-sync-confirmed',confirmed);
      window.removeEventListener('storage',accountChanged);
    };
  },[loadBootstrap,refreshOrders]);
  useEffect(()=>{
    const expired=()=>{openIntent.current++;listIntent.current++;
      if(activeOrder){setReauthOpen(true);setError('Sesiunea a expirat. Reautentifică-te pentru a continua ciorna.');}
      else{sessionUserId.current='';setSessionState('unauthenticated');setData({user:null});setTab('orders');}
    };
    window.addEventListener(SESSION_EXPIRED_EVENT,expired);
    return()=>window.removeEventListener(SESSION_EXPIRED_EVENT,expired);
  },[activeOrder]);
  const online=useSyncExternalStore(useCallback((notify:()=>void)=>{window.addEventListener('online',notify);window.addEventListener('offline',notify);return()=>{window.removeEventListener('online',notify);window.removeEventListener('offline',notify);};},[]),()=>navigator.onLine,()=>true);
  useEffect(()=>{
    if(!data.user||data.user.mustChangePassword||activeOrder||!['orders','sim'].includes(tab))return;
    const refreshVisible=()=>{if(navigator.onLine&&document.visibilityState==='visible'){setHistoryAnchor(Date.now());void refreshOrders();}};
    const interval=setInterval(refreshVisible,30000);
    document.addEventListener('visibilitychange',refreshVisible);
    return()=>{clearInterval(interval);document.removeEventListener('visibilitychange',refreshVisible);};
  },[data.user,activeOrder,refreshOrders,tab]);
  useEffect(()=>{
    if(data.user?.role!=='manager'||data.user.mustChangePassword)return;
    const refresh=()=>{if(navigator.onLine&&document.visibilityState==='visible')void refreshRequestInbox();};queueMicrotask(refresh);const interval=setInterval(refresh,30000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(interval);document.removeEventListener('visibilitychange',refresh);};
  },[data.user?.role,data.user?.mustChangePassword,refreshRequestInbox]);
  useEffect(()=>{
    if(data.user?.role!=='manager')return;const id=new URLSearchParams(window.location.search).get('request');if(!id||!/^[0-9a-f-]{36}$/i.test(id))return;queueMicrotask(()=>{setFocusRequestId(id);setRequestNavEpoch(value=>value+1);setPartnerView('requests');setTab('partner');});
  },[data.user?.role]);
  const orders=useMemo(()=>data.orders||[],[data.orders]);
  const user=data.user,users=data.users||[],warehouses=data.warehouses||[],cfg=data.settings||defaultSettings;
  const managerScope=useManagerScope(user,users);
  const writes=writePermissions(user,users);
  const createAgents=managerScope.selectedAgents.filter(agent=>writes.createOrder(agent.id));
  const agentFilter=managerScope.agentId||'all',setAgentFilter=managerScope.selectAgent;
  const selectionContext=JSON.stringify([tab,search,status,historyRange,managerScope.query,data.user?.id]);
  const previousSelectionContext=useRef(selectionContext);
  useEffect(()=>{if(previousSelectionContext.current!==selectionContext){openIntent.current++;previousSelectionContext.current=selectionContext;}},[selectionContext]);
  const stockAgent=managerScope.agentId,setStockAgent=managerScope.selectAgent;
  useEffect(()=>{if(tab==='partner'&&user?.role==='manager')queueMicrotask(()=>setPartnerOpened(true));},[tab,user?.role]);
  const [salesView,setSalesView]=useState<'current'|'history'|'clients'|undefined>();
  function navigateAgent(id:string,destination:ManagerDestination){if(id&&id!==managerScope.agentId)managerScope.openAgent(id);if(destination==='clients'){setSalesView('clients');setTab('sales');}else if(destination==='inventory'){setStockMode('inventory');setTab('stock');}else {if(destination==='sales')setSalesView(undefined);if(destination==='stock')setStockMode('stock');if(destination==='partner')setPartnerView('portfolio');setTab(destination);}window.scrollTo(0,0);}
  const saved=useCallback((o:Order)=>{setData(d=>({...d,orders:[o,...(d.orders||[]).filter(x=>x.id!==o.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}));},[]);
  async function deleteOrder() {
    if(!deleteTarget||deleting||!writes.agent(deleteTarget.userId))return;
    setDeleting(true);setDeleteError('');
    try {
      await api(`orders/${deleteTarget.id}`,'DELETE',{revision:deleteTarget.revision});
      await markOrderDeleted(user!.id,deleteTarget.id);listIntent.current++;
      setData(d=>({...d,orders:(d.orders||[]).filter(o=>o.id!==deleteTarget.id)}));
      setDeleteTarget(null);toast.success('Comanda a fost ștearsă.');void refreshOrders();
    } catch(err) {setDeleteError(errorMessage(err));} finally {setDeleting(false);}
  }
  function showOrder(order:Order,account=data.user) {
    openIntent.current++;
    if(order.status!=='draft'&&account&&writePermissions(account,users).createOrder(order.userId)) {
      const recovery=readFinalizedOrderRecovery(order,account.id);
      if(recovery){setOrderRecovery(recovery);setActiveOrder(null);setAutoDownload(false);return;}
    }
    setOrderRecovery(null);setActiveOrder(order);setAutoDownload(false);window.scrollTo(0,0);
  }
  async function login(e:React.SyntheticEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError('');try{await api('auth/login','POST',Object.fromEntries(new FormData(e.currentTarget)));const fresh=await loadBootstrap();if(reauthOpen&&activeOrder&&fresh?.user){const r=await api<{order:Order}>(`orders/${activeOrder.id}`);showOrder(r.order,fresh.user);setEditorEpoch(value=>value+1);setReauthOpen(false);setError('');}}catch(err){setError(errorMessage(err));}finally{setBusy(false);}}
  async function logout(){bootstrapEpoch.current++;openIntent.current++;listIntent.current++;try{await api('auth/logout','POST',{});offlineSources.current={};setActiveOrder(null);setOrderRecovery(null);setRequestInbox({count:0,items:[]});setOfflineNotices({});setPendingCount(0);setBlockedOrderIds([]);sessionUserId.current='';setSessionState('unauthenticated');setData({user:null});setTab('orders');}catch(e){toast.error(errorMessage(e));}}
  async function openOrder(o:Order){const intent=++openIntent.current,owner=sessionUserId.current;const current=()=>intent===openIntent.current&&owner===sessionUserId.current;if(o.number==='Ciornă locală'){showOrder(o);return;}try{const r=await api<{order:Order}>(`orders/${o.id}`);const work=await readWork<{base:Order;local:Order}>(owner,'order',o.id);if(!current())return;if(r.order.status!=='draft'&&work){setOrderRecovery({remote:r.order,local:work.local});return;}showOrder(r.order);}catch(e){if(!current())return;if(e instanceof ApiError&&e.status===404){const work=await readWork<{base:Order;local:Order}>(owner,'order',o.id);if(current()&&work){setOrderRecovery({remote:null,local:work.local});return;}}if(current())toast.error(errorMessage(e));}}
  async function openBlockedOrder(id:string){const owner=sessionUserId.current;const work=await readWork<{local:Order}>(owner,'order',id);if(owner!==sessionUserId.current)return;if(work)await openOrder({...work.local,number:work.local.number==='Ciornă locală'?'Ciornă de verificat':work.local.number});}
  async function create(kind:Kind,source?:Order){
    if(creating.current||!writes.createOrder(user?.role==='agent'?user.id:source?.userId||agentId))return;
    openIntent.current++;creating.current=true;setBusy(true);try{
      createId.current??=crypto.randomUUID();
      const r=await api<{order:Order}>('orders','POST',{id:createId.current,kind,agentId:source?.userId||agentId,sourceOrderId:source?.id});
      createId.current=null;saved(r.order);setActiveOrder(r.order);setAutoDownload(false);setNewKind(null);window.scrollTo(0,0);
    }catch(err){
      if(user?.role==='agent'&&!(err instanceof ApiError&&err.status<500)&&createId.current&&!source){
        try{const id=createId.current;const local:Order={id,number:'Ciornă locală',kind,userId:user.id,agentName:user.name,warehouseId:user.warehouseId||'',warehouseName:user.warehouseName||'',status:'draft',items:[],standItems:[],serials:[],client:null,notes:'',createdAt:new Date().toISOString(),finalizedAt:null,sourceOrderId:null,revision:1,total:0,pieces:0};
          const existing=await readWork<Order[]>(user.id,'draft-list','all')||[];await enqueue(user.id,'orders','POST',{id,kind,agentId:user.id},{scope:'draft-list',id:'all',value:[local,...existing.filter(o=>o.id!==id)]});
          createId.current=null;saved(local);setActiveOrder(local);setAutoDownload(false);setNewKind(null);toast.info('Ciornă salvată pe telefon · În așteptare.');
        }catch(storage){toast.error(errorMessage(storage));}
      }else toast.error(errorMessage(err));
    }finally{creating.current=false;setBusy(false);}
  }
  function start(kind:Kind){createId.current=null;if(user?.role==='manager'){const available=createAgents;if(!available.length)return;if(managerScope.agentId&&available.some(u=>u.id===managerScope.agentId))setAgentId(managerScope.agentId);else if(!available.some(u=>u.id===agentId))setAgentId(available[0]?.id||'');setNewKind(kind);}else void create(kind);}
  function copy(order:Order){createId.current=null;void create(order.kind,order);}
  function openRequest(id?:string){if(activeOrder?.status==='draft')return;setFocusRequestId(id||'');if(id)managerScope.selectRegion('');setRequestNavEpoch(value=>value+1);setPartnerView('requests');setTab('partner');setRequestsOpen(false);window.scrollTo(0,0);}
  useEffect(()=>{
    if(!user||user.mustChangePassword)return;
    type ModelContext={registerTool:(tool:{name:string;description:string;inputSchema:object;annotations?:object;execute:(input:unknown)=>unknown},options:{signal:AbortSignal})=>void|Promise<void>};
    const context=(document as Document&{modelContext?:ModelContext}).modelContext;if(!context?.registerTool)return;
    const lifecycle=new AbortController();
    const tool={name:'mobiup_search_orders',description:'Caută comenzile vizibile utilizatorului curent și deschide lista relevantă filtrată; nu modifică comenzile.',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input:unknown){if(!input||typeof input!=='object'||!('query'in input)||typeof input.query!=='string')throw new Error('Este necesar query text.');if(activeOrder)throw new Error('Salvează și închide comanda curentă înainte de căutare.');const matches=orders.filter(o=>normalize(o.number+' '+o.agentName+' '+o.client?.name).includes(normalize(input.query as string)));setTab(matches[0]?.kind==='sim'?'sim':'orders');setHistoryRange('all');setSearch(input.query);return matches.map(o=>({id:o.id,number:o.number,status:o.status,pieces:o.pieces}));}};
    try{void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}
    return()=>lifecycle.abort();
  },[user,orders,activeOrder]);
  if(!user&&sessionState!=='unauthenticated')return <main className="first-password"><Brand/><div className="panel" aria-live="polite"><h1>{sessionState==='checking'?'Se verifică sesiunea…':'Conexiune indisponibilă'}</h1><p>{error||'Se pregătește aplicația.'}</p>{sessionState!=='checking'&&<button className="primary" onClick={()=>{setSessionState('checking');setLoading(true);void loadBootstrap();}}>Reîncearcă</button>}</div></main>;
  if(!user) return <><Feedback/><main className="login-page"><section className="login-story"><Brand/><div className="login-intro"><span className="eyebrow">ECHIPA DIN TEREN</span><h1>Tot ce comanzi.<br/>Într-un singur loc.</h1><p>Stocul tău, comenzile tale și clienții de pe rută.</p></div><div className="login-features"><div><Boxes/><span><strong>Comenzi accesorii & standuri</strong><small>Produse organizate. Excel în formatul cunoscut.</small></span></div><div><ScanBarcode/><span><strong>Aviz client SIM 0</strong><small>Alegi clientul, scanezi seriile, pregătești avizul.</small></span></div><div><History/><span><strong>Istoric la îndemână</strong><small>Reiei o comandă și ajustezi cantitățile.</small></span></div></div><span className="login-foot">MOBIUP · PORTAL INTERN</span></section><section className="login-panel"><form className="login-form" onSubmit={e=>void login(e)}><span className="login-lock"><LockKeyhole size={26}/></span><h2>Bine ai revenit</h2><p>Intră în contul tău de agent sau manager.</p><label>Utilizator<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required placeholder="Numele de utilizator"/></label><label>Parolă<input name="password" type="password" autoComplete="current-password" required maxLength={128} placeholder="Parola ta"/></label>{error&&<p className="error-banner" role="alert">{error}</p>}<button className="primary" type="submit" disabled={busy||loading}>{busy||loading?'Se conectează…':'Intră în cont'} <ArrowRight size={19}/></button><p className="muted login-help">Pentru acces sau resetarea parolei, contactează managerul echipei.</p></form><div className="login-bottom"><span className="status-dot"/> Mobiup · Echipa de distribuție</div></section></main></>;
  if(user.mustChangePassword) return <><Feedback/><div className="first-password"><Brand/><div className="panel"><span className="login-lock"><KeyRound size={25}/></span><h1>Alege parola ta</h1><p>Bună, {user.name}. Înlocuiește parola temporară pentru a intra în aplicație.</p><PasswordForm onDone={()=>void loadBootstrap()}/><button className="quiet" onClick={()=>void logout()}>Ieșire din cont</button></div></div></>;
  const manager=user.role==='manager';
  const globalManager=manager&&user.managerScope==='global';
  const managedAgentIds=new Set(users.find(item=>item.id===user.id)?.managedAgentIds||[]);
  const managedUsers=users.filter(item=>globalManager||item.id===user.id||managedAgentIds.has(item.id));
  const managedWarehouses=warehouses.filter(item=>globalManager||managedUsers.some(agent=>agent.role==='agent'&&agent.warehouseId===item.id));
  const selectedAgentIds=new Set(managerScope.selectedAgents.map(agent=>agent.id));
  const visibleOrders=orders.filter(o=>!manager||(!managerScope.managerId&&!managerScope.agentId)||selectedAgentIds.has(o.userId));
  const weekly=visibleOrders.filter(o=>o.status==='finalized'&&o.finalizedAt&&localDateKey(o.finalizedAt)>=(data.weekKey||'9999'));
  const rangeDays=historyRange==='day'?0:historyRange==='7d'?6:historyRange==='30d'?29:null;
  const historyCutoff=rangeDays===null?'':localDateKey(new Date(historyAnchor-rangeDays*86_400_000).toISOString());
  const current=visibleOrders.filter(o=>(tab==='sim'?['sim','stand_client'].includes(o.kind):!['sim','stand_client'].includes(o.kind))&&(status==='all'||o.status===status)&&normalize(o.number+' '+o.agentName+' '+o.warehouseName+' '+o.client?.name+' '+o.client?.cui).includes(normalize(search))&&(o.status==='draft'||!historyCutoff||orderDateKey(o)>=historyCutoff));
  const statsOrders=visibleOrders.filter(o=>tab==='sim'?['sim','stand_client'].includes(o.kind):!['sim','stand_client'].includes(o.kind));
  const staleEntries=Object.entries(offlineNotices);
  const oldestOfflineAt=staleEntries.reduce((oldest,[,at])=>Math.min(oldest,at),Infinity);
  const businessDataReady=Array.isArray(data.products)&&Array.isArray(data.orders)&&Array.isArray(data.warehouses);
  return <><Feedback/><div className={'app-shell'+(manager?' manager-shell':'')}>{staleEntries.length>0&&<p className="error-banner" aria-live="polite">Date locale · cea mai veche copie afișată {new Date(oldestOfflineAt).toLocaleString('ro-RO')}. Sunt în așteptarea actualizării {staleEntries.length} seturi de date.</p>}{pendingCount>0&&<p className="error-banner" aria-live="polite">{pendingCount} operațiuni în așteptare. Finalizarea necesită conexiune și confirmare pe server.</p>}<header className="app-header"><Brand/><div className="header-right"><span className="header-date"><CalendarDays size={16}/>{new Date().toLocaleDateString('ro-RO',{day:'numeric',month:'long',year:'numeric'})}</span><span className="header-divider"/>{manager&&<button className="icon-button request-bell" onClick={()=>setRequestsOpen(true)} aria-label={`Solicitări${requestInbox.count?` (${requestInbox.count})`:``}`} title="Solicitări"><Bell size={20}/>{requestInbox.count>0&&<span className="request-count">{requestInbox.count>99?'99+':requestInbox.count}</span>}</button>}{manager?<button className="profile" onClick={()=>setPasswordOpen(true)} aria-label="Schimbă parola contului"><span className="avatar">{user.name.split(' ').slice(0,2).map(s=>s[0]).join('')}</span><span><strong>{user.name}</strong><small>{globalManager?'Manager distribuție':'Manager regional'}</small></span></button>:<div className="profile"><span className="avatar">{user.name.split(' ').slice(0,2).map(s=>s[0]).join('')}</span><span><strong>{user.name}</strong><small>{user.warehouseName?.replace(/^gestiune\s+/i,'')}</small></span></div>}{manager&&<button className="icon-button manager-settings" aria-label="Setări" title="Setări" aria-pressed={tab==='settings'} disabled={!!activeOrder} onClick={()=>setTab('settings')}><Settings2 size={20}/></button>}<button className="icon-button logout" disabled={activeOrder?.status==='draft'} title="Ieșire din cont" aria-label="Ieșire din cont" onClick={()=>void logout()}><LogOut size={19}/></button></div></header>
    {!online&&<div className="offline-banner" role="alert"><WifiOff size={17}/> Conexiune întreruptă. Verifică starea „Salvat pe telefon” înainte să închizi pagina. Sincronizarea continuă când revine conexiunea.</div>}
    <Suspense fallback={<main className="main-content"><output aria-live="polite">Se încarcă modulul solicitat…</output></main>}>
    {activeOrder?<main className="main-content">{activeOrder.status==='draft'?(activeOrder.kind==='combined'?<CombinedOrderEditor canEdit={writes.agent(activeOrder.userId)} key={`${activeOrder.id}:${editorEpoch}`} initial={activeOrder} products={data.products||[]} onClose={()=>{openIntent.current++;setActiveOrder(null);void refreshOrders();}} onSaved={saved} onFinalized={o=>{saved(o);setActiveOrder(o);setAutoDownload(true);window.scrollTo(0,0);}} onRecovered={o=>{saved(o);setActiveOrder(o);setEditorEpoch(value=>value+1);window.scrollTo(0,0);}}/>:<OrderEditor canEdit={writes.agent(activeOrder.userId)} partnerUserId={!manager?user.id:undefined} key={`${activeOrder.id}:${editorEpoch}`} initial={activeOrder} products={data.products||[]} onClose={()=>{openIntent.current++;setActiveOrder(null);void refreshOrders();}} onSaved={saved} onFinalized={o=>{saved(o);setActiveOrder(o);setAutoDownload(true);window.scrollTo(0,0);}} onRecovered={o=>{saved(o);setActiveOrder(o);setEditorEpoch(value=>value+1);window.scrollTo(0,0);}}/>):<OrderResult canCopy={writes.createOrder(activeOrder.userId)} key={activeOrder.id} order={activeOrder} onClose={()=>{openIntent.current++;setActiveOrder(null);void refreshOrders();}} onCopy={copy} autoDownload={autoDownload}/>}</main>:<Tabs value={tab} onValueChange={value=>{setTab(String(value));if(!manager){setSearch('');setStatus('all');setHistoryRange('7d');}}}><div className="nav-wrap"><TabsList className="main-nav" variant="line">{manager?<><TabsTrigger value="activity"><LayoutDashboard size={19}/>Sinteză</TabsTrigger><TabsTrigger value="partner"><Store size={19}/>Parteneri</TabsTrigger><TabsTrigger value="sales"><TrendingUp size={19}/>Vânzări</TabsTrigger><TabsTrigger value="team"><Users size={19}/>Echipă</TabsTrigger><TabsTrigger value={['orders','sim','stock','catalog'].includes(tab)?tab:'orders'}><Boxes size={19}/>Operațiuni</TabsTrigger></>:<><TabsTrigger value="orders"><Boxes size={19}/>Comenzi</TabsTrigger><TabsTrigger value="sim"><ScanBarcode size={19}/>Avize</TabsTrigger><TabsTrigger value="partner"><Store size={19}/>Parteneri</TabsTrigger><TabsTrigger value="sales"><TrendingUp size={19}/>Vânzări</TabsTrigger><TabsTrigger value="stock"><Package size={19}/>Stocul meu</TabsTrigger></>}</TabsList><span className="internal-label">PORTAL INTERN</span></div><main className="main-content">
      {error&&<p className="error-banner" role="alert">{error}</p>}
      {manager&&tab!=='settings'&&<ManagerScopeBar scope={managerScope}/>}
      {manager&&['orders','sim','stock','catalog'].includes(tab)&&<nav className="manager-operation-nav" aria-label="Operațiuni">{([['orders','Comenzi'],['sim','Avize'],['stock','Stocuri'],['catalog','Catalog produse']] as const).map(([value,label])=><button type="button" key={value} aria-current={tab===value?'page':undefined} onClick={()=>setTab(value)}>{label}</button>)}</nav>}
      {manager&&<TabsContent value="activity"><ManagerOverview scope={managerScope} users={users} month={managerMonth} onMonth={setManagerMonth} onRequests={()=>openRequest()} onAgent={navigateAgent}/></TabsContent>}
      {manager&&<TabsContent value="partner" keepMounted><div className="manager-partner-nav" aria-label="Parteneri"><button type="button" aria-pressed={partnerView==='portfolio'} onClick={()=>setPartnerView('portfolio')}>Portofoliu</button><button type="button" aria-pressed={partnerView==='requests'} onClick={()=>{setFocusRequestId('');setPartnerView('requests');}}>Solicitări</button></div>{(partnerOpened||tab==='partner')&&<div hidden={partnerView!=='portfolio'}><PartnerPortfolio key={`${user.id}:${managerScope.query}`} userId={user.id} manager scopeQuery={managerScope.query} active={tab==='partner'&&partnerView==='portfolio'}/></div>}{tab==='partner'&&partnerView==='requests'&&<ManagerRequests canConfirm={request=>writes.agent(request.agentId)} key={requestNavEpoch} scopeQuery={managerScope.query} month={managerMonth} onMonth={setManagerMonth} focusRequestId={focusRequestId} onBack={()=>setPartnerView('portfolio')} onChanged={()=>void refreshRequestInbox()}/>}</TabsContent>}
      {['orders','sim'].map(key=><TabsContent value={key} key={key}>
        <div className="page-heading"><div><span className="eyebrow">{manager?'ECHIPA MOBIUP':'SPAȚIUL TĂU DE LUCRU'}</span><h1>{key==='sim'?'Avize':'Comenzi'}</h1><p>{key==='sim'?'Pregătește avize SIM 0 sau standuri pentru clienți.':'Accesorii, cartele, telefoane și standuri într-o singură comandă.'}</p></div><div className="heading-controls">{manager&&<Choice label="Filtrează după agent" value={agentFilter} onChange={setAgentFilter} options={[{value:'all',label:'Toți agenții'},...managerScope.agents.map(u=>({value:u.id,label:u.name}))]}/>}<button className="icon-button refresh" aria-label="Actualizează comenzile" title="Actualizează" onClick={()=>void refreshOrders()}><RefreshCw size={19}/></button></div></div>
        <><div className="stats-strip"><div><span>FINALIZATE SĂPTĂMÂNA ASTA</span><strong>{businessDataReady?weekly.filter(o=>key==='sim'?['sim','stand_client'].includes(o.kind):!['sim','stand_client'].includes(o.kind)).length:'—'}<small>comenzi</small></strong></div><div><span>CIORNE ÎN LUCRU</span><strong>{businessDataReady?statsOrders.filter(o=>o.status==='draft').length:'—'}<small>de continuat</small></strong></div><div><span>PRODUSE ÎN CATALOG</span><strong>{businessDataReady?data.products!.length:'—'}<small>produse</small></strong></div><div><span>{manager?'GESTIUNI':'LIMITĂ ACCESORII'}</span><strong>{businessDataReady?(manager?warehouses.length:cfg.weeklyLimit):'—'}<small>{manager?'în echipă':'comenzi / săptămână'}</small></strong></div></div>
          <div className="quick-actions"><button className="action-card main-action order-action" onClick={()=>start(key==='sim'?'sim':'combined')} disabled={busy||!businessDataReady||(manager&&!createAgents.length)}><span className="action-icon"><Boxes size={29}/></span><span><span className="eyebrow">{key==='sim'?'SIM 0 VODAFONE':'COMANDĂ PENTRU STOC'}</span><h2>{key==='sim'?'Aviz pentru SIM 0':'Comandă nouă'}</h2><p>{key==='sim'?'Alege clientul din portofoliu și începe scanarea.':'Accesorii, cartele, telefoane și standuri.'}</p></span><span className="action-plus"><Plus size={23}/></span></button>{key==='sim'&&<button className="action-card main-action order-action" onClick={()=>start('stand_client')} disabled={busy||!businessDataReady||(manager&&!createAgents.length)}><span className="action-icon"><Boxes size={29}/></span><span><span className="eyebrow">STANDURI PENTRU CLIENT</span><h2>Aviz pentru standuri</h2><p>Alege clientul, punctul de lucru și standurile.</p></span><span className="action-plus"><Plus size={23}/></span></button>}</div></>
        <section className="panel orders-panel">{blockedOrderIds.length>0&&<div className="notice">Ciorne cu modificări locale de verificat: {blockedOrderIds.map(id=><button key={id} className="quiet" onClick={()=>void openBlockedOrder(id)}>{orders.find(order=>order.id===id)?.number||'Deschide ciorna recuperabilă'}</button>)}</div>}<div className="panel-heading"><div><h2>{key==='sim'?'Istoric avize':'Istoric comenzi'}</h2><span className="count-pill">{current.length}</span></div></div><div className="history-range" aria-label="Perioada istoricului">{([['day','Azi'],['7d','7 zile'],['30d','30 zile'],['all','Tot']] as const).map(([value,label])=><button key={value} className={historyRange===value?'active':''} aria-pressed={historyRange===value} onClick={()=>setHistoryRange(value)}>{label}</button>)}</div><div className="panel-toolbar"><div className="search-box"><Search size={18}/><input value={search} onChange={e=>setSearch(e.target.value)} aria-label={key==='sim'?'Caută avize':'Caută comenzi'} placeholder={key==='sim'?'Caută aviz sau client…':'Caută comandă sau client…'}/></div><Choice label="Status" value={status} onChange={setStatus} options={[{value:'all',label:'Toate statusurile'},{value:'draft',label:'Ciorne'},{value:'finalized',label:'Finalizate'}]}/></div><OrderTable paginationKey={JSON.stringify([key,search,status,historyRange,historyCutoff,managerScope.query])} canCopy={o=>writes.createOrder(o.userId)} canWrite={o=>writes.agent(o.userId)} orders={current} onOpen={o=>void openOrder(o)} onCopy={copy} manager={manager} onDelete={o=>{setDeleteTarget(o);setDeleteError('');}}/></section>
        <div className="page-footnote"><Clock3 size={14}/>Ciornele se salvează automat și rămân vizibile indiferent de perioada selectată.</div>
      </TabsContent>)}
      {!manager&&<TabsContent value="partner"><PartnerPortfolio key={user.id} userId={user.id}/></TabsContent>}
      <TabsContent value="sales"><Suspense fallback={<div className="sales-loading">Se încarcă vânzările…</div>}><SalesPanel initialView={salesView} onViewChange={setSalesView} user={user} users={users} scopeQuery={manager?managerScope.query:undefined} scopeLabel={manager?managerScope.label:undefined} initialMonth={manager?managerMonth:undefined} onMonthChange={manager?setManagerMonth:undefined}/></Suspense></TabsContent>
      <TabsContent value="stock">{manager&&<div className="page-heading"><div><h1>Stocuri agenți</h1></div></div>}{manager?<><label className="stock-agent-select">Agent<select aria-label="Agent pentru stoc" value={stockAgent} onChange={e=>setStockAgent(e.target.value)}><option value="">Selectează agentul</option>{managerScope.agents.filter(u=>u.active&&u.warehouseId).map(u=><option key={u.id} value={u.id}>{u.name} · {u.warehouseName}</option>)}</select></label>{stockAgent&&<StockWorkspace canStartInventory={writes.startInventory(users.find(u=>u.id===stockAgent)?.warehouseId)} key={`${stockAgent}:${stockMode}`} initialMode={stockMode} warehouseId={users.find(u=>u.id===stockAgent)?.warehouseId} title="Stoc agent" manager/>}</>:<StockWorkspace canStartInventory={writes.startInventory(user.warehouseId)} warehouseId={user.warehouseId}/>}</TabsContent>
      {manager&&<TabsContent value="team"><Tabs defaultValue="accounts" className="manager-team-tabs"><TabsList className="settings-tabs" variant="line" aria-label="Secțiuni echipă"><TabsTrigger value="accounts"><KeyRound size={17}/> Parole și conturi</TabsTrigger><TabsTrigger value="agents"><Users size={17}/> Agenți</TabsTrigger></TabsList><TabsContent value="accounts"><section className="panel manager-own-password"><div><h2>Parola mea</h2><p>Schimbă parola contului cu care ești autentificat.</p></div><button className="secondary" onClick={()=>setPasswordOpen(true)}><KeyRound size={17}/> Schimbă parola mea</button></section><div className="manager-team-admin"><Team user={user} users={managedUsers} warehouses={managedWarehouses} onUsers={users=>setData(d=>({...d,users}))} warnings={data.importWarnings||[]} canCreateAgents={globalManager}/></div></TabsContent><TabsContent value="agents"><ManagerTeamLinks scope={managerScope} onAgent={navigateAgent}/></TabsContent></Tabs></TabsContent>}{manager&&<TabsContent value="catalog"><ProductCatalog products={data.products||[]} onProducts={products=>setData(d=>({...d,products}))}/></TabsContent>}{manager&&<TabsContent value="settings"><div className="settings-stack"><PushNotifications/>{globalManager?<SettingsPanel settings={cfg} users={users} onSettings={settings=>setData(d=>({...d,settings}))} onUsers={users=>setData(d=>({...d,users}))}/>:<ManagerMailPanel settings={data.managerMailSettings||defaultManagerMail} regionalSettings={data.regionalSettings||cfg} mixed={!!data.regionalSettingsMixed} onSettings={managerMailSettings=>setData(d=>({...d,managerMailSettings}))} onRegionalSettings={regionalSettings=>setData(d=>({...d,regionalSettings,regionalSettingsMixed:false}))}/>}</div></TabsContent>}
    </main></Tabs>}
    </Suspense>
    <footer className="app-footer"><span>Mobiup <span>Distribuție</span></span><span>Comenzi & avize · {new Date().getFullYear()}</span></footer>
  </div><Dialog open={requestsOpen} onOpenChange={setRequestsOpen}><DialogContent className="admin-dialog request-inbox-dialog"><DialogHeader><DialogTitle>Solicitări</DialogTitle><DialogDescription>{requestInbox.count?`${requestInbox.count} solicitări de partener așteaptă confirmarea.`:'Nu ai solicitări în așteptare.'}</DialogDescription></DialogHeader>{requestInbox.items.length?<div className="request-inbox-list">{requestInbox.items.map(item=><div className="request-inbox-item" key={item.id}><span><strong>{item.title}</strong><small>{item.agentName} · {item.location}{item.county?` · ${item.county}`:''} · {dateLabel(item.createdAt)}</small></span><button className="secondary" disabled={activeOrder?.status==='draft'} onClick={()=>openRequest(item.id)}>Deschide</button></div>)}{requestInbox.count>requestInbox.items.length&&<p className="muted">Sunt afișate cele mai recente {requestInbox.items.length} solicitări.</p>}</div>:<p className="portfolio-message">Nicio solicitare de procesat.</p>}</DialogContent></Dialog><Dialog open={!!deleteTarget} onOpenChange={open=>{if(!open&&!deleting)setDeleteTarget(null);}}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>{deleteTarget?.status==='draft'?'Renunți la ciorna':'Ștergi comanda'} {deleteTarget?.number}?</DialogTitle><DialogDescription>{deleteTarget?.agentName} · {deleteTarget?.warehouseName}. {deleteTarget?.status==='draft'?'Ciorna va fi eliminată din istoricul tău.':'Comanda va dispărea din istoricul tuturor utilizatorilor.'}{deleteTarget?.status==='finalized'&&' Ștergerea nu retrage e-mailurile deja trimise.'}{deleteTarget?.kind==='sim'&&' Seriile SIM vor putea fi folosite într-un aviz nou.'}</DialogDescription></DialogHeader>{deleteError&&<p className="error-banner" role="alert">{deleteError}</p>}<div className="delete-actions"><button className="secondary" disabled={deleting} onClick={()=>setDeleteTarget(null)}>Renunță</button><button className="danger" disabled={deleting||!deleteTarget||!writes.agent(deleteTarget.userId)} onClick={()=>void deleteOrder()}>{deleting?(deleteTarget?.status==='draft'?'Se elimină…':'Se șterge…'):(deleteTarget?.status==='draft'?'Renunță la ciornă':'Șterge comanda')}</button></div></DialogContent></Dialog>
  <Dialog open={!!newKind} onOpenChange={open=>{if(!open&&!busy)setNewKind(null);}}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>Comandă nouă · {newKind?kindLabels[newKind]:''}</DialogTitle><DialogDescription>Alege agentul. Comanda va apărea în gestiunea și istoricul lui.</DialogDescription></DialogHeader><label htmlFor="order-agent">Agent<Choice id="order-agent" label="Agentul comenzii" value={agentId} onChange={setAgentId} options={createAgents.map(u=>({value:u.id,label:u.name+' · '+u.warehouseName?.replace(/^gestiune\s+/i,'')}))}/></label><button className="primary" disabled={busy||!createAgents.some(agent=>agent.id===agentId)} onClick={()=>newKind&&void create(newKind)}>{busy?<LoaderCircle className="spin" size={18}/>:<Plus size={18}/>} Creează ciorna</button></DialogContent></Dialog>
  <Dialog open={reauthOpen} onOpenChange={()=>{}}><DialogContent className="admin-dialog" showCloseButton={false}><DialogHeader><DialogTitle>Sesiunea a expirat</DialogTitle><DialogDescription>Reautentifică-te pentru a continua. Modificările locale ale ciornei sunt păstrate.</DialogDescription></DialogHeader><form className="form-stack" onSubmit={e=>void login(e)}><label>Utilizator<input name="username" value={user.username} readOnly autoComplete="username"/></label><label>Parolă<input name="password" type="password" autoComplete="current-password" required maxLength={128}/></label>{error&&<p className="error-banner" role="alert">{error}</p>}<div className="delete-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>{setReauthOpen(false);setActiveOrder(null);setData({user:null});setTab('orders');setError('');}}>Ieșire la autentificare</button><button className="primary" disabled={busy}>{busy?'Se conectează…':'Reautentifică-te'}</button></div><p className="muted">După autentificare, ciorna este reîncărcată de pe server și reconciliată cu modificările locale.</p></form></DialogContent></Dialog>
  <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}><DialogContent className="admin-dialog"><DialogHeader><DialogTitle>Schimbă parola</DialogTitle><DialogDescription>{user.username}</DialogDescription></DialogHeader><PasswordForm onDone={()=>{setPasswordOpen(false);void refreshOrders();}}/></DialogContent></Dialog>
  {orderRecovery&&writes.createOrder(orderRecovery.local.userId)&&<OrderRecoveryDialog recovery={orderRecovery} userId={user.id} onView={o=>{setOrderRecovery(null);setActiveOrder(o);setAutoDownload(false);window.scrollTo(0,0);}} onDiscard={o=>{setOrderRecovery(null);if(o){setActiveOrder(o);setAutoDownload(false);window.scrollTo(0,0);}}} onRecovered={o=>{setOrderRecovery(null);saved(o);setActiveOrder(o);setAutoDownload(false);setEditorEpoch(value=>value+1);window.scrollTo(0,0);}}/>}</>;
}
