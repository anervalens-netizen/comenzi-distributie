// Synthetic integration of the real portfolio and WebGL map; no production API.
// Bind the fixture's local account explicitly; cross-tab auth has its own real HTTP tests.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const root=resolve('.'),directory=mkdtempSync(join(tmpdir(),'portfolio-performance-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const chrome=process.env.CHROME_BIN||'/usr/bin/google-chrome';
const partners=Array.from({length:250},(_,index)=>({id:'synthetic-'+index,name:'Synthetic partner '+String(index).padStart(3,'0'),cui:'TEST-'+index,address:'Test street',city:'Test city',county:'Test county',route:'1',warehouseIds:['test'],latitude:45.5,longitude:24.5,positionSource:'manual',positionQuality:'exact',lastVisitedAt:null}));
const requests=[];
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
await build({entryPoints:['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'],outfile:join(directory,'map-worker.js'),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {PartnerPortfolio} from './components/partner-portfolio';import {setLocalWorkUserId} from './lib/local-work';setLocalWorkUserId('synthetic-agent');function Fixture(){const [active,setActive]=useState(false),[manager,setManager]=useState(true),[scope,setScope]=useState('');window.fixture={setActive,setManager,setScope};return <><h1>Portfolio synthetic fixture</h1><div id="fixture-host" hidden={!active}><PartnerPortfolio key={scope} userId="synthetic-agent" manager={manager} active={active} scopeQuery={scope}/></div></>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({stdin:{contents:source,resolveDir:root,sourcefile:'portfolio-fixture.tsx',loader:'tsx'},outfile:join(directory,'fixture.js'),bundle:true,minify:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},tsconfig:join(root,'tsconfig.json'),logLevel:'silent',plugins:[{name:'local-map-worker',setup(builder){builder.onResolve({filter:/maplibre-gl-worker\.mjs\?worker&url$/},()=>({path:'local-map-worker',namespace:'local-worker'}));builder.onLoad({filter:/.*/,namespace:'local-worker'},()=>({contents:'export default "/map-worker.js";',loader:'js'}));}}]});
const server=createServer((request,response)=>{
 const url=new URL(request.url,'http://127.0.0.1');
 if(url.pathname.startsWith('/api/')){
  requests.push({path:url.pathname,params:Object.fromEntries(url.searchParams),method:request.method,at:Date.now()});
  if(request.method!=='GET'){response.writeHead(405);response.end('Fixture allows GET only');return;}
  response.setHeader('Content-Type','application/json');
  const query=url.searchParams.get('q')||'',offset=Number(url.searchParams.get('offset')||0);
  if(url.pathname==='/api/partner/browse'){
   const selected=query==='slow'?[{...partners[0],id:'slow',name:'Slow synthetic response'}]:query==='fresh'?[{...partners[0],id:'fresh',name:'Fresh synthetic response'}]:partners.filter(p=>p.name.toLowerCase().includes(query.toLowerCase()));
   const data={partners:selected.slice(offset,offset+100),total:selected.length,located:selected.length,geocoded:0,nextOffset:offset+100<selected.length?offset+100:null,bounds:[24,45,25,46],facets:{counties:['Test county'],cities:['Test city'],routes:['1']},styleUrl:'/style.json',observedAt:'2026-10-01T00:00:00Z'};
   setTimeout(()=>response.end(JSON.stringify(data)),query==='slow'?1000:40);return;
  }
  if(url.pathname==='/api/partner/map'){response.end(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[24.5,45.5]},properties:{id:'synthetic-0',name:'Synthetic map point',approximate:false}}]}));return;}
  if(url.pathname==='/api/partner/summary'){response.end(JSON.stringify({partners}));return;}
  if(url.pathname==='/api/partner/planning'){response.end(JSON.stringify({week:url.searchParams.get('week'),plans:[],visits:[]}));return;}
  if(url.pathname==='/api/partner/activity'){response.end(JSON.stringify({state:'unavailable',message:'Synthetic activity fixture'}));return;}
  if(url.pathname==='/api/partner/requests'){response.end(JSON.stringify({requests:[]}));return;}
  response.writeHead(404);response.end(JSON.stringify({error:'Unexpected synthetic API path'}));return;
 }
 if(url.pathname==='/style.json'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#eef5f0'}}]}));return;}
 const file=join(directory,url.pathname.slice(1));
 if(['/fixture.js','/fixture.css','/map-worker.js'].includes(url.pathname)&&existsSync(file)){response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');response.end(readFileSync(file));return;}
 response.setHeader('Content-Type','text/html');response.end('<!doctype html><html lang="ro"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font:14px Arial;margin:20px}.partner-map{height:420px!important;min-height:420px!important;width:100%}button{padding:8px}#fixture-host{max-width:1200px}.manager-partner-grid{display:grid;grid-template-columns:1fr 1fr}.partner-list{max-height:420px;overflow:auto}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=join(directory,'chrome');
const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',detached:true});
let socket,closeBrowser;
const evidence={synthetic:true,checks:0,scenarios:{}};
try{
 for(let i=0;!existsSync(join(profile,'DevToolsActivePort'))&&i<100;i++)await delay(50);
 const port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
 const target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
 let next=1;const pending=new Map(),errors=[];
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);if(!message.id)return;const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);if(message.error)entry.reject(Error(message.error.message));else entry.resolve(message.result);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=next++,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},method==='Page.navigate'?45000:15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 closeBrowser=()=>send('Browser.close');
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const waitFor=async expression=>{for(let i=0;i<120;i++){if(await evaluate(expression))return;await delay(50);}throw Error('Not ready: '+expression);};
 const clickText=text=>evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('Button missing');button.click();return true;})()`);
 const fill=query=>evaluate(`(()=>{const input=document.querySelector('.partner-filters input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 const mark=()=>requests.length;
 const since=(index,path)=>requests.slice(index).filter(r=>!path||r.path===path);
 const camera=()=>evaluate("JSON.parse(document.querySelector('.partner-map').dataset.viewState)");
 const sameCamera=(before,after)=>before.center.every((value,index)=>Math.abs(value-after.center[index])<1e-8)&&['zoom','bearing','pitch'].every(key=>Math.abs(before[key]-after[key])<1e-8);
 const mapSettled=async()=>{await waitFor("document.querySelector('.partner-map')?.dataset.mapStatus==='ready'&&document.querySelector('.partner-map')?.dataset.featureCount==='1'");await delay(600);};
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:origin});await waitFor('!!window.fixture');await delay(450);
 check(requests.length===0,'Initially hidden portfolio makes zero requests');check(await evaluate("!document.querySelector('.maplibregl-canvas')"),'Initially hidden portfolio creates no WebGL canvas');
 evidence.scenarios.initiallyHidden={apiRequests:requests.length,webglCanvases:0};
 await evaluate('window.fixture.setActive(true)');await waitFor("document.querySelectorAll('.partner-card').length===100");await mapSettled();
 const initialMap=since(0,'/api/partner/map');check(initialMap.length===1,'Initial fitting and resize produce one map request');
 evidence.scenarios.initialMap={requests:initialMap.length,bbox:initialMap[0].params.bbox};
 await clickText('Pagina următoare');await waitFor("document.querySelectorAll('.partner-card').length===100&&document.querySelector('.partner-card strong')?.textContent==='Synthetic partner 100'");
 const typed=mark();await fill('Syn');await delay(30);await fill('Synthetic');await delay(30);await fill('Synthetic partner 02');
 await delay(30);check(await evaluate("document.querySelectorAll('.partner-card').length===100"),'Last valid page remains visible while new filters debounce');
 await waitFor("document.querySelectorAll('.partner-card').length===10");await mapSettled();
 const typedBrowse=since(typed,'/api/partner/browse');check(typedBrowse.length===1&&typedBrowse[0].params.q==='Synthetic partner 02'&&typedBrowse[0].params.offset==='0','Rapid typing after offset100 fetches final query exactly once at offset0');
 check(since(typed,'/api/partner/map').every(r=>r.params.q==='Synthetic partner 02'),'Map never fetches intermediate typed filters');
 evidence.scenarios.debounceAfterPagination={browseRequests:typedBrowse.map(r=>r.params),mapRequests:since(typed,'/api/partner/map').map(r=>r.params)};
 await fill('slow');check(await evaluate("document.querySelectorAll('.partner-card').length===10"),'Previous successful results remain during the delayed search');for(let i=0;i<30&&!requests.some(r=>r.params.q==='slow');i++)await delay(50);
 check(requests.some(r=>r.path==='/api/partner/browse'&&r.params.q==='slow'),'Delayed old request starts');await delay(100);check(!requests.some(r=>r.path==='/api/partner/map'&&r.params.q==='slow'),'Map waits for matching filter bounds instead of saving the old viewport under the new filter');await fill('fresh');await waitFor("document.querySelector('.partner-card strong')?.textContent==='Fresh synthetic response'");await delay(1100);
 check(await evaluate("document.querySelector('.partner-card strong')?.textContent==='Fresh synthetic response'"),'Delayed stale response cannot overwrite newer filter results');
 evidence.scenarios.staleResponse={visible:'Fresh synthetic response'};
 await mapSettled();const contained=mark();await evaluate("document.querySelector('.maplibregl-ctrl-zoom-in').click();true");await delay(800);
 check(since(contained,'/api/partner/map').length===1&&Number(since(contained,'/api/partner/map')[0].params.zoom)===Math.floor((await camera()).zoom),'Integer zoom transition refreshes aggregation exactly once even within loaded bbox');
 const smallPan=mark();
 await evaluate("document.querySelector('.maplibregl-canvas').focus();true");await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await delay(850);
 check(since(smallPan,'/api/partner/map').length===0,'Small pan within padded bbox does not request duplicate GeoJSON');
 evidence.scenarios.containedNavigation={zoomRequests:1,panRequests:0};
 const expanded=mark();await evaluate("document.querySelector('.maplibregl-ctrl-zoom-out').click();true");await delay(700);await evaluate("document.querySelector('.maplibregl-ctrl-zoom-out').click();true");await delay(850);
 check(since(expanded,'/api/partner/map').length===2,'Two integer zoom-out transitions each fetch their new aggregation once');evidence.scenarios.expandedNavigation={mapRequests:since(expanded,'/api/partner/map').length};
 const beforeHidden=await camera(),sameScopeHidden=mark();await evaluate('window.fixture.setActive(false)');await delay(400);check(await evaluate("!document.querySelector('.maplibregl-canvas')"),'Same-scope hidden tab releases WebGL');check(since(sameScopeHidden).length===0,'Same-scope hidden tab makes no requests');await evaluate('window.fixture.setActive(true)');await mapSettled();const afterHidden=await camera();check(sameCamera(beforeHidden,afterHidden),'Zoom/pan camera is preserved exactly across hidden tab unmount/remount');evidence.scenarios.sameScopeViewport={before:beforeHidden,after:afterHidden};
 const beforeList=await camera(),list=mark();await clickText('Listă');await delay(600);check(await evaluate("!document.querySelector('.maplibregl-canvas')"),'List mode releases WebGL map');check(since(list,'/api/partner/map').length===0,'List mode makes zero hidden map requests');
 await send('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false});await delay(350);check(since(list,'/api/partner/map').length===0,'List resize makes zero hidden map requests');
 evidence.scenarios.listMode={mapRequests:0,webglCanvases:0};
 await clickText('Listă + Hartă');await mapSettled();const afterList=await camera();check(sameCamera(beforeList,afterList),'Zoom/pan camera is preserved across List mode and changed viewport dimensions');evidence.scenarios.listViewport={before:beforeList,after:afterList};await clickText('Listă');await delay(250);
 const hidden=mark();await evaluate('localStorage.setItem("mobiup-partner-view|synthetic-agent|agentId=synthetic-other",JSON.stringify({layout:"list"}));window.fixture.setActive(false);window.fixture.setScope("agentId=synthetic-other")');await delay(650);check(since(hidden).length===0,'Scope change on hidden tab fetches neither browse nor map');check(await evaluate("!document.querySelector('.maplibregl-canvas')"),'Hidden tab releases WebGL map');
 evidence.scenarios.hiddenScopeChange={apiRequests:0,webglCanvases:0};
 await evaluate('window.fixture.setActive(true)');await waitFor("document.querySelector('.partner-card strong')?.textContent==='Synthetic partner 000'");await delay(300);
 check(since(hidden,'/api/partner/browse').every(r=>r.params.agentId==='synthetic-other'),'Reactivation uses latest scope');check(since(hidden,'/api/partner/map').length===0,'Reactivation in List mode keeps map off');
 await clickText('Hartă');await mapSettled();const newScopeCamera=await camera();check(!sameCamera(beforeList,newScopeCamera),'Changed scope fits the new selection instead of restoring another scope camera');evidence.scenarios.newScopeViewport={view:newScopeCamera};check(await evaluate("document.querySelector('.partner-hub').dataset.layout==='map'"),'Map-only mode is selected');await clickText('Listă + Hartă');await delay(500);check(await evaluate("document.querySelector('.partner-hub').dataset.layout==='split'"),'Split mode is selected');
 await evaluate('window.fixture.setManager(false)');await delay(200);const planner=mark();await clickText('Vizite și traseu');await waitFor("!!document.querySelector('.partner-planning')||!!document.querySelector('.partner-week')||document.body.innerText.includes('Planifică')");await delay(500);
 check(await evaluate("!document.querySelector('.maplibregl-canvas')"),'Planner releases WebGL map');check(since(planner,'/api/partner/map').length===0&&since(planner,'/api/partner/browse').length===0,'Planner fetches no hidden map or browse');check(since(planner,'/api/partner/summary').length===1,'Planner loads its catalog only when opened');
 evidence.scenarios.planner={mapRequests:0,browseRequests:0,summaryRequests:1,webglCanvases:0};
 await evaluate("document.querySelector('.planner-heading button').click();true");await waitFor("!!document.querySelector('.partner-hub')");await mapSettled();const activity=mark();await clickText('Activitate și vânzări');await waitFor("!!document.querySelector('.partner-activity')");await delay(500);
 check(await evaluate("!document.querySelector('.maplibregl-canvas')"),'Activity releases WebGL map');check(since(activity,'/api/partner/map').length===0&&since(activity,'/api/partner/browse').length===0,'Activity fetches no hidden map or browse');
 evidence.scenarios.activity={mapRequests:0,browseRequests:0,activityRequests:since(activity,'/api/partner/activity').length};
 const hiddenActivity=mark();await evaluate('window.fixture.setActive(false);window.fixture.setScope("agentId=synthetic-hidden-activity")');await delay(650);
 evidence.scenarios.hiddenActivityScopeChange={apiRequests:since(hiddenActivity).map(r=>({path:r.path,params:r.params})),webglCanvases:await evaluate("document.querySelectorAll('.maplibregl-canvas').length")};
 evidence.checks=checks;if(process.env.PERFORMANCE_EVIDENCE_PATH)writeFileSync(process.env.PERFORMANCE_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 check(since(hiddenActivity).length===0,'Scope change while activity tab is hidden makes zero API requests');
 await evaluate('window.fixture.setActive(true)');await waitFor("document.querySelector('.partner-card strong')?.textContent==='Synthetic partner 000'");check(since(hiddenActivity,'/api/partner/browse').every(r=>r.params.agentId==='synthetic-hidden-activity'),'A remounted scope never reuses another scope list');await clickText('Activitate și vânzări');await waitFor("!!document.querySelector('.partner-activity')");await delay(350);check(since(hiddenActivity,'/api/partner/activity').length===1&&since(hiddenActivity,'/api/partner/activity')[0].params.agentId==='synthetic-hidden-activity','Activity reactivation fetches latest scope once');
 await clickText('← Înapoi la Parteneri');await waitFor("!!document.querySelector('.partner-hub')");await mapSettled();const adding=mark();await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Adaugă partener')).click();true");await delay(500);check(await evaluate("!document.querySelector('.maplibregl-canvas')"),'New-partner view releases WebGL map');check(since(adding,'/api/partner/map').length===0&&since(adding,'/api/partner/browse').length===0,'New-partner view fetches no hidden browse or map');evidence.scenarios.adding={mapRequests:0,browseRequests:0,webglCanvases:0};
 check(requests.every(r=>r.method==='GET'),'Entire integration performed GET requests only');check(errors.length===0,'No browser runtime exceptions');evidence.checks=checks;
 if(process.env.PERFORMANCE_EVIDENCE_PATH)writeFileSync(process.env.PERFORMANCE_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(evidence,null,2));console.log(`PASS: ${checks} portfolio navigation performance checks.`);
} finally{
 await closeBrowser?.().catch(()=>{});socket?.close();
 const exited=new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));await Promise.race([exited,delay(2000)]);if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM');}catch{}await exited;}
 await delay(200);await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
