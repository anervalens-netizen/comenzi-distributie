import {mergeStockRows,stockImpact} from './stock-impact';
import { db, fail, readLimited, requireManager, requireWarehouseAccess, response, userView } from './server';
import { readCatalog } from './catalog';
import { STOCK_FILE_LIMIT, stockHash, stockWarehouseName } from './stock-file';
import { parseStockFileRuntime } from './stock-parser-runtime';
import { stockCode, type StockView, type StockCoverageDecision, type StockCoverage, type StockPreview } from './stock-types';
import type { User } from './types';

const stateKey='agent-stock-v1';
type State={warehouses:Record<string,Omit<StockView,'depot'|'depotImportedAt'|'depotCoverage'|'depotObservedAt'>>;depot?:Record<string,number|null>;depotImportedAt?:string;depotCoverage?:StockCoverage;depotObservedAt?:Record<string,string|null>;recovery?:{savedAt:string;userId:string;previous:Omit<State,'recovery'>};mappings:Record<string,string|null>;history:{importedAt:string;filename:string;userId:string;fileHash:string;warehouses:number;rows:number;decision?:StockCoverageDecision;confirmation?:string}[]};
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
  return {...view,rows,depot:state.depot||{},depotImportedAt:state.depotCoverage?state.depotCoverage.fullSnapshotAt:state.depotImportedAt||null,depotCoverage:state.depotCoverage,depotObservedAt:state.depotObservedAt};
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
  const suggested=groups.map(group=>{
    const remembered=state.mappings[group.key],exact=available.filter(t=>t.names.includes(stockWarehouseName(group.name)));
    const bySite=groups.filter(g=>g.siteId===group.siteId).length===1?available.filter(t=>t.siteIds.includes(group.siteId)):[];
    const candidate=remembered&&available.some(t=>t.id===remembered)?remembered:exact.length===1?exact[0].id:exact.length===0&&bySite.length===1?bySite[0].id:null;
    return {key:group.key,name:group.name,siteId:group.siteId,rowCount:group.rows.length,quantity:group.rows.reduce((sum,r)=>sum+r.quantity,0),warehouseId:candidate};
  });
  const candidates=suggested.map(g=>g.warehouseId);
  for(const g of suggested)if(g.warehouseId&&candidates.filter(id=>id===g.warehouseId).length>1)g.warehouseId=null;
  let mappings:Record<string,string|null>,decision:StockCoverageDecision;
  try{
    mappings=JSON.parse(req.headers.get('X-Stock-Mappings')||JSON.stringify(Object.fromEntries(suggested.map(g=>[g.key,g.warehouseId]))));
    decision=JSON.parse(req.headers.get('X-Stock-Coverage')||'{"warehouses":"partial","depot":"partial"}');
  }catch{fail(400,'Asocierile sau acoperirea sunt invalide.');}
  if(!mappings||typeof mappings!=='object'||Array.isArray(mappings)||Object.keys(mappings).length!==groups.length||groups.some(g=>!Object.hasOwn(mappings,g.key)))fail(400,'Verifică asocierea fiecărei gestiuni din fișier.');
  if(!decision||Object.keys(decision).sort().join(',')!=='depot,warehouses'||!['full','partial'].includes(decision.warehouses)||!['full','partial'].includes(decision.depot))fail(400,'Declară separat acoperirea gestiunilor și a depozitului.');
  const selected=new Set<string>();
  for(const group of groups){
    const target=mappings[group.key];
    if(target===null||target===''){mappings[group.key]=null;continue;}
    if(typeof target!=='string'||!available.some(t=>t.id===target))fail(400,'Una dintre gestiunile selectate nu are un agent activ.');
    if(selected.has(target))fail(400,'Asociază o singură gestiune din fișier fiecărei gestiuni din aplicație.');
    selected.add(target);
  }
  const impact=stockImpact(state,groups,mappings,decision);
  const confirmation=stockHash(JSON.stringify(['stock-coverage-v1',user.id,version,fileHash,groups.map(g=>[g.key,mappings[g.key]]),decision.warehouses,decision.depot,impact]));
  if(!apply){
    const productCodes=new Set(currentCatalog.products.map(p=>stockCode(p.code))),allRows=groups.flatMap(g=>g.rows);
    const preview:StockPreview={version,fileHash,filename,decision,confirmation,impact,rowCount:allRows.length,matchedRows:allRows.filter(r=>productCodes.has(r.code)).length,unknownProducts:new Set(allRows.filter(r=>!productCodes.has(r.code)).map(r=>r.code)).size,targets:available.map(({id,name})=>({id,name})),groups:suggested.map(g=>({...g,warehouseId:mappings[g.key]}))};
    return response(preview);
  }
  if(req.headers.get('X-Stock-Version')!==version)fail(409,'Stocul sau agenții au fost modificați. Reîncarcă previzualizarea înainte de import.');
  if(req.headers.get('X-Stock-Hash')!==fileHash)fail(409,'Fișierul diferă de previzualizare. Reîncarcă previzualizarea.');
  if(!req.headers.has('X-Stock-Coverage')||!req.headers.has('X-Stock-Mappings')||req.headers.get('X-Stock-Confirmation')!==confirmation)fail(409,'Confirmă impactul și acoperirea din previzualizarea actuală.');
  if(!selected.size)fail(400,'Selectează cel puțin o gestiune pentru import.');
  const importedAt=new Date().toISOString();let rowCount=0;
  // Bounded recovery copy is committed in the same CAS as stock, with no recursive copies.
  const {recovery:_priorRecovery,...previous}=structuredClone(state);
  state.recovery={savedAt:importedAt,userId:user.id,previous};
  for(const group of groups){
    const target=mappings[group.key];state.mappings[group.key]=target;
    if(!target)continue;
    rowCount+=group.rows.length;
    const old=state.warehouses[target],fullSnapshotAt=decision.warehouses==='full'?importedAt:old?.coverage?.fullSnapshotAt??null;
    const before=(old?.rows||[]).map(r=>({...r,observedAt:r.observedAt??old?.importedAt??undefined}));
    state.warehouses[target]={warehouseId:target,importedAt,filename,coverage:{mode:decision.warehouses,updatedAt:importedAt,fullSnapshotAt},rows:mergeStockRows(before,group.rows.map(({code,name,quantity})=>({code,name,quantity,observedAt:importedAt})),decision.warehouses)};
  }
  // A partial export patches only present products. Its timestamp never declares full coverage.
  const depotRows=Object.fromEntries(groups.flatMap(group=>group.rows.map(row=>[row.code,row.depotQuantity])));
  const depotDates=Object.fromEntries(Object.keys(state.depot||{}).map(code=>[code,state.depotObservedAt?.[code]??state.depotImportedAt??null]));
  state.depot=decision.depot==='full'?depotRows:{...state.depot,...depotRows};
  state.depotObservedAt={...(decision.depot==='partial'?depotDates:{}),...Object.fromEntries(Object.keys(depotRows).map(code=>[code,importedAt]))};
  if(decision.depot==='full')state.depotImportedAt=importedAt;
  state.depotCoverage={mode:decision.depot,updatedAt:importedAt,fullSnapshotAt:decision.depot==='full'?importedAt:state.depotCoverage?.fullSnapshotAt??null};
  state.history=[{importedAt,filename,userId:user.id,fileHash,warehouses:selected.size,rows:rowCount,decision,confirmation},...state.history].slice(0,30);
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
