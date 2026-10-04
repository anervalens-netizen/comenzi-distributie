// Real HTTP route, Node SQLite runtime and Chrome IndexedDB. All records synthetic.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {browserFixture,delay,waitFor} from './offline-browser-fixture.mjs';
mkdirSync('work',{recursive:true});const directory=mkdtempSync(resolve('work/recovery-contract-'));
const baseline=process.env.RECOVERY_BASELINE_REF;
const baselinePlugin={name:'baseline',setup(b){b.onLoad({filter:/(lib\/offline-work\.ts|components\/use-order-draft-save\.ts)$/},args=>({contents:execFileSync('git',['show',`${baseline}:${args.path.slice(process.cwd().length+1)}`],{encoding:'utf8'}),loader:'ts',resolveDir:resolve(args.path,'..')}));}};
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
 const compiled=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {PartnerSheet} from './components/partner-portfolio';
 import {useOrderDraftSave} from './components/use-order-draft-save';import {OrderSaveConflictDialog} from './components/order-save-conflict-dialog';
 export * from './lib/order-recovery';
 window.mountPartner=()=>{window.root=createRoot(document.getElementById('root'));root.render(<PartnerSheet id="point" onClose={()=>{}} onSaved={()=>{}}/>);};
 export {writeLocalWork} from './lib/local-work';export * from './lib/client-api';export * from './lib/offline-work';export * from './lib/local-work';export * from './lib/order-draft';
 window.mountEditor=(initial)=>{window.root=createRoot(document.getElementById('root'));function Editor(){const draft=useOrderDraftSave({initial,storageOwnerId:'agent',onSaved:()=>{}});window.draft=draft;return <><output>{draft.saveState} {draft.saveError}</output><OrderSaveConflictDialog conflict={draft.conflict} onResolve={draft.resolveConflict}/></>;}root.render(<Editor/>);};
 `,loader:'tsx',resolveDir:resolve('.')},write:false,outdir:'out',bundle:true,format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent',alias:{'next/image':resolve('tools/offline-image.tsx')},plugins:baseline?[baselinePlugin]:[]});
 let dropNext=false,dropOrder=false;
 server=createServer(async(req,res)=>{
  try{
   if(req.url.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    const headers=new Headers(req.headers),url='http://'+req.headers.host+req.url;
    const request=new Request(url,{method:req.method,headers,...body.length?{body}: {}});
    const result=await route[req.method](request);const text=await result.text();
    if(req.method==='POST'&&req.url.endsWith('/visits')){
     requests.push({id:req.headers['x-operation-id'],body:JSON.parse(body.toString()),status:result.status});
     if(dropNext){dropNext=false;res.writeHead(200,{'Content-Type':'application/json'});res.end('{');return;}

    }
    if(req.method==='PUT'&&req.url.startsWith('/api/orders/')&&result.ok&&dropOrder){dropOrder=false;res.writeHead(200,{'Content-Type':'application/json'});res.end('{');return;}
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(text);return;
   }
   res.setHeader('Content-Type',req.url==='/fixture.mjs'?'text/javascript':'text/html');res.end(req.url==='/fixture.mjs'?compiled.outputFiles.find(f=>f.path.endsWith('.js')).text:'<!doctype html><title>Synthetic recovery contracts</title><div id="root"></div>');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);const evaluate=browser.evaluate;
 await evaluate(`window.m=await import('/fixture.mjs');document.cookie='mobiup_session=${token}; Path=/';window.originalFetch=fetch;`);
 await evaluate("await m.api('auth/session');window.transport=(p,method,body,id)=>m.networkApi(p,method,body,undefined,id,'agent');window.replay=()=>m.replay('agent',transport,m.currentLocalWorkUserId);");
 // T01: a real accepted PUT loses its response; a subsequent local edit must win
 // only against that confirmation, while an external C still causes a conflict.
 for(const external of [false,true]){
  await evaluate("window.base=(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order;window.A={...base,notes:'A'};await m.enqueue('agent','orders/'+base.id,'PUT',m.orderSaveBody(A,base.revision),{scope:'order',id:base.id,value:{base,local:A}});");
  dropOrder=true;await evaluate('await replay()');
  const attempted=await evaluate("(await m.pendingOperations('agent')).find(op=>op.path==='orders/'+base.id)");
  await evaluate("window.B={...base,notes:'B'};await m.enqueue('agent','orders/'+base.id,'PUT',m.orderSaveBody(B,base.revision),{scope:'order',id:base.id,value:{base,local:B}});");
  await delay(2100);await evaluate('await replay()');
  check(await evaluate("(await m.readWork('agent','order',base.id)).base.notes==='A'&&(await m.readWork('agent','order',base.id)).local.notes==='B'"),'T01 acknowledgement advances durable base and retains B');
  if(!external){
   await evaluate("m.writeLocalWork('order','agent',base.id,{base,local:B});mountEditor((await transport('orders/'+base.id,'GET')).order)");
   await waitFor(()=>evaluate("window.draft?.order.notes==='B'&&!draft.conflict"),'durable confirmation defeats stale legacy conflict');
   await evaluate('root.unmount()');
  }
  if(external)await evaluate("window.C=(await transport('orders/'+base.id,'GET')).order;await transport('orders/'+base.id,'PUT',m.orderSaveBody({...C,notes:'C'},C.revision));");
  await evaluate('await replay()');
  check(await evaluate(external?"(await m.pendingOperations('agent')).find(op=>op.path==='orders/'+base.id).state==='blocked'&&(await transport('orders/'+base.id,'GET')).order.notes==='C'":"(await m.pendingOperations('agent')).length===0&&(await transport('orders/'+base.id,'GET')).order.notes==='B'&&(await transport('orders/'+base.id,'GET')).order.revision===base.revision+2"),external?'T01 genuine external C remains a conflict':'T01 eventual server B and queue zero');
  if(!external){assert.equal((await db.prepare('SELECT COUNT(*) n FROM orders WHERE id=?').bind(await evaluate('base.id')).first()).n,1);continue;}
  // T02: mount the real React hook/dialog against the persisted blocked queue.
  await evaluate("mountEditor((await transport('orders/'+base.id,'GET')).order)");
  await waitFor(()=>evaluate('!!window.draft?.conflict'),'restored conflict UI');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Păstrează modificările mele')).click()");
  await waitFor(()=>evaluate('!draft.conflict'),'local resolution commits');
  await evaluate('await replay()');
  check(await evaluate("(await m.pendingOperations('agent')).length===0&&(await transport('orders/'+base.id,'GET')).order.notes==='B'"),'T02 choosing local resolves outbox and server');
  await evaluate('root.unmount()');
  check(attempted.attempts===1,'first attempted identity persisted');
 }
 // Legacy rows without optional metadata remain recoverable; server choice
 // resolves both work and queue without a new write.
 await evaluate("window.base=(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order;window.local={...base,notes:'Local legacy'};await m.enqueue('agent','orders/'+base.id,'PUT',m.orderSaveBody(local,base.revision),{scope:'order',id:base.id,value:{base,local}});window.remote=(await transport('orders/'+base.id,'PUT',m.orderSaveBody({...base,notes:'Remote'},base.revision))).order;await replay();");
 await evaluate("const db=await new Promise(r=>{const q=indexedDB.open('mobiup-offline-v3',1);q.onsuccess=()=>r(q.result)});const tx=db.transaction('outbox','readwrite');const store=tx.objectStore('outbox');const q=store.getAll();q.onsuccess=()=>{for(const op of q.result){delete op.status;delete op.orderWork;op.attempts=1;store.put(op)}};await new Promise(r=>tx.oncomplete=r);db.close();mountEditor(remote);");
 await waitFor(()=>evaluate('!!draft.conflict'),'legacy conflict');
 await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Folosește versiunea serverului')).click()");
 await waitFor(()=>evaluate('!draft.conflict'),'legacy remote resolution');
 check(await evaluate("(await m.pendingOperations('agent')).length===0&&!(await m.readWork('agent','order',base.id))&&!m.readLocalWork('order','agent',base.id).value"),'T02 old attempted blocked queue resolves server choice atomically');
 await evaluate('root.unmount()');
 // A second real tab adds B while the first tab awaits A's HTTP confirmation.
 await evaluate("window.tabBase=(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order;window.tabA={...tabBase,notes:'A'};await m.enqueue('agent','orders/'+tabBase.id,'PUT',m.orderSaveBody(tabA,tabBase.revision),{scope:'order',id:tabBase.id,value:{base:tabBase,local:tabA}});window.releaseAck=null;window.inflight=m.replay('agent',async(p,method,body,id)=>{const result=await transport(p,method,body,id);if(method==='PUT')await new Promise(r=>releaseAck=r);return result;},m.currentLocalWorkUserId);true");
 await waitFor(()=>evaluate('!!releaseAck'),'A accepted before second-tab B');
 const tabBase=await evaluate('tabBase'),second=await browser.newTab(origin);
 await second.evaluate(`window.m=await import('/fixture.mjs');await m.api('auth/session');window.base=${JSON.stringify(tabBase)};const local={...base,notes:'B'};await m.enqueue('agent','orders/'+base.id,'PUT',m.orderSaveBody(local,base.revision),{scope:'order',id:base.id,value:{base,local}});`);
 await evaluate('releaseAck();await inflight');
 await second.evaluate("await m.replay('agent',(p,method,body,id)=>m.networkApi(p,method,body,undefined,id,'agent'),m.currentLocalWorkUserId)");
 check(await evaluate("(await transport('orders/'+tabBase.id,'GET')).order.notes==='B'&&(await m.pendingOperations('agent')).length===0"),'T01 two real tabs preserve B across A confirmation');
 await second.close();
 // A has fully confirmed before stale tab B edits an independent quantity.
 await evaluate("window.staleBase=(await m.api('orders','POST',{id:crypto.randomUUID(),kind:'accessories',agentId:'agent'})).order;window.product=(await m.api('catalog')).products.find(p=>p.kind==='accessories');staleBase=(await transport('orders/'+staleBase.id,'PUT',m.orderSaveBody({...staleBase,items:[{...product,quantity:1}]},staleBase.revision))).order;");
 const staleBase=await evaluate('staleBase'),product=await evaluate('product'),staleTab=await browser.newTab(origin);
 await staleTab.evaluate(`window.m=await import('/fixture.mjs');await m.api('auth/session');window.base=${JSON.stringify(staleBase)};window.product=${JSON.stringify(product)};`);
 await browser.send('Page.bringToFront');
 await evaluate("const local={...staleBase,notes:'Confirmed notes from A'};await m.enqueue('agent','orders/'+staleBase.id,'PUT',m.orderSaveBody(local,staleBase.revision),{scope:'order',id:staleBase.id,value:{base:staleBase,local}});await replay()");
 check(await evaluate("(await transport('orders/'+staleBase.id,'GET')).order.notes==='Confirmed notes from A'&&(await m.pendingOperations('agent')).length===0"),'A notes are fully acknowledged before stale tab edits');
 await staleTab.send('Page.bringToFront');
 await staleTab.evaluate("const local={...base,items:[{...product,quantity:3}]};await m.saveOrderWork('agent',base.id,{base,local});await m.enqueue('agent','orders/'+base.id,'PUT',m.orderSaveBody(local,base.revision),{scope:'order',id:base.id,value:{base,local}});await m.replay('agent',(p,method,body,id)=>m.networkApi(p,method,body,undefined,id,'agent'),m.currentLocalWorkUserId)");
 check(await evaluate("const saved=(await transport('orders/'+staleBase.id,'GET')).order;saved.notes==='Confirmed notes from A'&&saved.items[0].quantity===3&&(await m.pendingOperations('agent')).length===0"),'A stale second tab quantity preserves confirmed notes through HTTP/IndexedDB');
 await staleTab.close();await browser.send('Page.bringToFront');
 // Compact startup and filtered page caches predate an offline create + update.
 await evaluate("await m.api('bootstrap?compact=1');window.filteredPath='orders?page=1&q=NO-MATCH';await m.api(filteredPath);window.createdId=crypto.randomUUID();await m.enqueue('agent','orders','POST',{id:createdId,kind:'accessories',agentId:'agent'},{scope:'draft-list',id:'all',value:[{...staleBase,id:createdId,number:'Local'}]});await replay();window.created=(await transport('orders/'+createdId,'GET')).order;const local={...created,items:[{...product,quantity:1}],notes:'Confirmed offline update'};await m.enqueue('agent','orders/'+createdId,'PUT',m.orderSaveBody(local,created.revision),{scope:'order',id:createdId,value:{base:created,local}});await replay()");
 const createdId=await evaluate('createdId');
 check(await evaluate("(await m.snapshot('agent',filteredPath)).value.orders.length===0"),'D acknowledgement never inserts into an unrelated filtered page');
 // Simulate metadata written by the installed pre-fix client.
 await evaluate("const db=await new Promise(r=>{const q=indexedDB.open('mobiup-offline-cache-v1');q.onsuccess=()=>r(q.result)});const tx=db.transaction(['snapshotIndex','meta'],'readwrite'),index=tx.objectStore('snapshotIndex'),meta=tx.objectStore('meta');const q=index.get('agent|bootstrap?compact=1');q.onsuccess=()=>index.put({...q.result,pinned:false});meta.delete('compact-pin-v1');await new Promise(r=>tx.oncomplete=r);db.close()");
 // Saturation is cache-only and keeps both essential startup records.
 await evaluate("for(let i=0;i<660;i++)await m.saveSnapshot('agent','saturation/'+i,{i});");
 const fresh=await browser.newTab(origin);
 await fresh.evaluate("window.m=await import('/fixture.mjs');window.fetch=async()=>{throw new TypeError('Synthetic offline')};window.session=await m.api('auth/session');window.boot=await m.api('bootstrap?compact=1');window.rows=await m.reconcileOrderList('agent',boot.orders,true)");
 check(await fresh.evaluate(`session.user.id==='agent'&&boot.user.id==='agent'&&rows.filter(o=>o.id===${JSON.stringify(createdId)}).length===1&&rows.find(o=>o.id===${JSON.stringify(createdId)}).notes==='Confirmed offline update'&&(await m.pendingOperations('agent')).length===0`),'C/D fresh client offline boot after saturation retains exactly one acknowledged draft');
 // No projection mutates a filtered server cache or its authoritative membership.
 check(await evaluate("(await m.readWork('agent','draft-list','all')).every(o=>o.id!==createdId)"),'acknowledged create is no longer an unconfirmed local draft');
 await fresh.close();await browser.send('Page.bringToFront');
 // Finalize without any list refresh, then close and reopen with network loss.
 await evaluate("window.finalBase=(await m.readWork('agent','order-list','confirmed'))[createdId];await m.saveOrderWork('agent',createdId,{base:finalBase,local:finalBase});m.writeLocalWork('order','agent',createdId,{base:finalBase,local:finalBase});");
 const finalizingTab=await browser.newTab(origin);
 await finalizingTab.evaluate(`window.m=await import('/fixture.mjs');await m.api('auth/session');window.base=${JSON.stringify(await evaluate('finalBase'))};window.finalOrder=(await m.api('orders/'+base.id+'/finalize','POST',{revision:base.revision})).order`);
 check(await finalizingTab.evaluate("finalOrder.status==='finalized'"),'successful finalization returned before tab close');
 await finalizingTab.close();
 await evaluate("window.finalOrder=(await m.readWork('agent','order-list','confirmed'))[createdId]");
 check(await evaluate("finalOrder.status==='finalized'&&(await m.readWork('agent','order-list','confirmed'))[createdId].status==='finalized'&&!(await m.readWork('agent','order',createdId))&&!m.readLocalWork('order','agent',createdId).value"),'finalize durably retires confirmed projection and clean recovery before returning to UI');
 const finalizedTab=await browser.newTab(origin);
 await finalizedTab.evaluate("window.m=await import('/fixture.mjs');window.fetch=async()=>{throw new TypeError('Synthetic offline')};await m.api('auth/session');window.boot=await m.api('bootstrap?compact=1');window.rows=await m.reconcileOrderList('agent',boot.orders,true)");
 check(await finalizedTab.evaluate(`rows.filter(o=>o.id===${JSON.stringify(createdId)}).length<=1&&!rows.some(o=>o.id===${JSON.stringify(createdId)}&&o.status==='draft')`),'offline reopened bootstrap never resurrects or duplicates finalized acknowledged draft');
 check(await finalizedTab.evaluate(`const stale={...${JSON.stringify(await evaluate('finalBase'))},revision:999};await m.reconcileOrderList('agent',[stale]);const rows=await m.reconcileOrderList('agent',[stale],true);!rows.some(o=>o.id===stale.id&&o.status==='draft')`),'late old-client list cannot undo terminal projection');
 await finalizedTab.close();await browser.send('Page.bringToFront');
 check(await evaluate("const local={...finalBase,notes:'Unsaved in another tab'};await m.saveOrderWork('agent',createdId,{base:finalBase,local});m.writeLocalWork('order','agent',createdId,{base:finalBase,local});await m.api('orders/'+createdId+'/finalize','POST',{revision:finalBase.revision});(await m.readWork('agent','order',createdId)).local.notes===local.notes&&m.readLocalWork('order','agent',createdId).value.local.notes===local.notes"),'idempotent finalization preserves real unsaved recovery in both stores');
 await evaluate("await m.markOrderDeleted('agent',createdId)");
 check(await evaluate("!(await m.reconcileOrderList('agent',[finalBase],true)).some(o=>o.id===createdId)"),'deleted marker also defeats confirmed projection');
 // H: real rendered form rejects Saturday before persistence, allows correction,
 // and releases a definitive server rejection while retaining entered fields.
 await evaluate('mountPartner()');
 await waitFor(()=>evaluate("!!document.querySelector('.partner-visits textarea')"),'visit form');
 const fillVisit=(selector,value)=>evaluate(`const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));`);
 const clickVisit=()=>evaluate("document.querySelector('.partner-visits button.primary').click()");
 await fillVisit('.partner-visits textarea','Keep entered note');await fillVisit('.partner-follow-up-fields input:not([type=date])','Keep next step');await fillVisit('.partner-follow-up-fields input[type=date]','2026-10-10');await clickVisit();
 await waitFor(()=>evaluate("document.body.innerText.includes('luni până vineri')"),'Saturday validation');
 check(await evaluate("!document.querySelector('.partner-follow-up-fields input[type=date]').disabled&&!(await m.readWork('agent','visit','point'))"),'H Saturday stays editable and never persists pending work');
 await fillVisit('.partner-follow-up-fields input[type=date]','2026-10-12');
 await evaluate("window.fetch=async(input,init)=>init?.method==='POST'?new Response(JSON.stringify({error:'Synthetic validation rejection'}),{status:400}):originalFetch(input,init)");await clickVisit();
 await waitFor(()=>evaluate("document.body.innerText.includes('Synthetic validation rejection')"),'definitive rejection');
 check(await evaluate("!document.querySelector('.partner-visits textarea').disabled&&document.querySelector('.partner-visits textarea').value==='Keep entered note'&&document.querySelector('.partner-follow-up-fields input[type=date]').value==='2026-10-12'&&!(await m.readWork('agent','visit','point'))"),'H definitive 4xx clears pending but preserves correction fields');
 await evaluate('window.fetch=originalFetch');await clickVisit();
 await waitFor(()=>evaluate("document.body.innerText.includes('Vizita a fost sincronizată.')"),'Monday visit success');
 check(await evaluate("document.querySelector('.partner-visits textarea').value===''&&!(await m.readWork('agent','visit','point'))"),'H Monday succeeds and clears confirmed input');
 // Installed legacy clients persisted invalid pending dates before validation.
 for(const invalidDate of ['2026-10-10','2026-02-30']){
  await evaluate(`root.unmount();window.legacyVisit={id:crypto.randomUUID(),notes:'Legacy note',nextStep:'Legacy next step',followUpDate:${JSON.stringify(invalidDate)}};await m.saveWork('agent','visit','point',legacyVisit);mountPartner()`);
  await waitFor(()=>evaluate("!!document.querySelector('.partner-visits textarea')&&!document.querySelector('.partner-visits textarea').disabled&&document.querySelector('.partner-visits textarea').value==='Legacy note'"),'legacy invalid pending unlocked on reopen');
  check(await evaluate(`!document.querySelector('.partner-follow-up-fields input[type=date]').disabled&&document.querySelector('.partner-follow-up-fields input:not([type=date])').value==='Legacy next step'&&!(await m.readWork('agent','visit','point'))&&(await m.readWork('agent','visit-edit','point')).followUpDate===${JSON.stringify(invalidDate)}`),'invalid pending retains all content as editable recovery');
  if(invalidDate==='2026-10-10')check(await evaluate("document.querySelector('.partner-follow-up-fields input[type=date]').value==='2026-10-10'"),'legacy Saturday remains visible for correction');
  await evaluate('root.unmount();mountPartner()');
  await waitFor(()=>evaluate("document.querySelector('.partner-visits textarea')?.value==='Legacy note'"),'editable legacy content survives another reopen');
  await fillVisit('.partner-follow-up-fields input[type=date]','2026-10-12');await clickVisit();
  await waitFor(()=>evaluate("document.body.innerText.includes('Vizita a fost sincronizată.')"),'corrected legacy Monday saves');
  check(await evaluate("!(await m.readWork('agent','visit','point'))&&!(await m.readWork('agent','visit-edit','point'))"),'corrected legacy confirmation clears pending and recovery');
  assert.deepEqual(requests.at(-1).body.notes,'Legacy note');assert.equal(requests.at(-1).body.nextStep,'Legacy next step');assert.equal(requests.at(-1).body.followUpDate,'2026-10-12');
 }
 await fillVisit('.partner-visits textarea','Network retains visit');await evaluate("window.fetch=async()=>{throw new TypeError('Synthetic offline')}");await clickVisit();
 await waitFor(()=>evaluate("document.body.innerText.includes('Vizită salvată pe telefon')"),'network visit queued');
 check(await evaluate("(await m.pendingOperations('agent')).some(op=>op.path.endsWith('/visits'))&&(await m.readWork('agent','visit','point')).notes==='Network retains visit'"),'H network failure remains queued');
 await evaluate('root.unmount();window.fetch=originalFetch;await replay()');
 // Unlocking invalid local content cannot erase a newer tab's pending visit.
 check(await evaluate("const owner='visit-race',old={id:'old',notes:'Keep old',followUpDate:'2026-10-10'},newer={id:'new',notes:'Keep newer'};await m.saveWork(owner,'visit','point',newer);let rejected=false;try{await m.unlockVisitWork(owner,'point',old)}catch{rejected=true}rejected&&(await m.readWork(owner,'visit','point')).id==='new'&&!(await m.readWork(owner,'visit-edit','point'))"),'legacy invalid cleanup compares the persisted pending version');
 check(await evaluate("const owner='visit-retry',body={id:'retry',notes:'Ambiguous request',followUpDate:'2026-10-10'};await m.enqueue(owner,'partner/portfolio/point/visits','POST',body,{scope:'visit',id:'point',value:body});await m.replay(owner,async()=>{throw new TypeError('Synthetic lost response')},()=>owner);const before=JSON.stringify(await m.pendingOperations(owner));await m.unlockVisitWork(owner,'point',body);JSON.stringify(await m.pendingOperations(owner))===before&&(await m.readWork(owner,'visit-edit','point')).notes===body.notes"),'invalid pending unlock preserves attempted immutable outbox identity and content');
 // T01 controls: confirmation merges only the submitted operation, preserving
 // newer edits/reverts and remote changes to non-overlapping fields.
 for(const revert of [false,true]){
  check(await evaluate(`const owner='merge-${revert}',b={...base,id:owner,userId:owner,notes:'',items:[],revision:1};const line={id:'synthetic-product',name:'Synthetic',code:'TEST',kind:'accessories',brand:'',category:'',price:1,netPrice:1,sourceRow:1,image:null,quantity:2};let server={...b,items:[line],revision:2};const sent=[];let pause;let release;const reached=new Promise(r=>pause=r);const syntheticTransport=async(p,method,body,id)=>{if(method==='GET')return{order:server};sent.push({body:structuredClone(body),id});pause();await new Promise(r=>release=r);server={...server,notes:body.notes,revision:server.revision+1};return{order:server};};const A={...b,notes:'A'};await m.enqueue(owner,'orders/'+b.id,'PUT',m.orderSaveBody(A,1),{scope:'order',id:b.id,value:{base:b,local:A}});const first=m.replay(owner,syntheticTransport,()=>owner);await reached;const newer={...b,notes:${revert?"''":"'B'"}};await m.enqueue(owner,'orders/'+b.id,'PUT',m.orderSaveBody(newer,1),{scope:'order',id:b.id,value:{base:b,local:newer}});release();await first;const remaining=(await m.pendingOperations(owner))[0],work=await m.readWork(owner,'order',b.id);remaining.body.notes===newer.notes&&remaining.body.items[0].id===line.id&&work.local.notes===newer.notes&&work.local.items[0].id===line.id&&work.base.notes==='A'`),'T01 in-flight '+(revert?'revert':'B')+' retains non-overlapping remote lines');
 }
 check(await evaluate("const owner='clear-guard',b={...base,id:owner,userId:owner},local={...b,notes:'newer tab'};await m.saveWork(owner,'order',b.id,{base:b,local});await m.clearConfirmedOrderWork(owner,b.id,b);(await m.readWork(owner,'order',b.id)).local.notes==='newer tab'"),'T01 editor cleanup cannot remove another tab newer unsent work');
 check(await evaluate("const owner='immutable-retry',b={...base,id:owner,userId:owner,revision:1,notes:''},local={...b,notes:'A'};let retryRemote=b;const sent=[];const syntheticTransport=async(p,method,body,id)=>{if(method==='GET')return{order:retryRemote};sent.push({body:structuredClone(body),id});if(sent.length===1)throw Error('lost before response');throw Object.assign(Error('revision conflict'),{status:409});};await m.enqueue(owner,'orders/'+b.id,'PUT',m.orderSaveBody(local,1),{scope:'order',id:b.id,value:{base:b,local}});await m.replay(owner,syntheticTransport,()=>owner);retryRemote={...b,revision:2,notes:'External'};await new Promise(r=>setTimeout(r,2100));await m.replay(owner,syntheticTransport,()=>owner);sent.length===2&&sent[0].id===sent[1].id&&JSON.stringify(sent[0].body)===JSON.stringify(sent[1].body)&&(await m.pendingOperations(owner))[0].state==='blocked'"),'T01 retries keep exact attempted payload and operation identity');
 check(await evaluate("const owner='clear-revert',b={...base,id:owner,userId:owner,notes:'A',revision:1};await m.saveWork(owner,'order',b.id,{base:{...b,notes:'C',revision:2},local:b});await m.clearConfirmedOrderWork(owner,b.id,b);(await m.readWork(owner,'order',b.id)).base.revision===2"),'T01 old editor cleanup cannot remove a newer explicit revert');
 // T02 negative controls: an ambiguous sent operation cannot be retired by a
 // choice, revoked access cannot resolve/replay, and another tab defeats CAS.
 for(const mode of ['ambiguous','revoked','concurrent']){
  check(await evaluate(`const owner='resolve-${mode}',b={...base,id:owner,userId:owner,notes:'base',revision:1},local={...b,notes:'local'},remote={...b,notes:'server',revision:2};await m.enqueue(owner,'orders/'+b.id,'PUT',m.orderSaveBody(local,1),{scope:'order',id:b.id,value:{base:b,local}});await m.replay(owner,async(p,method)=>method==='GET'?{order:b}:Promise.reject(Error('lost')),()=>owner);const before=(await m.pendingOperations(owner))[0];let failed=false,reads=0;const syntheticTransport=async(p,method)=>{if('${mode}'==='revoked')throw Object.assign(Error('revoked'),{status:403});if(method==='GET'){if('${mode}'==='concurrent'&&++reads===2)await m.saveWork(owner,'order',b.id,{base:b,local:{...local,notes:'newer tab'}});return{order:remote};}if('${mode}'==='ambiguous')return{};throw Object.assign(Error('rejected revision'),{status:409});};try{await m.resolveQueuedWork({userId:owner,path:'orders/'+b.id,method:'PUT',remote,body:null,local:{scope:'order',id:b.id,value:{base:remote,local:remote}},transport:syntheticTransport,active:()=>owner});}catch{failed=true;}const after=(await m.pendingOperations(owner))[0];failed&&before.id===after.id&&JSON.stringify(before.body)===JSON.stringify(after.body)&&(await m.readWork(owner,'order',b.id)).local.notes===('${mode}'==='concurrent'?'newer tab':'local')`),'T02 '+mode+' retains exact operation and local work');
 }
 for(const terminal of ['deleted','finalized']){
  check(await evaluate(`const owner='terminal-${terminal}',b={...base,id:owner,userId:owner},local={...b,notes:'retained'};const op=await m.enqueue(owner,'orders/'+b.id,'PUT',m.orderSaveBody(local,1),{scope:'order',id:b.id,value:{base:b,local}});const syntheticTransport=async()=>{if('${terminal}'==='deleted')throw Object.assign(Error('deleted'),{status:404});return{order:{...b,status:'finalized'}};};await m.retireOrderWork(owner,b.id,syntheticTransport,()=>owner);(await m.pendingOperations(owner)).length===0&&(await m.readWork(owner,'recovered-order',b.id)).local.notes==='retained'&&(await m.readWork(owner,'resolved-operation',op.id)).id===op.id`),'T02 '+terminal+' retires safely with archived recovery copy');
 }
 // T03: local draft survives every list read; confirmed/deleted rows never revive.
 check(await evaluate("const local={...base,id:crypto.randomUUID(),number:'Ciornă locală'};window.listLocal=local;await m.saveWork('agent','draft-list','all',[local]);(await m.reconcileOrderList('agent',[])).some(o=>o.id===local.id)&&(await m.reconcileOrderList('agent',[])).some(o=>o.id===local.id)"),'T03 local-only survives refresh/reload rule');
 check(await evaluate("const confirmed={...listLocal,number:'TEST'};(await m.reconcileOrderList('agent',[confirmed])).filter(o=>o.id===confirmed.id).length===1&&(await m.reconcileOrderList('agent',[])).length===0"),'T03 confirmed local collapses and cannot return from an old draft-list');
 check(await evaluate("await m.markOrderDeleted('agent',listLocal.id);(await m.reconcileOrderList('agent',[listLocal])).length===0&&(await m.reconcileOrderList('other',[])).length===0"),'T03 tombstones defeat late server pages and preserve account isolation');
 // T04: actual profile conflict does not starve an authorized visit. Legacy
 // entity keys are deliberately retained to exercise an installed old queue.
 await evaluate("window.path='partner/portfolio/point';window.profile=(await transport(path,'GET')).partner;await m.enqueue('agent',path,'PATCH',{...profile,contact:'Local contact'});await transport(path,'PATCH',{...profile,contact:'Remote contact'});await replay();window.visitId=crypto.randomUUID();await m.enqueue('agent',path+'/visits','POST',{id:visitId,notes:'Independent visit'});");
 await evaluate("const db=await new Promise(r=>{const q=indexedDB.open('mobiup-offline-v3',1);q.onsuccess=()=>r(q.result)});const tx=db.transaction('outbox','readwrite');const q=tx.objectStore('outbox').getAll();q.onsuccess=()=>{for(const op of q.result){if(op.path.endsWith('/visits')){op.entity=path;tx.objectStore('outbox').put(op)}}};await new Promise(r=>tx.oncomplete=r);db.close();");
 dropNext=true;await evaluate('await replay()');await delay(2100);await evaluate('await replay()');
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM partner_visits WHERE id=?').bind(await evaluate('visitId')).first()).n,1);
 check(await evaluate("(await m.pendingOperations('agent')).length===1&&(await m.pendingOperations('agent'))[0].path===path"),'T04 independent lost-response visit confirms exactly once while profile stays blocked');
 // Contextual client/profile resolution and day-plan resolution use the same
 // guarded replacement transaction, with fresh authorization and revision.
 check(await evaluate("const remote=(await transport(path,'GET')).partner;const next={...remote,contact:'Chosen contact'};const old=(await m.pendingOperations('agent'))[0];await m.resolveQueuedWork({userId:'agent',path,method:'PATCH',remote,body:next,local:{scope:'partner',id:'point',value:next},transport,active:m.currentLocalWorkUserId});const replacement=(await m.pendingOperations('agent'))[0];await replay();replacement.id!==old.id&&(await m.pendingOperations('agent')).length===0&&(await transport(path,'GET')).partner.contact==='Chosen contact'"),'T02 profile choice replaces blocked operation and confirms chosen fields');
 for(const choice of ['local','remote']){
  check(await evaluate(`const date='2026-10-0${choice==='local'?'5':'6'}',week='2026-10-05',payload={date,stops:[],revision:0};await m.enqueue('agent','partner/planning','PUT',payload,{scope:'plans',id:week,value:{[date]:[]}});const remote=await transport('partner/planning','PUT',{date,stops:['point'],revision:0});await replay();const old=(await m.pendingOperations('agent'))[0];const body={...remote,stops:[]};await m.resolveQueuedWork({userId:'agent',path:'partner/planning',method:'PUT',remote,body:'${choice}'==='local'?body:null,local:{scope:'plans',id:week,value:{[date]:'${choice}'==='local'?[]:remote.stops}},transport,active:m.currentLocalWorkUserId});await replay();const current=(await transport('partner/planning?week='+week,'GET')).plans.find(p=>p.date===date);(await m.pendingOperations('agent')).length===0&&current.stops.length===('${choice}'==='local'?0:1)&&(await m.readWork('agent','plans',week))[date].length===current.stops.length&&(await m.readWork('agent','resolved-operation',old.id)).id===old.id`),'T02 day-plan '+choice+' reconciles queue and local work');
 }
 await db.prepare("UPDATE customers SET warehouse_id='moved',data=json_set(data,'$.warehouseIds',json_array('moved')) WHERE id='point'").run();
 await evaluate("window.deniedId=crypto.randomUUID();await m.enqueue('agent',path+'/visits','POST',{id:deniedId,notes:'Revoked'});await replay();");
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM partner_visits WHERE id=?').bind(await evaluate('deniedId')).first()).n,0);
 check(await evaluate("(await m.pendingOperations('agent')).find(op=>op.path.endsWith('/visits')).state==='blocked'"),'T04 moved portfolio prevents visit on actual server');
 console.log(`PASS: ${checks} recovery contracts with React, real Chrome/IndexedDB and HTTP/SQLite.`);

}finally{
 await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 if(previousDirectory===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previousDirectory;
 rmSync(directory,{recursive:true,force:true});
}
