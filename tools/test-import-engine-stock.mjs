import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
const folder=await mkdtemp(join(tmpdir(),'stock-engine-'));
try{
 const sql=new DatabaseSync(join(folder,'mobiup.sqlite'));sql.exec(`CREATE TABLE users(id TEXT,name TEXT,role TEXT,active INTEGER,site_code TEXT,warehouse_name TEXT,warehouse_id TEXT,manager_scope TEXT,must_change_password INTEGER,profile_revision INTEGER);CREATE TABLE sessions(token_hash TEXT,user_id TEXT,expires_at INTEGER);CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);`);
 sql.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)').run('manager','Synthetic manager','manager',1,'','',null,'global',0,1);
 sql.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)').run('agent','Synthetic agent','agent',1,'SITE','TR Example','warehouse','assigned',0,1);
 const hash=createHash('sha256').update('synthetic-token').digest('hex');sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash,'manager',Date.now()+60000);
 class Statement{constructor(q,args=[]){this.q=q;this.args=args;}bind(...args){return new Statement(this.q,args)} execute(){const r=sql.prepare(this.q);if(/^\s*SELECT/i.test(this.q))return {results:r.all(...this.args),meta:{changes:0}};r.run(...this.args);return {results:[],meta:{changes:Number(sql.prepare('SELECT changes() n').get().n)}};}async all(){return this.execute()}async first(){return this.execute().results[0]||null}async run(){return this.execute()}}
 globalThis.__stockDb={prepare:q=>new Statement(q),async batch(items){sql.exec('BEGIN IMMEDIATE');try{const result=items.map(s=>s.execute());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const stubs={server:`import{createHash}from'node:crypto';export const db=()=>globalThis.__stockDb;export const sha256=v=>createHash('sha256').update(v).digest('hex');export const sessionToken=()=>'';export const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};export const readLimited=async req=>new Uint8Array(await req.arrayBuffer());export const requireManager=u=>{if(u.role!=='manager')fail(403,'denied')};export const requireWarehouseAccess=()=>{};export const response=v=>Response.json(v);export const userView=r=>({id:r.id,name:r.name,role:r.role,warehouseId:r.warehouse_id,warehouseName:r.warehouse_name,siteCode:r.site_code,managerScope:r.manager_scope,profileVersion:String(r.profile_revision)});`,catalog:`export const readCatalog=async()=>({products:[]});`,parser:`export const parseStockFileRuntime=async()=>[{key:'group',name:'TR Example',siteId:'SITE',rows:[{code:'P1',name:'Synthetic product',quantity:5,depotQuantity:10}]}];`};
 await build({entryPoints:[resolve('lib/stock-server.ts')],outfile:join(folder,'stock.mjs'),bundle:true,platform:'node',format:'esm',plugins:[{name:'stubs',setup(b){b.onResolve({filter:/^\.\/(server|catalog|stock-parser-runtime)$/},args=>({path:args.path,namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:args.path.endsWith('server')?stubs.server:args.path.endsWith('catalog')?stubs.catalog:stubs.parser,loader:'js'}));}}]});
 const {stockUpload}=await import(pathToFileURL(join(folder,'stock.mjs'))),user={id:'manager',role:'manager',managerScope:'global',profileVersion:'1'},auth={userId:'manager',profileVersion:1,managerScope:'global',tokenHash:hash};
 const id=randomUUID(),internal={authorization:auth,action:{id,actor:{id:'manager',label:'Synthetic manager',type:'human'},period:{start:'2026-01-01',end:'2026-01-01'}}};
 const req=(headers={})=>new Request('http://local/',{method:'POST',headers:{'X-Stock-Filename':'synthetic.xlsx',...headers},body:'synthetic'});
 const preview=await (await stockUpload(req(),user,false,internal)).json(),mappings={group:'warehouse'},coverage={warehouses:'full',depot:'full'};
 const p=await (await stockUpload(req({'X-Stock-Mappings':JSON.stringify(mappings),'X-Stock-Coverage':JSON.stringify(coverage)}),user,false,internal)).json();
 const commitHeaders={'X-Stock-Mappings':JSON.stringify(mappings),'X-Stock-Coverage':JSON.stringify(coverage),'X-Stock-Version':p.version,'X-Stock-Hash':p.fileHash,'X-Stock-Confirmation':p.confirmation};
 const result=await (await stockUpload(req(commitHeaders),user,true,internal)).json();assert.equal(result.receipt.effect,'published');assert.equal(result.receipt.action_id,id);
 assert.equal(JSON.parse(sql.prepare('SELECT value FROM settings WHERE key=?').get('import_action_receipt:'+id).value).source_sha256,p.fileHash);
 const state=sql.prepare("SELECT value FROM settings WHERE key='agent-stock-v1'").get().value;
 const second=await (await stockUpload(req(),user,false,internal)).json(),secondId=randomUUID();sql.prepare('DELETE FROM sessions').run();
 await assert.rejects(()=>stockUpload(req({...commitHeaders,'X-Stock-Version':second.version,'X-Stock-Hash':second.fileHash,'X-Stock-Confirmation':second.confirmation}),user,true,{...internal,action:{...internal.action,id:secondId}}),e=>e.status===401);
 assert.equal(sql.prepare("SELECT value FROM settings WHERE key='agent-stock-v1'").get().value,state);assert.equal(sql.prepare('SELECT value FROM settings WHERE key=?').get('import_action_receipt:'+secondId),undefined);
 assert.equal(preview.rowCount,1);sql.close();console.log('Stock import atomic receipt and revocation tests passed');
}finally{delete globalThis.__stockDb;await rm(folder,{recursive:true,force:true});}
