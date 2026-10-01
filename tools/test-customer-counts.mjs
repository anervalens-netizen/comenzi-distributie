// Synthetic, isolated membership parity and manager activity regression checks.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'customer-counts-')),sqlite=new DatabaseSync(':memory:');
let customerReads=0,checks=0;
const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const adapter={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async all(){if(sql==='SELECT id,warehouse_id,data FROM customers WHERE active=1')customerReads++;return {results:sqlite.prepare(sql).all(...this.args)};},async first(){return sqlite.prepare(sql).get(...this.args)||null;}};}};
globalThis.__customerCountDb=adapter;
const stubs={server:`export const db=()=>globalThis.__customerCountDb;export const isGlobalManager=u=>u.role==='manager'&&u.managerScope==='global';export const requireManager=u=>{if(u.role!=='manager')throw new Error('Forbidden');};export const fail=(status,message)=>{throw new Error(message);};export const textField=x=>typeof x==='string'?x:'';export const requireAgentAccess=async()=>{};`,'push-notifications':`export const sendPartnerRequestPush=()=>{throw new Error('Unexpected push');};`};
const plugin={name:'isolated-activity',setup(b){b.onResolve({filter:/^\.\/(server|push-notifications)$/},args=>({path:args.path.slice(2),namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:stubs[args.path]}));}};
async function load(entry,plugins=[]){const outfile=join(dir,entry.replace(/\W/g,'_')+'.mjs');await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',plugins,logLevel:'silent'});return import(pathToFileURL(outfile));}
try{
 sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,warehouse_id TEXT,warehouse_name TEXT,active INTEGER,site_code TEXT,manager_scope TEXT);
 CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER);
 CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
 CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE orders(id TEXT,user_id TEXT,kind TEXT,status TEXT,finalized_at TEXT);
 CREATE TABLE partner_requests(id TEXT,agent_id TEXT,warehouse_id TEXT,cui_key TEXT,status TEXT,payload TEXT,created_at TEXT,updated_at TEXT,confirmed_at TEXT,confirmed_by TEXT,customer_id TEXT,revision INTEGER);`);
 const accounts=[['manager','manager',null,1,'global'],['regional','manager',null,1,'assigned'],['a','agent','w-a',1,'assigned'],['shared-agent','agent','w-a',1,'assigned'],['inactive-agent','agent','w-a',0,'assigned'],['b','agent','w-b',1,'assigned'],['empty-agent','agent','',1,'assigned'],['numeric-agent','agent','1',1,'assigned'],['null-agent','agent',null,1,'assigned']];
 for(const [id,role,w,active,scope] of accounts)sqlite.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id,id,role,w,w,active,id,scope);
 sqlite.prepare('INSERT INTO manager_agents VALUES(?,?)').run('regional','a');
 const add=(id,w,data,active=1)=>sqlite.prepare('INSERT INTO customers VALUES(?,?,?,?)').run(id,w,JSON.stringify({id,name:'Synthetic '+id,cui:'RO123',city:'Synthetic city',county:'Synthetic county',address:'Synthetic address',...data}),active);
 add('legacy','w-a',{});add('shared','w-a',{warehouseIds:['w-a','w-b','w-a']});add('inactive','w-a',{warehouseIds:['w-a','w-b']},0);add('explicit-empty','w-a',{warehouseIds:[]});add('json-null','w-a',{warehouseIds:null});add('b-only','w-b',{warehouseIds:['w-b']});add('empty-membership','ignored',{warehouseIds:['','']});add('numeric-membership','ignored',{warehouseIds:[1,'1',1]});add('unassigned',null,{});
 const {selectUsersWithClientCounts}=await load('lib/customer-counts.ts');
 const baseline="SELECT u.id,(SELECT COUNT(*) FROM customers c WHERE c.active=1 AND EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) WHERE value=u.warehouse_id)) client_count FROM users u";
 const expected=sqlite.prepare(baseline+' ORDER BY u.id').all();
 equal(sqlite.prepare(selectUsersWithClientCounts('u.id')+' ORDER BY u.id').all(),expected,'all users: shared/duplicate/inactive/missing/null/empty/numeric membership parity');
 const counts=Object.fromEntries(expected.map(r=>[r.id,r.client_count]));
 equal(counts.a,3,'legacy plus shared once plus null fallback');equal(counts.b,2,'shared and own customer');equal(counts['empty-agent'],1,'explicit empty string membership counts once');equal(counts['numeric-agent'],1,'SQLite TEXT warehouse equality also deduplicates numeric/text JSON aliases');equal(counts['null-agent'],0,'SQL null warehouse matches nothing');equal(counts['inactive-agent'],3,'inactive users keep counts; inactive customers do not');
 for(const filter of [" WHERE u.role='agent'"," WHERE u.id='manager' OR EXISTS(SELECT 1 FROM manager_agents ma WHERE ma.manager_id='regional' AND ma.agent_id=u.id)"]){equal(sqlite.prepare(selectUsersWithClientCounts('u.id')+filter+' ORDER BY u.id').all(),sqlite.prepare(baseline+filter+' ORDER BY u.id').all(),'filtered users preserve visibility and count parity');}
 const activity=await load('lib/partner-requests.ts',[plugin]);
 const user=(id,scope='global')=>({id,role:'manager',managerScope:scope});
 const request=(id,agent,status,created,confirmed,customer)=>sqlite.prepare('INSERT INTO partner_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,agent,agent==='b'?'w-b':'w-a','123',status,JSON.stringify({company:'Synthetic company',cui:'RO123',location:'Synthetic city'}),created,created,confirmed,'manager',customer,1);
 request('old-pending','a','requested','2026-08-05T10:00:00Z',null,null);
 request('a-confirmed','a','confirmed','2026-08-05T10:00:00Z','2026-09-05T10:00:00Z','shared');
 request('a-confirmed-duplicate','a','confirmed','2026-09-05T10:00:00Z','2026-09-06T10:00:00Z','shared');
 request('b-current-pending','b','requested','2026-09-05T10:00:00Z',null,null);
 request('b-later-confirmation','b','confirmed','2026-09-05T10:00:00Z','2026-10-05T10:00:00Z','b-only');
 const inventory={id:'synthetic-inventory',warehouseId:'w-a',createdBy:'a',createdByName:'Synthetic author',scopeLabel:'All',status:'finalized',createdAt:'2026-08-05T10:00:00Z',finalizedAt:'2026-09-10T10:00:00Z',lines:[{expected:5,counted:3}]};
 sqlite.prepare('INSERT INTO settings VALUES(?,?)').run('inventory-v1:'+inventory.id,JSON.stringify(inventory));
 sqlite.prepare('INSERT INTO orders VALUES(?,?,?,?,?)').run('order','a','combined','finalized','2026-09-10T10:00:00Z');
 sqlite.prepare('INSERT INTO orders VALUES(?,?,?,?,?)').run('notice','a','sim','finalized','2026-09-10T10:00:00Z');
 customerReads=0;const team=await activity.teamActivity(user('manager'),'2026-09');
 equal(team.partnerRequests.map(r=>r.id),['a-confirmed-duplicate','b-current-pending','b-later-confirmation'],'team remains creation-month scoped');equal(customerReads,1,'team decorates nonempty list once');equal(team.agents.find(r=>r.agentId==='a').clientCount,3,'team shared membership count');equal(team.totals.finalizedInventories,1,'team inventory event date intact');
 customerReads=0;const manager=await activity.managerActivity(user('manager'),new URLSearchParams('month=2026-09&agentId=a'));
 equal(customerReads,1,'manager decorates requests once instead of creation-month then event-month');equal(manager.activity.agents.map(a=>a.agentId),['a'],'manager agent filter intact');equal(manager.activity.partnerRequests.map(r=>r.id),['a-confirmed-duplicate','old-pending','a-confirmed'],'manager includes all-time pending and confirmation month');equal(manager.pending,1,'all-time pending');equal(manager.confirmed,1,'confirmed locations deduplicated');equal(manager.confirmedByAgent.a,1,'agent confirmation KPI deduplicated');equal(manager.activity.totals.finalizedInventories,1,'inventory KPI unchanged');equal(manager.activity.totals.inventoryShortage,2,'inventory differences preserved');equal(manager.finalizedOrders,1,'combined order counts once');equal(manager.finalizedNotices,1,'notices count preserved');equal(manager.activity.partnerRequests[0].existingLocations.length,8,'all active same-CUI points retained, including outside selected warehouse');
 customerReads=0;const empty=await activity.listPartnerRequests(user('manager'),'2026-07');equal(empty.requests,[],'empty list contract');equal(customerReads,0,'empty requests do not read all customers');
 customerReads=0;const emptyManager=await activity.managerActivity(user('manager'),new URLSearchParams('month=2026-07&agentId=empty-agent'));equal(emptyManager.activity.partnerRequests,[],'empty selected manager workspace');equal(customerReads,0,'empty manager scope does not decorate customers');
 const regional=await activity.teamActivity(user('regional','assigned'),'2026-09');equal(regional.agents.map(r=>r.agentId),['a'],'internal regional team ownership unaffected');
 console.log(`PASS: ${checks} customer count parity and activity contract checks (isolated synthetic SQLite).`);
}finally{sqlite.close();rmSync(dir,{recursive:true,force:true});delete globalThis.__customerCountDb;}
