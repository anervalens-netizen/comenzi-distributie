import mailDefaults from '@/resources/mail-defaults.json';
import { generateVapidKeys } from '@mmmike/web-push/vapid';
import { sendPushBatch, topicFromString, WebPushError, type PushSubscriptionData, type VapidConfig } from '@mmmike/web-push/send';
import { db, fail, isGlobalManager, requireManager, textField } from './server';
import type { ManagerRequestInbox, ManagerRequestInboxItem, PartnerRequest, User } from './types';

const VAPID_KEY='push-vapid-v1';
const VAPID_SUBJECT=mailDefaults.publicOrigin;
const endpointMax=4096,keyMax=512;
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
  const endpoint=textField(raw.endpoint,endpointMax),p256dh=textField(raw.keys?.p256dh,keyMax),auth=textField(raw.keys?.auth,keyMax);
  let url:URL;try{url=new URL(endpoint);}catch{fail(400,'Endpointul push este invalid.');}
  if(url.protocol!=='https:')fail(400,'Endpointul push trebuie să folosească HTTPS.');
  if(!p256dh||!auth||!b64url.test(p256dh)||!b64url.test(auth))fail(400,'Cheile abonamentului push sunt invalide.');
  return {endpoint,keys:{p256dh,auth}};
}
export async function managerRequestInbox(user:User):Promise<ManagerRequestInbox>{
  requireManager(user);
  const where=isGlobalManager(user)
    ?"pr.status='requested'"
    :"pr.status='requested' AND EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=pr.agent_id)";
  const countSql='SELECT COUNT(*) count FROM partner_requests pr WHERE '+where;
  const rowsSql="SELECT pr.id,pr.agent_id,u.name agent_name,pr.created_at,pr.payload FROM partner_requests pr JOIN users u ON u.id=pr.agent_id WHERE "+where+' ORDER BY pr.created_at DESC LIMIT 20';
  const countArgs=isGlobalManager(user)?[]:[user.id],rowArgs=isGlobalManager(user)?[]:[user.id];
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
export async function pushPublicConfig(user:User){
  requireManager(user);const cfg=await vapid();return {publicKey:cfg.publicKey};
}
export async function upsertPushSubscription(user:User,input:unknown){
  requireManager(user);const subscription=parseSubscription(input),now=new Date().toISOString();
  await db().prepare("INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at").bind(subscription.endpoint,user.id,subscription.keys.p256dh,subscription.keys.auth,now,now).run();
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
    const cfg=await vapid(),subscriptions=rows.results.map(row=>({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}}));
    const topic=await topicFromString('partner-request:'+requestId);
    const result=await sendPushBatch(subscriptions,{title:`Partener nou · ${partner.company}`,body:`Solicitare trimisă de ${agent.name}`,url:`/?request=${requestId}`,tag:`partner-request-${requestId}`},cfg,{ttl:86400,urgency:'high',topic,timeoutMs:5000,concurrency:8});
    if(result.gone.length)await db().batch(result.gone.map(endpoint=>db().prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(endpoint)));
    for(const failure of result.failed){
      const err=failure.error;
      if(err instanceof WebPushError)console.warn('Push delivery failed',{statusCode:err.statusCode,retryAfterMs:err.retryAfterMs});
      else console.warn('Push delivery failed',{kind:err instanceof TypeError?'network':'invalid'});
    }
  }catch(error){
    console.warn('Push dispatch skipped',{kind:error instanceof Error?error.name:'unknown'});
  }
}
