// Isolated synthetic SQLite fixtures; no application server, resources or real data.
import assert from 'node:assert/strict';
import {build,transform} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'import-inventory-safety-'));
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,warehouse_id TEXT,active INTEGER);
CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
CREATE TABLE partner_requests(id TEXT PRIMARY KEY,customer_id TEXT,payload TEXT,status TEXT,confirmed_at TEXT);`);
sqlite.exec(readFileSync('drizzle/0006_partner_portfolio.sql','utf8'));
sqlite.exec(readFileSync('drizzle/0011_partner_visit_follow_up.sql','utf8'));
let beforeBatch;
const adapter={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async all(){return {results:sqlite.prepare(sql).all(...this.args)};},async first(){return sqlite.prepare(sql).get(...this.args)||null;},async run(){return this.execute();},execute(){return {meta:sqlite.prepare(sql).run(...this.args)};}};},async batch(statements){beforeBatch?.();beforeBatch=undefined;sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
globalThis.__safetyDb=adapter;
const server=readFileSync('lib/server.ts','utf8');
// Exercise the real authorization functions, using only the isolated DB adapter.
const auth=server.slice(server.indexOf('export function isGlobalManager'),server.indexOf('export function assertOrigin'));
const stub=`import {createHash} from 'node:crypto';
export const db=()=>globalThis.__safetyDb;
export function fail(status,message){throw Object.assign(new Error(message),{status});}
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const textField=(v,n=1000)=>typeof v==='string'?v.trim().slice(0,n):'';
export const jsonBody=req=>req.json();export const response=data=>Response.json(data);
${auth}`;
const plugin={name:'isolated-fixtures',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'fixture'}));b.onResolve({filter:/^\.\/(catalog|stock-server)$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'ts',contents:a.path==='server'?stub:a.path==='./catalog'?'export const readCatalog=async()=>({products:[]});':'export const stockForWarehouse=async()=>({rows:[]});'}));}};
const load=async file=>{const outfile=join(dir,file+'.mjs');await build({entryPoints:['lib/'+file+'.ts'],outfile,bundle:true,platform:'node',format:'esm',plugins:[plugin],logLevel:'silent'});return import(pathToFileURL(outfile));};
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const reject=async(fn,status=409)=>{await assert.rejects(fn,e=>e.status===status);checks++;};
const point=(address='Test 1',cui='991001')=>({name:'Synthetic Shop',cui,city:'Test City',county:'Test County',address,route:'1'});
const insert=(id,c,active=1,w='w1')=>sqlite.prepare('INSERT INTO customers VALUES(?,?,?,?)').run(id,w,JSON.stringify({id,warehouseId:w,...c}),active);
const rows=()=>sqlite.prepare('SELECT * FROM customers ORDER BY id').all();
const reset=()=>sqlite.exec('DELETE FROM partner_visits; DELETE FROM partner_profiles; DELETE FROM customers');
try {
 const {importClients}=await load('client-import-server');
 const preview=async clients=>(await importClients('w1',{clients,preview:true})).preview;
 const commit=(clients,p,remove=false)=>importClients('w1',{clients,snapshot:p.snapshot,...remove?{confirmRemovals:p.snapshot}:{}});
 const simple=await importClients('w1',{clients:[point()]});check(simple.count===1,'simple new portfolio works');
 reset();insert('stable',{...point(),profile:{note:'Synthetic profile'},pin:{lat:1,lng:2},custom:'keep',route:'9'});
 const p=await preview([{...point(),cui:'RO 991001',city:' TEST CITY ',route:''}]);
 check(p.unchanged[0].id==='stable'&&!p.removed.length,'normalized exact identity retained');
 await commit([{...point(),cui:'RO 991001',city:' TEST CITY ',route:''}],p);
 const retained=JSON.parse(rows()[0].data);check(retained.custom==='keep'&&retained.profile.note==='Synthetic profile'&&retained.pin.lat===1&&retained.route==='9','all extra fields and empty optional fields preserved');
 // Exercise the real profile table, address-change trigger and public projection,
 // not just inline fields carried in the customer JSON.
 reset();insert('stable',point());
 const {createHash}=await import('node:crypto');
 const fp=createHash('sha256').update(JSON.stringify([point().address,point().city,point().county])).digest('hex');
 sqlite.prepare('INSERT INTO partner_profiles(customer_id,contact,latitude,longitude,position_source,position_metadata,address_fingerprint,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('stable','Actual profile',44.4,26.1,'manual',JSON.stringify({positionQuality:'locality_approximate'}),fp,new Date().toISOString());
 const {partnerDetail}=await load('partner-portfolio');
 const caller={id:'reader',role:'manager',managerScope:'global'};
 const profileBefore=(await partnerDetail(caller,'stable',null)).partner;
 const spelling=[{...point(),address:'  TEST  1 ',city:'TEST CITY',county:'TEST COUNTY'}];
 await commit(spelling,await preview(spelling));
 const profileAfter=(await partnerDetail(caller,'stable',null)).partner;
 check(profileAfter.id===profileBefore.id&&profileAfter.latitude===44.4&&profileAfter.longitude===26.1,'normalized reimport preserves actual public pin');
 check(profileAfter.positionQuality==='locality_approximate'&&profileAfter.contact==='Actual profile'&&profileAfter.addressFingerprint===fp,'normalized reimport preserves actual metadata, contact and fingerprint');
 check(profileAfter.address===point().address&&profileAfter.city===point().city&&profileAfter.county===point().county,'raw address identity remains unchanged on exact normalized match');
 const changed=await preview([point('Test 2')]);check(changed.ambiguous.length===1&&changed.blocked.some(s=>s.includes('editează mai întâi')),'address change fails closed with edit instruction');
 const before=JSON.stringify(rows());await reject(()=>commit([point('Test 2')],changed,true));check(JSON.stringify(rows())===before,'profile/pin and original remain untouched');
 const incomplete=await preview([{...point(),address:'',county:''}]);check(incomplete.ambiguous.length===1,'missing point fields never replace known identity');
 insert('dropped',{...point('Other','991002'),extra:'preserved'});
 const removal=await preview([point()]);check(removal.removed.some(c=>c.id==='dropped'),'omitted incomplete spreadsheet row is explicit missing point');
 await reject(()=>commit([point()],removal));await reject(()=>importClients('w1',{clients:[point()],snapshot:removal.snapshot,confirmRemovals:'wrong'}));await commit([point()],removal,true);
 check(rows().find(r=>r.id==='dropped').active===0&&JSON.parse(rows().find(r=>r.id==='dropped').data).extra==='preserved','confirmed removal retains all data');
 const reactivate=await preview([point(),point('Other','991002')]);await commit([point(),point('Other','991002')],reactivate);check(rows().length===2&&rows().find(r=>r.id==='dropped').active===1,'inactive exact identity reuses preserved ID');
 reset();insert('original',point());const multi=await preview([point(),point('Test 2')]);check(multi.added.length===1&&!multi.ambiguous.length,'new same-CUI point with original exact identity coexists');await commit([point(),point('Test 2')],multi);check(rows().length===2,'distinct points never merge by CUI');
 reset();insert('a',point());insert('b',point());const duplicate=await preview([point()]);check(duplicate.ambiguous.length===1,'duplicate persisted exact identity is ambiguous');await reject(()=>commit([point()],duplicate));
 for(const mutation of ['data','active','ownership','insert'])for(const timing of ['after-preview','before-batch']){
  reset();insert('stable',point());const clients=[point(),point('New','991003')],p=await preview(clients);
  const mutate=()=>{if(mutation==='insert')insert('concurrent',point('Concurrent','991004'));else if(mutation==='data')sqlite.prepare("UPDATE customers SET data=json_set(data,'$.extra','concurrent') WHERE id='stable'").run();else if(mutation==='active')sqlite.prepare("UPDATE customers SET active=0 WHERE id='stable'").run();else sqlite.prepare("UPDATE customers SET warehouse_id='w2' WHERE id='stable'").run();};
  let expected;if(timing==='after-preview'){mutate();expected=JSON.stringify(rows());}else beforeBatch=()=>{mutate();expected=JSON.stringify(rows());};
  await reject(()=>commit(clients,p,true));check(JSON.stringify(rows())===expected,`${mutation} ${timing}: complete atomic rejection, no new record`);
 }
 reset();insert('inactive-shared',{...point('Historical','991009'),warehouseIds:['w1','w2']},0);
 const unrelated=await preview([point('New','991010')]);check(!unrelated.blocked.length,'unrelated inactive shared history permits a new independent portfolio');
 await commit([point('New','991010')],unrelated);check(rows().find(r=>r.id==='inactive-shared').active===0,'inactive shared history stays untouched');
 const sharedReactivation=await preview([point('Historical','991009')]);check(sharedReactivation.blocked.length>0,'shared inactive identity reactivation remains protected');
 for(const primary of ['w1','w2']){reset();insert('shared',{...point(),warehouseIds:['w1','w2']},1,primary);const p=await preview([point()]);check(p.blocked.length>0,'shared membership blocked regardless of primary');const before=JSON.stringify(rows());await reject(()=>commit([point()],p,true));check(JSON.stringify(rows())===before,'shared portfolio unchanged');}
 reset();const generated='imp-'+(await import('node:crypto')).createHash('sha256').update('w1|991001|TEST COUNTY|TEST CITY|TEST 1').digest('hex').slice(0,32);insert(generated,point(),1,'w2');const moved=await preview([point()]);await reject(()=>commit([point()],moved));check(rows()[0].warehouse_id==='w2','moved generated ID cannot be reclaimed');
 reset();insert('stable',{...point(),profile:{note:'keep'},pin:{lat:1,lng:2}});
 sqlite.prepare("UPDATE customers SET data=json_set(data,'$.address','Test 2') WHERE id='stable'").run();
 const edited=await preview([point('Test 2')]);await commit([point('Test 2')],edited);check(rows()[0].id==='stable'&&JSON.parse(rows()[0].data).pin.lat===1,'editing known address first permits reimport with same ID and profile');
 const triggerPreview=await preview([point('Test 2')]);const triggerBefore=JSON.stringify(rows());
 sqlite.exec("CREATE TRIGGER force_transfer BEFORE UPDATE OF active ON customers WHEN OLD.id='stable' BEGIN UPDATE customers SET warehouse_id='w2' WHERE id=OLD.id; END");
 try{await reject(()=>commit([point('Test 2')],triggerPreview));check(JSON.stringify(rows())===triggerBefore,'mid-transaction ownership mutation rolls back whole import');}finally{sqlite.exec('DROP TRIGGER force_transfer');}
 const {inventories}=await load('inventory-server');
 sqlite.exec("INSERT INTO users VALUES('a','agent','w1',1),('b','agent','w2',1),('c','agent','w1',1); INSERT INTO manager_agents VALUES('m','a');");
 const manager={id:'m',role:'manager',managerScope:'assigned'},agent={id:'a',role:'agent',warehouseId:'w1'};
 const make=(warehouseId,createdBy,status='draft')=>{const r={id:randomUUID(),warehouseId,createdBy,status,revision:1,lines:[],operations:[],createdAt:new Date().toISOString()};sqlite.prepare('INSERT INTO settings VALUES(?,?)').run('inventory-v1:'+r.id,JSON.stringify(r));return r;};
 const outside=make('w2','b'),inside=make('w1','a'),other=make('w1','c'),final=make('w1','a','finalized');
 const req=(method='GET',body,w='w1')=>new Request('http://fixture.invalid/api/inventory?warehouseId='+w,{method,...body?{body:JSON.stringify(body)}:{}});
 const get=async(user,r)=>(await (await inventories(req(),user,r.id)).json()).inventory;
 const out=await get(manager,outside);check(!out.canEdit&&!out.canDelete,'national outside scope detail read200 has no write capabilities');
 for(const method of ['PATCH','DELETE'])await reject(()=>inventories(req(method,{revision:1,action:'cancel',operationId:randomUUID()}),manager,outside.id),404);
 const list=await (await inventories(req('GET',null,'w2'),manager)).json();check(list.inventories.length===1&&!list.inventories[0].canEdit&&!list.inventories[0].canDelete,'national summaries outside scope read-only');
 check((await get(manager,inside)).canEdit&&(await get(manager,inside)).canDelete,'within scope editable and deletable');
 check(!(await get(manager,final)).canEdit&&(await get(manager,final)).canDelete,'finalized preserves existing delete right but disables edits');
 check((await get(agent,inside)).canEdit,'agent own editable');await reject(()=>get(agent,other),404);await reject(()=>get(agent,outside),404);
 const own=await (await inventories(req(),agent)).json();check(own.inventories.every(i=>i.createdBy==='a'),'agent lists own only');
 await reject(()=>inventories(req('PATCH',{revision:1,action:'cancel',operationId:randomUUID()}),agent,final.id),409);
 const updated=await (await inventories(req('PATCH',{revision:1,action:'cancel',operationId:randomUUID()}),manager,inside.id)).json();check(updated.inventory.status==='cancelled'&&!updated.inventory.canEdit,'within-scope write succeeds');
 assert.match(readFileSync('app/api/[...path]/route.ts','utf8'),/inventories\(req,user,path\[1\]\)/);
 for(const path of ['components/admin.tsx','components/inventory-panel.tsx','app/api/[...path]/route.ts'])await transform(readFileSync(path,'utf8'),{loader:path.endsWith('tsx')?'tsx':'ts'});
 console.log(`PASS: ${checks} focused import/inventory safety assertions; changed route/UI syntax verified.`);
}finally{sqlite.close();delete globalThis.__safetyDb;rmSync(dir,{recursive:true,force:true});}
