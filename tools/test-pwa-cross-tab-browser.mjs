// Real waiting workers and two same-origin documents. Pauses are explicit protocol
// barriers, not timing assumptions; no fixture uses production records or assets.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
let browser,server,version='old',checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {PwaInstall,getOfflineShellPreparation} from './components/pwa';import * as work from './lib/offline-work';import {setLocalWorkUserId} from './lib/local-work';window.work=work;window.shell=getOfflineShellPreparation;setLocalWorkUserId('editor');window.documentToken=crypto.randomUUID();createRoot(document.getElementById('root')).render(<><textarea defaultValue="Synthetic unsaved editor"/><PwaInstall/></>);`,loader:'tsx',resolveDir:resolve('.')},write:false,bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const workBundle=await build({stdin:{contents:"export * from './lib/offline-work';",loader:'ts',resolveDir:resolve('.')},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 const worker=tag=>readFileSync('public/sw.js','utf8').replace('__SHELL_VERSION__',tag).replace('/*__SHELL_ESSENTIAL__*/[]',JSON.stringify(['/offline.html']));
 server=createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.url==='/sw.js'){res.setHeader('Content-Type','text/javascript');res.end(worker(version));return;}if(req.url==='/fixture.js'||req.url==='/work.mjs'){res.setHeader('Content-Type','text/javascript');res.end((req.url==='/fixture.js'?bundle:workBundle).outputFiles[0].text);return;}res.setHeader('Content-Type','text/html');res.end(req.url==='/'?'<!doctype html><div id="root"></div><script src="/fixture.js"></script>':'<!doctype html><title>Synthetic second editor</title><textarea>Synthetic second editor</textarea>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);const a=browser.evaluate,b=await browser.newTab(origin+'/second');await b.evaluate("window.work=await import('/work.mjs')");
 const wait=expression=>waitFor(()=>a(expression),expression);
 await wait('!!window.work&&!!navigator.serviceWorker.controller');const token=await a('documentToken');
 const offer=async tag=>{version=tag;await a('await (await navigator.serviceWorker.getRegistration()).update()');await wait("navigator.serviceWorker.getRegistration().then(r=>!!r.waiting&&!r.installing)");await wait("document.body.innerText.includes('Activează pentru următoarea')");};
 const click=()=>a("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Activează pentru următoarea')).click()");
 const clear=()=>b.evaluate("for(const row of await work.pendingOperations('other-account'))await work.removeOperation(row.id)");
 await offer('candidate');
 // Release an older empty count after a newer blocked queue read has rendered.
 await a(`window.originalCount=IDBObjectStore.prototype.count;window.holdCount=true;IDBObjectStore.prototype.count=function(...args){const req=originalCount.apply(this,args);if(this.name!=='outbox'||!holdCount)return req;holdCount=false;return {get result(){return req.result},set onsuccess(fn){req.onsuccess=()=>{window.releaseCount=fn;window.countHeld=true}},set onerror(fn){req.onerror=fn}}};window.dispatchEvent(new Event(work.OFFLINE_EVENT));`);
 await wait('!!window.countHeld');
 await b.evaluate("await work.enqueue('other-account','partner/portfolio/point','PATCH',{revision:1},{scope:'partner',id:'point',value:{notes:'Synthetic retained work'}});await work.replay('other-account',async()=>{throw Object.assign(new Error('Synthetic permission block'),{status:403})},()=> 'other-account')");
 await wait("document.body.innerText.includes('Sincronizează lucrul local')");
 await a('releaseCount();IDBObjectStore.prototype.count=originalCount');
 check(await a("document.body.innerText.includes('Sincronizează lucrul local')&&!document.body.innerText.includes('Activează pentru următoarea')"),'blocked queue in an unrelated account blocks activation; stale empty status cannot overwrite it');
 // Exercise the authoritative check, even if the UI saw zero before another tab saved.
 await clear();await wait("document.body.innerText.includes('Activează pentru următoarea')");
 await a("window.originalPost=ServiceWorker.prototype.postMessage;ServiceWorker.prototype.postMessage=function(message,...args){if(message.type==='PREPARE_OFFLINE_SHELL'){window.releasePrepare=()=>originalPost.call(this,message,...args);return}return originalPost.call(this,message,...args)}");await click();await wait('!!window.releasePrepare');
 await b.evaluate("await work.enqueue('other-account','partner/portfolio/point','PATCH',{revision:2})");await a('releasePrepare();ServiceWorker.prototype.postMessage=originalPost');
 await wait("document.querySelector('[role=alert]')?.textContent.includes('toate conturile')");
 check(await a("(await navigator.serviceWorker.getRegistration()).waiting!==null"),'complete outbox check aborts stale zero-count activation');await clear();await wait("document.body.innerText.includes('Activează pentru următoarea')");
 // Missing Web Locks: actionable refusal while durable saves remain available.
 await a("window.originalLocks=navigator.locks;Object.defineProperty(navigator,'locks',{configurable:true,value:undefined})");await click();await wait("document.querySelector('[role=alert]')?.textContent.includes('browser actualizat')");
 check(await a("(await navigator.serviceWorker.getRegistration()).waiting!==null"),'no-lock fallback refuses activation');await a("Object.defineProperty(navigator,'locks',{configurable:true,value:originalLocks})");
 // Hold ACTIVATE_SAFE after the all-account empty read: another tab's durable
 // save must be pending on the same lock until activation settles or aborts.
 const hold=async()=>{await a("window.activationReached=false;window.releaseActivation=null;ServiceWorker.prototype.postMessage=function(message,...args){if(message.type==='ACTIVATE_SAFE'){window.activationReached=true;window.releaseActivation=()=>originalPost.call(this,message,...args);return}return originalPost.call(this,message,...args)}");await click();await wait('activationReached');await b.evaluate("window.saveDone=false;window.saving=work.enqueue('other-account','partner/portfolio/point','PATCH',{revision:3},{scope:'partner',id:'point',value:{notes:'Synthetic waiting save'}}).then(()=>saveDone=true);void 0");await waitFor(()=>b.evaluate("navigator.locks.query().then(s=>s.pending.some(l=>l.name==='mobiup-outbox-activation'))"));check(await b.evaluate("!saveDone&&(await work.pendingOperations('other-account')).length===0"),'durable enqueue cannot commit between empty check and activation settlement');};
 await hold();
 version='replacement';await a('await (await navigator.serviceWorker.getRegistration()).update()');await b.evaluate('await saving');await wait("document.querySelector('[role=alert]')?.textContent.includes('schimbat')");
 check(await b.evaluate("saveDone&&(await work.readWork('other-account','partner','point')).notes==='Synthetic waiting save'"),'real waiting-worker replacement aborts activation and releases queued save');
 await a('ServiceWorker.prototype.postMessage=originalPost');await clear();await wait("navigator.serviceWorker.getRegistration().then(r=>!!r.waiting&&!r.installing)");await wait("document.body.innerText.includes('Activează pentru următoarea')");
 // Posting errors also release the lock immediately.
 await a("ServiceWorker.prototype.postMessage=function(message,...args){if(message.type==='ACTIVATE_SAFE')throw new Error('Synthetic activation failure');return originalPost.call(this,message,...args)}");await click();await wait("document.querySelector('[role=alert]')?.textContent.includes('Synthetic activation failure')");
 await b.evaluate("await work.enqueue('other-account','partner/portfolio/point','PATCH',{revision:4})");check(await b.evaluate("(await work.pendingOperations('other-account')).length===1"),'post failure releases gate without dropping work');await clear();await a('ServiceWorker.prototype.postMessage=originalPost');await wait("document.body.innerText.includes('Activează pentru următoarea')");
 // Bound activation timeout, using the real timer callback with a shorter delay.
 await a('window.originalTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===15000?1000:ms,...args)');await hold();await b.evaluate('await saving');await wait("document.querySelector('[role=alert]')?.textContent.includes('confirmată')");
 check(await b.evaluate('saveDone'),'activation timeout releases waiting save');await a('window.setTimeout=originalTimeout;ServiceWorker.prototype.postMessage=originalPost');await clear();await wait("document.body.innerText.includes('Activează pentru următoarea')");
 // A replay completion can recreate a removed row; its update must use the
 // same gate as enqueue, even when an operator removed the in-flight item.
 await b.evaluate("await work.enqueue('other-account','partner/portfolio/replay-point','PATCH',{revision:5});window.replaying=work.replay('other-account',()=>new Promise((resolve,reject)=>window.failReplay=()=>reject(new Error('Synthetic interrupted transport'))),()=> 'other-account');void 0");
 await waitFor(()=>b.evaluate('!!window.failReplay'));await clear();await wait("document.body.innerText.includes('Activează pentru următoarea')");
 await hold();await b.evaluate('failReplay()');
 await waitFor(()=>b.evaluate("navigator.locks.query().then(s=>s.pending.filter(l=>l.name==='mobiup-outbox-activation').length===2)"));
 check(await b.evaluate("(await work.pendingOperations('other-account')).length===0"),'replay update cannot recreate a row while activation owns the gate');
 await a('releaseActivation();ServiceWorker.prototype.postMessage=originalPost');await b.evaluate('await saving;await replaying');await wait("shell().state==='ready'");
 check(await a(`documentToken===${JSON.stringify(token)}&&document.querySelector('textarea').value==='Synthetic unsaved editor'`),'successful activation keeps current document and editor');
 check(await b.evaluate("saveDone&&(await work.pendingOperations('other-account')).length===2&&(await work.readWork('other-account','partner','point')).notes==='Synthetic waiting save'"),'save waiting through successful activation persists with its recovery copy');
 await clear();await offer('close-test');await hold();
 // Closing the owner tab must not strand the second document behind its lock.
 await browser.closeTab();await b.evaluate('await saving');
 check(await b.evaluate("saveDone&&(await work.pendingOperations('other-account')).length===1"),'closing activation document releases browser-owned lock and preserves queued save');
 console.log(`PASS: ${checks} real two-tab activation/outbox regressions.`);
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
