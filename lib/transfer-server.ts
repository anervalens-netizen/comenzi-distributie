import {db,fail,jsonBody,textField,response,userView,requireAgentAccess,settings,settingsForOrder,requireGlobalManager} from './server';
import {readCatalog} from './catalog';
import {stockForWarehouse} from './stock-server';
import {emlFor} from './exports';
import {transferExport,transferMail} from './transfer-export';
import {transferCategory,serializedCategory,validTransferSerial} from './transfer-types';
import type {Transfer,TransferTarget,TransferLine,TransferView} from './transfer-types';
import type {User} from './types';

const prefix='transfer-v1:';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
async function targets():Promise<TransferTarget[]> {
  const rows=await db().prepare("SELECT * FROM users WHERE role='agent' AND active=1 AND warehouse_id IS NOT NULL ORDER BY name,id").all<Record<string,unknown>>();
  return rows.results.map(userView).filter(user=>user.warehouseName).map(user=>({agentId:user.id,agentName:user.name,warehouseId:user.warehouseId!,warehouseName:user.warehouseName!}));
}
async function access(record:Transfer,user:User,write=false){
  if(user.role==='agent'&&(record.source.agentId!==user.id||record.source.warehouseId!==user.warehouseId))fail(404,'Transferul nu a fost găsit.');
  if(write&&user.role!=='manager')await requireAgentAccess(user,record.source.agentId);
}
async function view(record:Transfer,user:User):Promise<TransferView>{const writable=user.role==='manager'||user.id===record.source.agentId&&record.source.warehouseId===user.warehouseId;return {...record,canEdit:writable&&record.status==='draft',canDelete:writable&&record.status==='draft'};}
async function get(id:string,user:User,write=false){
  if(!uuid(id))fail(400,'Identificator de transfer invalid.');
  const row=await db().prepare('SELECT value FROM settings WHERE key=?').bind(prefix+id).first<{value:string}>();
  if(!row)fail(404,'Transferul nu a fost găsit.');
  const record=JSON.parse(row.value) as Transfer;await access(record,user,write);return {record,raw:row.value};
}
async function config(){const row=await db().prepare("SELECT value FROM settings WHERE key='transfer-mail-v1'").first<{value:string}>();return row?textField(JSON.parse(row.value).to,254):(await settings()).standsEmail;}
const email=(value:string)=>/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
async function recipients(record:Transfer){
  const to=await config();if(!email(to))fail(409,'Managerul trebuie să configureze adresa distribuției pentru transferuri.');
  // Reuse the authoritative regional overrides and personal manager routes for
  // both agents, regardless of the product groups in this particular transfer.
  const configs=await Promise.all([settingsForOrder({userId:record.source.agentId}),settingsForOrder({userId:record.destination!.agentId})]);
  const managers=await db().prepare("SELECT DISTINCT s.value FROM manager_agents ma JOIN users m ON m.id=ma.manager_id AND m.role='manager' AND m.active=1 LEFT JOIN settings s ON s.key='manager-mail:'||m.id WHERE ma.agent_id IN (?,?)").bind(record.source.agentId,record.destination!.agentId).all<{value:string|null}>();
  const personal=managers.results.flatMap(row=>{if(!row.value)return [];const value=JSON.parse(row.value);return [value.stands||value.accessories||value.sim||value.partner||''];});
  const cc=[...new Map([...configs.flatMap(cfg=>cfg.standsCc),...personal].filter(address=>typeof address==='string'&&email(address)&&address.toLowerCase()!==to.toLowerCase()).map(address=>[address.toLowerCase(),address])).values()];
  return {to,cc};
}
async function payload(body:Record<string,unknown>,record:Transfer,finalizing:boolean){
  const available=await targets();
  const source=available.find(target=>target.agentId===record.source.agentId&&target.warehouseId===record.source.warehouseId);
  if(!source)fail(409,'Agentul sau gestiunea sursă s-a modificat. Creează un transfer nou.');
  const destinationId=textField(body.destinationAgentId,100);
  const destination=destinationId?available.find(target=>target.agentId===destinationId):null;
  if(destinationId&&!destination)fail(400,'Alege un agent destinatar activ.');
  if(destination?.warehouseId===source.warehouseId)fail(400,'Selectează o altă gestiune decât cea sursă.');
  if(finalizing&&!destination)fail(400,'Alege gestiunea destinație.');
  if(!Array.isArray(body.lines)||body.lines.length>600)fail(400,'Lista de produse este invalidă (maximum 600).');
  const catalog=(await readCatalog()).products,seen=new Set<string>(),serials=new Set<string>();
  const lines:TransferLine[]=body.lines.map(raw=>{
    if(!raw||typeof raw!=='object')fail(400,'Produs invalid.');
    const item=raw as Record<string,unknown>,product=catalog.find(product=>product.id===item.id);
    if(!product||seen.has(product.id))fail(400,'Produs necunoscut sau duplicat.');
    seen.add(product.id);const category=transferCategory(product);if(!category)fail(400,'Categoria produsului nu permite transferul.');
    if(typeof item.quantity!=='number'||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>9999)fail(400,'Cantitatea trebuie să fie între 1 și 9999.');
    if(!Array.isArray(item.serials)||item.serials.length>1000)fail(400,'Lista de serii este invalidă (maximum 1.000 pe produs).');
    const values=item.serials.map(value=>{
      if(typeof value!=='string')fail(400,'Seria trebuie transmisă ca text.');
      const serial=value.replace(/\s/g,'');
      if(!validTransferSerial(category,serial))fail(400,category==='phones'?'IMEI1 trebuie să aibă 15 cifre.':'Seria SIM trebuie să aibă 18–22 de cifre.');
      if(serials.has(serial))fail(400,'Aceeași serie apare de două ori în transfer.');serials.add(serial);return serial;
    });
    if(!serializedCategory(category)&&values.length)fail(400,'Accesoriile și standurile nu au serii.');
    if(finalizing&&serializedCategory(category)&&values.length!==item.quantity)fail(400,'Scanează câte o serie pentru fiecare telefon sau SIM.');
    return {id:product.id,code:product.code,name:product.name,category,quantity:item.quantity,serials:values};
  });
  if(finalizing&&!lines.length)fail(400,'Adaugă cel puțin un produs.');
  return {...record,source,destination:destination||null,lines,notes:textField(body.notes,2000),updatedAt:new Date().toISOString(),revision:record.revision+1};
}
export async function transfers(req:Request,user:User,path:string[]){
  const [,id,action]=path;
  if(id==='config'){
    requireGlobalManager(user);
    if(req.method==='GET')return response({to:await config()});
    if(req.method==='PUT'){const body=await jsonBody(req),to=textField(body.to,254);if(!email(to))fail(400,'Adresă de e-mail invalidă.');await db().prepare("INSERT INTO settings(key,value) VALUES('transfer-mail-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({to})).run();return response({to});}
    fail(405,'Metodă nepermisă.');
  }
  if(!id&&req.method==='GET'){
    const params=new URL(req.url).searchParams,offset=Number(params.get('offset')||0);
    if(!Number.isSafeInteger(offset)||offset<0)fail(400,'Pagină invalidă.');
    const requested=textField(params.get('agentId'),100);
    const owner=user.role==='agent'?user.id:requested;
    const rows=await db().prepare("SELECT value FROM settings WHERE key LIKE 'transfer-v1:%' AND (?='' OR json_extract(value,'$.source.agentId')=?) ORDER BY json_extract(value,'$.createdAt') DESC,key DESC LIMIT 41 OFFSET ?").bind(owner,owner,offset).all<{value:string}>();
    const available=await targets();
    return response({transfers:await Promise.all(rows.results.slice(0,40).map(row=>view(JSON.parse(row.value),user))),hasMore:rows.results.length>40,nextOffset:offset+40,targets:available,sources:available.filter(target=>user.role==='manager'||target.agentId===user.id)});
  }
  if(!id&&req.method==='POST'){
    const body=await jsonBody(req);if(!uuid(body.id))fail(400,'Identificator de transfer invalid.');
    const agentId=user.role==='agent'?user.id:textField(body.sourceAgentId,100);if(user.role!=='manager')await requireAgentAccess(user,agentId);
    const source=(await targets()).find(target=>target.agentId===agentId);if(!source)fail(400,'Alege agentul expeditor activ.');
    const existing=await db().prepare('SELECT value FROM settings WHERE key=?').bind(prefix+body.id).first<{value:string}>();
    if(existing){const record=JSON.parse(existing.value) as Transfer;await access(record,user,true);if(record.source.agentId!==agentId||record.createdBy!==user.id)fail(409,'Identificator folosit pentru alt transfer.');return response({transfer:await view(record,user)});}
    const now=new Date().toISOString();
    const record:Transfer={id:body.id,number:`TRF-${now.slice(0,10).replace(/-/g,'')}-${body.id.slice(0,8).toUpperCase()}`,source,destination:null,createdBy:user.id,createdAt:now,updatedAt:now,finalizedAt:null,status:'draft',revision:1,lines:[],notes:''};
    const result=await db().prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').bind(prefix+record.id,JSON.stringify(record)).run();if(!result.meta.changes)fail(409,'Transferul a fost creat între timp. Reîncarcă lista.');
    return response({transfer:await view(record,user)});
  }
  if(!id)fail(405,'Metodă nepermisă.');
  const write=req.method!=='GET',{record,raw}=await get(id,user,write);
  if(req.method==='GET'){
    if(action==='stock')return response(await stockForWarehouse(record.source.warehouseId));
    if(!action)return response({transfer:await view(record,user)});
    if(record.status!=='finalized')fail(409,'Finalizează solicitarea înainte de export.');
    if(action==='mail')return response({mail:record.mail});
    if(action==='excel'||action==='eml'){
      const bytes=transferExport(record),mail=record.mail!;
      return new Response(action==='eml'?emlFor(mail,bytes):bytes as BodyInit,{headers:{'Content-Type':action==='eml'?'message/rfc822':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${action==='eml'?mail.filename.replace(/\.xlsx$/,'.eml'):mail.filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    fail(404,'Resursă necunoscută.');
  }
  if(req.method==='DELETE'&&!action){
    const body=await jsonBody(req);if(record.status!=='draft')fail(409,'Solicitările finalizate rămân în istoric.');if(body.revision!==record.revision)fail(409,'Ciorna s-a modificat. Reîncarcă transferul.');
    const result=await db().prepare('DELETE FROM settings WHERE key=? AND value=?').bind(prefix+id,raw).run();if(!result.meta.changes)fail(409,'Ciorna s-a modificat. Reîncarcă transferul.');return response({ok:true});
  }
  if((req.method==='PUT'&&!action)||(req.method==='POST'&&action==='finalize')){
    if(record.status==='finalized'){if(action==='finalize')return response({transfer:await view(record,user)});fail(409,'Transferul este finalizat.');}
    const body=await jsonBody(req);if(body.revision!==record.revision)fail(409,'Ciorna a fost modificată în altă sesiune. Redeschide transferul.');
    const next=await payload(body,record,action==='finalize');
    if(action==='finalize'){next.status='finalized';next.finalizedAt=next.updatedAt;const {to,cc}=await recipients(next);next.mail=transferMail(next,to,cc);}
    const result=await db().prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(JSON.stringify(next),prefix+id,raw).run();if(!result.meta.changes)fail(409,'Ciorna s-a modificat. Reîncarcă transferul.');
    return response({transfer:await view(next,user)});
  }
  fail(405,'Metodă nepermisă.');
}
