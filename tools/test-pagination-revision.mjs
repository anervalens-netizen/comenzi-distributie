// Deterministic HTTP traversals through real SQLite portfolio/report readers.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
const t=await clientSalesTestRuntime(),{module:m,sql,root}=t;
let server,checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;};
const users={agent:t.user('agent'),global:t.user('manager'),regional:{...t.user('manager'),id:'regional',managerScope:'assigned'}};
try{
 sql.exec("INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,manager_scope) VALUES('regional','regional','Synthetic regional','manager','','not-a-credential',0,1,'assigned');INSERT INTO manager_agents VALUES('regional','agent');");
 m.buildActivitySnapshot(root,'2026-09-30');
 // More than two offline preparation pages, including a hidden agent portfolio.
 for(let i=0;i<420;i++){
  const id='fenced-'+String(i).padStart(3,'0'),warehouse=i<410?'g-5':'g-3';
  sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,warehouse,JSON.stringify({id,name:'Synthetic fenced '+i,cui:'fence-'+i,warehouseIds:[warehouse],county:'Test',city:'Test',route:'1',address:''}));
 }
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),user=users[req.headers['x-fixture-user']]||users.agent;
  try{
   const value=url.pathname==='/partner/browse'?await m.browsePartners(user,url.searchParams):url.pathname==='/sales/clients/reconciliation'?await m.clientSalesReconciliation(user,url.searchParams,new Date('2026-09-30T12:00:00Z')):await m.clientSalesOverview(user,url.searchParams,new Date('2026-09-30T12:00:00Z'));
   const response=value instanceof Response?value:Response.json(value);res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
  }catch(e){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 async function read(path,scope='agent',status=200){const response=await fetch(origin+'/'+path,{headers:{'x-fixture-user':scope}}),data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;}
 const mutate=()=>sql.prepare("UPDATE customers SET data=json_set(data,'$.name',json_extract(data,'$.name')||' changed') WHERE id='fenced-001'").run();
 for(const scope of ['agent','regional','global']){
  for(const path of ['partner/browse?limit=100','sales/clients?month=2026-09&sort=name']){
   const first=await read(path,scope),pageKey=path.startsWith('partner')?'offset':'page',rowsKey=path.startsWith('partner')?'partners':'rows';
   check(!!first.revision,scope+' '+path+' returns opaque revision');
   mutate();await read(path+'&'+pageKey+'='+ (pageKey==='offset'?100:1)+'&revision='+encodeURIComponent(first.revision),scope,409);
   let page=await read(path,scope),index=1;const items=[...page[rowsKey]],revision=page.revision,total=page.total;
   while(pageKey==='offset'?page.nextOffset!==null:page.hasMore){page=await read(path+'&'+pageKey+'='+(pageKey==='offset'?page.nextOffset:index++)+'&revision='+encodeURIComponent(revision),scope);assert.equal(page.revision,revision);items.push(...page[rowsKey]);}
   check(new Set(items.map(row=>row.id)).size===total&&items.length===total,scope+' restart yields a unique complete generation');
   if(scope==='agent')check(!items.some(row=>row.id==='fenced-419'),'agent scope cannot include hidden warehouse');
   else check(items.some(row=>row.id==='fenced-419'),'manager national read is preserved');
   await read(path+'&q=different&'+pageKey+'=1&revision='+encodeURIComponent(revision),scope,409);
  }
 }
 const own=await read('partner/browse?limit=100');await read('partner/browse?limit=100&offset=100&revision='+encodeURIComponent(own.revision),'global',409);
 const style=await read('partner/browse?limit=100');sql.exec("INSERT OR REPLACE INTO settings(key,value) VALUES('partner-map-style-url','/synthetic-style.json')");await read('partner/browse?limit=100&offset=100&revision='+encodeURIComponent(style.revision),'agent',409);
 const days=await read('partner/browse?limit=100&days=7');const dayPage=await read('partner/browse?limit=100&days=7&offset=100&revision='+encodeURIComponent(days.revision));assert.equal(dayPage.revision,days.revision,'rolling-day cutoff remains fixed across requests');
 const sales=await read('sales/clients?month=2026-09');
 sql.exec("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) VALUES('fence-visit','fenced-001','agent','Synthetic','2026-09-01T10:00:00Z','','2026-09-01T10:00:00Z')");
 await read('sales/clients?month=2026-09&page=1&revision='+encodeURIComponent(sales.revision),'agent',409);
 for(const scope of ['regional','global']){
  const path='sales/clients/reconciliation?month=2026-09',first=await read(path,scope);mutate();await read(path+'&page=1&revision='+encodeURIComponent(first.revision),scope,409);
  const restart=await read(path,scope),next=await read(path+'&page=1&revision='+encodeURIComponent(restart.revision),scope);assert.equal(next.revision,restart.revision);check(new Set(restart.exceptions.map(r=>r.key)).size===restart.total,'reconciliation restart has unique complete exceptions');
 }
 await read('sales/clients/reconciliation?month=2026-09','agent',403);
 const beforeSource=await read('sales/clients?month=2026-09'),beforeReconciliation=await read('sales/clients/reconciliation?month=2026-09','global');
 const history=new DatabaseSync(join(root,'client-history/client-sales-history.sqlite'));history.exec("UPDATE history_imports SET sha256='synthetic-new-generation'");history.close();
 await read('sales/clients?month=2026-09&page=1&revision='+encodeURIComponent(beforeSource.revision),'agent',409);
 await read('sales/clients/reconciliation?month=2026-09&page=1&revision='+encodeURIComponent(beforeReconciliation.revision),'global',409);
 m.buildActivitySnapshot(root,'2026-09-30');
 await read('sales/clients?month=2026-09&page=1&revision='+encodeURIComponent(beforeSource.revision),'agent',409);
 // Actual preparer restarts after a mutation between pages and refuses duplicate/missing coverage.
 let changed=false,restarts=0;
 const prepared=await m.preparePartnerPages(async path=>{
  if(path.includes('offset=0'))restarts++;
  if(path.includes('offset=200')&&!changed){changed=true;mutate();}
  const response=await fetch(origin+'/'+path),data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});return data;
 });
 check(restarts===2&&prepared.partners.length===prepared.total&&new Set(prepared.partners.map(p=>p.id)).size===prepared.total,'offline preparation restarts and verifies complete unique coverage');
 for(const missing of [false,true])await assert.rejects(()=>m.preparePartnerPages(async()=>({revision:'fixed',partners:missing?[{id:'one'}]:[{id:'one'},{id:'one'}],total:2,nextOffset:null})),e=>e.status===409,'incomplete/duplicate coverage cannot be accepted');
 console.log(`PASS: ${checks} pagination HTTP scope/generation contracts and offline preparation guards.`);
}finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}t.cleanup();}
