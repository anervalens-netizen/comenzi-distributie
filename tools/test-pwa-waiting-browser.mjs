// Real Chrome service-worker install/wait/activate/offline lifecycle with synthetic
// versioned lazy modules. This is not the full built application's route bundle.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';
let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;};
for(const connection of [{saveData:true,effectiveType:'4g'},{saveData:false,effectiveType:'2g'}]){
 let version='old',offline=false,failLazy=false,browser,server;const shellRequests=[];
 const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {PwaInstall,prepareOfflineShell,getOfflineShellPreparation} from './components/pwa';import * as work from './lib/offline-work';import {setLocalWorkUserId} from './lib/local-work';Object.defineProperty(navigator,'connection',{value:${JSON.stringify(connection)}});setLocalWorkUserId('synthetic');window.fixture={work,prepareOfflineShell,getOfflineShellPreparation};window.documentToken=crypto.randomUUID();createRoot(document.getElementById('root')).render(<><textarea defaultValue="Synthetic unsaved editor"/><PwaInstall/></>);`;
 const bundle=await build({stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},write:false,bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const worker=tag=>readFileSync('public/sw.js','utf8').replace('__SHELL_VERSION__',tag).replace('/*__SHELL_ESSENTIAL__*/[]',JSON.stringify(['/offline.html','/_next/static/distribution-app-'+tag+'.js'])).replace('/*__SHELL_OPTIONAL__*/[]',JSON.stringify(['/_next/static/lazy-'+tag+'.js']));
 try{
  server=createServer((req,res)=>{
   if(offline){req.socket.destroy();return;}
   res.setHeader('Cache-Control','no-store');
   if(req.url==='/sw.js'){res.setHeader('Content-Type','text/javascript');res.end(worker(version));return;}
   if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
   if(req.url.startsWith('/_next/static/')){res.setHeader('Content-Type','text/javascript');if(failLazy&&req.url==='/_next/static/lazy-new.js'){res.writeHead(503);res.end('synthetic failure');return;}res.end(req.url.includes('lazy-')?'export default '+JSON.stringify(req.url):'');return;}
   res.setHeader('Content-Type','text/html');
   if(req.url==='/offline.html'){shellRequests.push(version);res.end(`<body><button id="lazy">Open lazy route</button><output id="result">${version} shell</output><script type="module">document.querySelector('#lazy').onclick=async()=>{document.querySelector('#result').textContent=(await import('/_next/static/lazy-${version}.js')).default}</script>`);return;}
   res.end('<!doctype html><div id="root"></div><script src="/_next/static/distribution-app-old.js"></script><script src="/fixture.js"></script>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await browserFixture(origin);const evaluate=browser.evaluate,wait=expression=>waitFor(()=>evaluate(expression),expression);
  await wait('!!window.fixture&&!!navigator.serviceWorker.controller');
  const token=await evaluate('documentToken');
  version='new';await evaluate("await navigator.serviceWorker.getRegistration().then(r=>r.update())");await wait("navigator.serviceWorker.getRegistration().then(r=>!!r.waiting)");await wait("document.body.innerText.includes('Actualizare disponibilă')");
  await evaluate("window.dispatchEvent(new CustomEvent('mobiup-data-freshness',{detail:{path:'bootstrap',source:'network'}}))");await delay(2400);
  check(await evaluate("!(await (await caches.open('mobiup-shell-v3-old')).match('/_next/static/lazy-old.js'))&&!(await (await caches.open('mobiup-shell-v3-new')).match('/_next/static/lazy-new.js'))"),'Save-Data/2G skips automatic preparation of both versions');
  failLazy=true;
  check(await evaluate("let failed=false;try{await fixture.prepareOfflineShell()}catch{failed=true}failed&&fixture.getOfflineShellPreparation().state==='error'&&(await navigator.serviceWorker.getRegistration()).waiting!==null"),'waiting worker failure cannot report ready or activate');
  failLazy=false;
  await evaluate('await fixture.prepareOfflineShell()');
  assert.match(await evaluate("const cached=await (await caches.open('mobiup-shell-v3-new')).match('/offline.html');await cached.text()"),/new shell/,'new shell cache content; requests='+shellRequests);
  check(await evaluate("fixture.getOfflineShellPreparation().state==='ready'&&!!(await (await caches.open('mobiup-shell-v3-old')).match('/_next/static/lazy-old.js'))&&!!(await (await caches.open('mobiup-shell-v3-new')).match('/_next/static/lazy-new.js'))"),'explicit preparation fills both exact version caches');
  await evaluate("window.dispatchEvent(new Event('focus'))");await delay(100);
  check(await evaluate("(await caches.keys()).includes('mobiup-shell-v3-new')&&(await navigator.serviceWorker.getRegistration()).waiting!==null"),'old controller asset announcement cannot retire or activate prepared waiting version');
  await evaluate("await fixture.work.enqueue('synthetic','partner/portfolio/point','PATCH',{revision:1},{scope:'partner',id:'point',value:{notes:'Synthetic recovery'}})");
  await wait("document.body.innerText.includes('Sincronizează lucrul local')");
  check(await evaluate("!document.body.innerText.includes('Activează pentru următoarea')"),'pending queue blocks activation after explicit preparation');
  await evaluate("for(const row of await fixture.work.pendingOperations('synthetic'))await fixture.work.removeOperation(row.id)");await wait("document.body.innerText.includes('Activează pentru următoarea')");
  await evaluate("window.nextWorker=(await navigator.serviceWorker.getRegistration()).waiting;[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Activează pentru următoarea')).click()");await wait("navigator.serviceWorker.getRegistration().then(r=>!r.waiting&&r.active?.state==='activated'&&navigator.serviceWorker.controller===window.nextWorker)");
  await wait("fixture.getOfflineShellPreparation().state==='ready'");
  check(await evaluate(`documentToken===${JSON.stringify(token)}&&document.querySelector('textarea').value==='Synthetic unsaved editor'&&(await fixture.work.readWork('synthetic','partner','point')).notes==='Synthetic recovery'`),'activation preserves document, unsaved editor and recovery work');
  assert.match(await evaluate("const cachedAfter=await (await caches.open('mobiup-shell-v3-new')).match('/offline.html');await cachedAfter?.text()"),/new shell/,'new shell survives activation');
  offline=true;await browser.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  check(await evaluate("fetch('/_next/static/lazy-old.js').then(r=>r.ok)"),'old open document still has its lazy module offline');
  await browser.send('Page.navigate',{url:origin+'/offline-reopen'});await wait("document.querySelector('#result')?.textContent==='new shell'").catch(async error=>{throw new Error(error.message+'; body='+await evaluate('document.body.innerText')+'; cached='+await evaluate("await (await (await caches.open('mobiup-shell-v3-new')).match('/offline.html'))?.text()"))});
  await evaluate("document.querySelector('#lazy').click()");await wait("document.querySelector('#result')?.textContent==='/_next/static/lazy-new.js'");
  check(true,'activated version opens its previously unused lazy module with page and worker networks disconnected');
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
}
console.log(`PASS: ${checks} real waiting-worker preparation and offline lifecycle checks for Save-Data and 2G.`);
