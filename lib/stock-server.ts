import { db, fail, readLimited, requireManager, requireWarehouseAccess, response, userView } from './server';
import { readCatalog } from './catalog';
import { STOCK_FILE_LIMIT, stockHash, stockWarehouseName } from './stock-file';
import { parseStockFileRuntime } from './stock-parser-runtime';
import { stockCode, type StockView, type StockPreview } from './stock-types';
import type { User } from './types';

const stateKey='agent-stock-v1';
type State={warehouses:Record<string,Omit<StockView,'depot'|'depotImportedAt'>>;depot?:Record<string,number|null>;depotImportedAt?:string;mappings:Record<string,string|null>;history:{importedAt:string;filename:string;userId:string;fileHash:string;warehouses:number;rows:number}[]};
async function readState() {
  const row=await db().prepare('SELECT value FROM settings WHERE key=?').bind(stateKey).first<{value:string}>();
  return {raw:row?.value??null,state:row?JSON.parse(row.value) as State:{warehouses:{},mappings:{},history:[]} as State};
}
async function targets() {
  const result=await db().prepare("SELECT * FROM users WHERE role='agent' AND active=1 ORDER BY name").all<Record<string,unknown>>();
  const users=result.results.map(userView).filter(u=>u.warehouseId);
  return [...new Set(users.map(u=>u.warehouseId!))].sort().map(id=>({id,name:users.filter(u=>u.warehouseId===id).map(u=>`${u.name} · ${u.warehouseName}`).join(' / '),names:users.filter(u=>u.warehouseId===id).map(u=>stockWarehouseName(u.warehouseName||'')),siteIds:users.filter(u=>u.warehouseId===id).map(u=>u.siteCode.trim()).filter(Boolean)}));
}
async function duplicateStockImportMessage(userId:string) {
  const row=await db().prepare('SELECT name FROM users WHERE id=?').bind(userId).first<{name:string}>();
  return `Stocurile din acest fișier au fost deja importate de ${row?.name||'un alt manager'}. Nu este nevoie să le imporți din nou.`;
}
export async function stockView(req:Request,user:User) {
  const requested=new URL(req.url).searchParams.get('warehouseId');
  if(user.role==='agent'&&requested&&requested!==user.warehouseId)fail(403,'Poți consulta doar stocul gestiunii tale.');
  const warehouseId=user.role==='agent'?user.warehouseId:requested;
  if(!warehouseId)fail(400,'Selectează gestiunea.');
  await requireWarehouseAccess(user,warehouseId);
  return response(await stockForWarehouse(warehouseId));
}
export async function stockImportStatus() {
  const latest=(await readState()).state.history[0];
  return latest?{filename:latest.filename,importedAt:latest.importedAt,rows:latest.rows,warehouses:latest.warehouses}:null;
}
export async function stockForWarehouse(warehouseId:string):Promise<StockView> {
  const [{state},catalog]=await Promise.all([readState(),readCatalog()]);
  const categories=new Map<string,Set<string>>();
  for(const product of catalog.products){const code=stockCode(product.code),names=categories.get(code)||new Set<string>();names.add(product.category.trim()||'Necategorizate');categories.set(code,names);}
  const view=state.warehouses[warehouseId]||{warehouseId,importedAt:null,filename:null,rows:[]};
  const rows=view.rows.map(row=>{const names=categories.get(stockCode(row.code));return {...row,category:names?.size===1?[...names][0]:'Necategorizate'};});
  return {...view,rows,depot:state.depot||{},depotImportedAt:state.depotImportedAt||null};
}
export async function stockUpload(req:Request,user:User,apply:boolean) {
  requireManager(user);
  if(Number(req.headers.get('content-length')||0)>STOCK_FILE_LIMIT)fail(413,'Fișierul depășește limita de 8 MB.');
  let filename='';
  try{filename=decodeURIComponent(req.headers.get('X-Stock-Filename')||'');}catch{fail(400,'Numele fișierului este invalid.');}
  if(!filename||filename.length>250||/[\\/]/.test(filename)||filename.split('').some(c=>c.charCodeAt(0)<32))fail(400,'Numele fișierului este invalid.');
  const bytes=await readLimited(req,STOCK_FILE_LIMIT);
  let groups:Awaited<ReturnType<typeof parseStockFileRuntime>>;
  try{groups=await parseStockFileRuntime(bytes,filename);}catch(error){fail(400,error instanceof Error?error.message:'Fișier Excel invalid.');}
  const [{raw,state},available,currentCatalog]=await Promise.all([readState(),targets(),readCatalog()]);
  const version=stockHash(JSON.stringify([raw,available]));
  const fileHash=stockHash(bytes);
  const latest=state.history[0];
  if(latest?.fileHash===fileHash&&latest.userId!==user.id)fail(409,await duplicateStockImportMessage(latest.userId));
  if(!apply) {
    const productCodes=new Set(currentCatalog.products.map(p=>stockCode(p.code)));
    const allRows=groups.flatMap(g=>g.rows);
    const preview:StockPreview={version,fileHash,filename,rowCount:allRows.length,matchedRows:allRows.filter(r=>productCodes.has(r.code)).length,unknownProducts:new Set(allRows.filter(r=>!productCodes.has(r.code)).map(r=>r.code)).size,targets:available.map(({id,name})=>({id,name})),groups:groups.map(group=>{
      const remembered=state.mappings[group.key];
      const exact=available.filter(t=>t.names.includes(stockWarehouseName(group.name)));
      const bySite=groups.filter(g=>g.siteId===group.siteId).length===1?available.filter(t=>t.siteIds.includes(group.siteId)):[];
      const candidate=remembered&&available.some(t=>t.id===remembered)?remembered:exact.length===1?exact[0].id:exact.length===0&&bySite.length===1?bySite[0].id:null;
      return {key:group.key,name:group.name,siteId:group.siteId,rowCount:group.rows.length,quantity:group.rows.reduce((sum,r)=>sum+r.quantity,0),warehouseId:candidate};
    })};
    // Never silently select two source groups for one warehouse.
    const candidates=preview.groups.map(g=>g.warehouseId);
    for(const group of preview.groups)if(group.warehouseId&&candidates.filter(id=>id===group.warehouseId).length>1)group.warehouseId=null;
    return response(preview);
  }
  if(req.headers.get('X-Stock-Version')!==version)fail(409,'Stocul sau agenții au fost modificați. Reîncarcă previzualizarea înainte de import.');
  if(req.headers.get('X-Stock-Hash')!==fileHash)fail(409,'Fișierul diferă de previzualizare. Reîncarcă previzualizarea.');
  let mappings:Record<string,unknown>;
  try{mappings=JSON.parse(req.headers.get('X-Stock-Mappings')||'null');}catch{fail(400,'Asocierile gestiunilor sunt invalide.');}
  if(!mappings||typeof mappings!=='object'||Array.isArray(mappings))fail(400,'Asocierile gestiunilor sunt invalide.');
  if(Object.keys(mappings).length!==groups.length||groups.some(g=>!Object.hasOwn(mappings,g.key)))fail(400,'Verifică asocierea fiecărei gestiuni din fișier.');
  const selected=new Set<string>(),importedAt=new Date().toISOString();let rowCount=0;
  for(const group of groups) {
    const target=mappings[group.key];
    if(target===null||target===''){state.mappings[group.key]=null;continue;}
    if(typeof target!=='string'||!available.some(t=>t.id===target))fail(400,'Una dintre gestiunile selectate nu are un agent activ.');
    if(selected.has(target))fail(400,'Asociază o singură gestiune din fișier fiecărei gestiuni din aplicație. Stocul de prezentare rămâne separat.');
    selected.add(target);rowCount+=group.rows.length;
    state.warehouses[target]={warehouseId:target,importedAt,filename,rows:group.rows.map(({code,name,quantity})=>({code,name,quantity}))};
    state.mappings[group.key]=target;
  }
  if(!selected.size)fail(400,'Selectează cel puțin o gestiune pentru import.');
  // Depot is one global snapshot; repeated ERP values must not be summed.
  state.depot=Object.fromEntries(groups.flatMap(group=>group.rows.map(row=>[row.code,row.depotQuantity])));
  state.depotImportedAt=importedAt;
  state.history=[{importedAt,filename,userId:user.id,fileHash,warehouses:selected.size,rows:rowCount},...state.history].slice(0,30);
  const next=JSON.stringify(state);
  // A single compare-and-swap writes every selected warehouse together.
  const result=raw===null?await db().prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').bind(stateKey,next).run():await db().prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(next,stateKey,raw).run();
  if(!result.meta.changes) {
    const latestState=(await readState()).state.history[0];
    if(latestState?.fileHash===fileHash&&latestState.userId!==user.id)fail(409,await duplicateStockImportMessage(latestState.userId));
    fail(409,'Un alt import a fost salvat între timp. Reîncarcă previzualizarea.');
  }
  return response({ok:true,warehouses:selected.size,rows:rowCount,importedAt});
}
