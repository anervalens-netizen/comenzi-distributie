import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const directory=mkdtempSync(join(tmpdir(),'projection-test-'));
const sql=new DatabaseSync(join(directory,'test.sqlite'));
let queries=0;
const adapter={
 async readVersion(){return JSON.stringify([sql.prepare('PRAGMA data_version').get().data_version,sql.prepare('SELECT total_changes() n').get().n]);},
 prepare(query){return {values:[],bind(...values){this.values=values;return this;},async all(){queries++;return {results:sql.prepare(query).all(...this.values)};}};},
};
globalThis.__projectionTest=adapter;
const plugin={name:'isolated-projection',setup(builder){
 builder.onResolve({filter:/^\.\/server$/},()=>({path:'fixture-server',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`import {createHash} from 'node:crypto';export const db=()=>globalThis.__projectionTest;export const isGlobalManager=u=>u.role==='manager'&&u.managerScope==='global';export const sha256=s=>createHash('sha256').update(s).digest('hex');export const fail=(status,message)=>{throw new Error(message)};export const textField=v=>v;`}));
}};
async function load(name,source,resolveDir=resolve('lib')){
 const outfile=join(directory,name+'.mjs');
 await build({stdin:{contents:source,sourcefile:name+'.ts',loader:'ts',resolveDir},outfile,bundle:true,platform:'node',format:'esm',plugins:[plugin],logLevel:'silent'});
 return import(pathToFileURL(outfile));
}
try{
 const {readFileSync}=await import('node:fs');
 const {createReadProjectionCache}=await load('cache',readFileSync('lib/read-projection-cache.ts','utf8'));
 const cache=createReadProjectionCache(80,2);
 cache.put('a','1',{name:'a'});cache.put('b','1',{name:'b'});
 const a=cache.get('a','1');a.name='changed';assert.equal(cache.get('a','1').name,'a','fresh decode prevents mutation contamination');
 cache.put('c','1',{name:'c'});assert.equal(cache.get('b','1'),undefined,'LRU bounded entries');
 assert.equal(cache.get('a','2'),undefined,'different revision invalidates');
 cache.put('huge','1','x'.repeat(100));assert.equal(cache.get('huge','1'),undefined,'memory bound rejects oversized entries');
 sql.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER);
 CREATE TABLE partner_profiles(customer_id TEXT PRIMARY KEY,contact TEXT,phone TEXT,email TEXT,latitude REAL,longitude REAL,position_source TEXT,position_accuracy REAL,position_provider TEXT,position_metadata TEXT,address_fingerprint TEXT,revision INTEGER,updated_at TEXT);
 CREATE TABLE partner_visits(customer_id TEXT,visited_at TEXT);
 CREATE TABLE partner_requests(id TEXT,customer_id TEXT,status TEXT,confirmed_at TEXT,payload TEXT);
 CREATE TABLE users(id TEXT,warehouse_id TEXT,active INTEGER);CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);`);
 sql.prepare('INSERT INTO users VALUES(?,?,?)').run('a','w-a',1);sql.prepare('INSERT INTO manager_agents VALUES(?,?)').run('regional','a');
 const fixtures=[
  {id:'normal',name:'Șynthetic A',warehouseId:'w-a',warehouseIds:['w-a','w-b','w-a'],cui:'TEST-1',address:'Example 1',city:'City',county:'County',route:'1',historyCatalog:{kind:'company',franchiseCode:'point',countySource:'historical_seller_inferred',unused:'discard'},unused:{large:'x'.repeat(10000)}},
  {id:'missing',name:'B',warehouseId:'w-b',cui:'TEST-2',address:'',route:false},
  {id:'nulls',name:'C',warehouseId:'w-a',warehouseIds:null,cui:'TEST-3',address:null,city:null,county:null,route:null,historyCatalog:null},
 ];
 for(const c of fixtures){sql.prepare('INSERT INTO customers VALUES(?,?,?,1)').run(c.id,c.warehouseId,JSON.stringify(c));const fingerprint=createHash('sha256').update(JSON.stringify([c.address||'',c.city||'',c.county||''])).digest('hex');sql.prepare('INSERT INTO partner_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(c.id,'Contact','Phone','email@example.invalid',45,25,'manual',null,'provider',JSON.stringify({positionQuality:'locality_approximate'}),fingerprint,1,'2026-09-01');}
 const baseline=process.env.PERFORMANCE_BASELINE_REF;
 const before=baseline?await load('before',execFileSync('git',['show',baseline+':lib/partner-portfolio.ts'],{encoding:'utf8'})):null;
 const after=await load('after',readFileSync('lib/partner-portfolio.ts','utf8'));
 const scopes=[{id:'manager',role:'manager',managerScope:'global'},{id:'a',role:'agent',warehouseId:'w-a'},{id:'regional',role:'manager',managerScope:'assigned'}];
 if(before)for(const user of scopes)for(const area of [undefined,[24,44,26,46]])for(const warehouses of [undefined,['w-a'],[],['w-b']])assert.deepEqual(JSON.parse(JSON.stringify(await after.portfolioSummary(user,area,warehouses))),JSON.parse(JSON.stringify(await before.portfolioSummary(user,area,warehouses))),'canonical HTTP projection parity including missing/null/arrays and approximate fingerprint');
 const manager=scopes[0];const first=await after.portfolioSummary(manager);
 assert.deepEqual(first.map(p=>p.id),['missing','nulls','normal']);assert.equal(first.find(p=>p.id==='missing').route,false,'legacy JSON boolean retains its type');assert.equal(first.find(p=>p.id==='normal').positionQuality,'locality_approximate');assert.deepEqual(first.find(p=>p.id==='normal').warehouseIds,['w-a','w-b','w-a']);assert.equal(first.find(p=>p.id==='normal').historyCatalog.kind,'company');assert(!('unused' in first.find(p=>p.id==='normal')));assert.equal(first.find(p=>p.id==='nulls').address,null);assert.equal(first.find(p=>p.id==='nulls').latitude,45);assert.deepEqual((await after.portfolioSummary(scopes[1])).map(p=>p.id),['nulls','normal']);assert.deepEqual(await after.portfolioSummary(manager,undefined,[]),[]);assert.deepEqual(await after.portfolioSummary(manager,[0,0,1,1]),[]);queries=0;const hit=await after.portfolioSummary(manager);assert.equal(queries,0,'warm snapshot does not scan customers');assert.deepEqual(JSON.parse(JSON.stringify(hit)),JSON.parse(JSON.stringify(first)),'warm and cold HTTP wire contract is identical');hit[0].name='client mutation';assert.notEqual((await after.portfolioSummary(manager))[0].name,'client mutation');
 sql.prepare('UPDATE customers SET data=json_set(data,\'$.address\',\'Changed\') WHERE id=?').run('normal');const changed=await after.portfolioSummary(manager);assert.equal(changed.find(p=>p.id==='normal').latitude,null,'local commit invalidates cache and fingerprint');
 const other=new DatabaseSync(join(directory,'test.sqlite'));other.prepare('UPDATE customers SET active=0 WHERE id=?').run('missing');other.close();assert(!(await after.portfolioSummary(manager)).some(p=>p.id==='missing'),'external connection commit invalidates');
 sql.prepare('UPDATE users SET active=0 WHERE id=?').run('a');assert.deepEqual(await after.portfolioSummary(scopes[2]),[],'permissions changes invalidate regional cache');
 if(process.env.PROJECTION_BENCHMARK_ROWS){
  assert(before,'benchmark requires PERFORMANCE_BASELINE_REF');
  const count=Number(process.env.PROJECTION_BENCHMARK_ROWS);assert(count>=3&&count<=50000);
  sql.exec('BEGIN');const insert=sql.prepare('INSERT INTO customers VALUES(?,?,?,1)');
  for(let i=3;i<count;i++)insert.run('synthetic-'+i,'w-a',JSON.stringify({id:'synthetic-'+i,name:'Synthetic '+String(i).padStart(6,'0'),warehouseId:'w-a',cui:'TEST-'+i,address:'Example',city:'City',county:'County',route:'1',unused:'x'.repeat(1000)}));sql.exec('COMMIT');
  const measures=[];for(let i=0;i<3;i++){const start=performance.now();const old=await before.portfolioSummary(manager);const middle=performance.now();const next=await after.portfolioSummary(manager);const end=performance.now();const warm=await after.portfolioSummary(manager);const done=performance.now();assert.deepEqual(JSON.parse(JSON.stringify(next)),JSON.parse(JSON.stringify(old)));assert.equal(warm.length,next.length);measures.push({rows:next.length,beforeMs:middle-start,candidateColdMs:end-middle,candidateWarmMs:done-end});sql.prepare('UPDATE users SET active=active').run();}
  console.log(JSON.stringify(measures));if(process.env.PROJECTION_BENCHMARK_OUTPUT)writeFileSync(process.env.PROJECTION_BENCHMARK_OUTPUT,JSON.stringify({synthetic:true,count,measures},null,2),{mode:0o600});
 }
 console.log('PASS: bounded projection cache; canonical field/scope/bbox/membership parity; local/external/permission invalidation.');
}finally{sql.close();delete globalThis.__projectionTest;rmSync(directory,{recursive:true,force:true});}
