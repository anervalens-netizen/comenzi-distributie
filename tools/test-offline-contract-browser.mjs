// Real HTTP route, Node SQLite runtime and Chrome IndexedDB. All records synthetic.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {browserFixture,delay} from './offline-browser-fixture.mjs';
mkdirSync('work',{recursive:true});const directory=mkdtempSync(resolve('work/offline-contract-'));
const previousDirectory=process.env.MOBIUP_DATA_DIR;process.env.MOBIUP_DATA_DIR=join(directory,'data');
let browser,server,checks=0;const requests=[];
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const modulePath=join(directory,'route.mjs');
 await build({stdin:{contents:"export * from './app/api/[...path]/route';export {env} from './lib/runtime';",loader:'ts',resolveDir:resolve('.')},outfile:modulePath,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'node-runtime',setup(b){b.onResolve({filter:/^#mobiup-/},args=>({path:resolve('lib/'+args.path.slice('#mobiup-'.length)+'-node.ts')}));b.onResolve({filter:/\.sql\?raw$/},args=>({path:resolve(args.path.replace(/^@\//,'').replace(/\?raw$/,'')),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));}}]});
 const route=await import(pathToFileURL(modulePath));const db=route.env.DB;
 await db.prepare('SELECT 1').first();
 await db.prepare("INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active) VALUES('agent','synthetic','Synthetic agent','agent','w','not-a-credential',0,1)").run();
 const token=randomUUID(),hash=createHash('sha256').update(token).digest('hex');
 const login=async()=>{await db.prepare("INSERT OR REPLACE INTO sessions(token_hash,user_id,expires_at) VALUES(?,'agent',?)").bind(hash,Date.now()+3600000).run();if(browser)await browser.send('Network.setCookie',{name:'mobiup_session',value:token,url:await browser.evaluate('location.origin'),httpOnly:true});};await login();
 const partner={id:'point',name:'Synthetic point',warehouseId:'w',warehouseIds:['w'],cui:'TEST',address:'Example',city:'Example',county:'Example',route:''};
 await db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').bind('point','w',JSON.stringify(partner)).run();
 const facetInputs=[['OLT','1'],['Olt','1, 11'],['Iasi','11, 1'],['Iași','11'],['Bucuresti','2, 7'],['Municipiul Bucuresti','7, 2'],['SB','1, 11'],['Sibiu','11']];
 for(const [i,[county,route]] of facetInputs.entries())await db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').bind('facet-'+i,'w',JSON.stringify({...partner,id:'facet-'+i,name:'Facet sample '+i,county,route})).run();
 const compiled=await build({stdin:{contents:"export * from './lib/client-api';export * from './lib/offline-work';export * from './lib/local-work';",loader:'ts',resolveDir:resolve('.')},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 let dropNext=false,legacyResponse=false;
 server=createServer(async(req,res)=>{
  try{
   if(req.url.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    const headers=new Headers(req.headers),url='http://'+req.headers.host+req.url;
    const request=new Request(url,{method:req.method,headers,...body.length?{body}: {}});
    const result=await route[req.method](request);let text=await result.text();
    if(req.method==='POST'&&req.url.endsWith('/visits')){
     requests.push({id:req.headers['x-operation-id'],body:JSON.parse(body.toString()),status:result.status});
     if(dropNext){dropNext=false;res.writeHead(200,{'Content-Type':'application/json'});res.end('{');return;}
     if(legacyResponse&&result.ok){const data=JSON.parse(text);delete data.visit;text=JSON.stringify(data);}
    }
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(text);return;
   }
   res.setHeader('Content-Type',req.url==='/fixture.mjs'?'text/javascript':'text/html');res.end(req.url==='/fixture.mjs'?compiled.outputFiles[0].text:'<!doctype html><title>Synthetic HTTP contract</title>');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);const evaluate=browser.evaluate;
 await evaluate(`window.m=await import('/fixture.mjs');document.cookie='mobiup_session=${token}; Path=/';window.originalFetch=fetch;`);
 check(await evaluate("(await m.api('auth/session')).user.id==='agent'&&(await m.api('bootstrap')).user.id==='agent'"),'actual authenticated contracts');
 await evaluate("await m.api('partner/summary');window.facetOnline=[];for(const county of ['OLT','Olt','Iasi','Iași','Bucuresti','Municipiul Bucuresti','SB','Sibiu'])facetOnline.push(await m.api('partner/browse?limit=199&q=Facet+sample&county='+encodeURIComponent(county)));window.fetch=async()=>{throw new TypeError('synthetic offline')}");
 await evaluate("await m.saveSnapshot('agent','partner/browse?limit=198&q=Facet+sample&county=OLT',{partners:[],total:0,facets:{counties:['OLT'],cities:[],routes:['1, 11']}})");
 check(await evaluate("let equal=true;let i=0;for(const county of ['OLT','Olt','Iasi','Iași','Bucuresti','Municipiul Bucuresti','SB','Sibiu']){const offline=await m.api('partner/browse?limit=198&q=Facet+sample&county='+encodeURIComponent(county));equal=equal&&offline.total===2&&JSON.stringify(offline.partners.map(p=>p.id).sort())===JSON.stringify(facetOnline[i++].partners.map(p=>p.id).sort());}equal"),'offline county aliases match live SQL population');
 check(await evaluate("const routes=await m.api('partner/browse?limit=198&q=Facet+sample&route=1');routes.total===4&&!routes.facets.routes.some(r=>r.includes(','))&&routes.partners.every(p=>['1','1, 11','11, 1'].includes(p.route))"),'offline exact route memberships and atomic facets preserve raw text');
 check(await evaluate("(await m.api('partner/browse?limit=198&q=Sibiu')).total===2"),'offline county search includes code aliases');
 await evaluate('window.fetch=originalFetch');

 const bootstrap=await evaluate("(await m.snapshot('agent','bootstrap')).value");check(Array.isArray(bootstrap.products),'full authenticated bootstrap snapshot exists');
 await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hash).run();
 check(await evaluate("const value=await m.api('bootstrap');Object.keys(value).length===1&&value.user===null&&m.currentLocalWorkUserId()===''&&(await m.lastAccount())===''"),'session expired between auth/session and bootstrap accepts exact {user:null}');
 check(await evaluate("(await m.snapshot('agent','bootstrap')).value.user.id==='agent'"),'explicit rejection does not overwrite old account recovery data');
 check(await evaluate("window.fetch=async()=>{throw new TypeError('synthetic offline')};let rejected=false;try{await m.api('bootstrap')}catch{rejected=true}rejected&&m.currentLocalWorkUserId()===''"),'network failure after explicit rejection cannot revive the account');
 await login();await evaluate("window.fetch=originalFetch;await m.api('auth/session');await m.api('bootstrap');window.fetch=async()=>{throw new TypeError('synthetic offline')}");
 check(await evaluate("(await m.api('bootstrap')).user.id==='agent'"),'network failure with a valid binding still supports offline');
 // In-flight success and in-flight fallback both lose authority on explicit logout.
 for(const success of [true,false]){
  check(await evaluate(`window.fetch=originalFetch;await m.api('auth/session');let finish;window.fetch=()=>new Promise((resolve,reject)=>finish=${success?'resolve':'reject'});const stale=m.api('bootstrap').then(()=>false,e=>e.status===409);window.fetch=originalFetch;await m.api('auth/logout','POST');finish(${success?"new Response(JSON.stringify({user:{id:'agent'}}))":"new TypeError('offline')"});await stale`),'logout fences delayed '+(success?'success':'offline fallback'));
  await login();
 }
 // Anonymous requests cannot resurrect a session after an explicit null response either.
 check(await evaluate("m.setLocalWorkUserId('');let finish;window.fetch=()=>new Promise(resolve=>finish=resolve);const stale=m.api('auth/session').then(()=>false,e=>e.status===409);window.fetch=async()=>new Response(JSON.stringify({user:null}));await m.api('bootstrap');finish(new Response(JSON.stringify({user:{id:'agent'}})));await stale"),'null while already anonymous fences earlier authentication');
 await evaluate("window.fetch=originalFetch;await m.api('auth/session');window.fetch=async()=>new Response(JSON.stringify({user:42}));");
 check(await evaluate("(await m.api('bootstrap')).user.id==='agent'"),'malformed success still preserves valid offline payload rather than masquerading as logout');
 await evaluate("window.fetch=originalFetch;window.path='partner/portfolio/point';await m.api(path);window.transport=(p,method,body,id)=>m.networkApi(p,method,body,undefined,id,'agent');window.replay=()=>m.replay('agent',transport,m.currentLocalWorkUserId);window.confirmations=0;addEventListener('mobiup-sync-confirmed',()=>confirmations++);");
 const visitId=randomUUID();dropNext=true;
 await evaluate(`window.visitBody={id:${JSON.stringify(visitId)},notes:'Synthetic recovery'};await m.enqueue('agent',path+'/visits','POST',visitBody,{scope:'visit',id:'point',value:visitBody});await replay();`);
 check(await evaluate("(await m.pendingOperations('agent')).length===1&&(await m.readWork('agent','visit','point')).notes==='Synthetic recovery'"),'dropped real POST response retains operation and local recovery');
 // Backdate the already persisted idempotent request and fill a whole first page.
 await db.prepare("UPDATE partner_visits SET visited_at='2020-01-01T00:00:00Z' WHERE id=?").bind(visitId).run();
 for(let i=0;i<55;i++)await db.prepare("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) VALUES(?,'point','agent','Synthetic agent','2025-01-01T00:00:00Z','','2025-01-01T00:00:00Z')").bind(randomUUID()).run();
 await delay(2100);await evaluate('await replay();await replay()');
 assert.equal(requests.length,2);assert.equal(requests[0].id,requests[1].id);assert.deepEqual(requests[0].body,requests[1].body);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM partner_visits WHERE id=?').bind(visitId).first()).n,1);
 check(await evaluate("(await m.pendingOperations('agent')).length===0&&confirmations===1"),'same idempotent request removes queue exactly once after bounded-page confirmation');
 const cached=await evaluate("(await m.snapshot('agent',path)).value"),actual=await evaluate("await m.networkApi(path)");assert.deepEqual(cached,actual);assert.equal(cached.visits.length,50);assert.equal(cached.visitCount,56);assert(cached.nextCursor);check(!cached.visits.some(v=>v.id===visitId),'cache is authoritative first page, not a fabricated cursor/history merge');
 // Older server contract, with our exact record out of order in the returned history.
 legacyResponse=true;const oldId=randomUUID();
 await evaluate(`await m.enqueue('agent',path+'/visits','POST',{id:${JSON.stringify(oldId)},notes:'Legacy detail'});`);
 await db.prepare("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) VALUES(?,'point','agent','Synthetic agent','2025-01-02T00:00:00Z','Legacy detail','2025-01-02T00:00:00Z')").bind(oldId).run();
 await db.prepare("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) VALUES(?,'point','agent','Synthetic agent','2025-01-03T00:00:00Z','','2025-01-03T00:00:00Z')").bind(randomUUID()).run();
 await evaluate('await replay()');check(await evaluate(`(await m.pendingOperations('agent')).length===0&&(await m.snapshot('agent',path)).value.visits[1].id===${JSON.stringify(oldId)}`),'legacy detail finds matching visit rather than arbitrary first row');
 // Valid empty history, a full unmatched page, mismatched confirmation and malformed
 // success are all ambiguous, never permission to delete the durable local request.
 for(const kind of ['empty','full','wrong','malformed','malformed-history']){
  check(await evaluate(`const account='ambiguous-${kind}',body={id:crypto.randomUUID(),notes:'Keep me'};await m.enqueue(account,path+'/visits','POST',body,{scope:'visit',id:'point',value:body});const detail=${kind==='empty'?"{partner:{id:'point'},visits:[],visitCount:0,nextCursor:null}":kind==='full'?JSON.stringify(cached):kind==='malformed-history'?"{partner:{id:'point'},visits:[{id:'invalid'}],visitCount:1,nextCursor:null,visit:{...body,customerId:'point',agentId:account,agentName:'Synthetic',visitedAt:'2026-01-01T00:00:00Z',createdAt:'2026-01-01T00:00:00Z'}}":kind==='wrong'?"{partner:{id:'point'},visits:[],visitCount:1,nextCursor:null,visit:{id:crypto.randomUUID()}}":"{unexpected:true}"};await m.replay(account,async()=>detail,()=>account);(await m.pendingOperations(account)).length===1&&(await m.readWork(account,'visit','point')).notes==='Keep me'`),'preserve '+kind+' ambiguous success');
 }
 console.log(`PASS: ${checks} offline HTTP/IndexedDB contracts; actual route retries and SQLite deduplication.`);
}finally{
 await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 if(previousDirectory===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previousDirectory;
 rmSync(directory,{recursive:true,force:true});
}
