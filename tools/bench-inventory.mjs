// Real inventory/catalog handlers and SQLite; synthetic stock and transport only.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {lab,payloadBytes,distribution,positiveInt} from './performance/lab.mjs';
const lineCount=positiveInt(process.env.LAB_LINES,1000);assert(lineCount>=2,'At least two lines exercise hidden-row validation');
mkdirSync('work',{recursive:true});const dir=mkdtempSync(resolve('work/inventory-lab-'));
const database=join(dir,'synthetic.sqlite');let sql=new DatabaseSync(database);
sql.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,warehouse_id TEXT,active INTEGER);CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);INSERT INTO users VALUES('agent','agent','warehouse',1);`);
globalThis.__inventoryLabDb={prepare(query){return {args:[],bind(...args){this.args=args;return this;},async first(){return sql.prepare(query).get(...this.args)||null;},async all(){return {results:sql.prepare(query).all(...this.args)};},async run(){return {meta:sql.prepare(query).run(...this.args)};}};}};
const source=readFileSync('lib/server.ts','utf8'),auth=source.slice(source.indexOf('export function isGlobalManager'),source.indexOf('export function assertOrigin'));
const products=Array.from({length:lineCount},(_,i)=>({id:'synthetic-'+i,code:'LAB-'+String(i).padStart(4,'0'),name:'Synthetic inventory product '+i,brand:'Synthetic',category:'Synthetic',kind:'accessories',price:2,netPrice:1,sourceRow:i,image:null,ean:i===0?'4006381333931':''}));
const stock={importedAt:'2026-01-01T00:00:00Z',filename:'synthetic',rows:products.map(p=>({code:p.code,name:p.name,quantity:10,category:p.category}))};
const serialization=[],b=lab('inventory',{lines:lineCount,scans:100,catalogProducts:lineCount});
globalThis.__inventoryLabResponse=(value,status=200)=>{const at=performance.now(),r=Response.json(value,{status});serialization.push(performance.now()-at);return r;};
const modules={server:`import {createHash} from 'node:crypto';export const db=()=>globalThis.__inventoryLabDb;export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};export const sha256=v=>createHash('sha256').update(v).digest('hex');export const textField=(v,n=500)=>typeof v==='string'?v.trim().slice(0,n):'';export const jsonBody=req=>req.json();export const response=(...args)=>globalThis.__inventoryLabResponse(...args);${auth}`,seed:`export default ${JSON.stringify({products})}`,stock:`export const stockForWarehouse=async()=>(${JSON.stringify(stock)});`};
const plugin={name:'inventory-lab',setup(b){for(const [filter,path] of [[/^\.\/server$/,'server'],[/^@\/resources\/seed\.json$/,'seed'],[/^\.\/stock-server$/,'stock']])b.onResolve({filter},()=>({path,namespace:'lab'}));b.onLoad({filter:/.*/,namespace:'lab'},a=>({loader:'ts',contents:modules[a.path]}));}};
const outfile=join(dir,'inventory.mjs');
try{
 await build({stdin:{contents:"export {inventories} from './lib/inventory-server';",resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,format:'esm',platform:'node',plugins:[plugin],logLevel:'silent'});
 let {inventories}=await import(pathToFileURL(outfile));const user={id:'agent',name:'Synthetic agent',role:'agent',warehouseId:'warehouse'};
 async function request(method,id,body){try{return await inventories(new Request('https://example.invalid/inventory',{method,...body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}}),user,id);}catch(e){if(!e.status)throw e;return Response.json({error:e.message},{status:e.status});}}
 async function call(method,id,body,status=200){const r=await request(method,id,body);assert.equal(r.status,status,await (r.status===status?Promise.resolve(''):r.clone().text()));return r.json();}
 const created=await b.measure('create','agent','cold catalog',1,()=>call('POST',undefined,{id:randomUUID(),warehouseId:'warehouse',scope:'all'}));
 let inv=created.result.inventory;assert.equal(inv.lines.length,lineCount);created.record.bytes=payloadBytes(created.result);
 const op=(action,extra={})=>({operationId:randomUUID(),revision:inv.revision,action,...extra});
 const operations=[],bytes=[],parse=[],compress=[];serialization.length=0;
 await b.measure('100-scans','agent','warm sequential; distinct durable IDs, repeated EAN',100,async()=>{
  const body=op('scan',{ean:products[0].ean,quantity:1});operations.push(body);
  const r=await request('PATCH',inv.id,body);assert.equal(r.status,200);const text=await r.text();const at=performance.now();inv=JSON.parse(text).inventory;parse.push(performance.now()-at);
  assert.equal(inv.lines[0].counted,operations.length);assert.equal(inv.lines.length,lineCount);assert(!('operations' in inv));
  // Size/compression measured outside the handler timing in a separate phase below.
  bytes.push(text);
 });
 const scanSerialization=[...serialization];
 for(const text of bytes){const at=performance.now();const size=payloadBytes(text);compress.push({ms:performance.now()-at,...size});}
 const raw=()=>sql.prepare('SELECT value FROM settings WHERE key=?').get('inventory-v1:'+inv.id).value;
 const durable=raw();assert.equal(JSON.parse(durable).operations.length,100);assert.deepEqual(JSON.parse(durable).operations.map(o=>o.id),operations.map(o=>o.operationId));
 await b.measure('duplicate-retry','agent','old revision; lost response',30,async()=>{assert.equal((await call('PATCH',inv.id,operations[0])).inventory.lines[0].counted,100);assert.equal(raw(),durable);});
 await call('PATCH',inv.id,{...operations[0],quantity:2},409);
 await b.measure('concurrent-cas','agent','two writers at same revision; loser rebased with same durable ID',30,async i=>{
  const competing=[op('scan',{ean:products[0].ean,quantity:1}),op('scan',{ean:products[0].ean,quantity:2})];
  const parallel=await Promise.all(competing.map(body=>request('PATCH',inv.id,body)));assert.deepEqual(parallel.map(r=>r.status).sort((a,b)=>a-b),[200,409]);
  inv=(await call('GET',inv.id)).inventory;const loser=parallel.findIndex(r=>r.status===409);inv=(await call('PATCH',inv.id,{...competing[loser],revision:inv.revision})).inventory;assert.equal(inv.lines[0].counted,100+3*(i+1));
 });
 await call('PATCH',inv.id,op('finalize'),409);assert.equal(inv.lines.at(-1).counted,null,'hidden last row blocks finalize');
 // Exercise every row through the API, including rows beyond a filtered viewport.
 for(const line of inv.lines.slice(1))inv=(await call('PATCH',inv.id,op('set',{code:line.code,quantity:0}))).inventory;
 inv=(await call('PATCH',inv.id,op('finalize'))).inventory;assert.equal(inv.status,'finalized');assert.equal(inv.lines.reduce((n,l)=>n+l.counted,0),190);assert.equal(inv.lines.length,lineCount);
 const finalRaw=raw();sql.close();sql=new DatabaseSync(database);({inventories}=await import(pathToFileURL(outfile)+'?restart'));
 assert.deepEqual((await call('PATCH',inv.id,operations[0])).inventory,inv);assert.equal(raw(),finalRaw);
 await call('PATCH',inv.id,op('scan',{ean:products[0].ean,quantity:1}),409);
 b.save({response:{rawBytes:distribution(compress.map(x=>x.raw)),gzipBytes:distribution(compress.map(x=>x.gzip)),brotliBytes:distribution(compress.map(x=>x.brotli)),serializeMs:distribution(scanSerialization),clientJsonParseMs:distribution(parse),offlineCompressionMs:distribution(compress.map(x=>x.ms)),totalRawBytes:compress.reduce((n,x)=>n+x.raw,0),totalGzipBytes:compress.reduce((n,x)=>n+x.gzip,0)},correctness:{durableScans:100,casWaves:30,casWinnerPerWave:1,casLoserRetried:true,hiddenRowsValidated:lineCount,restartRetry:true,finalCount:190},limits:'Module/SQLite LAB; compression estimate, not actual network. DOM rendering/scanner focus are not measured here.'});
}finally{sql.close();delete globalThis.__inventoryLabDb;delete globalThis.__inventoryLabResponse;rmSync(dir,{recursive:true,force:true});}
