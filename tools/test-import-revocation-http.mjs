import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import XLSX from 'xlsx';

const work=mkdtempSync(join(tmpdir(),'import-route-')),cwd=process.cwd();
process.env.MOBIUP_DATA_DIR=join(work,'data');process.env.MOBIUP_USAGE_DISABLED='1';
let app,server;
try {
 symlinkSync(resolve('node_modules'),join(work,'node_modules'));
 const bundle=join(work,'routes.mjs');
 await build({stdin:{contents:"export * from './app/api/[...path]/route';export {env} from './lib/runtime';",loader:'ts',resolveDir:cwd},outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'runtime',setup(b){b.onResolve({filter:/^#mobiup-/},a=>({path:resolve('lib/'+a.path.slice(8)+'-node.ts')}));b.onResolve({filter:/\.sql\?raw$/},a=>({path:resolve(a.path.replace(/^@\//,'').replace(/\?raw$/,'')),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},a=>({contents:readFileSync(a.path,'utf8'),loader:'text'}));}}]});
 for(const kind of ['stock','sales'])await build({entryPoints:[`lib/${kind}-parser-worker.ts`],outfile:join(work,`${kind}-parser-worker.mjs`),bundle:true,platform:'node',format:'esm',packages:'external'});
 const routes=await import(pathToFileURL(bundle));await routes.env.DB.prepare('SELECT 1').first();
 app=new DatabaseSync(join(work,'data','mobiup.sqlite'));app.exec('PRAGMA busy_timeout=5000');
 app.prepare("INSERT OR IGNORE INTO settings VALUES('seed-v1','1')").run();
 app.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active,profile_revision) VALUES('m','m','Synthetic manager','manager','global','unused',0,1,1)").run();
 app.prepare("INSERT INTO users(id,username,name,role,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES('a','a','Synthetic agent','agent','warehouse','Synthetic warehouse','TEST','unused',0,1,1)").run();
 const token='synthetic-http-session',hash=createHash('sha256').update(token).digest('hex');
 function resetSession(){app.prepare('DELETE FROM sessions').run();app.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash,'m',Date.now()+60000);}
 let onRead=()=>{};
 server=createServer(async (incoming,outgoing)=>{try{
  const req=new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`,{method:incoming.method,headers:incoming.headers,body:Readable.toWeb(incoming),duplex:'half'});
  const get=req.body.getReader.bind(req.body);req.body.getReader=(...args)=>{onRead();return get(...args);};
  const response=await routes.POST(req);outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){outgoing.writeHead(500);outgoing.end(String(e));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/`;
 process.chdir(work);
 function excel(columns,row){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([columns,row]),'Input');return XLSX.write(book,{type:'buffer',bookType:'xlsx'});}
 const cases=[
  {kind:'stock',prefix:'admin/stock/',headers:['Gestiune','ItemCode','ItemName','Stoc','SiteId','StocDepozit'],row:['Synthetic warehouse','TEST','Product',7,'TEST',9]},
  {kind:'sales',prefix:'sales/',headers:['Data','SiteCode','ItemCode','ItemName','Cantitate','Brand','Pret','Valoare','Locatie','Firma','ASM','Regional','Nr','Categorie','SubCategorie','Agent'],row:['01.10.2026','TEST','TEST','Product',1,'Test',4,4,'TR Synthetic','Synthetic','','','1','Test','Test','Synthetic']},
 ];
 for(const c of cases){
  resetSession();const bytes=excel(c.headers,c.row),headers={Cookie:`mobiup_session=${token}`,[c.kind==='stock'?'X-Stock-Filename':'X-Sales-Filename']:'synthetic.xlsx'};
  const previewResponse=await fetch(base+c.prefix+'preview',{method:'POST',headers,body:bytes});const preview=await previewResponse.json();assert.equal(previewResponse.status,200,JSON.stringify(preview));
  if(c.kind==='stock')Object.assign(headers,{'X-Stock-Version':preview.version,'X-Stock-Hash':preview.fileHash,'X-Stock-Mappings':JSON.stringify(Object.fromEntries(preview.groups.map(g=>[g.key,g.warehouseId]))),'X-Stock-Coverage':JSON.stringify(preview.decision),'X-Stock-Confirmation':preview.confirmation});
  else Object.assign(headers,{'X-Sales-Revision':String(preview.revision),'X-Sales-Hash':preview.fileHash,'X-Sales-Mapping-Hash':preview.mappingHash});
  let ready;const reading=new Promise(r=>ready=r);onRead=ready;
  let request;const result=new Promise((resolve,reject)=>{request=httpRequest(base+c.prefix+'import',{method:'POST',headers:{...headers,'Content-Length':bytes.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);request.flushHeaders();});
  await reading;app.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);request.end(bytes);assert.equal(await result,401,`${c.kind} revoked during body`);
  if(c.kind==='stock')assert.equal(app.prepare("SELECT count(*) n FROM settings WHERE key='agent-stock-v1'").get().n,0);
  else {const sales=new DatabaseSync(join(work,'data','sales.sqlite'));assert.equal(sales.prepare('SELECT count(*) n FROM sales_rows').get().n,0);sales.close();}
  resetSession();onRead=()=>{};
  const valid=await fetch(base+c.prefix+'import',{method:'POST',headers,body:bytes});const body=await valid.text();assert.equal(valid.status,200,body);
  // No lock is left behind by either denied or successful import.
  app.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
 }
 console.log('PASS: real HTTP delayed body revocation leaves stock and sales unchanged; valid retries commit and release locks.');
} finally {process.chdir(cwd);app?.close();if(server)await new Promise(r=>server.close(r));rmSync(work,{recursive:true,force:true});}
