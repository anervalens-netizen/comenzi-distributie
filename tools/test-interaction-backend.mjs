import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'interaction-read-model-')),file=join(dir,'test.sqlite'),sql=new DatabaseSync(file);
let statements=[];
function prepare(query){return {values:[],bind(...v){this.values=v;return this;},async all(){statements.push(query);return {results:sql.prepare(query).all(...this.values)};},async first(){statements.push(query);return sql.prepare(query).get(...this.values)||null;},async run(){const r=sql.prepare(query).run(...this.values);return {meta:{changes:r.changes}};}};}
const adapter={prepare,async batch(items){sql.exec('BEGIN IMMEDIATE');try{const rows=[];for(const item of items)rows.push(await item.run());sql.exec('COMMIT');return rows;}catch(e){sql.exec('ROLLBACK');throw e;}},async portfolioReadVersion(){return JSON.stringify(sql.prepare('SELECT data_revision,scope_revision FROM portfolio_revision').get());}};
globalThis.__interactionDb=adapter;
const plugin={name:'fixture-server',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`import {createHash} from 'node:crypto';export const db=()=>globalThis.__interactionDb;export const isGlobalManager=u=>u.role==='manager'&&u.managerScope==='global';export const sha256=s=>createHash('sha256').update(s).digest('hex');export const textField=v=>v;export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};`}));}};
async function load(name,contents){const out=join(dir,name+'.mjs');await build({stdin:{contents,resolveDir:resolve('lib'),loader:'ts'},outfile:out,bundle:true,format:'esm',platform:'node',plugins:[plugin],logLevel:'silent'});return import(pathToFileURL(out));}
try{
 sql.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
 sql.exec("ALTER TABLE users ADD COLUMN manager_scope TEXT DEFAULT 'assigned';CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);CREATE TABLE partner_requests(id TEXT,customer_id TEXT,status TEXT,confirmed_at TEXT,payload TEXT);");
 for(const f of ['0006_partner_portfolio.sql','0007_partner_day_plans.sql','0008_partner_map_index.sql','0009_portfolio_read_model.sql'])sql.exec(readFileSync('drizzle/'+f,'utf8'));
 sql.prepare('INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,manager_scope) VALUES(?,?,?,?,?,?,0,1,?)').run('agent','agent','Agent','agent','w','not-a-credential','assigned');
 const insert=sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)');
 for(let i=0;i<320;i++){const c={id:'p'+String(i).padStart(6,'0'),warehouseId:'w',warehouseIds:['w'],name:'Synthetic '+i,cui:'TEST-'+i,address:'Example '+i,city:i%2?'City A':'City B',county:'County',route:i%3?'R1':'R2'};insert.run(c.id,'w',JSON.stringify(c));}
 const model=await load('model',readFileSync('lib/portfolio-read-model.ts','utf8'));
 const user={id:'agent',role:'agent',warehouseId:'w'};
 await model.readyReadModel();
 const period=new URLSearchParams({salesPeriod:'year:2026'});
 assert.equal((await model.pagedBrowse(user,period,undefined,0,100,['p000001'])).total,1);
 assert.equal((await model.pagedBrowse(user,period,undefined,0,100,[])).total,0,'changed validated billing membership cannot return an old cached page');
 assert.equal((await model.pagedBrowse(user,period,undefined,0,100)).total,320,'undefined selection differs from an explicitly empty selection');
 const RealDate=Date,base=RealDate.now();
 sql.prepare('UPDATE portfolio_read_rows SET last_visited_at=? WHERE id=?').run(new RealDate(base-7*86400000+60000).toISOString(),'p000001');
 const days=new URLSearchParams({q:'p000001',days:'7'});
 assert.equal((await model.pagedBrowse(user,days,undefined,0,100)).total,0);
 globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[base+120000]));}static now(){return base+120000;}};
 try{assert.equal((await model.pagedBrowse(user,days,undefined,0,100)).total,1,'rolling threshold advances without a portfolio write');}finally{globalThis.Date=RealDate;}
 await model.pagedBrowse(user,new URLSearchParams({q:'synthetic'}),undefined,0,100);
 statements=[];
 await model.pagedBrowse(user,new URLSearchParams({q:'0002'}),undefined,0,100);
 assert.equal(statements.filter(s=>s.includes('SELECT DISTINCT')).length,0,'query change reuses same-scope facet values');
 statements=[];
 const candidates=await model.selectedBillingCandidates(user,new URLSearchParams());
 assert.equal(candidates.length,320);assert.deepEqual(Object.keys(candidates[0]).sort(),['cui','id']);
 assert(!statements.some(s=>s.startsWith('SELECT m.summary')),'billing candidate path does not load complete summaries');
 statements=[];await model.selectedBillingCandidates(user,new URLSearchParams());
 assert(!statements.some(s=>s.startsWith('SELECT m.id,COALESCE')),'stable candidate identity projection is reused');
 const external=new DatabaseSync(file);external.prepare("UPDATE customers SET data=json_set(data,'$.county','New County') WHERE id='p000001'").run();external.close();
 assert((await model.pagedBrowse(user,new URLSearchParams(),undefined,0,100)).facets.counties.includes('New County'),'external writes invalidate cached facets');
 assert.equal((await model.pagedBrowse({...user,warehouseId:'other'},new URLSearchParams(),undefined,0,100)).total,0,'cache does not cross warehouse scope');
 const {createReadProjectionCache}=await load('bounded-cache',readFileSync('lib/read-projection-cache.ts','utf8'));
 const cache=createReadProjectionCache(1024,4);cache.put('expiring','v',{value:1},1);
 await new Promise(r=>setTimeout(r,5));assert.equal(cache.get('expiring','v'),undefined,'TTL is enforced independently of data revision');
 console.log('PASS: interaction backend billing membership, clock boundaries, facet reuse, identity projection, external invalidation, scope and TTL.');
}finally{sql.close();rmSync(dir,{recursive:true,force:true});delete globalThis.__interactionDb;}
