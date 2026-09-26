import { env } from '@/lib/runtime';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import seed from '@/resources/seed.json';
import initialUserData from '@/resources/initial-users.json';
import mailDefaults from '@/resources/mail-defaults.json';
import type { User, Order, Settings, OperationalMailSettings, ManagerMailSettings, Product } from './types';

type InitialUser={id:string;username:string;name:string;role:string;warehouseId:string|null;passwordHash:string};
const initialUsers=initialUserData as InitialUser[];
export const catalog = seed.products as Product[];
export const warehouses = seed.warehouses;
export const db = () => env.DB;
export const SESSION_TTL_SECONDS=365*24*60*60;
export const SESSION_TTL_MS=SESSION_TTL_SECONDS*1000;
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export function fail(status: number, message: string): never { throw new AppError(status, message); }
export function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
const scryptOptions={N:32768,r:8,p:3,maxmem:40*1024*1024} as const;
function derivePassword(password:string,salt:string) {
  return new Promise<Buffer>((resolve,reject)=>{
    scrypt(password,salt,32,scryptOptions,(error,derivedKey)=>error?reject(error):resolve(Buffer.from(derivedKey)));
  });
}
export async function hashPassword(password: string) {
  const salt = Buffer.from(randomBytes(16)).toString('hex');
  return `scrypt:${salt}:${Buffer.from(await derivePassword(password,salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [,salt,hash] = encoded.split(':');
  if (!salt || !hash) return false;
  const value = await derivePassword(password,salt);
  const expected=Buffer.from(hash,'hex');
  return value.length===expected.length && timingSafeEqual(value,expected);
}
export async function seedDatabase() {
  if (await db().prepare("SELECT value FROM settings WHERE key='seed-v1'").first()) return;
  for (let i=0;i<initialUsers.length;i+=50) await db().batch(initialUsers.slice(i,i+50).map(u=>db().prepare('INSERT OR IGNORE INTO users (id,username,name,role,manager_scope,warehouse_id,password_hash) VALUES (?,?,?,?,?,?,?)').bind(u.id,u.username,u.name,u.role,u.id==='manager'&&u.role==='manager'?'global':'assigned',u.warehouseId,u.passwordHash)));
  for (let i=0;i<seed.clients.length;i+=50) await db().batch(seed.clients.slice(i,i+50).map(c=>db().prepare('INSERT OR IGNORE INTO customers (id,warehouse_id,data) VALUES (?,?,?)').bind(c.id,c.warehouseId,JSON.stringify(c))));
  await db().prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('seed-v1','1')").run();
}
export function userView(row: Record<string, unknown>): User {
  const role = row.role as User['role'];
  const managerScope:User['managerScope']=role==='manager'&&row.manager_scope==='global'?'global':'assigned';
  return {id:String(row.id),username:String(row.username),name:String(row.name),role,managerScope,warehouseId:row.warehouse_id as string|null,warehouseName:(typeof row.warehouse_name==='string'&&row.warehouse_name?row.warehouse_name:warehouses.find(g=>g.id===row.warehouse_id)?.name)||null,siteCode:typeof row.site_code==='string'?row.site_code:'',profileVersion:String(Number(row.profile_revision||1)),mustChangePassword:role==='manager'&&!!row.must_change_password,active:Number(row.active)};
}
export function sessionToken(req: Request) { return req.headers.get('Cookie')?.match(/(?:^|;\s*)mobiup_session=([^;]+)/)?.[1]||''; }
export async function currentUser(req: Request) {
  const token=sessionToken(req);
  if (!token) return null;
  const row=await db().prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').bind(sha256(token),Date.now()).first<Record<string,unknown>>();
  return row?userView(row):null;
}
export async function refreshSession(req: Request) {
  const token=sessionToken(req);
  if(!token)return '';
  const now=Date.now();
  const result=await db().prepare('UPDATE sessions SET expires_at=? WHERE token_hash=? AND expires_at>? AND EXISTS (SELECT 1 FROM users WHERE users.id=sessions.user_id AND users.active=1)').bind(now+SESSION_TTL_MS,sha256(token),now).run();
  return result.meta.changes?token:'';
}
export async function requireUser(req: Request, allowPasswordChange=false) {
  const u=await currentUser(req);
  if (!u) fail(401,'Sesiunea a expirat. Autentifică-te din nou.');
  if (u.mustChangePassword && !allowPasswordChange) fail(428,'Alege o parolă personală înainte să continui.');
  return u;
}
export function requireManager(user: User) { if(user.role!=='manager') fail(403,'Această acțiune este disponibilă managerului.'); }
export function isGlobalManager(user: User) { return user.role==='manager'&&user.managerScope==='global'; }
export function requireGlobalManager(user: User) { if(!isGlobalManager(user)) fail(403,'Această acțiune este disponibilă managerului general.'); }
export async function canAccessAgent(user: User,agentId:string) {
  if(user.role==='agent')return user.id===agentId;
  if(isGlobalManager(user))return true;
  return !!await db().prepare('SELECT 1 ok FROM manager_agents WHERE manager_id=? AND agent_id=?').bind(user.id,agentId).first();
}
export async function requireAgentAccess(user:User,agentId:string) { if(!await canAccessAgent(user,agentId))fail(404,'Agentul nu a fost găsit.'); }
export async function canAccessWarehouse(user:User,warehouseId:string) {
  if(user.role==='agent')return user.warehouseId===warehouseId;
  if(isGlobalManager(user))return true;
  return !!await db().prepare('SELECT 1 ok FROM manager_agents ma JOIN users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.warehouse_id=? LIMIT 1').bind(user.id,warehouseId).first();
}
export async function requireWarehouseAccess(user:User,warehouseId:string) { if(!await canAccessWarehouse(user,warehouseId))fail(404,'Gestiunea nu a fost găsită.'); }
export function assertOrigin(req: Request) {
  const origin=req.headers.get('Origin');
  if (origin && origin!==new URL(req.url).origin) fail(403,'Cerere dintr-o origine nepermisă.');
  if (req.headers.get('Sec-Fetch-Site')==='cross-site') fail(403,'Cerere dintr-o origine nepermisă.');
}
export async function jsonBody(req: Request) {
  if (!req.headers.get('content-type')?.startsWith('application/json')) fail(415,'Este necesar un document JSON.');
  if (Number(req.headers.get('content-length')||0)>1_000_000) fail(413,'Cererea este prea mare.');
  const raw=new TextDecoder().decode(await readLimited(req,1_000_000));
  try { const value=JSON.parse(raw); if(!value || typeof value!=='object' || Array.isArray(value)) fail(400,'Date invalide.'); return value as Record<string,unknown>; } catch { fail(400,'Date invalide.'); }
}
export async function readLimited(req: Request,max: number) {
  const reader=req.body?.getReader();if(!reader) return new Uint8Array();
  const parts:Uint8Array[]=[];let size=0;
  while(true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();fail(413,'Cererea este prea mare.');}parts.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}return bytes;
}
export function textField(value: unknown, max=500) { if(typeof value!=='string') return ''; return value.trim().slice(0,max); }
export function weekKey(date=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const get=(type: string)=>parts.find(p=>p.type===type)!.value;
  const d=new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
  return d.toISOString().slice(0,10);
}
export function orderView(row: Record<string, unknown>): Order {
  const p=JSON.parse(String(row.payload));
  const hasDetailedLines=Array.isArray(p.items)||Array.isArray(p.standItems);
  const items=p.items||[],standItems=p.standItems||[];
  const itemCount=hasDetailedLines?items.length+standItems.length:(p.itemCount??0);
  return {...p,items,standItems,serials:p.serials||[],itemCount,id:row.id,number:row.number,userId:row.user_id,warehouseId:row.warehouse_id,kind:row.kind,status:row.status,createdAt:row.created_at,finalizedAt:row.finalized_at,sourceOrderId:row.source_order_id,revision:row.revision};
}
export async function getOrder(id: string,user: User) {
  const row=await db().prepare('SELECT * FROM orders WHERE id=?').bind(id).first<Record<string,unknown>>();
  if(!row || row.status==='deleted' || !await canAccessAgent(user,String(row.user_id))) fail(404,'Comanda nu a fost găsită.');
  return orderView(row);
}
export async function settings(): Promise<Settings> {
  const row=await db().prepare("SELECT value FROM settings WHERE key='app'").first<{value:string}>();
  return {accessoriesEmail:'',standsEmail:'',simEmail:'',accessoriesCc:[],standsCc:[],simCc:[],partnerTo:[...mailDefaults.partnerTo],partnerCc:[...mailDefaults.partnerCc],weeklyLimit:2,...(row?JSON.parse(row.value):{})};
}
export function operationalMailSettings(cfg:Settings):OperationalMailSettings {
  return {
    accessoriesEmail:cfg.accessoriesEmail,standsEmail:cfg.standsEmail,simEmail:cfg.simEmail,
    accessoriesCc:[...cfg.accessoriesCc],standsCc:[...cfg.standsCc],simCc:[...cfg.simCc],
    partnerTo:[...cfg.partnerTo],partnerCc:[...cfg.partnerCc],
  };
}
function withOperationalMailOverride(base:Settings,raw:string|null):Settings {
  if(!raw)return base;
  let value:Partial<OperationalMailSettings>;try{value=JSON.parse(raw);}catch{return base;}
  const next={...base};
  for(const key of ['accessoriesEmail','standsEmail','simEmail'] as const)if(typeof value[key]==='string')next[key]=value[key]!;
  for(const key of ['accessoriesCc','standsCc','simCc','partnerTo','partnerCc'] as const)if(Array.isArray(value[key])&&value[key]!.every(entry=>typeof entry==='string'))next[key]=[...value[key]!];
  return next;
}
export async function settingsForAgent(agentId:string):Promise<Settings> {
  const base=await settings();
  const row=await db().prepare('SELECT value FROM settings WHERE key=?').bind('agent-mail:'+agentId).first<{value:string}>();
  return withOperationalMailOverride(base,row?.value||null);
}
export async function regionalOperationalSettings(managerId:string) {
  const base=await settings();
  const rows=await db().prepare("SELECT a.id,s.value FROM manager_agents ma JOIN users a ON a.id=ma.agent_id AND a.role='agent' AND a.active=1 LEFT JOIN settings s ON s.key='agent-mail:'||a.id WHERE ma.manager_id=? ORDER BY a.id").bind(managerId).all<{id:string;value:string|null}>();
  const routes=rows.results.map(row=>operationalMailSettings(withOperationalMailOverride(base,row.value)));
  const fallback=operationalMailSettings(base);
  const first=routes[0]||fallback;
  const signature=JSON.stringify(first);
  return {settings:first,mixed:routes.some(route=>JSON.stringify(route)!==signature),agentIds:rows.results.map(row=>row.id)};
}
export async function managerMailSettings(managerId:string):Promise<ManagerMailSettings> {
  const row=await db().prepare('SELECT value FROM settings WHERE key=?').bind('manager-mail:'+managerId).first<{value:string}>();
  const value=row?JSON.parse(row.value) as Partial<ManagerMailSettings>:{};
  const accessories=typeof value.accessories==='string'?value.accessories:'';
  const stands=typeof value.stands==='string'?value.stands:'';
  const sim=typeof value.sim==='string'?value.sim:'';
  const partner=typeof value.partner==='string'?value.partner:(accessories||stands||sim);
  return {accessories,stands,sim,partner};
}
export async function settingsForOrder(order:Pick<Order,'userId'>):Promise<Settings> {
  const cfg=await settingsForAgent(order.userId);
  const rows=await db().prepare("SELECT s.value FROM manager_agents ma JOIN users m ON m.id=ma.manager_id AND m.role='manager' AND m.active=1 LEFT JOIN settings s ON s.key='manager-mail:'||m.id WHERE ma.agent_id=? ORDER BY m.username").bind(order.userId).all<{value:string|null}>();
  for(const row of rows.results) {
    if(!row.value)continue;
    let value:Partial<ManagerMailSettings>;try{value=JSON.parse(row.value);}catch{continue;}
    if(typeof value.accessories==='string'&&value.accessories)cfg.accessoriesCc=[...new Set([...cfg.accessoriesCc,value.accessories])];
    if(typeof value.stands==='string'&&value.stands)cfg.standsCc=[...new Set([...cfg.standsCc,value.stands])];
    if(typeof value.sim==='string'&&value.sim)cfg.simCc=[...new Set([...cfg.simCc,value.sim])];
  }
  return cfg;
}
export function response(data: unknown,status=200,extra?: HeadersInit) { const headers=new Headers(extra);headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');return Response.json(data,{status,headers}); }
export function handleError(err: unknown) {
  if(err instanceof AppError) return response({error:err.message},err.status);
  console.error('Request failed',err instanceof Error?err.message:'unknown');
  return response({error:'Operațiunea nu a reușit. Datele salvate rămân disponibile; încearcă din nou.'},500);
}
