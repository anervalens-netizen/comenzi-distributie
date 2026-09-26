import { db, fail, isGlobalManager, requireAgentAccess, requireManager, textField } from './server';
import { bucharestMonthKey, bucharestMonthUtcRange } from './bucharest-month';
import { hasPartnerCounty, normalizeCui, partnerLegacyPointKey, partnerPointKey } from './partner-identity';
import { sendPartnerRequestPush } from './push-notifications';
import type { Client, PartnerLocation, PartnerRequest, PartnerRequestRecord, TeamActivityAgent, TeamActivityView, User } from './types';

type RequestRow={id:string;agent_id:string;warehouse_id:string;cui_key:string;status:string;payload:string;created_at:string;updated_at:string;confirmed_at:string|null;confirmed_by:string|null;customer_id:string|null;revision:number;agent_name?:string;warehouse_name?:string|null};
type CustomerRow={id:string;warehouse_id:string;data:string};
type InventoryRecord={id:string;createdBy:string;createdByName:string;scopeLabel:string;status:'draft'|'finalized'|'cancelled';createdAt:string;lines:{expected:number;counted:number|null}[]};
type InventoryDifference={delta:number;shortage:number;surplus:number;discrepantLines:number};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const monthPattern=/^\d{4}-(0[1-9]|1[0-2])$/;
const monthFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'});
export const currentPartnerMonth=()=>monthFormatter.format(new Date());
function monthValue(value:string|null){const month=value||currentPartnerMonth();if(!monthPattern.test(month))fail(400,'Luna este invalidă.');return month;}
function customerFromRow(row:CustomerRow){return JSON.parse(row.data) as Client;}
function location(row:CustomerRow):PartnerLocation{const client=customerFromRow(row);return {id:row.id,name:client.name,cui:client.cui,city:client.city,county:client.county,address:client.address,warehouseIds:client.warehouseIds||[row.warehouse_id]};}
async function allActiveCustomers(){return (await db().prepare('SELECT id,warehouse_id,data FROM customers WHERE active=1').all<CustomerRow>()).results;}
function requestPayload(row:RequestRow){return JSON.parse(row.payload) as PartnerRequest;}
function summarizeInventory(record:InventoryRecord):InventoryDifference{return record.lines.reduce((summary,line)=>{const diff=(line.counted??0)-line.expected;if(diff<0)summary.shortage+=-diff;else if(diff>0)summary.surplus+=diff;if(diff!==0)summary.discrepantLines++;summary.delta+=diff;return summary;},{delta:0,shortage:0,surplus:0,discrepantLines:0});}

export async function partnerLocations(cui:string){const key=normalizeCui(cui);if(!key)return [];const rows=await allActiveCustomers();return rows.filter(row=>normalizeCui(customerFromRow(row).cui)===key).map(location);}
async function decorate(rows:RequestRow[]){const keys=new Set(rows.map(row=>row.cui_key)),customers=await allActiveCustomers();const byKey=new Map<string,PartnerLocation[]>();for(const row of customers){const item=location(row),key=normalizeCui(item.cui);if(!keys.has(key))continue;byKey.set(key,[...(byKey.get(key)||[]),item]);}return rows.map(row=>{const partner=requestPayload(row);return {...partner,id:row.id,agentId:row.agent_id,agentName:row.agent_name||'',warehouseId:row.warehouse_id,warehouseName:row.warehouse_name||'',status:row.status==='confirmed'?'confirmed':'requested',createdAt:row.created_at,updatedAt:row.updated_at,confirmedAt:row.confirmed_at,confirmedBy:row.confirmed_by,customerId:row.customer_id,revision:Number(row.revision),existingLocations:byKey.get(row.cui_key)||[]} satisfies PartnerRequestRecord;});}

export async function savePartnerRequest(user:User,requestId:unknown,revisionInput:unknown,partner:PartnerRequest){
  if(user.role!=='agent'||!user.warehouseId)fail(403,'Cererea de partener nou se salvează din contul agentului.');
  let id=textField(requestId,80);if(!id)id=crypto.randomUUID();if(!uuid.test(id))fail(400,'Identificatorul cererii este invalid.');
  const existing=await db().prepare('SELECT * FROM partner_requests WHERE id=?').bind(id).first<RequestRow>();
  let created=false;
  const now=new Date().toISOString(),payload=JSON.stringify(partner),cuiKey=normalizeCui(partner.cui);if(!cuiKey)fail(400,'CUI/CIF invalid.');
  if(existing){
    if(existing.agent_id!==user.id)fail(409,'Identificatorul cererii este deja folosit.');
    if(existing.status==='confirmed')fail(409,'Cererea a fost deja confirmată. Pornește o cerere nouă.');
    const expected=Number(revisionInput);
    if(existing.payload===payload&&existing.cui_key===cuiKey&&existing.warehouse_id===user.warehouseId)return (await decorate([existing]))[0];
    if(!Number.isSafeInteger(expected)||expected!==Number(existing.revision))fail(409,'Cererea s-a modificat în altă fereastră. Păstrează datele curente și reîncarcă istoricul.');
    const result=await db().prepare("UPDATE partner_requests SET warehouse_id=?,cui_key=?,payload=?,updated_at=?,revision=revision+1 WHERE id=? AND agent_id=? AND status='requested' AND revision=?").bind(user.warehouseId,cuiKey,payload,now,id,user.id,expected).run();
    if(!result.meta.changes)fail(409,'Cererea s-a modificat în altă fereastră. Păstrează datele curente și reîncarcă istoricul.');
  } else {await db().prepare("INSERT INTO partner_requests(id,agent_id,warehouse_id,cui_key,status,payload,created_at,updated_at,revision) VALUES (?,?,?,?,'requested',?,?,?,1)").bind(id,user.id,user.warehouseId,cuiKey,payload,now,now).run();created=true;}
  const row=await db().prepare("SELECT pr.*,u.name agent_name,COALESCE(u.warehouse_name,'') warehouse_name FROM partner_requests pr JOIN users u ON u.id=pr.agent_id WHERE pr.id=?").bind(id).first<RequestRow>();
  if(created)void sendPartnerRequestPush(user,id,partner);
  return (await decorate([row!]))[0];
}

export async function getPartnerRequest(user:User,id:string){
  if(!uuid.test(id))fail(400,'Identificatorul cererii este invalid.');
  const select="SELECT pr.*,u.name agent_name,COALESCE(u.warehouse_name,'') warehouse_name FROM partner_requests pr JOIN users u ON u.id=pr.agent_id WHERE pr.id=?";
  const row=await db().prepare(select).bind(id).first<RequestRow>();
  if(!row)fail(404,'Cererea nu a fost găsită.');
  if(user.role==='agent'){if(row.agent_id!==user.id)fail(404,'Cererea nu a fost găsită.');}
  else await requireAgentAccess(user,row.agent_id);
  return (await decorate([row]))[0];
}

export async function listPartnerRequests(user:User,monthInput:string|null){
  const month=monthValue(monthInput),{start,end}=bucharestMonthUtcRange(month),select="SELECT pr.*,u.name agent_name,COALESCE(u.warehouse_name,'') warehouse_name FROM partner_requests pr JOIN users u ON u.id=pr.agent_id";
  let rows:RequestRow[];
  if(user.role==='agent')rows=(await db().prepare(select+' WHERE pr.agent_id=? AND pr.created_at>=? AND pr.created_at<? ORDER BY pr.created_at DESC').bind(user.id,start,end).all<RequestRow>()).results;
  else if(isGlobalManager(user))rows=(await db().prepare(select+' WHERE pr.created_at>=? AND pr.created_at<? ORDER BY pr.created_at DESC').bind(start,end).all<RequestRow>()).results;
  else rows=(await db().prepare(select+' WHERE pr.created_at>=? AND pr.created_at<? AND EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=pr.agent_id) ORDER BY pr.created_at DESC').bind(start,end,user.id).all<RequestRow>()).results;
  return {month,requests:await decorate(rows)};
}

export async function confirmPartnerRequest(user:User,id:string,revision:unknown,locationResolutionInput?:unknown){
  requireManager(user);if(!uuid.test(id))fail(400,'Identificatorul cererii este invalid.');
  const row=await db().prepare('SELECT * FROM partner_requests WHERE id=?').bind(id).first<RequestRow>();if(!row)fail(404,'Cererea nu a fost găsită.');await requireAgentAccess(user,row.agent_id);
  if(row.status==='confirmed'){const full=await db().prepare("SELECT pr.*,u.name agent_name,COALESCE(u.warehouse_name,'') warehouse_name FROM partner_requests pr JOIN users u ON u.id=pr.agent_id WHERE pr.id=?").bind(id).first<RequestRow>();return (await decorate([full!]))[0];}
  const expected=Number(revision);if(!Number.isSafeInteger(expected)||expected!==Number(row.revision))fail(409,'Cererea s-a modificat. Actualizează lista.');
  const partner=requestPayload(row),customers=await allActiveCustomers(),sameFirm=customers.filter(item=>normalizeCui(customerFromRow(item).cui)===row.cui_key);
  const wantedPoint=partnerPointKey(partner.location,partner.county,partner.address),wantedLegacy=partnerLegacyPointKey(partner.location,partner.address),locationResolution=textField(locationResolutionInput,100);
  const exact=sameFirm.filter(item=>{const client=customerFromRow(item);return partnerPointKey(client.city,client.county,client.address)===wantedPoint;});
  const incompleteLegacy=sameFirm.filter(item=>{const client=customerFromRow(item);return !hasPartnerCounty(client.county)&&partnerLegacyPointKey(client.city,client.address)===wantedLegacy;});
  let samePoint:CustomerRow|undefined;
  if(exact.length===1)samePoint=exact[0];
  else if(exact.length>1){samePoint=exact.find(item=>item.id===locationResolution);if(!samePoint)fail(409,'Există mai multe puncte identice în datele vechi. Alege explicit punctul care trebuie asociat.');}
  else if(incompleteLegacy.length){if(locationResolution==='new')samePoint=undefined;else {samePoint=incompleteLegacy.find(item=>item.id===locationResolution);if(!samePoint)fail(409,'Punctul existent are județul incomplet. Alege explicit punctul existent sau creează unul nou.');}}
  else if(locationResolution&&locationResolution!=='new')fail(409,'Alegerea punctului de lucru nu mai este valabilă. Actualizează lista.');
  const customerId=samePoint?.id||`partner-${id}`,now=new Date().toISOString();
  let customerStatement;
  if(samePoint)customerStatement=db().prepare("UPDATE customers SET data=json_set(data,'$.warehouseIds',json_insert(COALESCE(json_extract(data,'$.warehouseIds'),json_array(warehouse_id)),'$[#]',?)) WHERE id=? AND active=1 AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.warehouseIds'),json_array(warehouse_id))) WHERE value=?) AND EXISTS (SELECT 1 FROM partner_requests WHERE id=? AND status='requested' AND revision=?)").bind(row.warehouse_id,customerId,row.warehouse_id,id,expected);
  else {const client:Client={id:customerId,warehouseId:row.warehouse_id,warehouseIds:[row.warehouse_id],name:partner.company,cui:partner.cui,city:partner.location,county:partner.county,address:partner.address,route:''};customerStatement=db().prepare("INSERT INTO customers(id,warehouse_id,data,active) SELECT ?,?,?,1 WHERE EXISTS (SELECT 1 FROM partner_requests WHERE id=? AND status='requested' AND revision=?)").bind(customerId,row.warehouse_id,JSON.stringify(client),id,expected);}
  const results=await db().batch([customerStatement,db().prepare("UPDATE partner_requests SET status='confirmed',confirmed_at=?,confirmed_by=?,customer_id=?,updated_at=?,revision=revision+1 WHERE id=? AND status='requested' AND revision=? AND EXISTS (SELECT 1 FROM customers WHERE id=? AND active=1)").bind(now,user.id,customerId,now,id,expected,customerId)]);
  if(!results[1]?.meta.changes)fail(409,'Cererea s-a modificat sau clientul nu a putut fi asociat. Actualizează lista.');
  const full=await db().prepare("SELECT pr.*,u.name agent_name,COALESCE(u.warehouse_name,'') warehouse_name FROM partner_requests pr JOIN users u ON u.id=pr.agent_id WHERE pr.id=?").bind(id).first<RequestRow>();return (await decorate([full!]))[0];
}

export async function teamActivity(user:User,monthInput:string|null):Promise<TeamActivityView>{
  requireManager(user);
  const month=monthValue(monthInput),agentSelect="SELECT u.id,u.name,u.active,COALESCE(u.warehouse_name,'') warehouse_name,(SELECT COUNT(*) FROM customers c WHERE c.active=1 AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) WHERE value=u.warehouse_id)) client_count FROM users u WHERE u.role='agent'";
  const agentRows=isGlobalManager(user)?(await db().prepare(agentSelect+' ORDER BY u.name').all<{id:string;name:string;active:number;warehouse_name:string;client_count:number}>()).results:(await db().prepare(agentSelect+' AND EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=u.id) ORDER BY u.name').bind(user.id).all<{id:string;name:string;active:number;warehouse_name:string;client_count:number}>()).results;
  const agentIds=new Set(agentRows.map(agent=>agent.id));
  const partnerView=await listPartnerRequests(user,month);
  const inventoryRows=(await db().prepare("SELECT value FROM settings WHERE key LIKE 'inventory-v1:%'").all<{value:string}>()).results;
  const inventories:InventoryRecord[]=[];
  for(const item of inventoryRows){try{const record=JSON.parse(item.value) as InventoryRecord;if(agentIds.has(record.createdBy)&&bucharestMonthKey(record.createdAt)===month&&record.status!=='cancelled')inventories.push(record);}catch{}}
  const agents:TeamActivityAgent[]=agentRows.map(agent=>{
    const requests=partnerView.requests.filter(item=>item.agentId===agent.id);
    const own=inventories.filter(item=>item.createdBy===agent.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const finalized=own.filter(item=>item.status==='finalized');
    const summary=finalized.reduce((total,item)=>{const current=summarizeInventory(item);total.shortage+=current.shortage;total.surplus+=current.surplus;total.discrepantLines+=current.discrepantLines;total.delta+=current.delta;return total;},{delta:0,shortage:0,surplus:0,discrepantLines:0});
    const latest=own[0],latestSummary=latest?.status==='finalized'?summarizeInventory(latest):null;
    return {agentId:agent.id,agentName:agent.name,warehouseName:agent.warehouse_name,active:Boolean(agent.active),clientCount:Number(agent.client_count),partnerRequests:requests.length,partnerConfirmed:requests.filter(item=>item.status==='confirmed').length,inventories:own.length,finalizedInventories:finalized.length,inventoryDelta:summary.delta,inventoryShortage:summary.shortage,inventorySurplus:summary.surplus,inventoryDiscrepantLines:summary.discrepantLines,latestInventory:latest?{id:latest.id,createdAt:latest.createdAt,status:latest.status==='finalized'?'finalized':'draft',scopeLabel:latest.scopeLabel,delta:latestSummary?.delta??null,shortage:latestSummary?.shortage??null,surplus:latestSummary?.surplus??null,discrepantLines:latestSummary?.discrepantLines??null}:null};
  });
  return {month,agents,totals:{partnerRequests:partnerView.requests.length,partnerConfirmed:partnerView.requests.filter(item=>item.status==='confirmed').length,activeAgents:agents.filter(item=>item.active).length,agentsWithInventory:agents.filter(item=>item.inventories>0).length,finalizedInventories:agents.reduce((sum,item)=>sum+item.finalizedInventories,0),inventoryDelta:agents.reduce((sum,item)=>sum+item.inventoryDelta,0),inventoryShortage:agents.reduce((sum,item)=>sum+item.inventoryShortage,0),inventorySurplus:agents.reduce((sum,item)=>sum+item.inventorySurplus,0),inventoryDiscrepantLines:agents.reduce((sum,item)=>sum+item.inventoryDiscrepantLines,0)},partnerRequests:partnerView.requests};
}
