import {db,fail,jsonBody,requireWarehouseAccess,response,sha256,textField} from './server';
import {stockForWarehouse} from './stock-server';
import {validEan} from './barcodes';
import {readCatalog} from './catalog';
import {stockCode} from './stock-types';
import type {User} from './types';
import type {Inventory,InventorySummary,InventoryScope} from './inventory-types';

type RecordData=Omit<Inventory,'canEdit'>&{operations:{id:string;hash:string}[]};
const prefix='inventory-v1:';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
async function warehouse(user:User,requested:unknown) {
  const id=textField(requested,100)||user.warehouseId;
  if(!id)fail(400,'Selectează gestiunea pentru inventar.');
  if(user.role==='agent'&&id!==user.warehouseId)fail(403,'Poți inventaria doar gestiunea ta.');
  await requireWarehouseAccess(user,id);
  if(!await db().prepare("SELECT id FROM users WHERE warehouse_id=? AND role='agent' AND active=1 LIMIT 1").bind(id).first())fail(400,'Gestiunea nu are un agent activ.');
  return id;
}
function visible(record:RecordData,user:User) {
  if(user.role!=='manager'&&(record.createdBy!==user.id||record.warehouseId!==user.warehouseId))fail(404,'Inventarul nu a fost găsit.');
}
function view(record:RecordData,user:User):Inventory {
  const {operations:_,...publicRecord}=record;
  return {...publicRecord,canEdit:record.status==='draft'&&(user.role==='manager'||record.createdBy===user.id)};
}
async function get(id:string,user:User) {
  if(!uuid(id))fail(400,'Identificator de inventar invalid.');
  const row=await db().prepare('SELECT value FROM settings WHERE key=?').bind(prefix+id).first<{value:string}>();
  if(!row)fail(404,'Inventarul nu a fost găsit.');
  const record=JSON.parse(row.value) as RecordData;
  await requireWarehouseAccess(user,record.warehouseId);
  visible(record,user);
  const catalog=await readCatalog();
  const eans=new Map(catalog.products.map(product=>[stockCode(product.code),product.ean||'']));
  record.lines=record.lines.map(line=>({...line,ean:line.ean||eans.get(stockCode(line.code))||''}));
  return {record,raw:row.value};
}
export async function inventories(req:Request,user:User,id?:string) {
  if(req.method==='DELETE'&&id) {
    const body=await jsonBody(req),{record,raw}=await get(id,user);
    if(body.revision!==record.revision)fail(409,'Inventarul s-a modificat între timp. Actualizează lista înainte de ștergere.');
    const result=await db().prepare('DELETE FROM settings WHERE key=? AND value=?').bind(prefix+id,raw).run();
    if(!result.meta.changes)fail(409,'Inventarul s-a modificat între timp. Actualizează lista și încearcă din nou.');
    return response({ok:true,deletedId:record.id});
  }
  if(req.method==='GET'&&id)return response({inventory:view((await get(id,user)).record,user)});
  if(req.method==='GET') {
    const query=new URL(req.url).searchParams;
    const warehouseId=await warehouse(user,query.get('warehouseId'));
    const requestedLimit=Number(query.get('limit')||50),requestedOffset=Number(query.get('offset')||0);
    const limit=Number.isSafeInteger(requestedLimit)&&requestedLimit>0?Math.min(requestedLimit,100):50;
    const offset=Number.isSafeInteger(requestedOffset)&&requestedOffset>=0?requestedOffset:0;
    const rows=await db().prepare("SELECT value FROM settings WHERE key LIKE 'inventory-v1:%' AND json_extract(value,'$.warehouseId')=? AND (?='manager' OR json_extract(value,'$.createdBy')=?) ORDER BY json_extract(value,'$.createdAt') DESC, json_extract(value,'$.id') DESC LIMIT ? OFFSET ?").bind(warehouseId,user.role,user.id,limit+1,offset).all<{value:string}>();
    const hasMore=rows.results.length>limit;
    const summaries:InventorySummary[]=rows.results.slice(0,limit).map(row=>{const record=JSON.parse(row.value) as RecordData;const {lines,...rest}=view(record,user);return {...rest,totalCodes:lines.length,checkedCodes:lines.filter(l=>l.counted!==null).length,expectedTotal:lines.reduce((s,l)=>s+l.expected,0),countedTotal:lines.reduce((s,l)=>s+(l.counted??0),0)};});
    return response({inventories:summaries,hasMore,nextOffset:offset+summaries.length});
  }
  if(req.method==='POST'&&!id) {
    const body=await jsonBody(req);if(!uuid(body.id))fail(400,'Identificator de inventar invalid.');
    const warehouseId=await warehouse(user,body.warehouseId);
    const scope=body.scope as InventoryScope;if(!['all','category','product'].includes(scope))fail(400,'Alege cod, categorie sau inventar total.');
    const selection=textField(body.value,500);
    const existing=await db().prepare('SELECT value FROM settings WHERE key=?').bind(prefix+body.id).first<{value:string}>();
    if(existing){const record=JSON.parse(existing.value) as RecordData;visible(record,user);if(record.createdBy!==user.id||record.warehouseId!==warehouseId||record.scope!==scope||record.scopeLabel!==(scope==='all'?'Inventar total':scope==='product'?stockCode(selection):selection))fail(409,'Identificatorul a fost folosit pentru alt inventar.');return response({inventory:view(record,user)});}
    const [stock,catalog]=await Promise.all([stockForWarehouse(warehouseId),readCatalog()]);
    if(!stock.importedAt)fail(409,'Importă stocul gestiunii înainte de a începe inventarul.');
    const eans=new Map(catalog.products.map(product=>[stockCode(product.code),product.ean||'']));
    const lines=stock.rows.filter(r=>scope==='all'||(scope==='product'?r.code===stockCode(selection):(r.category||'Necategorizate')===selection)).map(r=>({code:r.code,name:r.name,category:r.category||'Necategorizate',ean:eans.get(stockCode(r.code))||'',expected:r.quantity,counted:null}));
    if(!lines.length)fail(400,'Selecția nu conține produse din stocul importat.');
    const now=new Date().toISOString();
    const record:RecordData={id:body.id,warehouseId,createdBy:user.id,createdByName:user.name,scope,scopeLabel:scope==='all'?'Inventar total':scope==='product'?stockCode(selection):selection,status:'draft',createdAt:now,updatedAt:now,finalizedAt:null,stockImportedAt:stock.importedAt,stockFilename:stock.filename||'',revision:1,lines,operations:[]};
    const result=await db().prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').bind(prefix+record.id,JSON.stringify(record)).run();
    if(!result.meta.changes)fail(409,'Inventarul a fost creat între timp. Actualizează lista.');
    return response({inventory:view(record,user)});
  }
  if(req.method==='PATCH'&&id) {
    const body=await jsonBody(req),{record,raw}=await get(id,user);
    if(user.role!=='manager'&&record.createdBy!==user.id)fail(403,'Poți modifica doar inventarele tale.');
    if(!uuid(body.operationId))fail(400,'Identificator de salvare invalid.');
    const action=textField(body.action),ean=textField(body.ean,80),code=stockCode(textField(body.code,100)),quantity=body.quantity;
    const hash=sha256(JSON.stringify([action,ean,code,quantity??null]));
    const previous=record.operations.find(op=>op.id===body.operationId);
    if(previous){if(previous.hash!==hash)fail(409,'Identificatorul salvării a fost reutilizat cu alte date.');return response({inventory:view(record,user)});}
    if(record.status!=='draft')fail(409,'Inventarul este închis și nu mai poate fi modificat.');
    if(body.revision!==record.revision)fail(409,'Inventarul a fost modificat în altă sesiune. Reîncarcă datele înainte de a continua.');
    if(action==='scan'||action==='set') {
      const amount=quantity===undefined&&action==='scan'?1:quantity;
      if(typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<(action==='scan'?1:0)||amount>1_000_000)fail(400,'Cantitatea trebuie să fie un număr întreg valid.');
      let itemCode=code;
      if(action==='scan') {
        if(!validEan(ean))fail(422,'EAN invalid. Scanează codul de bare complet sau introdu cantitatea manual.');
        const [{mappings},catalog]=await Promise.all([barcodeState(),readCatalog()]);
        const codes=new Set(catalog.products.filter(p=>p.eans?.includes(ean)||stockCode(p.code)===ean).map(p=>stockCode(p.code)));
        if(mappings[ean]&&!catalog.products.some(p=>stockCode(p.code)===mappings[ean]))codes.add(mappings[ean]);
        if(record.lines.some(l=>l.code===ean))codes.add(ean);
        if(codes.size>1)fail(422,'EAN asociat mai multor produse. Verifică asocierea în catalog.');
        itemCode=[...codes][0]||'';
        if(!itemCode)fail(422,`EAN ${ean} nu este asociat unui ItemCode. Solicită managerului asocierea; scanarea nu a fost numărată.`);
      }
      const line=record.lines.find(l=>l.code===itemCode);
      if(!line)fail(422,'Produsul nu face parte din selecția acestui inventar. Scanarea nu a fost numărată.');
      const count=action==='scan'?(line.counted??0)+amount:amount;
      if(count>1_000_000)fail(400,'Cantitatea numărată depășește limita.');line.counted=count;
    }else if(action==='finalize') {
      if(record.lines.some(l=>l.counted===null))fail(409,'Mai sunt coduri nenumărate. Pentru produsele lipsă, introdu explicit 0.');
      record.status='finalized';record.finalizedAt=new Date().toISOString();
    }else if(action==='cancel')record.status='cancelled';
    else fail(400,'Acțiune de inventar necunoscută.');
    record.updatedAt=new Date().toISOString();record.revision++;
    record.operations=[...record.operations,{id:body.operationId,hash}].slice(-2000);
    const result=await db().prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(JSON.stringify(record),prefix+id,raw).run();
    if(!result.meta.changes)fail(409,'Numărătoarea s-a modificat între timp. Reîncarcă inventarul.');
    return response({inventory:view(record,user)});
  }
  fail(405,'Metodă nepermisă.');
}

async function barcodeState() {
  const row=await db().prepare("SELECT value FROM settings WHERE key='inventory-ean-v1'").first<{value:string}>();
  return {mappings:row?JSON.parse(row.value) as Record<string,string>:{}};
}