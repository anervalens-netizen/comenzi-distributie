import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import XLSX from 'xlsx';

const data=resolve('work/sales-view-consistency-qa'),origin='http://127.0.0.1:3037';
rmSync(data,{recursive:true,force:true});mkdirSync(data,{recursive:true});
const server=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:data,HOST:'127.0.0.1',PORT:'3037',NODE_ENV:'production'},stdio:['ignore','ignore','pipe']});
let stderr='';server.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(path,{method='GET',cookie,body,headers={}}={}){
  const started=performance.now(),response=await fetch(`${origin}/api/${path}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...headers},...(body!==undefined?{body}: {})});
  const data=await response.json();return {status:response.status,data,ms:performance.now()-started,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function waitHealth(){for(let i=0;i<80;i++){try{if((await fetch(`${origin}/api/health`)).ok)return;}catch{}await sleep(100);}throw new Error(`Server did not become healthy: ${stderr}`);}
const columns=['Data','SiteCode','ItemCode','ItemName','Cantitate','Brand','Pret','Valoare','Locatie','Firma','ASM','Regional','Nr','Categorie','SubCategorie','Agent'];
const smallFile=attempt=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([columns,['2026-09-01','AUDIT0','P1','Produs A',1,'Brand',10,10,'TR QA','QA','','',`A${attempt}`,'Accesorii','','QA'],['2026-09-02','AUDIT0','P2','Produs B',1,'Brand',20+attempt,20+attempt,'TR QA','QA','','',`B${attempt}`,'Accesorii','','QA']]),'Sales');return XLSX.write(book,{type:'buffer',bookType:'xlsx'});};
let salesDb;
function publishLargeSeptember(revision){
  salesDb.exec('BEGIN IMMEDIATE;');
  try{
    const importedAt=new Date().toISOString(),info=salesDb.prepare('INSERT INTO sales_imports(month,file_hash,filename,imported_at,imported_by,row_count,original_path,revision) VALUES(?,?,?,?,?,?,?,?)').run('2026-09',`reset-${revision}`,'reset.xlsx',importedAt,'qa',20000,'synthetic',revision),importId=Number(info.lastInsertRowid);
    salesDb.prepare("DELETE FROM sales_rows WHERE month='2026-09'").run();
    const add=salesDb.prepare('INSERT INTO sales_rows(import_id,row_number,date,month,site_code,item_code,item_name,quantity,brand,price_cents,value_cents,location,company,asm,regional,order_number,category,sub_category,agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<20000;i++)add.run(importId,i,`2026-09-${String(i%28+1).padStart(2,'0')}`,'2026-09',`AUDIT${i%19}`,`P${i%500}`,`Produs ${i%500}`,1,'Brand',1000,1000,'TR QA','QA','','',`BON${revision}-${i}`,'Accesorii','','QA');
    salesDb.prepare('INSERT INTO sales_months(month,import_id,imported_at,filename,file_hash,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET import_id=excluded.import_id,imported_at=excluded.imported_at,filename=excluded.filename,file_hash=excluded.file_hash,revision=excluded.revision').run('2026-09',importId,importedAt,'reset.xlsx',`reset-${revision}`,revision);
    salesDb.prepare("UPDATE sales_meta SET value=? WHERE key='revision'").run(String(revision));salesDb.exec('COMMIT;');
  }catch(error){try{salesDb.exec('ROLLBACK;');}catch{}throw error;}
}
try{
  await waitHealth();
  const appDb=new DatabaseSync(resolve(data,'mobiup.sqlite')),password=randomBytes(20).toString('hex'),salt=randomBytes(16).toString('hex'),hash=`scrypt:${salt}:${scryptSync(password,salt,32,{N:32768,r:8,p:3,maxmem:40*1024*1024}).toString('hex')}`;
  appDb.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active) VALUES('sales-consistency-manager','sales-consistency-manager','Sales consistency manager','manager','global',?,0,1)").run(hash);appDb.close();
  const login=await request('auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'sales-consistency-manager',password})});assert.equal(login.status,200);const cookie=login.cookie;
  assert(cookie);assert.equal((await request('sales?month=2026-09',{cookie})).status,200);
  salesDb=new DatabaseSync(resolve(data,'sales.sqlite'));salesDb.exec('PRAGMA busy_timeout=5000;');
  const add=salesDb.prepare('INSERT INTO sales_rows(import_id,row_number,date,month,site_code,item_code,item_name,quantity,brand,price_cents,value_cents,location,company,asm,regional,order_number,category,sub_category,agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let revision=0;
  for(let monthIndex=4;monthIndex<=8;monthIndex++){revision++;const month=`2026-${String(monthIndex).padStart(2,'0')}`,importedAt=new Date().toISOString(),info=salesDb.prepare('INSERT INTO sales_imports(month,file_hash,filename,imported_at,imported_by,row_count,original_path,revision) VALUES(?,?,?,?,?,?,?,?)').run(month,`seed-${month}`,'seed.xlsx',importedAt,'qa',20000,'synthetic',revision),importId=Number(info.lastInsertRowid);salesDb.prepare('INSERT INTO sales_months(month,import_id,imported_at,filename,file_hash,revision) VALUES(?,?,?,?,?,?)').run(month,importId,importedAt,'seed.xlsx',`seed-${month}`,revision);salesDb.exec('BEGIN');for(let i=0;i<20000;i++)add.run(importId,i,`${month}-${String(i%28+1).padStart(2,'0')}`,month,`AUDIT${i%19}`,`P${i%500}`,`Produs ${i%500}`,1,'Brand',1000,1000,'TR QA','QA','','',`BON${month}-${i}`,'Accesorii','','QA');salesDb.exec('COMMIT;');}
  publishLargeSeptember(++revision);
  const fileHeaders={'Content-Type':'application/octet-stream','X-Sales-Filename':'consistency-race.xlsx'};
  for(let attempt=0;attempt<3;attempt++){
    if(attempt>0)publishLargeSeptember(++revision);
    const bytes=smallFile(attempt),preview=await request('sales/preview',{method:'POST',cookie,body:bytes,headers:fileHeaders});assert.equal(preview.status,200,JSON.stringify(preview.data));
    const reportPromise=request('sales?month=2026-09&fromMonth=2026-04&toMonth=2026-09',{cookie});await sleep([0,20,40][attempt]);
    const health=await request('health');assert.equal(health.status,200);assert.ok(health.ms<500,`Health stalled during sales report: ${health.ms.toFixed(1)} ms`);
    const importPromise=request('sales/import',{method:'POST',cookie,body:bytes,headers:{...fileHeaders,'X-Sales-Hash':preview.data.fileHash,'X-Sales-Revision':String(preview.data.revision),'X-Sales-Mapping-Hash':preview.data.mappingHash,'X-Sales-Allow-Historical':'1','X-Sales-Allow-Regression':'1','X-Sales-Month':preview.data.month}});
    const [report,applied]=await Promise.all([reportPromise,importPromise]);assert.equal(report.status,200,JSON.stringify(report.data));assert.equal(applied.status,200,JSON.stringify(applied.data));revision=Number(applied.data.revision);
    const view=report.data,monthly=view.monthly.find(item=>item.month==='2026-09'),productRows=view.products.reduce((sum,item)=>sum+item.rows,0),dailyRows=view.daily.reduce((sum,item)=>sum+item.rows,0),siteRows=view.sites.reduce((sum,item)=>sum+item.rows,0);
    assert(monthly,'September must be present in explicit history');
    assert.equal(monthly.rows,view.summary.rows,`Attempt ${attempt}: monthly/summary generations differ`);assert.equal(productRows,view.summary.rows,`Attempt ${attempt}: products/summary generations differ`);assert.equal(dailyRows,view.summary.rows,`Attempt ${attempt}: daily/summary generations differ`);assert.equal(siteRows,view.summary.rows,`Attempt ${attempt}: sites/summary generations differ`);
    assert.ok(view.summary.rows===20000||view.summary.rows===2,`Attempt ${attempt}: unexpected snapshot row count ${view.summary.rows}`);
  }
  console.log('PASS: concurrent HTTP Sales import/report stays on one SQLite read snapshot and health remains responsive.');
} finally {
  try{salesDb?.close();}catch{}
  server.kill('SIGTERM');
}
