import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'mobile-read-model-')),file=join(dir,'test.sqlite'),sql=new DatabaseSync(file);let queries=0;
function prepare(query){return {values:[],bind(...v){this.values=v;return this;},async all(){queries++;return {results:sql.prepare(query).all(...this.values)};},async first(){queries++;return sql.prepare(query).get(...this.values)||null;},async run(){queries++;const r=sql.prepare(query).run(...this.values);return {meta:{changes:r.changes}};}};}
const adapter={prepare,async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const rows=[];for(const s of statements)rows.push(await s.run());sql.exec('COMMIT');return rows;}catch(e){sql.exec('ROLLBACK');throw e;}},async portfolioReadVersion(){return JSON.stringify(sql.prepare('SELECT data_revision,scope_revision FROM portfolio_revision').get());}};
globalThis.__mobileDb=adapter;
const plugin={name:'fixture-server',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`import {createHash} from 'node:crypto';export const db=()=>globalThis.__mobileDb;export const isGlobalManager=u=>u.role==='manager'&&u.managerScope==='global';export const sha256=s=>createHash('sha256').update(s).digest('hex');export const textField=v=>v;export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};`}));}};
async function load(name,contents){const out=join(dir,name+'.mjs');await build({stdin:{contents,resolveDir:resolve('lib'),loader:'ts'},outfile:out,bundle:true,format:'esm',platform:'node',plugins:[plugin],logLevel:'silent'});return import(pathToFileURL(out));}
try{
 sql.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));sql.exec("ALTER TABLE users ADD COLUMN manager_scope TEXT DEFAULT 'assigned';CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);CREATE TABLE partner_requests(id TEXT,customer_id TEXT,status TEXT,confirmed_at TEXT,payload TEXT);");
 for(const f of ['0006_partner_portfolio.sql','0007_partner_day_plans.sql','0008_partner_map_index.sql','0009_portfolio_read_model.sql'])sql.exec(readFileSync('drizzle/'+f,'utf8'));
 sql.prepare('INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,manager_scope) VALUES(?,?,?,?,?,?,0,1,?)').run('agent','agent','Agent','agent','w','not-a-credential','assigned');
 sql.exec('BEGIN');const insert=sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)');for(let i=0;i<40020;i++){const c={id:'p'+String(i).padStart(6,'0'),warehouseId:'w',warehouseIds:['w'],name:'Șynthetic '+String(i).padStart(6,'0'),cui:'TEST-'+i,address:'Example '+i,city:i%2?'City A':'City B',county:'County',route:i%3?'R1':'R2'};insert.run(c.id,'w',JSON.stringify(c));}sql.exec('COMMIT');
 const model=await load('model',readFileSync('lib/portfolio-read-model.ts','utf8'));
 const legacy=await load('legacy',execFileSync('git',['show','33d012e:lib/partner-portfolio.ts'],{encoding:'utf8'}));
 const user={id:'agent',role:'agent',warehouseId:'w'};
 const t=performance.now();const first=await model.pagedBrowse(user,new URLSearchParams(),undefined,0,100);assert.equal(first.total,40020);assert.equal(first.partners.length,100);const cold=performance.now()-t;
 console.log('read model first page complete',cold);const before=await legacy.portfolioSummary(user);console.log('legacy read complete');const after=await model.selectedSummaries(user,new URLSearchParams());assert.deepEqual(JSON.parse(JSON.stringify(after)),JSON.parse(JSON.stringify(before)),'canonical HTTP projection parity');
 const q=new URLSearchParams({city:'city a',route:'R1'});const filtered=await model.pagedBrowse(user,q,undefined,100,100);const expected=before.filter(p=>p.city.toLowerCase().includes('city a')&&p.route==='R1');assert.equal(filtered.total,expected.length);assert.deepEqual(JSON.parse(JSON.stringify(filtered.partners)),JSON.parse(JSON.stringify(expected.slice(100,200))));
 assert.deepEqual(first.facets.cities,['City A','City B']);assert.equal(first.nextOffset,100);
 const warmAt=performance.now();const warm=await model.pagedBrowse(user,new URLSearchParams(),undefined,0,100);const warmMs=performance.now()-warmAt;assert.deepEqual(warm,first);
 sql.prepare("INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run('p000002','w',JSON.stringify({id:'p000002',warehouseId:'w',name:'Upsert',city:'City B',county:'County',route:'R1'}));sql.prepare("INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run('p000002','w',JSON.stringify({id:'p000002',warehouseId:'w',name:'Upsert',city:'City B',county:'County',route:'R1'}));assert.equal((await model.pagedBrowse(user,new URLSearchParams({q:'Upsert'}),undefined,0,100)).total,1);
 // Rebuild old projection and verify aliases/membership without changing authoritative cards.
 const facetRows=[['OLT','1'],['Olt','1, 11'],['Iasi','11, 1'],['Iași','11'],['Bucuresti','2, 7, 17, 12'],['Municipiul Bucuresti','12, 7, 2, 17'],['SB',' 11 ,\t1\n, 1'],['Sibiu','17, 12, 7, 2'],['Unknown','01'],['UNKNOWN','1']];
 for(const [i,[county,route]] of facetRows.entries())insert.run('facet-'+i,'w',JSON.stringify({id:'facet-'+i,name:'Facet synthetic '+i,county,route,address:'Synthetic',city:'City',cui:'SYN'+i}));
 sql.exec('UPDATE portfolio_model_state SET version=1');
 const rawBefore=sql.prepare("SELECT data FROM customers WHERE id LIKE 'facet-%' ORDER BY id").all();
 for(const [a,b] of [['OLT','Olt'],['Iasi','Iași'],['Bucuresti','Municipiul Bucuresti'],['SB','Sibiu']]){
   const read=county=>model.pagedBrowse(user,new URLSearchParams({county}),undefined,0,100);
   assert.deepEqual((await read(a)).partners,(await read(b)).partners);assert.equal((await read(a)).total,2);
 }
 const routeOne=await model.pagedBrowse(user,new URLSearchParams({q:'Facet synthetic',route:'1'}),undefined,0,100);
 assert.deepEqual(routeOne.partners.map(p=>p.id),['facet-0','facet-1','facet-2','facet-6','facet-9']);
 assert.equal((await model.pagedBrowse(user,new URLSearchParams({route:'17'}),undefined,0,100)).total,3);
 assert.equal((await model.pagedBrowse(user,new URLSearchParams({route:' '}),undefined,0,100)).total,0);
 assert(routeOne.facets.routes.includes('1'));assert(!routeOne.facets.routes.some(r=>r.includes(',')));
 assert.equal((await model.pagedBrowse(user,new URLSearchParams({county:'Unknown'}),undefined,0,100)).total,1);
 assert.equal((await model.pagedBrowse(user,new URLSearchParams({q:'Sibiu'}),undefined,0,100)).total,2);
 assert.deepEqual(sql.prepare("SELECT data FROM customers WHERE id LIKE 'facet-%' ORDER BY id").all(),rawBefore);
 sql.exec("DELETE FROM customers WHERE id LIKE 'facet-%'");
 const version=await model.portfolioVersion();sql.exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('synthetic-token','agent',0);UPDATE sessions SET expires_at=1");assert.equal(await model.portfolioVersion(),version,'session writes do not invalidate portfolio');
 const external=new DatabaseSync(file);external.prepare("UPDATE customers SET data=json_set(data,'$.name','Changed') WHERE id='p000000'").run();external.close();assert.notEqual(await model.portfolioVersion(),version,'external writer trigger');const changed=await model.pagedBrowse(user,new URLSearchParams({q:'Changed'}),undefined,0,100);assert.equal(changed.total,1);assert.equal(changed.partners[0].name,'Changed');
 sql.prepare("DELETE FROM customers WHERE id='p000001'").run();assert.equal((await model.pagedBrowse(user,new URLSearchParams(),undefined,0,100)).total,40019);
 sql.prepare("UPDATE users SET warehouse_id=NULL WHERE id='agent'").run();assert.equal((await model.pagedBrowse({...user,warehouseId:null},new URLSearchParams(),undefined,0,100)).total,0);
 const aggregate=await load('aggregate',readFileSync('lib/partner-map-aggregation.ts','utf8'));
 const points={type:'FeatureCollection',features:Array.from({length:100000},(_,i)=>({type:'Feature',id:'f'+i,geometry:{type:'Point',coordinates:[i%2?179.9:-179.9,44+i%100/100000]},properties:{id:'f'+i,name:'Synthetic',approximate:i%2===0}}))};
 const low=aggregate.aggregateMapPoints(points,4);assert.equal(low.totalPoints,100000);assert.equal(low.features.reduce((n,f)=>n+(f.properties.point_count||1),0),100000);assert.ok(low.features.length<10);assert.equal(aggregate.aggregateMapPoints(points,17).features.length,100000);assert.throws(()=>aggregate.aggregateMapPoints(points,NaN));
 console.log(JSON.stringify({status:'PASS',rows:40020,coldMs:Math.round(cold),warmMs:Math.round(warmMs*100)/100,pageBytes:JSON.stringify(first).length,rawMapBytes:JSON.stringify(points).length,clusterBytes:JSON.stringify(low).length,readModel:model.readModelMetrics,queries}));
}finally{sql.close();rmSync(dir,{recursive:true,force:true});delete globalThis.__mobileDb;}
