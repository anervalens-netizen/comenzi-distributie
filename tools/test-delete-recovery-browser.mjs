// Real HTTP route, Node SQLite runtime and Chrome IndexedDB. All records synthetic.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
mkdirSync('work',{recursive:true});const directory=mkdtempSync(resolve('work/delete-recovery-'));
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
 const compiled=await build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import {useOrderDraftSave} from './components/use-order-draft-save';window.mountEditor=initial=>{window.root=createRoot(document.getElementById('root'));function Editor(){window.draft=useOrderDraftSave({initial,storageOwnerId:'agent',onSaved:()=>{}});return null;}root.render(React.createElement(Editor));};export * from './lib/client-api';export * from './lib/offline-work';export * from './lib/local-work';export * from './lib/order-draft';",loader:'ts',resolveDir:resolve('.')},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 let pauseDelete=false,releaseDelete,deleteReached=false,dropPut=false,oldDelete=false;
 server=createServer(async(req,res)=>{
  try{
   if(req.url.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    if(req.method==='DELETE'&&pauseDelete){deleteReached=true;await new Promise(resolve=>releaseDelete=resolve);pauseDelete=false;}
    const result=await route[req.method](new Request('http://'+req.headers.host+req.url,{method:req.method,headers:new Headers(req.headers),...body.length?{body}:{}}));
    requests.push({method:req.method,path:req.url,status:result.status});
    let text=await result.text();
    if(req.method==='PUT'&&dropPut&&result.ok){dropPut=false;text='{';}
    if(req.method==='DELETE'&&oldDelete&&result.ok)text=JSON.stringify({ok:true});
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(text);return;
   }
   res.setHeader('Content-Type',req.url==='/fixture.mjs'?'text/javascript':'text/html');res.end(req.url==='/fixture.mjs'?compiled.outputFiles[0].text:'<!doctype html><title>Synthetic delete recovery</title><div id="root"></div>');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);const a=browser.evaluate,b=await browser.newTab();
 await a(`window.m=await import('/fixture.mjs');document.cookie='mobiup_session=${token}; Path=/';await m.api('auth/session');`);
 await b.evaluate("window.m=await import('/fixture.mjs');await m.api('auth/session');");
 for(const kind of ['unsent','idb-only','attempted','clean','during-delete']){
  const base=await a("(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order");
  for(const tab of [browser,b])await tab.evaluate(`window.base=${JSON.stringify(base)};window.local={...base,notes:'Newer tab edit'};window.deleteRevision=base.revision;`);
  await a("m.writeLocalWork('order','agent',base.id,{base,local:base});await m.saveOrderWork('agent',base.id,{base,local:base});");
  if(kind==='idb-only')await b.evaluate("await m.saveOrderWork('agent',base.id,{base,local});");
  if(kind!=='idb-only'&&kind!=='clean'&&kind!=='during-delete')await b.evaluate("m.writeLocalWork('order','agent',base.id,{base,local});await m.saveOrderWork('agent',base.id,{base,local});");
  let operation;
  if(kind==='attempted'){
   operation=await b.evaluate("await m.enqueue('agent','orders/'+base.id,'PUT',m.orderSaveBody(local,base.revision),{scope:'order',id:base.id,value:{base,local}})");
   dropPut=true;await b.evaluate("await m.replay('agent',(p,method,body,id)=>m.networkApi(p,method,body,undefined,id,'agent'),()=> 'agent');");
   await a("window.deleteRevision=(await m.api('orders/'+base.id)).order.revision");
   check(await b.evaluate("(await m.pendingOperations('agent'))[0].attempts===1"),'attempt recorded durably');
  }
  if(kind==='during-delete'){
   pauseDelete=true;deleteReached=false;
   await a("window.deleting=m.api('orders/'+base.id,'DELETE',{revision:base.revision});void 0");
   await waitFor(()=>deleteReached);
   await b.evaluate("m.writeLocalWork('order','agent',base.id,{base,local});await m.saveOrderWork('agent',base.id,{base,local});");
   releaseDelete();await a('await deleting');
  }else await a("await m.api('orders/'+base.id,'DELETE',{revision:deleteRevision})");
  assert.equal((await db.prepare('SELECT status FROM orders WHERE id=?').bind(base.id).first()).status,'deleted');
  check(await a("(await m.pendingOperations('agent')).length===0&&!(await m.readWork('agent','order',base.id))"),kind+': no replaying PUT or pending count');
  check(await a("(await m.reconcileOrderList('agent',[base],true)).length===0"),kind+': tombstone filters stale list');
  if(kind==='clean')check(await a("m.readLocalWork('order','agent',base.id).value===null&&!(await m.readWork('agent','recovered-order',base.id))"),'clean recovery retired');
  else check(await a("(await m.readWork('agent','recovered-order',base.id)).local.notes==='Newer tab edit'&&m.readLocalWork('order','agent',base.id).value.local.notes==='Newer tab edit'"),kind+': archived and explicit recovery survives');
  if(operation)check(await a(`(await m.readWork('agent','resolved-operation',${JSON.stringify(operation.id)})).attempts===1`),'attempted payload retained as resolved evidence');
  const count=requests.length;await a("await m.replay('agent',(p,method,body,id)=>m.networkApi(p,method,body,undefined,id,'agent'),()=> 'agent')");assert.equal(requests.length,count,'deleted operations never GET/PUT a missing order');
  // A suspended editor waking after deletion cannot reintroduce a permanent blocker.
  if(kind==='unsent'){
   check(await b.evaluate("let terminal=false;try{await m.enqueue('agent','orders/'+base.id,'PUT',m.orderSaveBody(local,base.revision),{scope:'order',id:base.id,value:{base,local}})}catch(e){terminal=e.status===404}terminal"),'stale editor receives recovery outcome rather than false saved status');
   check(await a("(await m.pendingOperations('agent')).length===0"),'post-delete stale enqueue is archived');
  }
 }
 // The real editor must surface recovery instead of acknowledging an archived save.
 const editorBase=await a("(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order");
 await b.evaluate(`mountEditor(${JSON.stringify(editorBase)})`);await waitFor(()=>b.evaluate('!!window.draft'));
 await b.evaluate("draft.update({notes:'Editor recovery'})");
 await a(`await m.api('orders/${editorBase.id}','DELETE',{revision:${editorBase.revision}})`);
 await b.evaluate("try{await draft.save(true)}catch{};void 0");await waitFor(()=>b.evaluate('draft.remoteDeleted'));
 check(await b.evaluate("draft.saveState==='Necesită recuperare'&&draft.order.notes==='Editor recovery'&&(await m.pendingOperations('agent')).length===0"),'suspended real editor preserves content and cannot report false save');
 await b.evaluate('root.unmount()');
 // A local-only POST cannot be retired by DELETE 404.
 await a("window.base={...base,id:crypto.randomUUID()};await m.enqueue('agent','orders','POST',{id:base.id,kind:'accessories',agentId:'agent'},{scope:'order',id:base.id,value:{base,local:base}});window.failed=false;try{await m.api('orders/'+base.id,'DELETE',{revision:base.revision})}catch(e){failed=e.status===404}");
 check(await a("failed&&(await m.pendingOperations('agent')).length===1&&!!(await m.readWork('agent','order',base.id))"),'local-only create survives impossible server delete');
 await a("for(const op of await m.pendingOperations('agent'))await m.removeOperation(op.id)");
 // A persisted create with a lost response is retired only by explicit server deletion proof.
 await a("window.base=(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order;await m.enqueue('agent','orders','POST',{id:base.id,kind:'accessories',agentId:'agent'},{scope:'order',id:base.id,value:{base,local:base}});await m.api('orders/'+base.id,'DELETE',{revision:base.revision});");
 check(await a("(await m.pendingOperations('agent')).length===0"),'created-and-deleted server proof resolves POST');
 // An old server's generic success cannot silently resolve an ambiguous POST.
 oldDelete=true;
 await a("window.base=(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order;await m.enqueue('agent','orders','POST',{id:base.id,kind:'accessories',agentId:'agent'},{scope:'order',id:base.id,value:{base,local:base}});window.oldAnswer=await m.api('orders/'+base.id,'DELETE',{revision:base.revision});");
 check(await a("oldAnswer.ok===true&&(await m.pendingOperations('agent')).length===1&&!!(await m.readWork('agent','order',base.id))"),'legacy deletion success preserves unproven create ambiguity');
 oldDelete=false;await a("for(const op of await m.pendingOperations('agent'))await m.removeOperation(op.id)");
 // IDB cleanup failure after committed HTTP success never asks callers to retry DELETE.
 await a("window.base=(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order;window.put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(value.key==='agent|order-list|settled')throw new Error('Synthetic cleanup failure');return put.call(this,value,...args)};window.answer=await m.api('orders/'+base.id,'DELETE',{revision:base.revision});IDBObjectStore.prototype.put=put;");
 check(await a('answer.ok===true'),'DELETE success survives local cleanup failure');
 const deletedId=await a('base.id');
 assert.equal(requests.filter(r=>r.method==='DELETE'&&r.path==='/api/orders/'+deletedId).length,1,'exactly one DELETE');
 console.log(`PASS: ${checks} two-tab HTTP/IndexedDB deletion contracts.`);
}finally{
 await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 if(previousDirectory===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previousDirectory;
 rmSync(directory,{recursive:true,force:true});
}
