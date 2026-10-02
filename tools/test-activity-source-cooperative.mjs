// Standalone synthetic HTTP/adaptor regression. No stockqa, resources, build or network services.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,copyFileSync,renameSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {createClientSalesFixture} from './client-sales-fixture.mjs';
const root=mkdtempSync(join(tmpdir(),'activity-cooperative-')),previous=process.env.MOBIUP_DATA_DIR;
process.env.MOBIUP_DATA_DIR=root;
const NativeDate=Date;
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-30T12:00:00Z']));}};
const sql=new DatabaseSync(join(root,'mobiup.sqlite'));
let server,prepareHook;
const originalPrepare=DatabaseSync.prototype.prepare;
try{
 sql.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
 sql.exec("ALTER TABLE users ADD COLUMN manager_scope TEXT DEFAULT 'assigned';ALTER TABLE users ADD COLUMN site_code TEXT;CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);CREATE TABLE partner_requests(id TEXT,customer_id TEXT,status TEXT,confirmed_at TEXT,payload TEXT);");
 for(const f of ['0006_partner_portfolio.sql','0007_partner_day_plans.sql','0008_partner_map_index.sql','0009_portfolio_read_model.sql'])sql.exec(readFileSync('drizzle/'+f,'utf8'));
 for(const [id,role,warehouse] of [['agent','agent','g-5'],['other','agent','g-3'],['manager','manager','']])sql.prepare('INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,manager_scope) VALUES(?,?,?,?,?,?,0,1,?)').run(id,id,'Synthetic '+id,role,warehouse,'not-a-credential','global');
 const {partners}=createClientSalesFixture(root,true);
 for(const p of partners)sql.prepare("INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,address_fingerprint,revision,updated_at) VALUES(?,44.4,26.1,'manual',?,1,'2026-09-30')").run(p.id,createHash('sha256').update(JSON.stringify([p.address,p.city,p.county])).digest('hex'));
 function prepare(query){return {values:[],bind(...values){this.values=values;return this;},async all(){const results=sql.prepare(query).all(...this.values);await prepareHook?.(query);return {results};},async first(){const result=sql.prepare(query).get(...this.values)||null;await prepareHook?.(query);return result;},async run(){return {meta:{changes:sql.prepare(query).run(...this.values).changes}};}};}
 const adapter={prepare,async batch(items){sql.exec('BEGIN IMMEDIATE');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}},portfolioReadVersion:true};
 globalThis.__activityTestDb=adapter;
 const plugin={name:'synthetic-server',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`import {createHash} from 'node:crypto';export const db=()=>globalThis.__activityTestDb;export const isGlobalManager=u=>u.role==='manager';export const sha256=s=>createHash('sha256').update(s).digest('hex');export const textField=v=>v;export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};`}));}};
 const output=join(root,'api.mjs');const built=await build({stdin:{contents:"export * from './lib/partner-activity-api';export * from './lib/partner-map-api';export * from './lib/partner-activity-snapshot';export * from './lib/partner-billing-period';export * from './lib/history-source-stamp';export * from './lib/partner-portfolio';export * from './lib/portfolio-read-model';export * from './lib/client-sales-store';",resolveDir:process.cwd(),loader:'ts'},outfile:output,bundle:true,format:'esm',platform:'node',plugins:[plugin],metafile:true,logLevel:'silent'});
 // Type-check the actual dependency sources in an isolated mirror, with the same
 // typed D1 adapter boundary as HTTP (no private resource imports or emitted files).
 const types=join(root,'types');mkdirSync(types);symlinkSync(resolve('node_modules'),join(types,'node_modules'),'dir');
 for(const file of [...Object.keys(built.metafile.inputs).filter(f=>f.startsWith('lib/')&&f.endsWith('.ts')),'lib/types.ts','lib/partner-map-types.ts','lib/partner-portfolio-types.ts']){const target=join(types,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);}
 writeFileSync(join(types,'lib/server.ts'),`export declare const db:()=>D1Database;export declare const fail:(status:number,message:string)=>never;export declare const isGlobalManager:(u:import('./types').User)=>boolean;export declare const sha256:(s:string)=>string;export declare const textField:(v:unknown,max:number)=>string;`);
 writeFileSync(join(types,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2017',lib:['dom','dom.iterable','esnext'],module:'esnext',moduleResolution:'bundler',types:['node','@cloudflare/workers-types'],strict:true,skipLibCheck:true,noEmit:true},files:['lib/partner-activity-snapshot.ts','lib/partner-activity-api.ts','lib/partner-map-api.ts']}));
 execFileSync(resolve('node_modules/.bin/tsc'),['--project',join(types,'tsconfig.json')],{stdio:'inherit'});
 const m=await import(pathToFileURL(output));
 const history=join(root,'client-history/client-sales-history.sqlite'),derived=join(root,'client-history/partner-activity.sqlite');
 const c=new DatabaseSync(history);c.exec('ALTER TABLE history_references ADD COLUMN partners_json TEXT');
 // Generate the large reference once. Multibyte boundaries must match the old hash.
 c.prepare('UPDATE history_references SET partners_json=?').run(JSON.stringify({partners,historySourceIdentities:[],syntheticComment:'x'.repeat(1024*1024-2)+'ș😀'.repeat(Math.ceil(50*1024*1024/6))}));
 const referenceBytes=c.prepare('SELECT length(CAST(master_json AS BLOB))+length(CAST(partners_json AS BLOB)) n FROM history_references').get().n;
 assert(referenceBytes>50*1024*1024);
 const steps=m.historyStampSteps(c);let step;do{step=steps.next();}while(!step.done);assert.deepEqual(step.value,m.historyStamp(c));c.close();
 m.buildActivitySnapshot(root,'2026-09-30');
 const user={id:'agent',role:'agent',warehouseId:'g-5',managerScope:'assigned'},manager={id:'manager',role:'manager',warehouseId:'',managerScope:'global'};
 const visible=await m.portfolioSummary(user),period='year:2026',options={period,scope:'company'};
 const expected=m.readActivitySnapshot(visible,root,'2026-09-30',options);assert.equal(expected.state,'ready');assert(!expected.rows.has('monthly-hidden'));
 assert.equal(expected.rows.get('monthly-same-day').activity.billingDays,1);assert.equal(expected.metrics.get('monthly-same-day').documents,2);
 const expectedIds=m.selectBillingPeriod(visible,expected,period).map(p=>p.id).sort();
 await m.readyReadModel();
 let forbidden=true;
 DatabaseSync.prototype.prepare=function(query){if(forbidden)assert(!/SELECT \* FROM history_references|SELECT master_json FROM history_references|FROM history_allocations|FROM history_identities/i.test(query),'HTTP cannot parse/index/hash the entire national source synchronously');return originalPrepare.call(this,query);};
 const invoke=(kind,params=new URLSearchParams('salesPeriod='+period),who=user)=>kind==='activity'?m.partnerActivityOverview(who,params):kind==='browse'?m.browsePartners(who,params):m.mapPartners(who,params);
 server=createServer(async(req,res)=>{if(req.url==='/health'){res.end('ok');return;}try{const url=new URL(req.url,'http://localhost'),kind=url.pathname.slice(1);res.setHeader('Content-Type','application/json');const result=kind==='large'?await m.readActivitySnapshotAsync(Array.from({length:25000},(_,i)=>({id:'visible-'+i,cui:'100'})),root,'2026-09-30',options):await invoke(kind,url.searchParams);res.end(JSON.stringify(kind==='large'&&result.state==='ready'?{state:result.state,rowCount:result.rows.size,metricCount:result.metrics.size,first:result.metrics.get('visible-0'),last:result.rows.get('visible-24999')?.id}:result));}catch(e){res.statusCode=e.status||500;res.end(JSON.stringify({error:e.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const cold=()=>{copyFileSync(derived,derived+'.new');renameSync(derived+'.new',derived);};
 async function wave(label,kinds,coldExpected){
   const before=m.clientSalesCacheStats.stampBuilds,start=performance.now(),latencies=[];let done=false,during=0;
   const light=(async()=>{while(!done){const at=performance.now();assert.equal(await(await fetch(origin+'/health')).text(),'ok');latencies.push(performance.now()-at);if(!done)during++;await new Promise(r=>setTimeout(r,5));}})();
   const results=await Promise.all(kinds.map(async kind=>{const response=await fetch(origin+'/'+kind+'?salesPeriod='+period);assert.equal(response.status,200);return response.json();}));done=true;await light;
   for(const [i,result] of results.entries()){
     assert(!JSON.stringify(result).includes('monthly-hidden'),'no national card leak');
     if(kinds[i]==='large'){assert.equal(result.state,'ready');assert.equal(result.rowCount,25000);assert.equal(result.metricCount,25000);assert.deepEqual(result.first,expected.metrics.get('monthly-a'));assert.equal(result.last,'visible-24999');}
     if(kinds[i]==='browse')assert.deepEqual(result.partners.map(p=>p.id).sort(),expectedIds);
     if(kinds[i]==='map')assert.deepEqual(result.features.map(p=>p.id).sort(),expectedIds);
     if(kinds[i]==='activity'){
       assert.equal(result.total,new Set(expectedIds.map(id=>expected.rows.get(id)?.cui||id)).size);
       for(const row of result.partners){assert.deepEqual(row.metrics,expected.metrics.get(row.partner.id));assert.deepEqual(row.sales,expected.rows.get(row.partner.id));}
     }
   }
   assert.equal(m.clientSalesCacheStats.stampBuilds-before,Number(coldExpected),'all routes share one fingerprint flight');
   if(coldExpected)assert(during>=4,'control requests complete throughout cold hashing');
   const worst=Math.max(...latencies);assert(worst<250,`health stalled for ${worst}ms`);
   console.log(JSON.stringify({label,requests:kinds.length,referenceMiB:Math.round(referenceBytes/1024/1024),elapsedMs:Math.round(performance.now()-start),healthSamples:during,worstHealthMs:Math.round(worst)}));
 }
 await wave('cold mixed HTTP',['activity','activity','browse','map'],true);
 await wave('warm mixed HTTP',['activity','activity','browse','map'],false);
 cold();await wave('cold browse/map HTTP',['browse','map','browse','map'],true);
 await wave('warm large scoped reader',['large','large','large','large'],false);
 // Exact reader parity, including point/company, incomplete/unknown and empty periods.
 forbidden=false;
 for(const scope of ['point','company'])for(const selectedPeriod of ['',period,'year:2025','recent90','recent365','older365','unknown']){
   const opts={period:selectedPeriod,scope};assert.deepEqual(await m.readActivitySnapshotAsync(visible,root,'2026-09-30',opts),m.readActivitySnapshot(visible,root,'2026-09-30',opts));
 }
 assert.equal((await m.readActivitySnapshotAsync(visible,root,'2026-09-29',options)).state,'unavailable','same asOf required');
 for(const selectedPeriod of ['unknown','older365','year:2025','recent90']){
   const p=new URLSearchParams('salesPeriod='+selectedPeriod),want=m.selectBillingPeriod(visible,m.readActivitySnapshot(visible,root,'2026-09-30',{period:selectedPeriod,scope:'company'}),selectedPeriod).map(p=>p.id).sort();
   assert.deepEqual((await invoke('browse',p)).partners.map(p=>p.id).sort(),want);assert.deepEqual((await invoke('map',p)).features.map(p=>p.id).sort(),want);
 }
 const filtered=await invoke('activity',new URLSearchParams('agentId=agent&salesPeriod='+period),manager);assert(!JSON.stringify(filtered).includes('monthly-hidden'));
 await assert.rejects(invoke('activity',new URLSearchParams('agentId=other')),e=>e.status===403);
 for(const kind of ['activity','browse','map'])await assert.rejects(invoke(kind,new URLSearchParams('salesPeriod=bad')),e=>e.status===400);
 // Mutation at an actual cooperative source boundary (not a timer guess).
 async function duringHash(kind,change){
   cold();let fired=false;const original=DatabaseSync.prototype.prepare;
   DatabaseSync.prototype.prepare=function(query){const statement=original.call(this,query);if(query.includes('substr(CAST(COALESCE(')){const get=statement.get.bind(statement);statement.get=(...args)=>{const row=get(...args);if(!fired){fired=true;setImmediate(()=>change());}return row;};}return statement;};
   try{await assert.rejects(invoke(kind),e=>[403,409,503].includes(e.status));assert(fired);}finally{DatabaseSync.prototype.prepare=original;}
 }
 for(const kind of ['activity','browse','map']){
   await duringHash(kind,()=>sql.exec("UPDATE customers SET active=0 WHERE id='monthly-a'"));sql.exec("UPDATE customers SET active=1 WHERE id='monthly-a'");
   await duringHash(kind,()=>sql.exec("UPDATE users SET active=0 WHERE id='agent'"));sql.exec("UPDATE users SET active=1 WHERE id='agent'");
   await duringHash(kind,()=>sql.exec("UPDATE users SET role='manager' WHERE id='agent'"));sql.exec("UPDATE users SET role='agent' WHERE id='agent'");
   await duringHash(kind,()=>sql.exec("UPDATE users SET warehouse_id='g-3' WHERE id='agent'"));sql.exec("UPDATE users SET warehouse_id='g-5' WHERE id='agent'");
 }
 // Legacy adapters also re-read current scope after awaiting the source.
 adapter.portfolioReadVersion=false;await duringHash('browse',()=>sql.exec("UPDATE customers SET active=0 WHERE id='monthly-a'"));sql.exec("UPDATE customers SET active=1 WHERE id='monthly-a'");
 assert.deepEqual((await invoke('map')).features.map(p=>p.id).sort(),expectedIds);adapter.portfolioReadVersion=true;
 // Reject derived replacement even after filtering, during downstream DB awaits.
 for(const [kind,queryPart] of [['browse','SELECT COUNT(*) total'],['map','SELECT m.id,m.name,m.latitude']]){
   let changed=false;prepareHook=query=>{if(!changed&&query.includes(queryPart)){changed=true;cold();}};
   await assert.rejects(invoke(kind),e=>e.status===409);prepareHook=undefined;assert(changed);
 }
 // Reject source replacement even after the reader completes, during API DB awaits.
 await m.readActivitySnapshotAsync(visible,root,'2026-09-30',options);
 let changed=false;prepareHook=query=>{if(!changed&&query.includes("SELECT id,name,warehouse_id FROM users")){changed=true;copyFileSync(history,history+'.new');renameSync(history+'.new',history);}};
 await assert.rejects(invoke('activity'),e=>e.status===409);prepareHook=undefined;assert(changed);
 const read=()=>m.readActivitySnapshotAsync(visible,root,'2026-09-30',options);
 assert.equal((await read()).state,'unavailable','raw replacement invalidates unchanged logical stamp');m.buildActivitySnapshot(root,'2026-09-30');
 for(const mutation of ["UPDATE history_rows SET value_cents=value_cents+1 WHERE source_row=1","UPDATE history_allocations SET candidates_json='[\"synthetic\"]' WHERE identity_id=1","UPDATE history_references SET master_json='[]'","UPDATE history_references SET partners_json=replace(partners_json,'syntheticComment','syntheticPadding')"]){
   const writer=new DatabaseSync(history);writer.exec('PRAGMA journal_mode=WAL');writer.exec(mutation);assert.equal((await read()).state,'unavailable','WAL/raw/reference change cannot silently become absence');writer.close();m.buildActivitySnapshot(root,'2026-09-30');assert.equal((await read()).state,'ready');
 }
 for(const [field,value] of [['version','6'],['reference','wrong'],['signature','wrong'],['sourceGeneration','wrong']]){
   const d=new DatabaseSync(derived),meta=d.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value;d.prepare("UPDATE meta SET value=? WHERE key='snapshot'").run(JSON.stringify({...JSON.parse(meta),[field]:value}));d.close();assert.equal((await read()).state,'unavailable');
   for(const kind of ['browse','map'])await assert.rejects(invoke(kind),e=>e.status===409);
   assert.equal((await invoke('activity')).state,'unavailable');const restore=new DatabaseSync(derived);restore.prepare("UPDATE meta SET value=? WHERE key='snapshot'").run(meta);restore.close();
 }
 // Replacement during warm iteration must discard partially projected membership.
 await read();const pending=m.readActivitySnapshotAsync(Array.from({length:25000},(_,i)=>({id:'visible-'+i,cui:'100'})),root,'2026-09-30',options);
 await new Promise(r=>setImmediate(r));cold();assert.equal((await pending).state,'unavailable');
 // Derived open/BEGIN race: never bless an old inode using a new pathname stamp.
 await read();copyFileSync(derived,derived+'.new');const exec=DatabaseSync.prototype.exec;let replaced=false;
 DatabaseSync.prototype.exec=function(statement){if(statement==='BEGIN'&&!replaced){replaced=true;renameSync(derived+'.new',derived);}return exec.call(this,statement);};
 try{assert.equal((await read()).state,'unavailable');assert(replaced);}finally{DatabaseSync.prototype.exec=exec;}
 cold();const builds=m.clientSalesCacheStats.stampBuilds;const [activity,monthly]=await Promise.all([read(),m.readClientSalesAsync(visible,'2026-09',root,'2026-09-30')]);assert.equal(activity.state,'ready');assert.equal(monthly.state,'ready');assert.equal(m.clientSalesCacheStats.stampBuilds,builds+1);
 console.log('PASS: scoped sync parity, HTTP activity/browse/map responsiveness, shared stamp, same-date semantics, live ACL/portfolio and raw/WAL/reference/derived generation fences; no stale membership or false absence.');
}finally{
 DatabaseSync.prototype.prepare=originalPrepare;globalThis.Date=NativeDate;
 if(server)await new Promise(resolve=>server.close(resolve));sql.close();delete globalThis.__activityTestDb;
 if(previous===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previous;
 rmSync(root,{recursive:true,force:true});
}
