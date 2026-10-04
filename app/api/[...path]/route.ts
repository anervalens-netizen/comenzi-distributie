import { managerFilter } from '@/lib/manager-scope';
import {historyImportStatus,historyImportPreview,historyImportCommit} from '@/lib/client-history-import-runtime';
import {clientSalesReconciliation} from '@/lib/client-sales-reconciliation';
import {clientSalesOverview} from '@/lib/client-sales-api';
import {partnerActivityOverview} from '@/lib/partner-activity-api';
import { readPartnerSalesAsync, PartnerSalesInputError } from '@/lib/partner-sales-store';
import { clientPortfolioVersion } from '@/lib/client-sales-portfolio';
import { visitWeek, saveDayPlan } from '@/lib/partner-planning';
import { portfolio, portfolioSummary, partnerDetail, updatePartner, recordVisit, duePartnerFollowUps } from '@/lib/partner-portfolio';
import { browsePartners, mapPartners } from '@/lib/partner-map-api';
import { env, runtimeKind, operationalStatus } from '@/lib/runtime';
import { randomBytes, createHash } from 'node:crypto';
import seed from '@/resources/seed.json';
import templateHashes from '@/resources/template-hashes.json';
import templates from '@/resources/templates.json';
import { db, response, handleError, assertOrigin, jsonBody, readLimited, textField, seedDatabase, userView, requireUser, requireManager, requireGlobalManager, isGlobalManager, requireAgentAccess, requireWarehouseAccess, currentUser, refreshSession, SESSION_TTL_SECONDS, SESSION_TTL_MS, sha256, sessionToken, verifyPassword, hashPassword, catalog, warehouses, getOrder, orderView, settings, managerMailSettings, regionalOperationalSettings, settingsForOrder, weekKey, fail } from '@/lib/server';
import { templateExport, combinedExport, repairOrderExport, simExport, mailFor, emlFor } from '@/lib/exports';
import { readCatalog, changeProduct } from '@/lib/catalog';
import { stockImportStatus, stockView, stockUpload } from '@/lib/stock-server';
import { salesImportStatus, salesView, salesUpload } from '@/lib/sales-server';
import { inventories } from '@/lib/inventory-server';
import { partnerMail } from '@/lib/partner-mail';
import { confirmPartnerRequest, getPartnerRequest, listPartnerRequests, partnerLocations, teamActivity, managerActivity } from '@/lib/partner-requests';
import { managerRequestInbox, pushPublicConfig, removePushSubscription, upsertPushSubscription } from '@/lib/push-notifications';
import { importClients } from '@/lib/client-import-server';
import { selectUsersWithClientCounts } from '@/lib/customer-counts';
import { bucharestDayStartUtc } from '@/lib/bucharest-month';
import type { User, Order, Line, Client, Kind, Product } from '@/lib/types';

export const dynamic = 'force-dynamic';
const excelMime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function cookie(req: Request,token: string,age=SESSION_TTL_SECONDS) { return `mobiup_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(req.url).protocol==='https:'?'; Secure':''}`; }
// Used only by read handlers. The authenticated identity remains authoritative for writes.
function nationalReadScope(user:User):User {
  return user.role==='manager'?{...user,managerScope:'global'}:user;
}
async function getUsers(viewer:User) {
  const select=selectUsersWithClientCounts();
  const query=viewer.role==='manager'?db().prepare(select+" ORDER BY role DESC,name"):db().prepare(select+" WHERE u.id=? OR EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=u.id) ORDER BY role DESC,name").bind(viewer.id,viewer.id);
  const [result,assignments]=await Promise.all([query.all<Record<string,unknown>>(),db().prepare('SELECT manager_id,agent_id FROM manager_agents ORDER BY manager_id,agent_id').all<{manager_id:string;agent_id:string}>()]);
  return result.results.map(row=>{
    const base={...userView(row),clientCount:Number(row.client_count)};
    if(base.role!=='manager')return base;
    const managedAgentIds=assignments.results.filter(item=>item.manager_id===base.id).map(item=>item.agent_id);
    return {...base,managedAgentIds};
  });
}
async function visibleWarehouses(user:User) {
  if(user.role==='agent')return warehouses.filter(g=>g.id===user.warehouseId);
  if(user.role==='manager')return warehouses;
  const rows=await db().prepare('SELECT DISTINCT a.warehouse_id id FROM manager_agents ma JOIN users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.warehouse_id IS NOT NULL').bind(user.id).all<{id:string}>();
  const ids=new Set(rows.results.map(row=>row.id));
  return warehouses.filter(g=>ids.has(g.id));
}
async function listOrders(user: User) {
  const select="SELECT id,number,user_id,warehouse_id,kind,status,created_at,finalized_at,source_order_id,revision,json_set(json_remove(payload,'$.items','$.standItems','$.serials','$.exportKey'),'$.itemCount',COALESCE(json_array_length(payload,'$.items'),0)+COALESCE(json_array_length(payload,'$.standItems'),0)) AS payload FROM orders";
  const q=user.role==='agent'?db().prepare(select+" WHERE status!='deleted' AND user_id=? ORDER BY created_at DESC").bind(user.id):user.role==='manager'?db().prepare(select+" WHERE status!='deleted' ORDER BY created_at DESC"):db().prepare(select+" WHERE status!='deleted' AND EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=orders.user_id) ORDER BY created_at DESC").bind(user.id);
  return (await q.all<Record<string,unknown>>()).results.map(orderView);
}
const ORDER_PAGE_LIMIT=40;
type OrderCursor={createdAt:string;id:string};
function encodeOrderCursor(row:OrderCursor){return Buffer.from(JSON.stringify([row.createdAt,row.id])).toString('base64url');}
function decodeOrderCursor(raw:string|null):OrderCursor|null{
  if(!raw)return null;
  try{const value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(Array.isArray(value)&&value.length===2&&typeof value[0]==='string'&&typeof value[1]==='string'&&value[0].length<=40&&value[1].length<=100)return {createdAt:value[0],id:value[1]};}catch{}
  fail(400,'Cursorul listei este invalid.');
}
const orderSearch=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('ro');
async function orderScope(user:User,params:URLSearchParams){
  const clauses=["o.status!='deleted'"];const values:unknown[]=[];
  if(user.role==='agent'){clauses.push('o.user_id=?');values.push(user.id);}
  else if(!isGlobalManager(user)){clauses.push('EXISTS (SELECT 1 FROM manager_agents own WHERE own.manager_id=? AND own.agent_id=o.user_id)');values.push(user.id);}
  const filter=await managerFilter(user,params);
  if(filter){clauses.push(filter.agentIds.length?`o.user_id IN (${filter.agentIds.map(()=>'?').join(',')})`:'0');values.push(...filter.agentIds);}
  return {clauses,values};
}
async function listOrdersPage(user:User,params:URLSearchParams){
  const requestedLimit=Number(params.get('limit')||ORDER_PAGE_LIMIT),limit=Number.isSafeInteger(requestedLimit)?Math.max(1,Math.min(100,requestedLimit)):ORDER_PAGE_LIMIT;
  const kind=params.get('kind')||'orders',status=params.get('status')||'all',range=params.get('range')||'7d',query=textField(params.get('q'),200);
  if(!['orders','sim','all'].includes(kind)||!['all','draft','finalized'].includes(status)||!['day','7d','30d','all'].includes(range))fail(400,'Filtrele listei sunt invalide.');
  const {clauses:scopeClauses,values:scopeValues}=await orderScope(nationalReadScope(user),params),clauses=[...scopeClauses],values=[...scopeValues];
  if(kind==='orders')clauses.push("o.kind NOT IN ('sim','stand_client')");
  if(kind==='sim')clauses.push("o.kind IN ('sim','stand_client')");
  if(status!=='all'){clauses.push('o.status=?');values.push(status);}
  if(range!=='all'){
    const days=range==='day'?0:range==='7d'?6:29;
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const noon=new Date(today+'T12:00:00Z');noon.setUTCDate(noon.getUTCDate()-days);
    const fromKey=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(noon);
    clauses.push("(o.status='draft' OR COALESCE(o.finalized_at,o.created_at)>=?)");values.push(bucharestDayStartUtc(fromKey));
  }
  const revisionRow=await db().prepare('SELECT revision FROM order_list_revision WHERE id=1').first<{revision:number}>(),revision=String(Number(revisionRow?.revision||1));
  const expected=params.get('revision');if(expected&&expected!==revision)fail(409,'Lista de comenzi s-a modificat. Reîncarcă prima pagină.');
  const select="SELECT o.id,o.number,o.user_id,o.warehouse_id,o.kind,o.status,o.created_at,o.finalized_at,o.source_order_id,o.revision,json_set(json_remove(o.payload,'$.items','$.standItems','$.serials','$.exportKey'),'$.itemCount',COALESCE(json_array_length(o.payload,'$.items'),0)+COALESCE(json_array_length(o.payload,'$.standItems'),0)) AS payload FROM orders o";
  const cursor=decodeOrderCursor(params.get('cursor'));
  let rows:Record<string,unknown>[],total:number;
  if(query){
    const result=await db().prepare(`${select} WHERE ${clauses.join(' AND ')} ORDER BY o.created_at DESC,o.id DESC`).bind(...values).all<Record<string,unknown>>();
    const needle=orderSearch(query),filtered=result.results.filter(row=>{const order=orderView(row);return orderSearch([order.number,order.agentName,order.warehouseName,order.client?.name,order.client?.cui].join(' ')).includes(needle);});
    total=filtered.length;const after=cursor?filtered.filter(row=>String(row.created_at)<cursor.createdAt||String(row.created_at)===cursor.createdAt&&String(row.id)<cursor.id):filtered;rows=after.slice(0,limit+1);
  }else{
    const count=await db().prepare(`SELECT COUNT(*) count FROM orders o WHERE ${clauses.join(' AND ')}`).bind(...values).first<{count:number}>();total=Number(count?.count||0);
    const pageClauses=[...clauses],pageValues=[...values];if(cursor){pageClauses.push('(o.created_at<? OR (o.created_at=? AND o.id<?))');pageValues.push(cursor.createdAt,cursor.createdAt,cursor.id);}
    rows=(await db().prepare(`${select} WHERE ${pageClauses.join(' AND ')} ORDER BY o.created_at DESC,o.id DESC LIMIT ?`).bind(...pageValues,limit+1).all<Record<string,unknown>>()).results;
  }
  const hasMore=rows.length>limit,pageRows=rows.slice(0,limit),last=pageRows.at(-1);
  const statClauses=[...scopeClauses];const statValues=[...scopeValues];if(kind==='orders')statClauses.push("o.kind NOT IN ('sim','stand_client')");if(kind==='sim')statClauses.push("o.kind IN ('sim','stand_client')");
  const stats=await db().prepare(`SELECT SUM(CASE WHEN o.status='draft' THEN 1 ELSE 0 END) drafts,SUM(CASE WHEN o.status='finalized' AND o.week_key=? THEN 1 ELSE 0 END) weekly FROM orders o WHERE ${statClauses.join(' AND ')}`).bind(weekKey(),...statValues).first<{drafts:number;weekly:number}>();
  return {orders:pageRows.map(orderView),orderPage:{revision,total,limit,nextCursor:hasMore&&last?encodeOrderCursor({createdAt:String(last.created_at),id:String(last.id)}):null,stats:{drafts:Number(stats?.drafts||0),weekly:Number(stats?.weekly||0)}}};
}
async function targetAgent(user: User,id: unknown) {
  if(user.role==='agent') return user;
  const u=await db().prepare("SELECT * FROM users WHERE id=? AND role='agent' AND active=1").bind(textField(id)).first<Record<string,unknown>>();
  if(!u) fail(400,'Alege agentul pentru care faci comanda.');
  await requireAgentAccess(user,String(u.id));
  return userView(u);
}
function parseLines(raw: unknown, kind: 'accessories'|'stands'|'stand_client', activeProducts: Product[]) {
  if(raw===undefined) return [] as Line[];
  if(!Array.isArray(raw)) fail(400,'Lista de produse este invalidă.');
  if(raw.length>600) fail(400,'Prea multe produse.');
  const lines:Line[]=[];const seen=new Set<string>();
  for(const item of raw) {
    if(!item || typeof item!=='object') fail(400,'Produs invalid.');
    const p=activeProducts.find(p=>p.id===item.id && (kind==='stand_client'?p.kind==='stands'&&p.category==='Standuri':p.kind===kind));
    if(!p || seen.has(p.id)) fail(400,'Produs necunoscut sau duplicat.');
    const qty=item.quantity;
    if(typeof qty!=='number'||!Number.isSafeInteger(qty)||qty<1||qty>9999) fail(400,'Cantitățile trebuie să fie numere întregi între 1 și 9999.');
    lines.push({...p,quantity:qty});seen.add(p.id);
  }
  return lines;
}
async function payloadFor(body: Record<string,unknown>,order: Order) {
  const activeProducts=(await readCatalog()).products;
  const items=order.kind==='combined'?parseLines(body.items,'accessories',activeProducts):order.kind==='sim'?[]:parseLines(body.items,order.kind,activeProducts);
  const standItems=order.kind==='combined'?parseLines(body.standItems,'stands',activeProducts):[];
  let serials:string[]=[];
  if(body.serials!==undefined) {
    if(!Array.isArray(body.serials)||body.serials.length>1000) fail(400,'Poți include maximum 1.000 de serii într-un aviz.');
    serials=body.serials.map(s=>{
      if(typeof s!=='string') fail(400,'Seria SIM trebuie transmisă ca text.');
      const cleaned=s.replace(/\s/g,'');
      if(!/^\d{18,22}$/.test(cleaned)) fail(400,'O serie SIM trebuie să conțină 18–22 de cifre.');
      return cleaned;
    });
    if(new Set(serials).size!==serials.length) fail(400,'Aceeași serie SIM apare de două ori în aviz.');
  }
  let client:Client|null=null;
  if(body.clientId) {
    const row=await db().prepare("SELECT data FROM customers WHERE id=? AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.warehouseIds'),json_array(warehouse_id))) WHERE value=?) AND active=1").bind(textField(body.clientId),order.warehouseId).first<{data:string}>();
    if(!row) fail(400,'Clientul nu aparține portofoliului agentului.');
    client={...JSON.parse(row.data),warehouseId:order.warehouseId};
  }
  if(order.kind==='sim' && items.length) fail(400,'Avizul SIM conține serii, nu accesorii.');
  if(order.kind==='stand_client' && serials.length) fail(400,'Avizul de standuri nu conține serii SIM.');
  if(order.kind!=='sim' && order.kind!=='stand_client' && (serials.length||client)) fail(400,'Clientul și seriile sunt disponibile numai pentru avize SIM.');
  const notes=textField(body.notes,2000);
  return {...order,items,standItems:order.kind==='combined'?standItems:undefined,serials,client,notes,total:Math.round(items.reduce((sum,l)=>sum+(l.price||0)*l.quantity,0)*100)/100,pieces:order.kind==='sim'?serials.length:items.reduce((sum,l)=>sum+l.quantity,0)+standItems.reduce((sum,l)=>sum+l.quantity,0)+serials.length};
}
async function saveOrder(req: Request,id: string,user: User) {
  const order=await getOrder(id,user);
  if(order.status!=='draft') fail(409,'Comanda este finalizată. Folosește „Copiază comanda” pentru o comandă nouă.');
  const body=await jsonBody(req);
  if(body.revision!==order.revision) fail(409,'Comanda a fost modificată pe alt dispozitiv. Redeschide comanda înainte să o salvezi.');
  const next=await payloadFor(body,order);
  const result=await db().prepare("UPDATE orders SET payload=?,revision=revision+1 WHERE id=? AND status='draft' AND revision=?").bind(JSON.stringify(next),id,order.revision).run();
  if(!result.meta.changes) fail(409,'Comanda a fost modificată. Redeschide-o.');
  return response({order:await getOrder(id,user)});
}
async function finalize(id: string,user: User,req: Request) {
  const order=await getOrder(id,user);
  if(order.status==='finalized') return response({order,mail:mailFor(order,await settingsForOrder(order))});
  const body=await jsonBody(req);
  if(body.revision!==order.revision) fail(409,'Salvează modificările înainte de finalizare.');
  if(!order.pieces) fail(400,'Adaugă cel puțin un produs sau o serie SIM.');
  if((order.kind==='stand_client'||(order.kind==='sim'||order.kind==='combined') && order.serials.length) && !order.client) fail(400,'Alege clientul pentru aviz.');
  const currentCatalog=await readCatalog();
  if(order.kind!=='sim') {
    const productsById=new Map(currentCatalog.products.map(product=>[product.id,product]));
    for(const line of [...order.items,...(order.kind==='combined'?(order.standItems||[]):[])]) {
      const product=productsById.get(line.id);
      if(!product)fail(409,'Un produs a fost șters din catalog. Elimină-l din ciornă înainte de finalizare.');
      if((['code','name','brand','category','price','netPrice','sourceRow'] as const).some(key=>product[key]!==line[key]))fail(409,'Catalogul s-a actualizat. Redeschide și salvează ciorna pentru a prelua datele noi.');
    }
  }
  let clientData='';
  if(order.kind==='stand_client'||(order.kind==='sim'||order.kind==='combined') && order.serials.length) {
    const current=await db().prepare("SELECT data FROM customers WHERE id=? AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.warehouseIds'),json_array(warehouse_id))) WHERE value=?) AND active=1").bind(order.client!.id,order.warehouseId).first<{data:string}>();
    if(!current) fail(409,'Clientul a fost mutat sau scos din portofoliu. Alege alt client înainte de finalizare.');
    const client=JSON.parse(current.data) as Client;
    if((['name','cui','city','county','address','route'] as const).some(key=>client[key]!==order.client![key])) fail(409,'Datele clientului s-au schimbat. Selectează din nou clientul și salvează ciorna.');
    clientData=current.data;
  }
  const cfg=await settings();
  const finalOrder={...order,status:'finalized' as const,finalizedAt:new Date().toISOString()};
  let exportKey:string|undefined;
  if(order.kind!=='stand_client') {
  let bytes:Uint8Array;
  if(order.kind==='sim') bytes=simExport(finalOrder);
  else if(order.kind==='combined') {
    const template=await env.FILES.get('templates/accesorii.xlsx');
    const templateBytes=template?new Uint8Array(await template.arrayBuffer()):Buffer.from(templates.accesorii,'base64');
    bytes=combinedExport(templateBytes,finalOrder,catalog.filter(p=>p.kind==='accessories').map(p=>p.sourceRow),currentCatalog.products.filter(p=>p.kind==='accessories'));
  } else {
    const templateName=order.kind==='accessories'?'accesorii':'standuri';
    const template=await env.FILES.get(`templates/${templateName}.xlsx`);
    const templateBytes=template?new Uint8Array(await template.arrayBuffer()):Buffer.from(templates[templateName],'base64');
    bytes=templateExport(templateBytes,finalOrder,catalog.filter(p=>p.kind===order.kind).map(p=>p.sourceRow),currentCatalog.products.filter(p=>p.kind===order.kind));
  }
  exportKey=`exports/${order.id}/${crypto.randomUUID()}.xlsx`;
  await env.FILES.put(exportKey,bytes,{httpMetadata:{contentType:excelMime}});
  }
  const payload={...finalOrder,exportKey};
  try {
    const statements=[db().prepare("UPDATE orders SET status='finalized',finalized_at=?,week_key=?,payload=?,revision=revision+1 WHERE id=? AND status='draft' AND revision=? AND (? IS (SELECT value FROM settings WHERE key='catalog')) AND (kind NOT IN ('sim','combined','stand_client') OR (kind!='stand_client' AND json_array_length(json_extract(payload,'$.serials'))=0) OR EXISTS (SELECT 1 FROM customers c WHERE c.id=? AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) WHERE value=orders.warehouse_id) AND c.active=1 AND c.data=?)) AND (kind NOT IN ('accessories','combined') OR (kind='combined' AND json_array_length(json_extract(payload,'$.items'))=0) OR (SELECT COUNT(*) FROM orders o WHERE o.user_id=orders.user_id AND (o.kind='accessories' OR (o.kind='combined' AND json_array_length(json_extract(o.payload,'$.items'))>0)) AND o.status='finalized' AND o.week_key=?) < ?)").bind(finalOrder.finalizedAt,weekKey(),JSON.stringify(payload),id,order.revision,currentCatalog.raw,order.client?.id||'',clientData,weekKey(),cfg.weeklyLimit)];
    for(const serial of order.serials) statements.push(db().prepare("INSERT INTO serials (serial,order_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM orders WHERE id=? AND status='finalized' AND revision=?)").bind(serial,id,id,order.revision+1));
    const results=await db().batch(statements);
    if(!results[0].meta.changes) {
      const latest=await getOrder(id,user);
      if(latest.status==='finalized') { if(exportKey) await env.FILES.delete(exportKey); return response({order:latest,mail:mailFor(latest,await settingsForOrder(latest))}); }
      if(order.kind==='sim') fail(409,'Datele clientului sau ciorna s-au modificat între timp. Redeschide ciorna și selectează din nou clientul.');
      fail(409,`Limita este de ${cfg.weeklyLimit} comenzi de accesorii pe săptămână. Comanda rămâne ciornă. Dacă datele comenzii sau clientului s-au modificat, redeschide ciorna și verifică selecția.`);
    }
  } catch(err) {
    if(exportKey) await env.FILES.delete(exportKey);
    if(err instanceof Error && /UNIQUE constraint failed: serials/.test(err.message)) {
      const latest=await getOrder(id,user);
      if(latest.status==='finalized') return response({order:latest,mail:mailFor(latest,await settingsForOrder(latest))});
      fail(409,'Una dintre seriile SIM a fost deja inclusă într-un aviz finalizat. Comanda rămâne ciornă.');
    }
    throw err;
  }
  const result=await getOrder(id,user);
  return response({order:result,mail:mailFor(result,await settingsForOrder(result))});
}
async function dispatch(req: Request) {
  if(req.method!=='GET') assertOrigin(req);
  const path=new URL(req.url).pathname.replace(/^\/api\//,'').split('/');
  if(runtimeKind==='cloudflare' && req.method!=='GET' && !['auth/login','auth/logout'].includes(path.join('/'))) fail(409,'Versiunea de test este acum doar pentru consultare. Folosește instanța de producție configurată pentru comenzi noi.');
  if(path.join('/')==='health' && req.method==='GET') return response({status:'ok',service:'comenzi-distributie'});
  if(path.join('/')==='admin/status' && req.method==='GET') {
    requireGlobalManager(await requireUser(req));
    return response(operationalStatus());
  }
  await seedDatabase();
  if(path.join('/')==='auth/login' && req.method==='POST') {
    const body=await jsonBody(req); const username=textField(body.username,80).toLowerCase();
    if(typeof body.password!=='string'||body.password.length>128||!username) fail(400,'Completează utilizatorul și parola.');
    const now=Date.now(); const keys=[`account:${username}`,`ip:${sha256(req.headers.get('CF-Connecting-IP')||'local')}`];
    const results=await db().batch(keys.map(key=>db().prepare('INSERT INTO login_attempts (key,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END RETURNING attempts').bind(key,now+900000,now,now)));
    if(Number((results[0].results[0] as {attempts:number}).attempts)>10 || Number((results[1].results[0] as {attempts:number}).attempts)>80) fail(429,'Prea multe încercări. Reîncearcă în 15 minute.');
    const row=await db().prepare('SELECT * FROM users WHERE username=? AND active=1').bind(username).first<Record<string,unknown>>();
    const fallback='scrypt:00000000000000000000000000000000:'+ '0'.repeat(64);
    const verified=await verifyPassword(body.password,typeof row?.password_hash==='string'?row.password_hash:fallback);
    if(!row||!verified) fail(401,'Utilizator sau parolă incorectă.');
    const token=Buffer.from(randomBytes(32)).toString('base64url');
    const sessionResults=await db().batch([db().prepare('INSERT INTO sessions (token_hash,user_id,expires_at) SELECT ?,id,? FROM users WHERE id=? AND active=1 AND username=? AND password_hash=? AND profile_revision=?').bind(sha256(token),now+SESSION_TTL_MS,row.id,row.username,row.password_hash,row.profile_revision),db().prepare('DELETE FROM login_attempts WHERE key=? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash=?)').bind(keys[0],sha256(token)),db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(now)]);
    if(!sessionResults[0]?.meta.changes)fail(401,'Datele de acces s-au modificat. Autentifică-te din nou.');
    return response({user:userView(row)},200,{'Set-Cookie':cookie(req,token)});
  }
  if((path[0]==='bootstrap'||path.join('/')==='auth/session') && req.method==='GET') {
    let user=await currentUser(req);
    const existingToken=sessionToken(req);
    const refreshedToken=user?await refreshSession(req):'';
    if(user&&!refreshedToken)user=null;
    const sessionHeaders=refreshedToken?{'Set-Cookie':cookie(req,refreshedToken)}:existingToken?{'Set-Cookie':cookie(req,'',0)}:undefined;
    if(path.join('/')==='auth/session')return response({user},200,sessionHeaders);
    if(!user||user.mustChangePassword) return response({user},200,sessionHeaders);
    const cfg=await settings();
    const regional=user.role==='manager'&&!isGlobalManager(user)?await regionalOperationalSettings(user.id):undefined;
    const common={user,warehouses:await visibleWarehouses(user),users:user.role==='manager'?await getUsers(user):[],settings:cfg,managerMailSettings:user.role==='manager'?await managerMailSettings(user.id):undefined,regionalSettings:regional?.settings,regionalSettingsMixed:regional?.mixed,weekKey:weekKey(),importWarnings:isGlobalManager(user)?seed.importWarnings:[]};
    if(new URL(req.url).searchParams.get('compact')==='1')return response({...common,...await listOrdersPage(user,new URLSearchParams('kind=orders&range=7d&limit=40'))},200,sessionHeaders);
    return response({...common,products:(await readCatalog()).products,orders:await listOrders(user)},200,sessionHeaders);
  }
  const user=await requireUser(req,path[0]==='auth'||(path[0]==='admin'&&path[1]==='templates'));
  const readUser=nationalReadScope(user);
  if(path.join('/')==='notifications/inbox'&&req.method==='GET')return response(await managerRequestInbox(user));
  if(path.join('/')==='notifications/push'&&req.method==='GET')return response(await pushPublicConfig(user));
  if(path.join('/')==='notifications/push'&&req.method==='POST')return response(await upsertPushSubscription(user,await jsonBody(req)));
  if(path.join('/')==='notifications/push'&&req.method==='DELETE')return response(await removePushSubscription(user,await jsonBody(req)));
  if(path.join('/')==='partner/planning'&&req.method==='GET')return response(await visitWeek(user,new URL(req.url).searchParams.get('week')||''));
  if(path.join('/')==='partner/planning'&&req.method==='PUT')return response(await saveDayPlan(user,await jsonBody(req)));
  if(path.join('/')==='partner/activity'&&req.method==='GET')return response(await partnerActivityOverview(readUser,new URL(req.url).searchParams,user));
  if(path.join('/')==='partner/attention'&&req.method==='GET')return response(await duePartnerFollowUps(user,new URL(req.url).searchParams));
  if(path.join('/')==='partner/browse'&&req.method==='GET')return response(await browsePartners(readUser,new URL(req.url).searchParams,user));
  if(path.join('/')==='partner/map'&&req.method==='GET')return response(await mapPartners(readUser,new URL(req.url).searchParams,user));
  if(path.join('/')==='partner/summary'&&req.method==='GET')return response({partners:await portfolioSummary(readUser)});
  if(path[0]==='partner'&&path[1]==='portfolio'&&path[2]&&path[3]==='sales'&&!path[4]&&req.method==='GET') {
    const version=await clientPortfolioVersion();
    const detail=await partnerDetail(readUser,path[2],null,user);
    try {
      const result=await readPartnerSalesAsync(path[2],detail.partner.cui,new URL(req.url).searchParams);
      // Cooperative source reads yield: recheck the session and current card scope.
      const currentUser=await requireUser(req);
      const current=await partnerDetail(nationalReadScope(currentUser),path[2],null,currentUser);
      if(current.partner.cui!==detail.partner.cui||version!==await clientPortfolioVersion())fail(503,'Portofoliul s-a actualizat. Reîncearcă fișa.');
      return response(result);
    }
    catch(error) { if(error instanceof PartnerSalesInputError) fail(400,error.message); throw error; }
  }
  if(path[0]==='partner'&&path[1]==='portfolio') {
    if(!path[2]&&req.method==='GET')return response(await portfolio(readUser));
    if(path[2]&&!path[3]&&req.method==='GET')return response(await partnerDetail(readUser,path[2],new URL(req.url).searchParams.get('cursor'),user));
    if(path[2]&&!path[3]&&req.method==='PATCH')return response(await updatePartner(user,path[2],await jsonBody(req)));
    if(path[2]&&path[3]==='visits'&&!path[4]&&req.method==='POST')return response(await recordVisit(user,path[2],await jsonBody(req)));
  }
  if(path.join('/')==='partner/mail'&&req.method==='POST')return partnerMail(req,user);
  if(path.join('/')==='partner/lookup'&&req.method==='GET') {
    const cui=new URL(req.url).searchParams.get('cui')||'';
    return response({cui,locations:await partnerLocations(cui)});
  }
  if(path.join('/')==='partner/requests'&&req.method==='GET') {
    const month=new URL(req.url).searchParams.get('month');
    return response(await listPartnerRequests(readUser,month));
  }
  if(path[0]==='partner'&&path[1]==='requests'&&path[2]&&!path[3]&&req.method==='GET') return response({request:await getPartnerRequest(readUser,path[2])});
  if(path[0]==='partner'&&path[1]==='requests'&&path[2]&&path[3]==='confirm'&&req.method==='POST') {
    const body=await jsonBody(req);
    return response({request:await confirmPartnerRequest(user,path[2],body.revision,body.locationResolution)});
  }
  if(path.join('/')==='manager/activity'&&req.method==='GET') return response(await managerActivity(readUser,new URL(req.url).searchParams));
  if(path.join('/')==='activity/team'&&req.method==='GET') {
    const month=new URL(req.url).searchParams.get('month');
    return response(await teamActivity(readUser,month));
  }
  if(path.join('/')==='sales/clients/reconciliation'&&req.method==='GET')return clientSalesReconciliation(readUser,new URL(req.url).searchParams);
  if(path.join('/')==='sales/clients'&&req.method==='GET')return response(await clientSalesOverview(readUser,new URL(req.url).searchParams));
  if(path.join('/')==='sales'&&req.method==='GET')return salesView(req,readUser);
  if(path.join('/')==='client-sales/import/status'&&req.method==='GET')return historyImportStatus(req,user);
  if(path.join('/')==='client-sales/import/preview'&&req.method==='POST')return historyImportPreview(req,user);
  if(path.join('/')==='client-sales/import'&&req.method==='POST')return historyImportCommit(req,user);
  if(path.join('/')==='sales/preview'&&req.method==='POST')return salesUpload(req,user,false);
  if(path.join('/')==='sales/import'&&req.method==='POST')return salesUpload(req,user,true);
  if(path.join('/')==='stock'&&req.method==='GET')return stockView(req,readUser);
  if(path.join('/')==='catalog'&&req.method==='GET')return response({products:(await readCatalog()).products});
  if(path[0]==='inventory'&&path.length<=2)return inventories(req,user,path[1]);
  if(path.join('/')==='admin/stock/preview'&&req.method==='POST')return stockUpload(req,user,false);
  if(path.join('/')==='admin/stock/import'&&req.method==='POST')return stockUpload(req,user,true);
  if(path.join('/')==='auth/logout' && req.method==='POST') {
    await db().prepare('DELETE FROM sessions WHERE token_hash=?').bind(sha256(sessionToken(req))).run();
    return response({ok:true},200,{'Set-Cookie':cookie(req,'',0)});
  }
  if(path.join('/')==='auth/password' && req.method==='POST') {
    requireManager(user);
    const body=await jsonBody(req); const password=body.password;
    if(typeof password!=='string'||password.length<10||password.length>128) fail(400,'Alege o parolă între 10 și 128 de caractere.');
    const row=await db().prepare('SELECT password_hash,profile_revision,active FROM users WHERE id=?').bind(user.id).first<{password_hash:string;profile_revision:number;active:number}>();
    if(!row||typeof body.currentPassword!=='string'||!(await verifyPassword(body.currentPassword,row.password_hash))) fail(400,'Parola curentă este incorectă.');
    if(password===body.currentPassword) fail(400,'Parola nouă trebuie să fie diferită.');
    const passwordHash=await hashPassword(password),tokenHash=sha256(sessionToken(req)),expectedRevision=Number(row.profile_revision);
    const results=await db().batch([
      db().prepare('UPDATE users SET password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND active=1 AND password_hash=? AND profile_revision=? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?)').bind(passwordHash,user.id,row.password_hash,expectedRevision,tokenHash,user.id,Date.now()),
      db().prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND active=1 AND password_hash=? AND profile_revision=?)').bind(user.id,tokenHash,user.id,passwordHash,expectedRevision+1),
    ]);
    if(!results[0]?.meta.changes)fail(409,'Contul sau parola s-au modificat între timp. Reautentifică-te și încearcă din nou.');
    return response({ok:true});
  }
  if(path[0]==='clients' && req.method==='GET') {
    const warehouseId=user.role==='agent'?user.warehouseId:new URL(req.url).searchParams.get('warehouseId');
    if(!warehouseId) fail(400,'Selectează gestiunea.');
    await requireWarehouseAccess(readUser,warehouseId);
    const rows=await db().prepare("SELECT data FROM customers WHERE EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.warehouseIds'),json_array(warehouse_id))) WHERE value=?) AND active=1 ORDER BY id").bind(warehouseId).all<{data:string}>();
    return response({clients:rows.results.map(r=>({...JSON.parse(r.data),warehouseId,...(user.role==='manager'?{version:sha256(r.data)}:{})}))});
  }
  if(path[0]==='orders') {
    const id=path[1];
    if(!id && req.method==='GET') {
      const params=new URL(req.url).searchParams;
      if(params.get('page')==='1')return response({user,...await listOrdersPage(user,params),weekKey:weekKey()});
      return response({user,orders:await listOrders(user),weekKey:weekKey()});
    }
    if(!id && req.method==='POST') {
      const body=await jsonBody(req); const kind=body.kind as Kind;
      if(!['accessories','stands','sim','combined','stand_client'].includes(kind)) fail(400,'Tip de comandă invalid.');
      const agent=await targetAgent(user,body.agentId);
      const uuid=textField(body.id,80);
      if(!/^[0-9a-f-]{36}$/.test(uuid)) fail(400,'Identificator de comandă invalid.');
      const existing=await db().prepare('SELECT * FROM orders WHERE id=?').bind(uuid).first<Record<string,unknown>>();
      if(existing) return response({order:await getOrder(uuid,user)});
      const number=`${kind==='stand_client'?'AVS':kind==='sim'?'SIM':kind==='stands'?'STD':kind==='combined'?'COM':'ACC'}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${uuid.slice(0,8).toUpperCase()}`;
      let order:Order={id:uuid,number,userId:agent.id,agentName:agent.name,warehouseId:agent.warehouseId!,warehouseName:agent.warehouseName!,kind,status:'draft',items:[],standItems:kind==='combined'?[]:undefined,serials:[],client:null,notes:'',createdAt:new Date().toISOString(),finalizedAt:null,sourceOrderId:null,revision:1,total:0,pieces:0};
      if(body.sourceOrderId) {
        const source=await getOrder(textField(body.sourceOrderId),user);
        if(source.kind!==kind||source.userId!==agent.id) fail(400,'Comanda se poate copia doar pentru același agent și același tip.');
        order={...order,items:source.items,standItems:kind==='combined'?source.standItems||[]:undefined,serials:kind==='combined'||kind==='sim'?[]:source.serials,client:source.client,notes:source.notes,sourceOrderId:source.id,total:source.total,pieces:kind==='sim'?0:kind==='combined'?source.items.reduce((sum,l)=>sum+l.quantity,0)+(source.standItems||[]).reduce((sum,l)=>sum+l.quantity,0):source.pieces};
      }
      await db().prepare('INSERT OR IGNORE INTO orders (id,number,user_id,warehouse_id,kind,status,payload,created_at,source_order_id) VALUES (?,?,?,?,?,?,?,?,?)').bind(uuid,number,agent.id,agent.warehouseId,kind,'draft',JSON.stringify(order),order.createdAt,order.sourceOrderId).run();
      return response({order:await getOrder(uuid,user)},201);
    }
    if(id && !path[2] && req.method==='GET') return response({order:await getOrder(id,readUser)});
    if(id && !path[2] && req.method==='DELETE') {
      const order=await getOrder(id,user);
      if(user.role!=='manager' && order.status!=='draft') fail(403,'Poți șterge doar ciornele create de tine.');
      const body=await jsonBody(req);
      if(body.revision!==order.revision) fail(409,'Comanda s-a modificat. Închide confirmarea și actualizează lista înainte de ștergere.');
      const result=await db().batch([
        db().prepare("UPDATE orders SET status='deleted',payload=json_set(payload,'$.deletedAt',?,'$.deletedBy',?,'$.previousStatus',status),revision=revision+1 WHERE id=? AND status!='deleted' AND revision=?").bind(new Date().toISOString(),user.id,id,order.revision),
        db().prepare("DELETE FROM serials WHERE order_id=? AND EXISTS (SELECT 1 FROM orders WHERE id=? AND status='deleted' AND revision=?)").bind(id,id,order.revision+1),
      ]);
      if(!result[0].meta.changes) fail(409,'Comanda s-a modificat. Actualizează lista înainte de ștergere.');
      return response({ok:true});
    }
    if(id && !path[2] && req.method==='PUT') return saveOrder(req,id,user);
    if(path[2]==='finalize' && req.method==='POST') return finalize(id,user,req);
    if(path[2]==='mail' && req.method==='GET') { const order=await getOrder(id,readUser); if(order.status!=='finalized') fail(400,'Finalizează comanda întâi.'); return response({mail:mailFor(order,await settingsForOrder(order))}); }
    if((path[2]==='excel'||path[2]==='eml') && req.method==='GET') {
      const order=await getOrder(id,readUser);
      if(order.status!=='finalized') fail(400,'Finalizează comanda pentru export.');
      if(order.kind==='stand_client') {
        if(path[2]==='excel') fail(400,'Avizul pentru standuri este disponibil în corpul e-mailului, fără Excel.');
        const mail=mailFor(order,await settingsForOrder(order));
        return new Response(emlFor(mail),{headers:{'Content-Type':'message/rfc822','Content-Disposition':`attachment; filename="${mail.filename}"`,'Cache-Control':'no-store'}});
      }
      const key=(order as Order & {exportKey:string}).exportKey;
      const object=await env.FILES.get(key);
      if(!object) fail(503,'Fișierul nu poate fi încărcat. Contactează managerul.');
      const mail=mailFor(order,await settingsForOrder(order));
      const bytes=repairOrderExport(new Uint8Array(await object.arrayBuffer()),order);
      if(path[2]==='eml') return new Response(emlFor(mail,bytes),{headers:{'Content-Type':'message/rfc822','Content-Disposition':`attachment; filename="${mail.filename.replace('.xlsx','.eml')}"`,'Cache-Control':'no-store'}});
      return new Response(new Uint8Array(bytes),{headers:{'Content-Type':excelMime,'Content-Disposition':`attachment; filename="${mail.filename}"`,'Cache-Control':'no-store'}});
    }
  }
  if(path[0]==='admin') {
    requireManager(user);
    if(path.join('/')==='admin/imports/status' && req.method==='GET') return response({sales:salesImportStatus(),stock:await stockImportStatus()});
    if(path[1]==='products') {
      if(req.method==='GET')return response({products:(await readCatalog()).products});
      if(['POST','PUT','DELETE'].includes(req.method))return response(await changeProduct(req.method,path[2],await jsonBody(req)));
    }
    if(path[1]==='regional-settings' && req.method==='PUT') {
      if(isGlobalManager(user)) fail(403,'Setările regionale se modifică dintr-un cont de manager regional.');
      const body=await jsonBody(req),regional=await regionalOperationalSettings(user.id);
      if(!regional.agentIds.length) fail(409,'Managerul nu are agenți activi alocați.');
      const next={...regional.settings,accessoriesCc:[...regional.settings.accessoriesCc],standsCc:[...regional.settings.standsCc],simCc:[...regional.settings.simCc],partnerTo:[...regional.settings.partnerTo],partnerCc:[...regional.settings.partnerCc]};
      for(const key of ['accessoriesEmail','standsEmail','simEmail'] as const) {
        if(body[key]===undefined)continue;
        const value=textField(body[key],254);
        if(value && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) fail(400,'Introdu o singură adresă de e-mail validă pentru fiecare tip.');
        next[key]=value;
      }
      for(const [key,limit,label] of [['accessoriesCc',4,'adrese CC'],['standsCc',4,'adrese CC'],['simCc',2,'adrese CC'],['partnerTo',2,'destinatari Partener nou'],['partnerCc',1,'adrese CC Partener nou']] as const) {
        if(body[key]===undefined)continue;
        const entries=body[key];
        if(!Array.isArray(entries)||entries.length>limit)fail(400,`Maximum ${limit} ${label}.`);
        const recipients:string[]=[];
        for(const entry of entries) {
          if(typeof entry!=='string'||entry.length>254)fail(400,'Adresă de e-mail invalidă.');
          const value=entry.trim();
          if(value && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value))fail(400,'Introdu o singură adresă validă în fiecare câmp de e-mail.');
          recipients.push(value);
        }
        next[key]=recipients;
      }
      if(!next.partnerTo.some(Boolean))fail(400,'Partener nou trebuie să aibă cel puțin un destinatar.');
      const stored=JSON.stringify(next);
      await db().batch(regional.agentIds.map(agentId=>db().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('agent-mail:'+agentId,stored)));
      return response({regionalSettings:next,regionalSettingsMixed:false});
    }
    if(path[1]==='manager-mail' && req.method==='PUT') {
      const body=await jsonBody(req);
      const next=await managerMailSettings(user.id);
      for(const key of ['accessories','stands','sim','partner'] as const) {
        const value=textField(body[key],254);
        if(value && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) fail(400,'Introdu o adresă de e-mail validă.');
        next[key]=value;
      }
      await db().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('manager-mail:'+user.id,JSON.stringify(next)).run();
      return response({managerMailSettings:next});
    }
    if(path[1]==='settings' && req.method==='PUT') {
      requireGlobalManager(user);
      const body=await jsonBody(req); const cfg=await settings();
      for(const key of ['accessoriesEmail','standsEmail','simEmail'] as const) {
        const value=textField(body[key],254);
        if(value && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) fail(400,'Introdu o singură adresă de e-mail validă pentru fiecare tip.');
        cfg[key]=value;
      }
      for(const [key,limit,label] of [['accessoriesCc',4,'adrese CC'],['standsCc',4,'adrese CC'],['simCc',2,'adrese CC'],['partnerTo',2,'destinatari Partener nou'],['partnerCc',1,'adrese CC Partener nou']] as const) {
        if(body[key]===undefined) continue;
        const entries=body[key];
        if(!Array.isArray(entries)||entries.length>limit) fail(400,`Maximum ${limit} ${label}.`);
        const recipients: string[]=[];
        for(const entry of entries) {
          if(typeof entry!=='string'||entry.length>254) fail(400,'Adresă de e-mail invalidă.');
          const value=entry.trim();
          if(value && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) fail(400,'Introdu o singură adresă validă în fiecare câmp de e-mail.');
          recipients.push(value);
        }
        cfg[key]=recipients;
      }
      if(!cfg.partnerTo.some(Boolean)) fail(400,'Partener nou trebuie să aibă cel puțin un destinatar.');
      if(typeof body.weeklyLimit!=='number'||!Number.isInteger(body.weeklyLimit)||body.weeklyLimit<1||body.weeklyLimit>7) fail(400,'Limita săptămânală trebuie să fie între 1 și 7.');
      cfg.weeklyLimit=body.weeklyLimit;
      await db().prepare("INSERT INTO settings (key,value) VALUES ('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
      return response({settings:cfg});
    }
    if(path[1]==='managers' && !path[2] && req.method==='POST') {
      requireGlobalManager(user);
      const body=await jsonBody(req),username=textField(body.username,80).toLowerCase(),name=textField(body.name,100),password=typeof body.password==='string'?body.password:'';
      const agentIds=Array.isArray(body.agentIds)?[...new Set(body.agentIds.filter((id):id is string=>typeof id==='string').map(id=>id.trim()).filter(Boolean))]:[];
      if(!/^[a-z0-9._-]{3,80}$/.test(username)||!name||password.length<10||password.length>128||agentIds.length>100)fail(400,'Completează numele, utilizatorul, parola și o listă validă de agenți.');
      if(await db().prepare('SELECT id FROM users WHERE username=?').bind(username).first())fail(409,'Numele de utilizator este deja folosit.');
      const available=await db().prepare("SELECT id FROM users WHERE role='agent' AND active=1").all<{id:string}>(),allowed=new Set(available.results.map(item=>item.id));
      if(agentIds.some(id=>!allowed.has(id)))fail(400,'Unul dintre agenții selectați nu este activ sau nu există.');
      const id=crypto.randomUUID(),passwordHash=await hashPassword(password);
      await db().batch([db().prepare("INSERT INTO users (id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,active) VALUES (?,?,?,'manager','assigned',NULL,?,0,1)").bind(id,username,name,passwordHash),...agentIds.map(agentId=>db().prepare('INSERT INTO manager_agents (manager_id,agent_id) VALUES (?,?)').bind(id,agentId))]);
      return response({users:await getUsers(user)});
    }
    if(path[1]==='managers' && path[2] && req.method==='PUT') {
      requireGlobalManager(user);
      const body=await jsonBody(req),row=await db().prepare("SELECT * FROM users WHERE id=? AND role='manager'").bind(path[2]).first<Record<string,unknown>>();
      if(!row)fail(404,'Managerul nu a fost găsit.');
      const current=userView(row),expectedRevision=Number(body.version);
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==Number(current.profileVersion))fail(409,'Datele managerului s-au modificat. Redeschide editarea.');
      if(current.managerScope==='global'&&current.id!==user.id)fail(403,'Poți modifica doar propriul cont global.');
      const username=textField(body.username,80).toLowerCase(),name=textField(body.name,100),password=body.password;
      if(!/^[a-z0-9._-]{3,80}$/.test(username)||!name)fail(400,'Completează numele și un utilizator valid.');
      if(password!==undefined&&(typeof password!=='string'||password.length<10||password.length>128))fail(400,'Parola trebuie să aibă între 10 și 128 de caractere.');
      if(await db().prepare('SELECT id FROM users WHERE username=? AND id!=?').bind(username,current.id).first())fail(409,'Numele de utilizator este deja folosit.');
      const agentIds=current.managerScope==='global'?[]:Array.isArray(body.agentIds)?[...new Set(body.agentIds.filter((id):id is string=>typeof id==='string').map(id=>id.trim()).filter(Boolean))]:[];
      if(agentIds.length>100)fail(400,'Sunt prea mulți agenți selectați.');
      const available=await db().prepare("SELECT id FROM users WHERE role='agent' AND active=1").all<{id:string}>(),allowed=new Set(available.results.map(item=>item.id));
      if(agentIds.some(id=>!allowed.has(id)))fail(400,'Unul dintre agenții selectați nu este activ sau nu există.');
      const passwordHash=password===undefined?null:await hashPassword(password);
      const guard='EXISTS (SELECT 1 FROM users WHERE id=? AND profile_revision=?)';
      const statements=[];
      if(current.managerScope==='assigned') {
        statements.push(db().prepare(`DELETE FROM manager_agents WHERE manager_id=? AND ${guard}`).bind(current.id,current.id,expectedRevision));
        for(const agentId of agentIds)statements.push(db().prepare(`INSERT INTO manager_agents (manager_id,agent_id) SELECT ?,? WHERE ${guard}`).bind(current.id,agentId,current.id,expectedRevision));
      }
      if(password!==undefined||username!==current.username) {
        statements.push(db().prepare(`DELETE FROM login_attempts WHERE key IN (?,?) AND ${guard}`).bind('account:'+current.username,'account:'+username,current.id,expectedRevision));
        statements.push(current.id===user.id?db().prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash!=? AND ${guard}`).bind(current.id,sha256(sessionToken(req)),current.id,expectedRevision):db().prepare(`DELETE FROM sessions WHERE user_id=? AND ${guard}`).bind(current.id,current.id,expectedRevision));
      }
      statements.push(passwordHash===null?db().prepare('UPDATE users SET username=?,name=?,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=?').bind(username,name,current.id,expectedRevision):db().prepare('UPDATE users SET username=?,name=?,password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=?').bind(username,name,passwordHash,current.id,expectedRevision));
      const results=await db().batch(statements);
      if(!results.at(-1)?.meta.changes)fail(409,'Datele managerului s-au modificat. Redeschide editarea.');
      return response({users:await getUsers(user)});
    }
    if(path[1]==='users' && path[2] && req.method==='PUT') {
      const body=await jsonBody(req);
      await requireAgentAccess(user,path[2]);
      const row=await db().prepare("SELECT * FROM users WHERE id=? AND role='agent'").bind(path[2]).first<Record<string,unknown>>();
      if(!row)fail(404,'Agentul nu a fost găsit.');
      const expectedRevision=Number(body.version),current=userView(row);
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==Number(current.profileVersion))fail(409,'Datele agentului s-au modificat. Redeschide editarea.');
      if(body.username!==undefined||body.password!==undefined) {
        const username=textField(body.username,80).toLowerCase(),password=body.password;
        if(!/^[a-z0-9._-]{3,80}$/.test(username))fail(400,'Utilizatorul trebuie să aibă între 3 și 80 de caractere: litere, cifre, punct, minus sau underscore.');
        if(typeof password!=='string'||password.length<10||password.length>128)fail(400,'Parola trebuie să aibă între 10 și 128 de caractere.');
        const duplicate=await db().prepare('SELECT id FROM users WHERE username=? AND id!=?').bind(username,path[2]).first();
        if(duplicate)fail(409,'Numele de utilizator este deja folosit.');
        const passwordHash=await hashPassword(password),guard='EXISTS (SELECT 1 FROM users WHERE id=? AND profile_revision=?)';
        const results=await db().batch([
          db().prepare(`DELETE FROM login_attempts WHERE key=(SELECT 'account:'||username FROM users WHERE id=?) AND ${guard}`).bind(path[2],path[2],expectedRevision),
          db().prepare(`DELETE FROM sessions WHERE user_id=? AND ${guard}`).bind(path[2],path[2],expectedRevision),
          db().prepare('UPDATE users SET username=?,password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=?').bind(username,passwordHash,path[2],expectedRevision),
        ]);
        if(!results.at(-1)?.meta.changes)fail(409,'Datele agentului s-au modificat. Redeschide editarea.');
        return response({users:await getUsers(user)});
      }
      const name=textField(body.name,100),warehouseName=textField(body.warehouseName,200),requestedSiteCode=textField(body.siteCode,80),currentSiteCode=typeof row.site_code==='string'?row.site_code:'';
      if(!name||!warehouseName)fail(400,'Completează numele agentului și denumirea gestiunii.');
      if(!isGlobalManager(user)&&requestedSiteCode!==currentSiteCode)fail(403,'SiteCode-ul poate fi modificat doar de managerul general.');
      const siteCode=isGlobalManager(user)?requestedSiteCode:currentSiteCode;
      if(siteCode&&await db().prepare("SELECT id FROM users WHERE role='agent' AND active=1 AND id!=? AND UPPER(TRIM(site_code))=UPPER(TRIM(?)) LIMIT 1").bind(path[2],siteCode).first())fail(409,'SiteCode-ul este deja alocat altui agent activ.');
      let result;
      try { result=await db().prepare('UPDATE users SET name=?,warehouse_name=?,site_code=?,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=?').bind(name,warehouseName,siteCode,path[2],expectedRevision).run(); }
      catch(error) { if(error instanceof Error&&/UNIQUE constraint failed/.test(error.message))fail(409,'SiteCode-ul este deja alocat altui agent activ.'); throw error; }
      if(!result.meta.changes)fail(409,'Datele agentului s-au modificat între timp. Actualizează lista.');
      return response({users:await getUsers(user)});
    }
    if(path[1]==='users' && req.method==='POST') {
      const body=await jsonBody(req);
      if(body.action==='reset') {
        const id=textField(body.id);
        await requireAgentAccess(user,id);
        if(id===user.id) fail(400,'Schimbă parola ta din meniul contului.');
        const password=textField(body.password,128);
        if(password.length<10) fail(400,'Parola trebuie să aibă cel puțin 10 caractere.');
        const found=await db().prepare("SELECT * FROM users WHERE id=? AND role='agent'").bind(id).first<Record<string,unknown>>();
        if(!found) fail(404,'Utilizatorul nu există.');
        const expectedRevision=Number(body.version);
        if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==Number(userView(found).profileVersion))fail(409,'Datele agentului s-au modificat. Actualizează lista.');
        const passwordHash=await hashPassword(password),guard='EXISTS (SELECT 1 FROM users WHERE id=? AND profile_revision=?)';
        const results=await db().batch([db().prepare(`DELETE FROM login_attempts WHERE key=(SELECT 'account:'||username FROM users WHERE id=?) AND ${guard}`).bind(id,id,expectedRevision),db().prepare(`DELETE FROM sessions WHERE user_id=? AND ${guard}`).bind(id,id,expectedRevision),db().prepare('UPDATE users SET password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=?').bind(passwordHash,id,expectedRevision)]);
        if(!results.at(-1)?.meta.changes)fail(409,'Datele agentului s-au modificat. Actualizează lista.');
      } else if(body.action==='toggle') {
        const id=textField(body.id);
        await requireAgentAccess(user,id);
        if(id===user.id) fail(400,'Nu îți poți dezactiva propriul cont.');
        const found=await db().prepare("SELECT * FROM users WHERE id=? AND role='agent'").bind(id).first<Record<string,unknown>>();
        if(!found)fail(404,'Utilizatorul nu există.');
        const expectedRevision=Number(body.version);
        if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==Number(userView(found).profileVersion))fail(409,'Datele agentului s-au modificat. Actualizează lista.');
        const activationGuard="(active=1 OR TRIM(site_code)='' OR NOT EXISTS (SELECT 1 FROM users other WHERE other.role='agent' AND other.active=1 AND other.id!=users.id AND UPPER(TRIM(other.site_code))=UPPER(TRIM(users.site_code))))";
        const results=await db().batch([
          db().prepare(`UPDATE users SET active=1-active,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=? AND ${activationGuard}`).bind(id,expectedRevision),
          db().prepare('DELETE FROM sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND profile_revision=?)').bind(id,id,expectedRevision+1),
        ]);
        if(!results[0]?.meta.changes) {
          const current=await db().prepare("SELECT active,site_code,profile_revision FROM users WHERE id=? AND role='agent'").bind(id).first<{active:number;site_code:string;profile_revision:number}>();
          if(current&&Number(current.profile_revision)===expectedRevision&&!current.active&&current.site_code.trim())fail(409,'SiteCode-ul este deja alocat altui agent activ. Schimbă SiteCode-ul înainte de reactivare.');
          fail(409,'Datele agentului s-au modificat. Actualizează lista.');
        }
      } else {
        requireGlobalManager(user);
        const username=textField(body.username,80).toLowerCase(),name=textField(body.name,100),password=textField(body.password,128),warehouseId=textField(body.warehouseId);
        if(!/^[a-z0-9._-]{3,80}$/.test(username)||!name||password.length<10||!warehouses.some(g=>g.id===warehouseId)) fail(400,'Completează numele, un utilizator valid, gestiunea și o parolă de minimum 10 caractere.');
        if(await db().prepare('SELECT id FROM users WHERE username=?').bind(username).first()) fail(409,'Numele de utilizator este deja folosit.');
        const passwordHash=await hashPassword(password);
        await db().prepare("INSERT INTO users (id,username,name,role,warehouse_id,password_hash,must_change_password) VALUES (?,?,?,'agent',?,?,0)").bind(crypto.randomUUID(),username,name,warehouseId,passwordHash).run();
      }
      return response({users:await getUsers(user)});
    }
    if(path[1]==='clients' && path[2] && req.method==='PUT') {
      const body=await jsonBody(req);
      const row=await db().prepare('SELECT data,warehouse_id FROM customers WHERE id=? AND active=1').bind(path[2]).first<{data:string;warehouse_id:string}>();
      if(!row) fail(404,'Clientul nu mai este în portofoliul activ. Actualizează lista.');
      const original=JSON.parse(row.data) as Client;
      const oldWarehouses=original.warehouseIds||[row.warehouse_id];
      const sourceWarehouseId=textField(body.sourceWarehouseId)||row.warehouse_id;
      if(!oldWarehouses.includes(sourceWarehouseId))fail(400,'Gestiunea sursă nu aparține clientului.');
      await requireWarehouseAccess(user,sourceWarehouseId);
      if(body.version!==sha256(row.data)) fail(409,'Clientul a fost modificat între timp. Reîncarcă portofoliul înainte de editare.');
      const ids=body.agentIds===undefined?[textField(body.agentId)]:body.agentIds;
      if(Array.isArray(ids))for(const id of ids)if(typeof id==='string')await requireAgentAccess(user,id);
      if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>typeof id!=='string'))fail(400,'Selectează cel puțin un agent.');
      const agents=await db().prepare("SELECT id,warehouse_id,active FROM users WHERE role='agent'").all<{id:string;warehouse_id:string;active:number}>();
      const selected=ids.map(id=>agents.results.find(a=>a.id===id));
      if(selected.some(a=>!a?.warehouse_id||(!a.active&&!oldWarehouses.includes(a.warehouse_id))))fail(400,'Alege agenți activi pentru portofoliu.');
      const selectedWarehouses=selected.map(a=>a!.warehouse_id);
      let warehouseIds:string[];
      if(isGlobalManager(user)) warehouseIds=[...new Set(body.agentIds===undefined?[...oldWarehouses.filter(w=>w!==sourceWarehouseId),selectedWarehouses[0]]:selectedWarehouses)];
      else {
        const scoped=await db().prepare('SELECT DISTINCT a.warehouse_id warehouseId FROM manager_agents ma JOIN users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.warehouse_id IS NOT NULL').bind(user.id).all<{warehouseId:string}>();
        const visibleWarehouses=new Set(scoped.results.map(item=>item.warehouseId));
        const preserved=oldWarehouses.filter(warehouseId=>!visibleWarehouses.has(warehouseId));
        warehouseIds=[...new Set([...preserved,...selectedWarehouses])];
      }
      const fields={name:200,cui:40,city:100,county:100,address:500,route:30} as const;
      const values:Record<string,string>={};
      for(const [key,limit] of Object.entries(fields)) {
        if(typeof body[key]!=='string'||body[key].length>limit) fail(400,'Datele clientului sunt invalide sau prea lungi.');
        values[key]=body[key].trim();
      }
      if(!values.name||!values.cui||!values.city) fail(400,'Denumirea, CUI-ul și localitatea sunt obligatorii.');
      const client={...original,...values,warehouseId:warehouseIds[0],warehouseIds};
      const data=JSON.stringify(client);
      const result=await db().prepare('UPDATE customers SET data=?,warehouse_id=? WHERE id=? AND active=1 AND data=? AND warehouse_id=?').bind(data,warehouseIds[0],path[2],row.data,row.warehouse_id).run();
      if(!result.meta.changes) fail(409,'Clientul s-a modificat între timp. Reîncarcă portofoliul.');
      return response({client:{...client,version:sha256(data)},users:await getUsers(user)});
    }
    if(path[1]==='import-clients' && req.method==='POST') {
      const body=await jsonBody(req),warehouseId=textField(body.warehouseId);
      if(!warehouses.some(g=>g.id===warehouseId)) fail(400,'Gestiune invalidă.');
      await requireWarehouseAccess(user,warehouseId);
      const result=await importClients(warehouseId,body);
      return response('preview' in result?result:{...result,users:await getUsers(user)});
    }
    if(path[1]==='templates' && req.method==='POST') {
      requireGlobalManager(user);
      const type=new URL(req.url).searchParams.get('type');
      if(type!=='accesorii'&&type!=='standuri') fail(400,'Model necunoscut.');
      if(Number(req.headers.get('content-length')||0)>22_000_000) fail(413,'Modelul depășește 22 MB.');
      const bytes=await readLimited(req,22_000_000);
      if(bytes.length>22_000_000||bytes[0]!==80||bytes[1]!==75) fail(400,'Încarcă modelul în format .xlsx.');
      if(createHash('sha256').update(bytes).digest('hex')!==templateHashes[type]) fail(400,'Modelul nu corespunde catalogului acestei versiuni. Încarcă modelul verificat din aplicație.');
      await env.FILES.put(`templates/${type}.xlsx`,bytes,{httpMetadata:{contentType:excelMime}});
      return response({ok:true});
    }
  }
  fail(404,'Pagina solicitată nu există.');
}
async function run(req: Request) { try { return await dispatch(req); } catch(err) { return handleError(err); } }
export const GET=run;
export const POST=run;
export const PUT=run;
export const PATCH=run;
export const DELETE=run;
