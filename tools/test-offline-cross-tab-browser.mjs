// Real same-origin tabs, Web Locks and v1 IndexedDB; all payloads synthetic.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
let browser,server,checks=0,networkCalls=0,networkUser={id:'network-account'};
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const bundle=await build({stdin:{contents:"export * from './lib/client-api';export * from './lib/offline-work';export * from './lib/local-work';",loader:'ts',resolveDir:resolve('.')},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 server=createServer((req,res)=>{if(req.url.startsWith('/api/')){networkCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/partner/summary'?{partners:[{id:'network-point'}]}:{user:networkUser}));return;}res.setHeader('Content-Type',req.url==='/fixture.mjs'?'text/javascript':'text/html');res.end(req.url==='/fixture.mjs'?bundle.outputFiles[0].text:'<!doctype html><title>Synthetic cross-tab session</title>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);const a=browser.evaluate,b=await browser.newTab();
 const init=tab=>tab.evaluate("window.m=await import('/fixture.mjs');window.online=()=>{window.fetch=async()=>new Response(JSON.stringify({user:{id:'synthetic'}}))};window.offline=()=>{window.fetch=async()=>{throw new TypeError('Synthetic offline')}};online()");
 await init(browser);await init(b);await a("await m.api('bootstrap');await m.api('auth/session')");
 await waitFor(()=>b.evaluate("m.currentLocalWorkUserId()==='synthetic'"));
 // Capture an earlier positive response, including its persistent starting epoch.
 await b.evaluate("window.fetch=()=>new Promise(resolve=>window.finishPositive=resolve);window.earlier=m.api('bootstrap').then(()=>false,e=>e.status===409);void 0");
 await waitFor(()=>b.evaluate('!!window.finishPositive'));
 // Hold only the cleanup transaction open. The rejection tombstone transaction
 // has already committed when this legacy active-account write is reached.
 await a(`window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){const result=originalPut.call(this,value,...args);if(this.name==='meta'&&value.key==='active'&&value.value===''){window.cleanupReached=true;const store=this;const spin=()=>{const r=store.get('active');r.onsuccess=()=>{if(!window.releaseCleanup)spin()}};spin()}return result};window.fetch=async()=>new Response(JSON.stringify({user:null}));window.rejection=m.api('bootstrap');void rejection.catch(()=>{});`);
 await waitFor(()=>a('!!window.cleanupReached'));
 await b.evaluate("window.originalGet=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(key){if(this.name==='meta'&&key==='session-fence')window.fenceRead=true;return originalGet.call(this,key)};offline();window.restored='waiting';window.restore=m.api('bootstrap').then(()=>restored='unsafe',()=>restored='rejected');void 0");
 await waitFor(()=>b.evaluate('!!window.fenceRead'));
 check(await b.evaluate("restored==='waiting'&&m.currentLocalWorkUserId()===''"),'second tab waits through the exact rejection/remembered-account cleanup gap');
 await a('window.releaseCleanup=true;await rejection;IDBObjectStore.prototype.put=originalPut');
 await b.evaluate("finishPositive(new Response(JSON.stringify({user:{id:'synthetic'}})));await restore;IDBObjectStore.prototype.get=originalGet");
 check(await b.evaluate("await earlier&&restored==='rejected'&&m.currentLocalWorkUserId()===''"),'delayed earlier positive and offline fallback cannot clear rejection');
 // Retained legacy account metadata must not be authority after rejection.
 await a("await m.rememberAccount('synthetic')");
 const c=await browser.newTab();await init(c);await c.evaluate('offline()');
 check(await c.evaluate("let denied=false;try{await m.api('bootstrap')}catch{denied=true}denied&&m.currentLocalWorkUserId()===''"),'tab loaded after rejection refuses retained lastAccount');
 await c.evaluate("Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Synthetic unavailable','SecurityError')}});void 0");
 check(await c.evaluate("let denied=false;try{await m.api('auth/session')}catch{denied=true}denied&&m.currentLocalWorkUserId()===''"),'unavailable localStorage does not resurrect rejected IndexedDB account');
 await a("online();await m.api('bootstrap');await m.api('auth/session')");
 check(await a("!(await m.sessionFence()).rejected"),'fresh validated positive clears only its current rejection');
 await a("m.setLocalWorkUserId('')");
 // Observe the other tab's restoration before removing localStorage access.
 // Reading localStorage itself is synchronous, but its storage event is queued;
 // a pending event would legitimately invalidate the following request mid-flight.
 await a("window.restoreObserved=new Promise(resolve=>{const listener=event=>{if(event.detail.userId==='synthetic'){removeEventListener(m.LOCAL_WORK_USER_EVENT,listener);resolve(true)}};addEventListener(m.LOCAL_WORK_USER_EVENT,listener)});void 0");
 const d=await browser.newTab();await init(d);await d.evaluate('offline()');
 check(await d.evaluate("(await m.api('bootstrap')).user.id==='synthetic'&&m.currentLocalWorkUserId()==='synthetic'"),'genuine offline boot still restores remembered account');
 check(await a('await restoreObserved'),'rejecting tab has observed the prior restoration before the storage capability fault');
 // Even if the rejecting tab cannot publish localStorage events, the shared
 // IndexedDB tombstone fences a still-bound reader in another tab.
 await a("window.storageDescriptor=Object.getOwnPropertyDescriptor(window,'localStorage');Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Synthetic unavailable','SecurityError')}});window.fetch=async()=>new Response(JSON.stringify({user:null}));await m.api('bootstrap');void 0");
 await d.evaluate('offline()');
 check(await d.evaluate("let denied=false;try{await m.api('bootstrap')}catch{denied=true}denied"),'rejection remains shared when the rejecting tab cannot access localStorage');
 await a("Object.defineProperty(window,'localStorage',storageDescriptor);void 0");
 // A fresh positive request made against one tombstone loses authority if a
 // second rejection happens before its response, even while already anonymous.
 await a("window.fetch=async()=>new Response(JSON.stringify({user:null}));await m.api('bootstrap')");
 await b.evaluate("window.finishPositive=null;window.fetch=()=>new Promise(resolve=>window.finishPositive=resolve);window.earlier=m.api('auth/session').then(()=>false,e=>e.status===409);void 0");
 await waitFor(()=>b.evaluate('!!window.finishPositive'));
 await a("await m.api('bootstrap')");
 await b.evaluate("finishPositive(new Response(JSON.stringify({user:{id:'synthetic'}})))");
 check(await b.evaluate("await earlier&&(await m.sessionFence()).rejected"),'positive for an older tombstone cannot clear a newer anonymous rejection');
 check(await a("const db=await new Promise((r,j)=>{const q=indexedDB.open('mobiup-offline-v3',1);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const version=db.version;db.close();version===1&&(await m.snapshot('synthetic','bootstrap')).value.user.id==='synthetic'"),'v1 schema and retained account recovery survive');
 // Separate documents cannot rely on storage events; persistent request CAS is
 // the authority for both null/401 responses and conflicting positive accounts.
 const isolated=async()=>{const tab=await browser.newTab();await tab.evaluate("Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Synthetic unavailable','SecurityError')}});window.m=await import('/fixture.mjs');");return tab;};
 const older=await isolated(),newer=await isolated();
 const start=async(tab,path='bootstrap')=>{
  await tab.evaluate(`window.finish=null;window.fetch=()=>new Promise(resolve=>window.finish=resolve);window.pending=m.api(${JSON.stringify(path)}).then(()=>false,e=>e.status===409);void 0`);
  await waitFor(()=>tab.evaluate('!!window.finish'));
 };
 const positive=(tab,id)=>tab.evaluate(`window.fetch=async()=>new Response(JSON.stringify({user:{id:${JSON.stringify(id)}}}));await m.api('bootstrap');`);
 for(const status of [200,401]){
  await start(older);
  await positive(newer,'account-A');
  const epoch=await newer.evaluate('(await m.sessionFence()).epoch');
  await older.evaluate(`finish(new Response(JSON.stringify(${status===200?'{user:null}':"{error:'Synthetic expired'}"}),{status:${status}}));`);
  check(await older.evaluate(`await pending&&(await m.sessionFence()).epoch===${JSON.stringify(epoch)}&&!(await m.sessionFence()).rejected`),'older '+status+' cannot tombstone newer login without localStorage');
  check(await newer.evaluate("window.fetch=async()=>{throw new TypeError('Synthetic offline')};(await m.api('bootstrap')).user.id==='account-A'"),'newer validated snapshot remains usable offline after stale '+status);
 }
 await start(older);await positive(newer,'account-B');
 await older.evaluate("finish(new Response(JSON.stringify({user:{id:'account-A'}})))");
 check(await older.evaluate("await pending&&(await m.sessionFence()).userId==='account-B'&&m.currentLocalWorkUserId()===''"),'stale different-account positive cannot replace the shared binding');
 // Three requests from one document plus another tab join the same admission;
 // every positive advances the epoch, without rejecting its valid siblings.
 await older.evaluate("window.finishes=[];window.fetch=()=>new Promise(resolve=>finishes.push(resolve));window.positives=Promise.all(['bootstrap','auth/session','bootstrap'].map(path=>m.api(path)));void positives.catch(()=>{})");
 await waitFor(()=>older.evaluate('finishes.length===3'));
 await positive(newer,'account-C');
 await older.evaluate("for(const finish of finishes)finish(new Response(JSON.stringify({user:{id:'account-C'}})));void 0");
 check(await older.evaluate("(await positives).every(value=>value.user.id==='account-C')&&m.currentLocalWorkUserId()==='account-C'"),'concurrent same-account boot positives all succeed across documents');
 await start(older);await positive(newer,'account-D');await positive(newer,'account-C');
 await older.evaluate("finish(new Response(JSON.stringify({user:{id:'account-C'}})))");
 check(await older.evaluate('await pending'),'A to B to A account changes fence earlier same-account positives');
 await positive(older,'account-C');await positive(newer,'account-D');
 check(await older.evaluate("window.fetch=async()=>{throw new TypeError('Synthetic offline')};let denied=false;try{await m.api('bootstrap')}catch{denied=true}denied"),'offline snapshot cannot restore an account superseded in another tab');
 await start(older);await newer.evaluate("window.fetch=async()=>new Response(JSON.stringify({user:null}));await m.api('bootstrap')");
 await older.evaluate("finish(new Response(JSON.stringify({user:{id:'account-D'}})))");
 check(await older.evaluate('await pending'),'newer rejection still fences delayed positives without localStorage');
 // Without Web Locks, cleanup still compares the committed tombstone, so it
 // cannot erase a positive binding accepted between the two metadata writes.
 const unlockedA=await isolated(),unlockedB=await isolated();
 for(const tab of [unlockedA,unlockedB])await tab.evaluate("Object.defineProperty(navigator,'locks',{value:undefined});void 0");
 await positive(unlockedA,'unlocked-account');
 await unlockedA.evaluate("window.fetch=async()=>new Response(JSON.stringify({user:null}));window.pending=m.api('bootstrap');await pending;window.tombstone=await m.sessionFence();");
 await positive(unlockedB,'unlocked-account');
 check(await unlockedA.evaluate("await m.rememberAccount('',tombstone);(await m.lastAccount())==='unlocked-account'"),'stale cleanup cannot clear a newer binding without Web Locks');
 await start(unlockedA);await positive(unlockedB,'unlocked-account');
 await unlockedA.evaluate("finish(new Response(JSON.stringify({user:null})))");
 check(await unlockedA.evaluate('await pending&&!(await m.sessionFence()).rejected'),'negative CAS also holds without localStorage or Web Locks');
 // Use real HTTP fetch in two new documents per capability fault. These tabs
 // share retained snapshots from above but may only trust the network response.
 for(const fault of ['missing','denied','error','blocked','silent','transaction','stalled','no-locks','no-storage-or-locks']){
  const tabs=[await browser.newTab(),await browser.newTab()];
  for(const tab of tabs){
   await tab.evaluate(`window.warnings=0;addEventListener('mobiup-storage-error',()=>warnings++);
    ${fault==='missing'||fault==='no-storage-or-locks'?"Object.defineProperty(window,'indexedDB',{value:undefined});":fault==='denied'?"Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Synthetic denied','SecurityError')}});":fault==='error'||fault==='blocked'||fault==='silent'?`indexedDB.open=()=>{const req={error:new DOMException('Synthetic storage failure','UnknownError')};${fault==='silent'?'':`setTimeout(()=>req.on${fault}?.(),0);`}return req};`:fault==='transaction'?"window.originalTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){if(args[0]==='meta')throw new DOMException('Synthetic broken transaction','UnknownError');return originalTransaction.apply(this,args)};":fault==='stalled'?"window.originalGet=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(key){const req=originalGet.call(this,key);if(this.name==='meta'&&key==='session-fence'){const store=this;const spin=()=>{const next=originalGet.call(store,key);next.onsuccess=spin};spin()}return req};":''}
    ${fault==='no-locks'||fault==='no-storage-or-locks'?"Object.defineProperty(navigator,'locks',{value:undefined});":''}
    window.m=await import('/fixture.mjs');window.started=performance.now();`);
  }
  networkUser={id:'network-account'};const before=networkCalls;
  for(const tab of tabs){
   check(await tab.evaluate("(await m.api('auth/login','POST')).user.id==='network-account'&&(await m.api('auth/session')).user.id==='network-account'&&(await m.api('bootstrap')).user.id==='network-account'&&(await m.api('partner/summary')).partners[0].id==='network-point'&&m.currentLocalWorkUserId()==='network-account'&&performance.now()-started<5000"),fault+' reaches real online auth and private reads within bound');
   if(fault!=='no-locks')check(await tab.evaluate('!m.sessionStorageAvailable()&&warnings>0'),fault+' explicitly disables offline authority for the document');
  }
  check(networkCalls===before+8,fault+' requests actually reached HTTP server from both tabs');
  networkUser=null;
  for(const tab of tabs){
   check(await tab.evaluate("(await m.api('bootstrap')).user===null&&m.currentLocalWorkUserId()===''"),fault+' explicit anonymous response is authoritative');
   check(await tab.evaluate("window.fetch=async()=>{throw new TypeError('Synthetic offline')};let denied=false;try{await m.api('bootstrap')}catch{denied=true}denied&&m.currentLocalWorkUserId()===''"),fault+' cannot revive retained authentication after rejection');
   await tab.close();
  }
 }
 console.log(`PASS: ${checks} real two-tab session rejection regressions.`);
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
