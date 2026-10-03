import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';

const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{PwaInstall,prepareOfflineShell,getOfflineShellPreparation}from'./components/pwa';window.fixture={prepareOfflineShell,getOfflineShellPreparation};createRoot(document.getElementById('root')).render(<PwaInstall/>);window.ready=true;`,loader:'tsx',resolveDir:resolve('.')},write:false,bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const source=readFileSync('public/sw.js','utf8');let version='v1',failManager=false,server,browser,checks=0;const counts=new Map(),sizes={'/common-v1.js':110,'/manager-v1.js':210,'/catalog-v1.js':310,'/common-v2.js':120,'/manager-v2.js':220,'/catalog-v2.js':320};
const check=(value,label)=>{assert.ok(value,label);checks++;};
const worker=tag=>source.replace('__SHELL_VERSION__',tag).replace('/*__SHELL_ESSENTIAL__*/[]',JSON.stringify(['/offline.html'])).replace('/*__SHELL_OPTIONAL__*/[]',JSON.stringify([`/common-${tag}.js`,`/manager-${tag}.js`,`/catalog-${tag}.js`])).replace('/*__SHELL_COMMON__*/[]',JSON.stringify([`/common-${tag}.js`])).replace('/*__SHELL_MANAGER__*/[]',JSON.stringify([`/manager-${tag}.js`]));
const reset=()=>counts.clear(),assetRequests=()=>[...counts].filter(([path])=>path.endsWith('.js')&&path!=='/fixture.js').reduce((sum,[,count])=>sum+count,0),assetBytes=()=>[...counts].reduce((sum,[path,count])=>sum+(sizes[path]||0)*count,0);
try{
 server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/sw.js'){res.setHeader('Content-Type','text/javascript');res.end(worker(version));return;}
  if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
  if(req.url==='/offline.html'){res.setHeader('Content-Type','text/html');res.end('offline');return;}
  if(req.url in sizes){counts.set(req.url,(counts.get(req.url)||0)+1);if(failManager&&req.url.includes('manager')){res.statusCode=503;res.end('interrupted');return;}res.setHeader('Content-Type','text/javascript');res.end(Buffer.alloc(sizes[req.url],req.url.includes('manager')?'m':req.url.includes('catalog')?'c':'a'));return;}
  const connection=req.url==='/save-data'?{saveData:true,effectiveType:'4g'}:req.url==='/two-g'?{saveData:false,effectiveType:'2g'}:null;
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><div id="root"></div>${connection?`<script>Object.defineProperty(navigator,'connection',{configurable:true,value:${JSON.stringify(connection)}})</script>`:''}<script type="module" src="/fixture.js"></script>`);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);const evaluate=browser.evaluate;await waitFor(()=>evaluate('ready&&!!navigator.serviceWorker.controller'),'controlled fixture');
 const clearOptional=()=>evaluate("(async()=>{for(const key of await caches.keys()){const cache=await caches.open(key);for(const request of await cache.keys())if(request.url.endsWith('.js'))await cache.delete(request);}return true})()");
 await clearOptional();reset();const legacy=await evaluate("fixture.prepareOfflineShell('legacy')");const before={requests:assetRequests(),bytes:assetBytes()};
 check(before.requests===3&&legacy.transferred===3&&counts.get('/catalog-v1.js')===1,'legacy installed client prepares every optional fixture asset '+JSON.stringify({before,legacy,counts:[...counts]}));
 await clearOptional();reset();await evaluate("window.dispatchEvent(new CustomEvent('mobiup-pwa-role',{detail:{role:'agent'}}));window.dispatchEvent(new CustomEvent('mobiup-data-freshness',{detail:{path:'bootstrap?compact=1',source:'network'}}))");await waitFor(()=>counts.get('/common-v1.js')===1,'agent idle preload');await delay(100);
 const agentCold={requests:assetRequests(),bytes:assetBytes()};check(agentCold.requests===1&&!counts.has('/manager-v1.js')&&!counts.has('/catalog-v1.js'),'cold agent startup prepares only common order navigation');
 const beforeWarm=assetRequests(),warm=await evaluate("fixture.prepareOfflineShell('agent')");check(assetRequests()===beforeWarm&&warm.transferred===0&&warm.transferBytes===0,'warm cache hit is not counted as a transfer');
 await clearOptional();reset();await evaluate("window.dispatchEvent(new CustomEvent('mobiup-pwa-role',{detail:{role:'manager'}}))");await waitFor(()=>counts.get('/manager-v1.js')===1&&counts.get('/common-v1.js')===1,'manager idle preload');const managerCold={requests:assetRequests(),bytes:assetBytes()};check(managerCold.requests===2&&!counts.has('/catalog-v1.js'),'manager startup adds manager overview but leaves catalog/admin intent-only');

 for(const [path,label] of [['/save-data','Save-Data'],['/two-g','2G']]){
  await clearOptional();reset();const tab=await browser.newTab(origin+path);await waitFor(()=>tab.evaluate('ready&&!!navigator.serviceWorker.controller'),label+' controlled');await tab.evaluate("window.dispatchEvent(new CustomEvent('mobiup-pwa-role',{detail:{role:'agent'}}));window.dispatchEvent(new CustomEvent('mobiup-data-freshness',{detail:{path:'bootstrap?compact=1',source:'network'}}))");await delay(2400);check(assetRequests()===0,label+' startup suppresses gradual preload');await tab.close();
 }

 await clearOptional();reset();failManager=true;check(await evaluate("fixture.prepareOfflineShell('manager').then(()=>false,()=>fixture.getOfflineShellPreparation().state==='error')"),'interrupted manager preload reports error');failManager=false;const retry=await evaluate("fixture.prepareOfflineShell('manager')");check(retry.state==='ready'&&retry.transferred>=1,'interrupted preload retries without activation or cache reset');

 version='v2';await evaluate("(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update();return true})()");await waitFor(()=>evaluate("navigator.serviceWorker.getRegistration().then(registration=>!!registration.waiting&&!registration.installing)"),'waiting v2');reset();const mixed=await evaluate("fixture.prepareOfflineShell('agent')");check(mixed.state==='ready'&&await evaluate("navigator.serviceWorker.getRegistration().then(registration=>!!registration.waiting)"),'mixed installed versions prepare active and waiting shells without forced activation');check(counts.get('/common-v2.js')===1&&!counts.has('/manager-v2.js')&&!counts.has('/catalog-v2.js'),'waiting agent shell keeps manager and catalog chunks intent-only');

 mkdirSync('work/evidence',{recursive:true});const evidence={fixture:'synthetic role preload assets',beforeLegacy:before,afterAgentCold:agentCold,afterAgentWarm:{requests:0,bytes:0},afterManagerCold:managerCold,saveData:{requests:0,bytes:0},twoG:{requests:0,bytes:0}};writeFileSync('work/evidence/t13-pwa-preload.json',JSON.stringify(evidence,null,2));
 console.log(`PASS: ${checks} real browser role/cold/warm/Save-Data/2G/interruption/mixed-version preload checks.`,JSON.stringify(evidence));
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
