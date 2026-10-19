import {isIP} from 'node:net';
import {db,fail,readLimited,sha256,sessionToken} from './server';
import {canViewUsageReport} from './usage-access';
import {bucharestDayStartUtc} from './bucharest-month';
import {parseUsagePulse,USAGE_RETENTION_DAYS} from './usage-model';
import {recordUsageAuth,recordUsagePulse,readUsage} from './usage-store';
import type {User} from './types';
const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});
function network(req:Request){
  // Only the ingress-sanitized header is trusted. Never accept body/XFF values.
  const candidate=req.headers.get('CF-Connecting-IP')||'';
  return {ip:isIP(candidate)?candidate:'',device:Array.from((req.headers.get('user-agent')||'').slice(0,256)).filter(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127).join('')};
}
const authKey=(token:string)=>sha256('usage-session:'+token);
export function usageAuth(req:Request,userId:string,event:'login'|'logout',token=sessionToken(req)){
  const {ip,device}=network(req);return recordUsageAuth(userId,authKey(token),event,ip,device);
}
export async function usagePulse(req:Request,user:User){
  let body:unknown;try{body=JSON.parse(new TextDecoder().decode(await readLimited(req,8192)));}catch{fail(400,'Date de utilizare invalide.');}
  const pulse=parseUsagePulse(body);if(!pulse)fail(400,'Date de utilizare invalide.');
  if(pulse.owner!==user.id)fail(409,'Contul s-a schimbat.');
  const {ip,device}=network(req);
  return {recorded:recordUsagePulse(user.id,authKey(sessionToken(req)),pulse,ip,device)};
}
export async function usageReport(user:User,params:URLSearchParams){
  if(!canViewUsageReport(user))fail(403,'Raportul de utilizare este disponibil numai administratorului.');
  if(params.has('managerId')||params.has('agentId'))fail(400,'Filtrele regionale nu se aplică raportului global de utilizare.');
  const today=dayFormat.format(Date.now()),from=params.get('from')||dayFormat.format(Date.now()-6*86400000),to=params.get('to')||today;
  let fromAt:number,toAt:number;
  try{
    fromAt=Date.parse(bucharestDayStartUtc(from));
    const next=new Date(to+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);
    // Validate the end date independently; Date normalizes invalid days.
    bucharestDayStartUtc(to);
    toAt=Date.parse(bucharestDayStartUtc(next.toISOString().slice(0,10)));
  }catch{fail(400,'Perioada este invalidă.');}
  if(to<from||to>today||toAt-fromAt>(USAGE_RETENTION_DAYS*24+1)*3600000||from<dayFormat.format(Date.now()-(USAGE_RETENTION_DAYS-1)*86400000))fail(400,'Alege o perioadă din ultimele 90 de zile.');
  const rows=(await db().prepare('SELECT id,name,username,role,active FROM users ORDER BY name').all<{id:string;name:string;username:string;role:string;active:number}>()).results;
  const users=rows;
  const detail=params.get('userId')||undefined;if(detail&&!users.some(u=>u.id===detail))fail(404,'Contul nu este în selecție.');
  let snapshot;try{snapshot=readUsage(from,to,users.map(u=>u.id),detail,fromAt,toAt);}catch{fail(503,'Raportul de utilizare este temporar indisponibil.');}
  return {...snapshot,from,to,generatedAt:Date.now(),users:users.map(u=>{
    const days=snapshot.days.filter(d=>d.user_id===u.id);
    return {...u,visibleMs:days.reduce((n,d)=>n+d.visible_ms,0),activeMs:days.reduce((n,d)=>n+d.active_ms,0),opens:days.reduce((n,d)=>n+d.opens,0),days:days.filter(d=>d.visible_ms>0).length,lastSeen:Math.max(0,...days.map(d=>d.last_seen)),logins:snapshot.logins[u.id]||0};
  })};
}
