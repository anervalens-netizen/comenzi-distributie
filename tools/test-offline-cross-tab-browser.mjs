// Real same-origin tabs, Web Locks and v1 IndexedDB; all payloads synthetic.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
let browser,server,checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const bundle=await build({stdin:{contents:"export * from './lib/client-api';export * from './lib/offline-work';export * from './lib/local-work';",loader:'ts',resolveDir:resolve('.')},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.mjs'?'text/javascript':'text/html');res.end(req.url==='/fixture.mjs'?bundle.outputFiles[0].text:'<!doctype html><title>Synthetic cross-tab session</title>');});
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
 const d=await browser.newTab();await init(d);await d.evaluate('offline()');
 check(await d.evaluate("(await m.api('bootstrap')).user.id==='synthetic'&&m.currentLocalWorkUserId()==='synthetic'"),'genuine offline boot still restores remembered account');
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
 console.log(`PASS: ${checks} real two-tab session rejection regressions.`);
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
