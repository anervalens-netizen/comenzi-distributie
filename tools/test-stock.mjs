import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,scryptSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import XLSX from 'xlsx';

// This script creates and mutates only its dedicated local QA database.
const folder=resolve('work/stock-qa-20260914');mkdirSync(folder,{recursive:true});
const root='http://127.0.0.1:3014/api/';
const headers=['Gestiune','ItemCode','ItemName','Stoc','SiteId','StocDepozit'];
const fixture=(rows,type='biff8')=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,...rows.map(r=>r.length===5?[...r,48]:r)]),'Stoc_TR');return XLSX.write(book,{type:'buffer',bookType:type});};
if(process.argv.includes('--prepare')) {
  const path=resolve(folder,'mobiup.sqlite');if(existsSync(path))throw new Error('QA database already exists; do not overwrite.');
  const db=new DatabaseSync(path);db.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));db.exec("ALTER TABLE users ADD COLUMN warehouse_name TEXT; ALTER TABLE users ADD COLUMN site_code TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'assigned'; CREATE TABLE manager_agents (manager_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(manager_id,agent_id));");
  const password=randomBytes(20).toString('base64url'),salt=randomBytes(16).toString('hex'),hash=`scrypt:${salt}:${scryptSync(password,salt,32,{N:32768,r:8,p:3,maxmem:40*1024*1024}).toString('hex')}`;
  for(const [id,role,warehouse,name,site] of [['stock-manager','manager',null,'Manager QA',''],['stock-regional','manager',null,'Manager regional QA',''],['stock-agent','agent','g-5','GESTIUNE TR Bucuresti 01 Agent Exemplu','1138'],['stock-agent2','agent','g-3','GESTIUNE TR Bacau 02','1158']])db.prepare('INSERT INTO users (id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,warehouse_name,site_code) VALUES (?,?,?,?,?,?,?,0,?,?)').run(id,id,name,role,role==='manager'?'global':'assigned',warehouse,hash,name,site);
  db.prepare("UPDATE users SET manager_scope='assigned' WHERE id='stock-regional'").run();
  db.prepare("INSERT INTO manager_agents(manager_id,agent_id) VALUES('stock-regional','stock-agent')").run();
  writeFileSync(resolve(folder,'credentials.json'),JSON.stringify({password}));db.close();console.log('Prepared isolated stock QA database.');process.exit();
}
await build({entryPoints:['lib/stock-file.ts'],outfile:resolve(folder,'parser.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'});
const {parseStockFile,stockWarehouseName}=await import(pathToFileURL(resolve(folder,'parser.mjs')));
let checks=0;const check=(condition,label)=>{assert.ok(condition,label);checks++;};
for(const [a,b] of [['GESTIUNE TR Persoana Test','TR Persoana Test'],['GESTIUNE PERSOANA EXEMPLU','TR Persoana Exemplu'],['gestiune TR București 1 Agent Exemplu','TR Bucuresti 01 Exemplu Agent'],['GESTIUNE TR Brasov 01 - Persoana Demo','TR Brasov 1 Demo Persoana']])check(stockWarehouseName(a)===stockWarehouseName(b),'Equivalent ERP warehouse labels');
check(stockWarehouseName('GESTIUNE TR Persoana Test PREZENTARE')!==stockWarehouseName('TR Persoana Test'),'Presentation stock stays separate');
check(stockWarehouseName('TR Bucuresti 01 Agent Exemplu')!==stockWarehouseName('TR Prahova 01 Persoana Fictiva'),'Different warehouses stay separate');
const base=[['GESTIUNE TR Bucuresti 01 Agent Exemplu','DEMOACC2','Produs A',12,1138],['GESTIUNE TR Bucuresti 01 Agent Exemplu','ERP-ONLY','Produs doar ERP',0,1138],['GESTIUNE TR Bacau 02','DEMOACC2','Produs A',5,1158]];
for(const type of ['biff8','xlsx'])check(parseStockFile(fixture(base,type),type==='xlsx'?'stock.xlsx':'stock.xls').length===2,`Read ${type}`);
const sparseBook=XLSX.utils.book_new(),sparseSheet=XLSX.utils.aoa_to_sheet([headers,base[0]]);
sparseSheet.XFD500={t:'s',v:'noise'};sparseSheet['!ref']='A1:XFD500';XLSX.utils.book_append_sheet(sparseBook,sparseSheet,'Stoc_TR');
const sparseBytes=XLSX.write(sparseBook,{type:'buffer',bookType:'xlsx'}),sparseStarted=performance.now();
check(parseStockFile(sparseBytes,'sparse-wide.xlsx').length===1&&performance.now()-sparseStarted<2000,'Sparse far-right Excel cells do not expand stock parser work');
check(parseStockFile(fixture(base),'stock.xls')[0].rows[1].quantity===0,'Zero preserved');
check(parseStockFile(fixture([['G','C','N',1,1,0]]),'stock.xls')[0].rows[0].depotQuantity===0,'Depot zero preserved');
check(parseStockFile(fixture([['G','C','N',1,1,'']]),'stock.xls')[0].rows[0].depotQuantity===null,'Depot blank preserved');
assert.throws(()=>parseStockFile(fixture([['G1','C','N',1,1,40],['G2','C','N',1,2,45]]),'stock.xls'));checks++;
check(parseStockFile(fixture([[...base[0].slice(0,3),-2,1138]]),'stock.xls')[0].rows[0].quantity===-2,'Negative stock preserved');
for(const rows of [[...base,base[0]],[['G','C','N','',1]],[['G','','N',1,1]],[['G','C','N','bad',1]]]){assert.throws(()=>parseStockFile(fixture(rows),'stock.xls'));checks++;}
assert.throws(()=>parseStockFile(Buffer.from('not excel'),'stock.xls'));checks++;
const realArg=process.argv.find(v=>v.startsWith('--file='));
if(realArg){const groups=parseStockFile(readFileSync(realArg.slice(7)),'stock.xls');check(groups.reduce((sum,g)=>sum+g.rows.length,0)===3992,'Actual ERP nonblank row count');check(groups.length===62,'Actual ERP distinct source groups');check(new Set(groups.map(g=>g.siteId)).size<groups.length,'Presentation groups have shared SiteId and remain distinct');check(groups.flatMap(g=>g.rows).filter(r=>r.depotQuantity===null).length===509,'Blank depot stock is unknown, not zero');}
if(!process.argv.includes('--api')){console.log(`PASS: ${checks} stock parser checks.`);process.exit();}
const {password}=JSON.parse(readFileSync(resolve(folder,'credentials.json'),'utf8'));
const qaDb=new DatabaseSync(resolve(folder,'mobiup.sqlite'));
assert(qaDb.prepare("SELECT id FROM users WHERE id='stock-manager' AND username='stock-manager'").get(),'Dedicated QA fixture required');
qaDb.prepare("DELETE FROM settings WHERE key='agent-stock-v1'").run();qaDb.close();
async function request(path,{cookie,body,headers={},method=body?'POST':'GET',status=200}={}) {
  const options={method,headers:{...(cookie?{Cookie:cookie}:{}),...headers}};if(body)options.body=body;
  const r=await fetch(root+path,options);const data=await r.json();check(r.status===status,`${path}: expected ${status}, got ${r.status}: ${JSON.stringify(data).slice(0,300)}`);return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const login=async(username)=>(await request('auth/login',{body:JSON.stringify({username,password}),headers:{'Content-Type':'application/json'}})).cookie;
const manager=await login('stock-manager'),regional=await login('stock-regional'),agent=await login('stock-agent'),agent2=await login('stock-agent2');
await request('stock',{status:401});await request('stock?warehouseId=g-3',{cookie:agent,status:403});
check((await request('stock',{cookie:agent})).data.importedAt===null,'No stock is unknown before import');
const bytes=fixture(base),uploadHeaders={'Content-Type':'application/octet-stream','X-Stock-Filename':'stock.xls'};
await request('admin/stock/preview',{cookie:agent,body:bytes,headers:uploadHeaders,status:403});
const preview=async(file=bytes,cookie=manager)=>(await request('admin/stock/preview',{cookie,body:file,headers:uploadHeaders})).data;
const p=await preview(bytes,regional);check(p.groups[0].warehouseId==='g-5'&&p.groups[1].warehouseId==='g-3','Regional manager can preview the shared stock import with exact warehouse matching');check(p.unknownProducts===1,'Non-catalogue product counted');
const mapping=Object.fromEntries(p.groups.map(g=>[g.key,g.warehouseId]));
const apply=async(p,file=bytes,mappings=mapping,status=200,cookie=manager)=>request('admin/stock/import',{cookie,body:file,status,headers:{...uploadHeaders,'X-Stock-Version':p.version,'X-Stock-Hash':p.fileHash,'X-Stock-Mappings':JSON.stringify(mappings)}});
await apply(p,bytes,mapping,403,agent);
await apply(p,bytes,Object.fromEntries(p.groups.map(g=>[g.key,'g-5'])),400);
await apply(p,bytes,{},400);
await apply({...p,fileHash:'wrong'},bytes,mapping,409);
await apply(p,bytes,mapping,200,regional);
const importStatus=(await request('admin/imports/status',{cookie:regional})).data.stock;
check(importStatus?.filename==='stock.xls'&&importStatus.rows===3&&importStatus.warehouses===2&&!!importStatus.importedAt,'Import status exposes latest successful stock file and timestamp');
const duplicateByOther=await request('admin/stock/preview',{cookie:manager,body:bytes,headers:uploadHeaders,status:409});
check(duplicateByOther.data.error.includes('Manager regional QA')&&duplicateByOther.data.error.includes('deja importate'),'Another manager gets a clear already-imported stock message');
check((await request('stock',{cookie:agent})).data.rows.length===2,'Agent gets only own two products');
check((await request('stock',{cookie:agent})).data.rows.find(r=>r.code==='DEMOACC2').category==='Încărcătoare','Category comes from catalogue');
check((await request('stock',{cookie:agent})).data.rows.find(r=>r.code==='ERP-ONLY').category==='Necategorizate','Unmatched code explicitly uncategorized');
check((await request('stock',{cookie:agent})).data.depot.DEMOACC2===48,'Depot values are global and never summed across agents');
check((await request('stock',{cookie:agent2})).data.rows[0].quantity===5,'Other agent gets own quantities');
await apply(p,bytes,mapping,409);
const changed=fixture([['GESTIUNE TR Bucuresti 01 Agent Exemplu','DEMOACC2','Produs A',3,1138]]),p2=await preview(changed);
await apply(p2,changed,{[p2.groups[0].key]:'g-5'});
const own=(await request('stock',{cookie:agent})).data;
check(own.rows.length===1&&own.rows[0].quantity===3,'Replacement removes old rows and never accumulates quantities');
check((await request('stock',{cookie:agent2})).data.rows[0].quantity===5,'Omitted warehouses retained');
const invalid=fixture([...base,base[0]]);await request('admin/stock/import',{cookie:manager,body:invalid,headers:uploadHeaders,status:400});
check((await request('stock',{cookie:agent})).data.rows[0].quantity===3,'Failed import leaves stock intact');
const conflicting=await preview();
const concurrent=()=>fetch(root+'admin/stock/import',{method:'POST',body:bytes,headers:{...uploadHeaders,Cookie:manager,'X-Stock-Version':conflicting.version,'X-Stock-Hash':conflicting.fileHash,'X-Stock-Mappings':JSON.stringify(mapping)}});
const results=await Promise.all([concurrent(),concurrent()]);
check(results.map(r=>r.status).sort((a,b)=>a-b).join(',')==='200,409','Concurrent import rejects stale writer');
const beforeSkip=await preview(),skipMappings={...mapping,[beforeSkip.groups[1].key]:null};
await apply(beforeSkip,bytes,skipMappings);
check((await preview()).groups[1].warehouseId==='g-3','A previously skipped group is suggested again when it uniquely matches an active agent');
check((await request('stock',{cookie:agent2})).data.rows[0].quantity===5,'Skipped warehouse retains snapshot');
console.log(`PASS: ${checks} stock parser, import, authorization and concurrency checks.`);
