import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import XLSX from 'xlsx';
const root=await mkdtemp(join(tmpdir(),'sales-engine-e2e-')),executor=resolve('dist/standalone/import-engine-executor.mjs'),lock=join(root,'executor.lock');
try{
 const app=new DatabaseSync(join(root,'mobiup.sqlite'));app.exec(await readFile('drizzle/0000_rare_hardball.sql','utf8'));
 app.exec("ALTER TABLE users ADD COLUMN warehouse_name TEXT; ALTER TABLE users ADD COLUMN site_code TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'assigned'; CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT,PRIMARY KEY(manager_id,agent_id));");
 app.prepare("INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,warehouse_name,site_code,profile_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('manager','manager','Synthetic manager','manager','global',null,'synthetic',0,'','',1);
 app.prepare("INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,warehouse_name,site_code,profile_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('agent','agent','Synthetic agent','agent','assigned','warehouse','synthetic',0,'TR Example','SITE',1);
 const hash=createHash('sha256').update('synthetic-token').digest('hex');app.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash,'manager',Date.now()+60000);app.prepare("INSERT INTO settings(key,value) VALUES('seed-v1','1')").run();app.close();
 const headers=['Data','SiteCode','ItemCode','ItemName','Cantitate','Brand','Pret','Valoare','Locatie','Firma','ASM','Regional','Nr','Categorie','SubCategorie','Agent'];
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,['10.01.2026','SITE','P1','Synthetic product',1,'Synthetic',10,10,'TR Example','ExampleCo','','','1','Accesorii','','']]),'Raport');
 const bytes=XLSX.write(book,{type:'buffer',bookType:'xlsx'}),id=randomUUID(),folder=join(root,'import-engine-spool',id);await mkdir(folder,{recursive:true});await writeFile(join(folder,'source.xlsx'),bytes);
 const job={id,kind:'sales_agent',actor:{id:'manager',label:'Synthetic manager',type:'human'},source:{filename:'synthetic.xlsx',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,date_start:'2025-12-31',date_end:'2026-01-31'},payload:{authorization:{userId:'manager',profileVersion:1,managerScope:'global',tokenHash:hash},commit_authorization:{userId:'manager',profileVersion:1,managerScope:'global',tokenHash:hash}}};
 async function invoke(value){return new Promise((resolveResult,reject)=>{const child=spawn('/usr/bin/flock',['--exclusive','--no-fork',lock,process.execPath,executor],{env:{...process.env,MOBIUP_DATA_DIR:root,IMPORT_ENGINE_LOCK_PATH:lock},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(Error('Executor failed '+err));try{resolveResult(JSON.parse(out));}catch(e){reject(e);}});child.stdin.end(JSON.stringify(value));});}
 const action_id=randomUUID(),preview=await invoke({protocol:1,mode:'execute',action:'preview',action_id:randomUUID(),attempt:0,job});assert.equal(preview.state,'ready',JSON.stringify(preview));assert.equal(preview.preview.firstDate,'2026-01-10');
 job.preview=preview.preview;job.options={allowHistorical:true,allowRegression:true};const commit=await invoke({protocol:1,mode:'execute',action:'commit',action_id,attempt:0,job});assert.equal(commit.state,'completed',JSON.stringify(commit));assert.equal(commit.receipt.action_id,action_id);assert.equal(commit.receipt.verified,true);
 const readback=new DatabaseSync(join(root,'sales.sqlite'),{readOnly:true});assert.equal(JSON.parse(readback.prepare('SELECT value FROM sales_meta WHERE key=?').get('import_action_receipt:'+action_id).value).source_sha256,job.source.sha256);const count=readback.prepare('SELECT COUNT(*) n FROM sales_imports').get().n;readback.close();
 const reconcile=await invoke({protocol:1,mode:'reconcile',action:'commit',action_id,attempt:1,job});assert.equal(reconcile.state,'completed');assert.equal(reconcile.receipt.action_id,action_id);
 const final=new DatabaseSync(join(root,'sales.sqlite'),{readOnly:true});assert.equal(final.prepare('SELECT COUNT(*) n FROM sales_imports').get().n,count);final.close();
 const stockBook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(stockBook,XLSX.utils.aoa_to_sheet([['Gestiune','ItemCode','ItemName','Stoc','SiteId','StocDepozit'],['TR Example','P1','Synthetic product',5,'SITE',10]]),'Stoc_TR');
 const stockBytes=XLSX.write(stockBook,{type:'buffer',bookType:'xlsx'}),stockId=randomUUID(),stockFolder=join(root,'import-engine-spool',stockId);await mkdir(stockFolder,{recursive:true});await writeFile(join(stockFolder,'source.xlsx'),stockBytes);
 const stock={...job,id:stockId,kind:'stock_tr',source:{...job.source,filename:'stock.xlsx',size:stockBytes.length,sha256:createHash('sha256').update(stockBytes).digest('hex')}};
 const stockPreview=await invoke({protocol:1,mode:'execute',action:'preview',action_id:randomUUID(),attempt:0,job:stock});assert.equal(stockPreview.state,'ready',JSON.stringify(stockPreview));
 const group=stockPreview.preview.groups[0];assert.equal(group.warehouseId,'warehouse');stock.options={mappings:{[group.key]:'warehouse'},coverage:{warehouses:'full',depot:'full'}};
 const revised=await invoke({protocol:1,mode:'execute',action:'preview',action_id:randomUUID(),attempt:0,job:stock});assert.equal(revised.state,'ready',JSON.stringify(revised));stock.preview=revised.preview;
 const stockAction=randomUUID(),stockCommit=await invoke({protocol:1,mode:'execute',action:'commit',action_id:stockAction,attempt:0,job:stock});assert.equal(stockCommit.state,'completed',JSON.stringify(stockCommit));assert.equal(stockCommit.receipt.source_sha256,stock.source.sha256);
 const stockReconcile=await invoke({protocol:1,mode:'reconcile',action:'commit',action_id:stockAction,attempt:1,job:stock});assert.equal(stockReconcile.receipt.action_id,stockAction);
 console.log('PASS: real sales and stock executors preview, commit, atomic receipt and reconciliation without replay.');
}finally{await rm(root,{recursive:true,force:true});}
