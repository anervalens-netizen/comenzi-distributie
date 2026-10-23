import mailDefaults from '@/resources/mail-defaults.json';
import { generateVapidKeys } from '@mmmike/web-push/vapid';
import { topicFromString, WebPushError, type PushSubscriptionData, type VapidConfig } from '@mmmike/web-push/send';
import { isAllowedPushEndpoint, PUSH_ENDPOINT_MAX, sendBrowserPushBatch } from './push-delivery';
import { operationalWriteGuard } from './operational-write-guard';
import { db, fail, isGlobalManager, requireManager, textField } from './server';
import type { ManagerRequestInbox, ManagerRequestInboxItem, PartnerRequest, User } from './types';

const VAPID_KEY='push-vapid-v1';
const VAPID_SUBJECT=mailDefaults.publicOrigin;
const endpointMax=PUSH_ENDPOINT_MAX,keyMax=512;
const subscriptionLimit=10;
const b64url=/^[A-Za-z0-9_-]+$/;

type StoredVapid={publicKey:string;privateKey:string};
type PushRow={endpoint:string;p256dh:string;auth:string};
type InboxRow={id:string;agent_id:string;agent_name:string;created_at:string;payload:string};

function validVapid(value:unknown):value is StoredVapid{
  if(!value||typeof value!=='object')return false;
  const item=value as Partial<StoredVapid>;
  return typeof item.publicKey==='string'&&typeof item.privateKey==='string'&&b64url.test(item.publicKey)&&b64url.test(item.privateKey);
}
async function vapid():Promise<VapidConfig>{
  const existing=await db().prepare('SELECT value FROM settings WHERE key=?').bind(VAPID_KEY).first<{value:string}>();
  if(existing){try{const parsed=JSON.parse(existing.value);if(validVapid(parsed))return {...parsed,subject:VAPID_SUBJECT};}catch{}}
  const generated=await generateVapidKeys();
  await db().prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').bind(VAPID_KEY,JSON.stringify(generated)).run();
  const row=await db().prepare('SELECT value FROM settings WHERE key=?').bind(VAPID_KEY).first<{value:string}>();
  if(!row)throw new Error('VAPID keys could not be persisted.');
  const parsed=JSON.parse(row.value);if(!validVapid(parsed))throw new Error('Stored VAPID keys are invalid.');
  return {...parsed,subject:VAPID_SUBJECT};
}
function parseSubscription(value:unknown):PushSubscriptionData{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Abonamentul push este invalid.');
  const raw=value as {endpoint?:unknown;keys?:{p256dh?:unknown;auth?:unknown}};
  const endpoint=typeof raw.endpoint==='string'?raw.endpoint:'',p256dh=typeof raw.keys?.p256dh==='string'?raw.keys.p256dh:'',auth=typeof raw.keys?.auth==='string'?raw.keys.auth:'';
  if(!isAllowedPushEndpoint(endpoint))fail(400,'Furnizorul sau adresa abonamentului push nu este acceptat.');
  if(!p256dh||!auth||p256dh.length>keyMax||auth.length>keyMax||!b64url.test(p256dh)||!b64url.test(auth))fail(400,'Cheile abonamentului push sunt invalide.');
  return {endpoint,keys:{p256dh,auth}};
}
export async function managerRequestInbox(user:User):Promise<ManagerRequestInbox>{
  requireManager(user);
  const scope=isGlobalManager(user)
    ?"(pr.status='confirmed' AND pr.confirmed_by=pr.agent_id)"
    :"(pr.status='confirmed' AND pr.confirmed_by=pr.agent_id) AND EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=pr.agent_id)";
  const where=scope+" AND NOT EXISTS (SELECT 1 FROM settings WHERE key='partner-read:'||?||':'||pr.id)";
  const countSql='SELECT COUNT(*) count FROM partner_requests pr WHERE '+where;
  const rowsSql="SELECT pr.id,pr.agent_id,u.name agent_name,pr.created_at,pr.payload FROM partner_requests pr JOIN users u ON u.id=pr.agent_id WHERE "+where+' ORDER BY pr.created_at DESC LIMIT 20';
  const countArgs=isGlobalManager(user)?[user.id]:[user.id,user.id],rowArgs=countArgs;
  const [countRow,rows]=await Promise.all([
    db().prepare(countSql).bind(...countArgs).first<{count:number}>(),
    db().prepare(rowsSql).bind(...rowArgs).all<InboxRow>(),
  ]);
  const items:ManagerRequestInboxItem[]=rows.results.flatMap(row=>{
    try{
      const p=JSON.parse(row.payload) as PartnerRequest;
      return [{id:row.id,type:'partner' as const,title:p.company||'Partener nou',agentId:row.agent_id,agentName:row.agent_name,createdAt:row.created_at,location:p.location||'',county:p.county||''}];
    }catch{return [];}
  });
  return {count:Number(countRow?.count||0),items};
}
/** Read state is private to each manager and never changes client availability. */
export async function readPartnerNotifications(user:User,input:unknown){
  requireManager(user);
  const ids=(input as {ids?:unknown})?.ids;
  if(!Array.isArray(ids)||ids.length<1||ids.length>20||ids.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)))fail(400,'Notificările selectate sunt invalide.');
  const now=new Date().toISOString();
  await db().batch([...new Set(ids as string[])].map(id=>db().prepare("INSERT OR IGNORE INTO settings(key,value) SELECT 'partner-read:'||?||':'||pr.id,? FROM partner_requests pr WHERE pr.id=? AND pr.status='confirmed' AND pr.confirmed_by=pr.agent_id AND (?=1 OR EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=pr.agent_id))").bind(user.id,now,id,isGlobalManager(user)?1:0,user.id)));
  return managerRequestInbox(user);
}
export async function pushPublicConfig(user:User){
  requireManager(user);const cfg=await vapid();return {publicKey:cfg.publicKey};
}
export async function upsertPushSubscription(user:User,input:unknown,req:Request){
  requireManager(user);const subscription=parseSubscription(input),now=new Date().toISOString();
  const guard=operationalWriteGuard(req,user);
  const result=await db().prepare("INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE ((SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?)<? OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint=? AND user_id=?)) AND "+guard.sql+" ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at").bind(subscription.endpoint,user.id,subscription.keys.p256dh,subscription.keys.auth,now,now,user.id,subscriptionLimit,subscription.endpoint,user.id,...guard.args).run();
  if(!result.meta.changes){
    if(!await db().prepare('SELECT 1 ok WHERE '+guard.sql).bind(...guard.args).first())fail(409,'Sesiunea sau accesul s-a schimbat. Reîncarcă aplicația înainte de a continua.');
    fail(429,'Limita de dispozitive push a fost atinsă. Elimină un abonament vechi înainte de a adăuga altul.');
  }
  return {ok:true};
}
export async function removePushSubscription(user:User,input:unknown){
  requireManager(user);const endpoint=textField((input as {endpoint?:unknown})?.endpoint,endpointMax);
  if(!endpoint)fail(400,'Endpointul push lipsește.');
  await db().prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').bind(endpoint,user.id).run();
  return {ok:true};
}
export async function sendPartnerRequestPush(agent:User,requestId:string,partner:PartnerRequest){
  try{
    const rows=await db().prepare("SELECT ps.endpoint,ps.p256dh,ps.auth FROM push_subscriptions ps JOIN users m ON m.id=ps.user_id WHERE m.role='manager' AND m.active=1 AND (m.manager_scope='global' OR EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=m.id AND ma.agent_id=?))").bind(agent.id).all<PushRow>();
    if(!rows.results.length)return;
    const allowed=rows.results.filter(row=>isAllowedPushEndpoint(row.endpoint));
    if(allowed.length!==rows.results.length)console.warn('Push subscriptions skipped',{kind:'endpoint-policy',count:rows.results.length-allowed.length});
    if(!allowed.length)return;
    const cfg=await vapid(),subscriptions=allowed.map(row=>({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}}));
    const topic=await topicFromString('partner-request:'+requestId);
    const result=await sendBrowserPushBatch(subscriptions,{title:`Partener nou · ${partner.company}`,body:`Client adăugat în portofoliu de ${agent.name}`,url:`/?request=${requestId}`,tag:`partner-request-${requestId}`},cfg,topic);
    if(result.gone.length)await db().batch(result.gone.map(endpoint=>db().prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(endpoint)));
    for(const failure of result.failed){
      const err=failure.error;
      if(err instanceof WebPushError)console.warn('Push delivery failed',{statusCode:err.statusCode,retryAfterMs:err.retryAfterMs});
      else console.warn('Push delivery failed',{kind:err instanceof TypeError?'network':'invalid'});
    }
  }catch{
    console.warn('Push dispatch skipped',{kind:'unavailable'});
  }
}
