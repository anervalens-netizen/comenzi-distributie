// Synthetic v2 -> current installed-worker upgrade with real IndexedDB and React UI.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const directory=mkdtempSync(join(tmpdir(),'offline-upgrade-'));let current=false,disconnected=false,chrome,socket,checks=0;
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {PwaInstall} from './components/pwa';import * as work from './lib/offline-work';import {setLocalWorkUserId} from './lib/local-work';setLocalWorkUserId('upgrade-agent');window.work=work;window.documentToken=crypto.randomUUID();createRoot(document.getElementById('root')).render(<><textarea defaultValue="Synthetic unsaved work"/><PwaInstall/></>);`;
const bundle=await build({stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,jsx:'automatic',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const old=`const CACHE='mobiup-shell-v2';const PUBLIC_FILES=['/offline.html'];self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PUBLIC_FILES)));self.skipWaiting();});self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('mobiup-')&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);if(r.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/'))return;if(r.mode==='navigate')e.respondWith(fetch(r).catch(()=>caches.match('/offline.html')));});`;
const next=readFileSync('public/sw.js','utf8').replace('__SHELL_VERSION__','upgrade-fixture').replace('/*__SHELL_ESSENTIAL__*/[]',JSON.stringify(['/offline.html','/fixture.js'])).replace('/*__SHELL_OPTIONAL__*/[]','[]');
const server=createServer((req,res)=>{if(disconnected){req.socket.destroy();return;}res.setHeader('Cache-Control','no-store');if(req.url==='/sw.js'){res.setHeader('Content-Type','text/javascript');res.end(current?next:old);}else if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}else if(req.url==='/offline.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>'+(current?'CURRENT GENERIC SHELL':'LEGACY GENERIC SHELL')+'</body>');}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function wait(fn,label){for(let i=0;i<450;i++){if(await fn())return;await sleep(100);}throw Error('Timeout '+label+(typeof evaluateDebug==='function'?await evaluateDebug():''));}
let evaluateDebug;
const check=(v,label)=>{assert.ok(v,label);checks++;};
try{
 chrome=spawn(process.env.CHROME_BIN||'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+directory,origin],{stdio:'ignore',detached:true});
 let port;await wait(()=>{try{port=Number(readFileSync(join(directory,'DevToolsActivePort'),'utf8').split('\n')[0]);return !!port;}catch{return false;}},'Chrome');
 const page=await fetch(`http://127.0.0.1:${port}/json/new?${origin}`,{method:'PUT'}).then(r=>r.json());socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));let id=0;const pending=new Map();
 socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('CDP '+method)),45000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,replMode:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 evaluateDebug=()=>evaluate('document.body.innerText');
 await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await wait(()=>evaluate('!!window.work&&!!navigator.serviceWorker.controller'),'legacy control');
 check(await evaluate("(await caches.keys()).includes('mobiup-shell-v2')"),'legacy installation exists');
 await evaluate("await caches.open('mobiup-shell-v2').then(c=>c.put('/_next/static/legacy-test.js',new Response('OLD TAB ASSET')));await work.saveWork('upgrade-agent','partner','local',{phone:'synthetic'});await work.enqueue('upgrade-agent','partner/portfolio/synthetic','PATCH',{revision:1});");
 const token=await evaluate('documentToken');current=true;await evaluate("await navigator.serviceWorker.getRegistration().then(r=>r.update())");await wait(()=>evaluate("navigator.serviceWorker.getRegistration().then(r=>!!r.waiting)"),'waiting update');
 await wait(()=>evaluate("document.body.innerText.includes('Actualizare disponibilă')"),'update UI');
 check(await evaluate("document.body.innerText.includes('Sincronizează lucrul local')&&!document.body.innerText.includes('Activează pentru următoarea')"),'update activation is blocked while operations are pending');
 check(await evaluate(`documentToken===${JSON.stringify(token)}&&document.querySelector('textarea').value==='Synthetic unsaved work'`),'update does not reload or lose unsaved editor');
 check(await evaluate("(await work.readWork('upgrade-agent','partner','local')).phone==='synthetic'&&(await work.pendingOperations('upgrade-agent')).length===1"),'durable work survives worker installation');
 await evaluate("for(const op of await work.pendingOperations('upgrade-agent'))await work.removeOperation(op.id)");await wait(()=>evaluate("document.body.innerText.includes('Activează pentru următoarea')"),'safe activation offer');await evaluate("window.changed=new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',()=>r(true),{once:true}));[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Activează pentru următoarea')).click()");
 await wait(()=>evaluate("navigator.serviceWorker.getRegistration().then(r=>!r.waiting&&r.active?.state==='activated')"),'safe activation');await evaluate('await window.changed');
 check(await evaluate(`documentToken===${JSON.stringify(token)}`),'explicit activation preserves current document');
 disconnected=true;await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 check(await evaluate("fetch('/_next/static/legacy-test.js').then(r=>r.text()).then(t=>t==='OLD TAB ASSET')"),'old immutable assets remain available offline to open tabs');
 await send('Page.navigate',{url:origin+'/reopen'});await wait(()=>evaluate("document.body.innerText==='CURRENT GENERIC SHELL'"),'new offline shell');
 check(await evaluate("document.body.innerText==='CURRENT GENERIC SHELL'"),'next offline opening uses current generic shell');
 console.log('PASS: '+checks+' installed v2/current upgrade checks.');
 }finally{
 socket?.close();
 // Chrome descendants share this test's process group and may outlive its launcher.
 if(chrome){
  const signalGroup=signal=>{try{process.kill(-chrome.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
  signalGroup('SIGTERM');
  if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(r=>chrome.once('exit',r)),sleep(3000)]);
  signalGroup('SIGKILL');
 }
 server.closeAllConnections();await new Promise(r=>server.close(r));
 rmSync(directory,{recursive:true,force:true,maxRetries:30,retryDelay:100});
}
