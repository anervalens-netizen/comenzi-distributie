import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import XLSX from 'xlsx';
const databaseUrl=process.env.IMPORT_TEST_DATABASE_URL,engineSource=process.env.IMPORT_ENGINE_SOURCE;
if(!databaseUrl||!engineSource)throw Error('Synthetic database URL and import engine source are required');
const cwd=process.cwd(),work=mkdtempSync(join(cwd,'work','import-e2e-')),data=join(work,'data'),schema='import_comenzi_test_'+randomUUID().replaceAll('-','').slice(0,12),key='synthetic-internal-key-'.repeat(3);
let app,appServer,engineServer,engine,pool;
try{
 process.env.MOBIUP_DATA_DIR=data;process.env.MOBIUP_ACTIVATIONS_DIR=join(data,'activations');process.env.MOBIUP_USAGE_DISABLED='1';process.env.IMPORT_ENGINE_KEY=key;
 const {ImportEngine}=await import(pathToFileURL(join(engineSource,'src/engine.mjs'))),{httpServer}=await import(pathToFileURL(join(engineSource,'src/server.mjs')));
 const req=createRequire(join(engineSource,'package.json'));const {Pool}=req('pg');pool=new Pool({connectionString:databaseUrl});
 const executor=resolve('dist/standalone/import-engine-executor.mjs');
 engine=new ImportEngine({schema,databaseUrl,kinds:['sales_agent','sales_location','stock_tr','sim_sales_vodafone','sim_sales_digi','sim_activations_vodafone','sim_activations_digi'],executor:[process.execPath,executor],executorCwd:resolve('dist/standalone'),lockFile:join(work,'executor.lock')});
 await engine.start();engineServer=httpServer(engine,key);await new Promise(r=>engineServer.listen(0,'127.0.0.1',r));process.env.IMPORT_ENGINE_URL=`http://127.0.0.1:${engineServer.address().port}`;
 symlinkSync(resolve('node_modules'),join(work,'node_modules'));const bundle=join(work,'routes.mjs');
 await build({stdin:{contents:"export * from './app/api/[...path]/route';export {env} from './lib/runtime';",loader:'ts',resolveDir:cwd},outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'runtime',setup(b){b.onResolve({filter:/^#mobiup-/},a=>({path:resolve('lib/'+a.path.slice(8)+'-node.ts')}));b.onResolve({filter:/\.sql\?raw$/},a=>({path:resolve(a.path.replace(/^@\//,'').replace(/\?raw$/,'')),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},a=>({contents:readFileSync(a.path,'utf8'),loader:'text'}));}}]});
 const routes=await import(pathToFileURL(bundle));await routes.env.DB.prepare('SELECT 1').first();
 app=new DatabaseSync(join(data,'mobiup.sqlite'));app.exec('PRAGMA busy_timeout=5000');app.prepare("INSERT OR IGNORE INTO settings VALUES('seed-v1','1')").run();
 app.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active,profile_revision) VALUES('m','m','Synthetic manager','manager','global','unused',0,1,1)").run();
 app.prepare("INSERT INTO users(id,username,name,role,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES('a','a','Synthetic agent','agent','warehouse','TR Example','SITE','unused',0,1,1)").run();
 const token='synthetic-http-session',tokenHash=createHash('sha256').update(token).digest('hex');app.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash,'m',Date.now()+3600000);
 const fixture=spawnSync('python3',['tools/test-import-engine-fixtures.py',data],{cwd,encoding:'utf8'});if(fixture.status!==0)throw Error('Synthetic fixture failed: '+fixture.stderr);
 appServer=createServer(async(incoming,outgoing)=>{try{const method=incoming.method,body=['GET','HEAD'].includes(method)?undefined:Readable.toWeb(incoming);const request=new Request(`http://127.0.0.1:${appServer.address().port}${incoming.url}`,{method,headers:incoming.headers,...(body?{body,duplex:'half'}:{})});const response=await routes[method](request);outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));}catch(e){outgoing.writeHead(500);outgoing.end(String(e));}});
 await new Promise(r=>appServer.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${appServer.address().port}/api/`,cookie=`mobiup_session=${token}`;
 async function call(path,opts={}){const r=await fetch(base+path,{...opts,headers:{Cookie:cookie,...opts.headers}});const value=await r.json();assert(r.ok,`${path}: ${r.status} ${JSON.stringify(value)}`);return value;}
 async function wait(id,state){for(let n=0;n<300;n++){const job=(await call('imports/jobs/'+id)).job;if(job.state===state)return job;if(['failed','uncertain'].includes(job.state))throw Error('Import '+job.kind+': '+JSON.stringify(job));await new Promise(r=>setTimeout(r,100));}throw Error('Timeout waiting for '+state);}
 function excel(headers,rows,sheet){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,...rows]),sheet);return XLSX.write(book,{type:'buffer',bookType:'xlsx'});}
 const cases=[
  {kind:'sales_agent',bytes:excel(['Data','SiteCode','ItemCode','ItemName','Cantitate','Brand','Pret','Valoare','Locatie','Firma','ASM','Regional','Nr','Categorie','SubCategorie','Agent'],[['10.01.2026','SITE','P1','Synthetic product',1,'Synthetic',10,10,'TR Example','ExampleCo','','','1','Accesorii','','']],'Raport'),start:'2025-12-31',end:'2026-01-31'},
  {kind:'stock_tr',bytes:excel(['Gestiune','ItemCode','ItemName','Stoc','SiteId','StocDepozit'],[['TR Example','P1','Synthetic product',5,'SITE',10]],'Stoc_TR'),start:'2026-01-31',end:'2026-01-31'},
  {kind:'sim_sales_vodafone',bytes:readFileSync(join(data,'sim.xlsx')),start:'2026-01-31',end:'2026-02-01',sourceAt:'2026-02-02'},
  {kind:'sim_sales_digi',bytes:readFileSync(join(data,'sim-digi.xlsx')),start:'2026-01-01',end:'2026-01-31',sourceAt:'2026-01-31'},
  {kind:'sim_activations_vodafone',bytes:readFileSync(join(data,'operator-vodafone.xlsx')),start:'2026-01-01',end:'2026-01-31',sourceAt:'2026-01-31'},
  {kind:'sim_activations_digi',bytes:readFileSync(join(data,'operator-digi.xlsx')),start:'2026-01-01',end:'2026-01-31',sourceAt:'2026-01-31',company:'ExampleCo'},
  {kind:'sales_location',bytes:readFileSync(join(data,'history.xlsx')),start:'2024-02-01',end:'2024-02-29'},
 ];
 for(const c of cases){
  const id=randomUUID(),sha=createHash('sha256').update(c.bytes).digest('hex');const headers={'X-Import-Id':id,'X-Import-Kind':c.kind,'X-Import-Filename':'synthetic.xlsx','X-Import-Sha256':sha,'X-Import-Date-Start':c.start,'X-Import-Date-End':c.end,...(c.sourceAt?{'X-Import-Source-At':c.sourceAt}:{}),...(c.company?{'X-Import-Company':c.company}:{})};
  await call('imports/jobs',{method:'POST',headers,body:c.bytes});await call('imports/jobs',{method:'POST',headers,body:c.bytes});let ready=await wait(id,'ready');assert.equal(ready.source.date_start,c.start);assert.equal(ready.payload,undefined);
  let options=c.kind==='sales_agent'?{allowHistorical:true,allowRegression:true}:c.kind==='sales_location'?{allowRegression:true}:{};
  if(c.kind==='stock_tr'){
   const group=ready.preview.groups[0];options={mappings:{[group.key]:'warehouse'},coverage:{warehouses:'full',depot:'full'}};const revision={request_id:randomUUID(),preview_hash:ready.preview_hash,options};
   await call('imports/jobs/'+id+'/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(revision)});ready=await wait(id,'ready');
  }
  const commit={preview_hash:ready.preview_hash,options};await call('imports/jobs/'+id+'/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(commit)});const done=await wait(id,'completed');
  assert.equal(done.receipt.verified,true);assert.equal(done.receipt.source_sha256,sha);assert.equal(done.receipt.action_id,done.action_id);assert.equal(done.receipt.actor.id,'m');assert.deepEqual(done.receipt.declared_period,{start:c.start,end:c.end});
  if(c.kind==='sim_sales_vodafone'){assert.equal(done.receipt.source_at,c.sourceAt);assert.equal(done.receipt.provider,'vodafone');}
  if(c.company)assert.equal(done.receipt.company,c.company);
  if(c.kind==='sim_activations_vodafone')assert.equal(done.receipt.company,'Vodafone');
  await call('imports/jobs/'+id+'/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(commit)});
  console.log('PASS:',c.kind,'real application HTTP → engine → executor → receipt, same-ID retry');
 }
}finally{
 if(appServer){appServer.closeAllConnections();await new Promise(r=>appServer.close(r));}app?.close();if(engineServer){engineServer.closeAllConnections();await new Promise(r=>engineServer.close(r));}await engine?.close();
 if(pool){await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${schema}_queue" CASCADE`);await pool.end();}
 rmSync(work,{recursive:true,force:true});
}
