import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const origin=process.env.BROWSER_TEST_ORIGIN||'http://127.0.0.1:3014';
const chrome=process.env.CHROME_BIN||'/usr/bin/google-chrome';
const {password}=JSON.parse(readFileSync('work/stock-qa-20260914/credentials.json','utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};

async function loginApi(username='stock-agent'){
  const response=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal(response.status,200,'Browser QA agent login precondition');
  return response.headers.get('set-cookie').split(';')[0];
}
async function api(path,cookie,method='GET',body){
  const options={method,headers:{Cookie:cookie}};
  if(body){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  const response=await fetch(`${origin}/api/${path}`,options);
  const data=await response.json();
  assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
class Cdp {
  constructor(socket){this.socket=socket;this.nextId=1;this.pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Page.javascriptDialogOpening'&&message.params.type==='beforeunload'&&this.acceptBeforeUnload){this.acceptBeforeUnload=false;void this.send('Page.handleJavaScriptDialog',{accept:true}).catch(error=>console.error(error.message));return;}if(message.method==='Page.loadEventFired')this.acceptBeforeUnload=false;if(!message.id)return;const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);if(message.error)pending.reject(new Error(message.error.message));else pending.resolve(message.result);});}
  send(method,params={}){if(method==='Page.reload')this.acceptBeforeUnload=true;return new Promise((resolve,reject)=>{const id=this.nextId++;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method} ${String(params.expression||'').slice(0,350)}`));},15000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Browser evaluation failed');return result.result?.value;}
}
async function waitFor(fn,label,attempts=80){
  let last;
  for(let i=0;i<attempts;i++){try{last=await fn();if(last)return last;}catch(error){if(String(error.message).startsWith('CDP timeout:'))throw error;last=error;}await sleep(100);}
  throw new Error(`Timeout: ${label}${last instanceof Error?` (${last.message})`:''}`);
}
async function connectPage(port){
  const page=await fetch(`http://127.0.0.1:${port}/json/new?${origin}`,{method:'PUT'}).then(r=>r.json());
  const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const cdp=new Cdp(socket);await cdp.send('Runtime.enable');await cdp.send('Page.enable');await cdp.send('Page.navigate',{url:origin});await waitFor(()=>cdp.evaluate(`location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'`),'initial page load');return {cdp,socket};
}
async function clickTab(cdp,label){
  const encoded=JSON.stringify(label);
  await waitFor(()=>cdp.evaluate(`[...document.querySelectorAll('[role="tab"]')].some(node=>node.textContent?.includes(${encoded}))`),`tab ${label} to render`);
  const clicked=await cdp.evaluate(`(()=>{const tab=[...document.querySelectorAll('[role="tab"]')].find(node=>node.textContent?.includes(${encoded}));if(!tab)return false;tab.click();return true;})()`);
  check(clicked,`Tab ${label} exists and can be activated`);await sleep(120);
}
async function fillPartner(cdp,company){
  await cdp.evaluate(`(()=>{const values={company:${JSON.stringify(company)},location:'Bucuresti',cui:'99170926',storeType:'MAGAZIN',contact:'QA',phone:'0700000000',email:'',address:'Strada QA 1',county:'Bucuresti'};for(const [key,value] of Object.entries(values)){const input=document.querySelector('[name="'+key+'"]');if(input instanceof HTMLInputElement){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}}return true;})()`);
}
async function newPartner(cdp){
  const oldId=await cdp.evaluate("document.querySelector('[name=requestId]').value");
  await cdp.evaluate("window.confirm=()=>true;[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cerere nouă')).click()");
  return waitFor(()=>cdp.evaluate(`document.querySelector('[name=requestId]').value!==${JSON.stringify(oldId)}&&document.querySelector('[name=requestId]').value`),'new request ID');
}
const cookie=await loginApi();
const globalCookie=await loginApi('stock-manager'),regionalUsername=`browser-${randomUUID()}`;
await api('admin/managers',globalCookie,'POST',{name:'Browser regional QA',username:regionalUsername,password,agentIds:['stock-agent']});
await api('admin/manager-mail',await loginApi(regionalUsername),'PUT',{partner:'browser@example.invalid'});
const inventoryA=(await api('inventory',cookie,'POST',{id:randomUUID(),warehouseId:'g-5',scope:'all',value:''})).inventory;
await sleep(10);
const inventoryB=(await api('inventory',cookie,'POST',{id:randomUUID(),warehouseId:'g-5',scope:'product',value:'DEMOACC2'})).inventory;
const deletedDraft=(await api('orders',cookie,'POST',{id:randomUUID(),kind:'combined',agentId:'stock-agent'})).order;
const partnerDb=new DatabaseSync('work/stock-qa-20260914/mobiup.sqlite');
partnerDb.prepare("DELETE FROM partner_day_plans WHERE agent_id='stock-agent'").run();
for(const id of ['browser-ph-located','browser-ph-unlocated'])partnerDb.prepare('INSERT OR REPLACE INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,'g-5',JSON.stringify({id,warehouseId:'g-5',warehouseIds:['g-5'],name:id,cui:'TEST-PH',address:'Strada Test 1',city:'București',county:'București',route:'browser'}));
partnerDb.close();
const located=(await api('partner/portfolio/browser-ph-located',cookie)).partner;
await api('partner/portfolio/browser-ph-located',cookie,'PATCH',{...located,latitude:44.43,longitude:26.1,positionSource:'manual',positionAccuracy:null});
const approximateDb=new DatabaseSync('work/stock-qa-20260914/mobiup.sqlite');
approximateDb.prepare("UPDATE partner_profiles SET position_source='geocoding',position_provider='geoapify',position_metadata=? WHERE customer_id='browser-ph-located'").run(JSON.stringify({positionQuality:'street_approximate'}));
approximateDb.close();
check((await api('partner/portfolio/browser-ph-located',cookie)).partner.positionQuality==='street_approximate','API exposes approximation quality');
const stalePartnerId=randomUUID();
const profile=mkdtempSync(join(tmpdir(),'comenzi-browser-'));
const chromeProcess=spawn(chrome,['--headless=new','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--no-sandbox','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,origin],{stdio:['ignore','ignore','pipe']});
let chromeError,chromeStderr='';
chromeProcess.on('error',error=>{chromeError=error;});
chromeProcess.stderr.on('data',chunk=>{chromeStderr=(chromeStderr+chunk.toString()).slice(-8000);});
let socket;
try {
  let port;
  const deadline=Date.now()+30000;
  while(!port&&Date.now()<deadline){
    if(chromeError||chromeProcess.exitCode!==null||chromeProcess.signalCode!==null)throw new Error(`Chrome failed (${chrome}): ${chromeError?.message||chromeProcess.exitCode||chromeProcess.signalCode}\n${chromeStderr}`);
    try{port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);}catch{}
    if(!port)await sleep(100);
  }
  if(!port)throw new Error(`Timeout: Chrome DevTools port (${chrome})\n${chromeStderr}`);
  const connected=await connectPage(port);const cdp=connected.cdp;socket=connected.socket;
  const login=await cdp.evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'stock-agent',password:${JSON.stringify(password)}})}).then(async r=>({ok:r.ok,status:r.status}))`);
  check(login?.ok,'Browser session login succeeds');await cdp.send('Page.reload',{ignoreCache:true});
  const agentOrdersSelected="(()=>{const active=[...document.querySelectorAll('.main-nav [role=tab]')].find(node=>node.getAttribute('aria-selected')==='true');return active?.textContent?.includes('Comenzi')===true;})()";
  await waitFor(()=>cdp.evaluate(agentOrdersSelected),'authenticated agent application with Comenzi selected');
  check(await cdp.evaluate(agentOrdersSelected),'Agent defaults to Comenzi after login');
  let failedGlyphs=0;
  const interceptGlyph=event=>{
    const message=JSON.parse(event.data);
    if(message.method!=='Fetch.requestPaused')return;
    const first=failedGlyphs===0;
    if(first)failedGlyphs++;
    void cdp.send(first?'Fetch.failRequest':'Fetch.continueRequest',first?{requestId:message.params.requestId,errorReason:'Failed'}:{requestId:message.params.requestId}).catch(error=>console.error(error.message));
  };
  socket.addEventListener('message',interceptGlyph);
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*tiles.openfreemap.org/fonts/*',requestStage:'Request'}]});
  await clickTab(cdp,'Parteneri');
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.partner-card').length>0&&Number(document.querySelector('.partner-map')?.dataset.renderedPoints)>0"),'portfolio list and real WebGL point',200);
  await waitFor(()=>failedGlyphs===1,'one real basemap glyph request fails',100);
  await sleep(4500);
  check(await cdp.evaluate("!document.querySelector('.partner-map-status[role=alert]')"),'transient glyph failure recovers after the bounded retry without a persistent warning');
  await cdp.send('Fetch.disable');socket.removeEventListener('message',interceptGlyph);
  await clickTab(cdp,'Comenzi');await clickTab(cdp,'Parteneri');
  await waitFor(()=>cdp.evaluate("Number(document.querySelector('.partner-map')?.dataset.renderedPoints)>0"),'map remount after transient resource failure',180);
  let failedTiles=0;
  const interceptTiles=event=>{
    const message=JSON.parse(event.data);
    if(message.method!=='Fetch.requestPaused')return;
    failedTiles++;
    void cdp.send('Fetch.failRequest',{requestId:message.params.requestId,errorReason:'Failed'}).catch(error=>console.error(error.message));
  };
  socket.addEventListener('message',interceptTiles);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*tiles.openfreemap.org/planet/*',requestStage:'Request'}]});
  await cdp.evaluate("document.querySelector('.maplibregl-ctrl-zoom-out').click()");await sleep(450);
  await cdp.evaluate("document.querySelector('.maplibregl-ctrl-zoom-out').click()");
  await waitFor(()=>failedTiles>0,'post-load basemap requests intercepted',120);
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-map-status[role=alert]')?.textContent.includes('Harta poate fi incompletă')"),'persistent post-load basemap outage exposes retry',120);
  check(await cdp.evaluate("document.querySelectorAll('.partner-card').length>0"),'list remains usable during persistent map resource failure');
  await cdp.send('Fetch.disable');socket.removeEventListener('message',interceptTiles);
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});
  await cdp.evaluate("document.querySelector('.partner-map-status[role=alert] button').click()");
  await waitFor(()=>cdp.evaluate("Number(document.querySelector('.partner-map')?.dataset.renderedPoints)>0&&!document.querySelector('.partner-map-status[role=alert]')"),'retry restores real basemap and customer layers after outage',180);checks++;
  check(await cdp.evaluate("document.querySelector('.partner-hub').innerText.includes('Fără poziție')"),'Unlocated points remain explicitly labelled');
  await cdp.evaluate("(()=>{const input=document.querySelector('.partner-filters input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'browser-ph');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.partner-card').length===2"),'partner search by name');checks++;
  for(const width of [390,768,1440]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await sleep(150);
    check(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`Partner Hub has no document overflow at ${width}px`);
    const capture=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync(`work/partner-hub-${width}.png`,Buffer.from(capture.data,'base64'));
  }
  check(await cdp.evaluate("document.querySelector('.partner-hub').innerText.includes('Aproximativ · pe stradă')"),'Approximate street pin has an explicit list label');
  await waitFor(()=>cdp.evaluate("Number(document.querySelector('.partner-map')?.dataset.renderedApproximate)>0"),'approximate point rendered by WebGL'); checks++;
  // Real MapLibre worker/WebGL stress: 25k features, not DOM markers or a library mock.
  await cdp.evaluate(`(() => {
    window.__mapBaseFetch=window.fetch;
    const fixture={type:'FeatureCollection',features:Array.from({length:25000},(_,i)=>({type:'Feature',id:'stress-'+i,geometry:{type:'Point',coordinates:[21+(i%250)/40,44+Math.floor(i/250)/35]},properties:{id:'stress-'+i,name:'Map stress '+i,approximate:i%3===0}}))};
    window.fetch=async (...args)=>{
      const url=String(args[0]);
      if(url.startsWith('/api/partner/map?')&&url.includes('q=map-stress')){
        if(url.includes('q=map-stress-slow'))await new Promise(r=>setTimeout(r,1200));
        return new Response(JSON.stringify(fixture),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return window.__mapBaseFetch(...args);
    };
    window.__setMapQuery=value=>{const input=document.querySelector('.partner-filters input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
    window.__mapStartedAt=performance.now();window.__setMapQuery('map-stress');
  })()`);
  await waitFor(()=>cdp.evaluate("Number(document.querySelector('.partner-map')?.dataset.featureCount)===25000&&Number(document.querySelector('.partner-map')?.dataset.renderedClusters)>0"),'25k points clustered by real worker/WebGL',250);
  const stress=await cdp.evaluate("({points:Number(document.querySelector('.partner-map').dataset.featureCount),clusters:Number(document.querySelector('.partner-map').dataset.renderedClusters),domMarkers:document.querySelectorAll('.maplibregl-marker').length,loadMs:Math.round(performance.now()-window.__mapStartedAt)})");
  check(stress.domMarkers===0&&stress.clusters>0,'25k points use cluster layers with no per-partner DOM markers');
  for(const width of [390,768,1440]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390}); await sleep(250);
    check(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`25k map no overflow at ${width}px`);
    const image=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync(`work/maplibre-25k-${width}.png`,Buffer.from(image.data,'base64'));
  }
  await cdp.evaluate("document.querySelector('.maplibregl-ctrl-zoom-in').click()"); await sleep(600);
  check(await cdp.evaluate("!!document.querySelector('.maplibregl-canvas')&&Number(document.querySelector('.partner-map').dataset.featureCount)===25000"),'25k map stays operational after zoom');
  await cdp.evaluate("window.__setMapQuery('map-stress-slow')"); await sleep(700);
  await cdp.evaluate("window.__setMapQuery('empty-map-selection')"); await sleep(1700);
  check(await cdp.evaluate("document.querySelector('.partner-map').dataset.featureCount==='0'"),'stale map response cannot overwrite newer filter');
  await cdp.evaluate("window.fetch=window.__mapBaseFetch;window.__setMapQuery('browser-ph')");
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.partner-card').length===2&&Number(document.querySelector('.partner-map').dataset.renderedApproximate)>0"),'real scoped data restored after stress',160);
  writeFileSync('work/maplibre-browser-benchmark.json',JSON.stringify(stress,null,2));
  console.log('PASS: MapLibre 25k browser stress',JSON.stringify(stress));
  const pointCenter=await cdp.evaluate("(()=>{const r=document.querySelector('.partner-map').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pointCenter});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pointCenter});
  await waitFor(()=>cdp.evaluate("document.querySelector('dialog[open]')?.textContent.includes('browser-ph-located')"),'clicking a real WebGL point opens its existing detail sheet'); checks++;
  const noGl=await connectPage(port);
  try {
    await noGl.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:"const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return String(kind).includes('webgl')?null:original.call(this,kind,...args);};"});
    await noGl.cdp.send('Page.reload',{ignoreCache:true});
    await clickTab(noGl.cdp,'Parteneri');
    await waitFor(()=>noGl.cdp.evaluate("document.querySelectorAll('.partner-card').length>0&&document.querySelector('.partner-map-status')?.textContent.includes('WebGL')"),'list usable when WebGL is unavailable',160); checks++;
    await noGl.cdp.send('Page.close');
  } finally { noGl.socket.close(); }
  await cdp.evaluate("[...document.querySelectorAll('.partner-card')].find(b=>b.textContent.includes('browser-ph-located')).click()");
  await waitFor(()=>cdp.evaluate("document.querySelector('dialog[open] a[href*=destination]')?.href.includes('44.43')"),'partner sheet navigation uses saved coordinates');
  check(await cdp.evaluate("document.querySelector('dialog').textContent.includes('Numărul magazinului nu a fost localizat')"),'Approximate street precision explained in store detail');
  check(await cdp.evaluate("!document.querySelector('dialog input[type=number]')"),'Coordinates cannot be typed manually');
  check(await cdp.evaluate("new URL(document.querySelector('dialog a[href*=waze]').href).searchParams.get('ll')==='44.43,26.1'"),'Waze receives saved store coordinates');
  await cdp.evaluate("Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(ok){window.gpsCalls=(window.gpsCalls||0)+1;ok({coords:{latitude:44.431,longitude:26.101,accuracy:8}})}}})");
  check(await cdp.evaluate("!window.gpsCalls"),'GPS remains idle until explicit click');
  await cdp.evaluate("document.querySelector('.partner-position-correction').open=true;document.querySelector('.partner-position-link').click()");
  await waitFor(()=>cdp.evaluate("document.querySelector('dialog output')?.textContent.includes('Poziția a fost preluată')"),'GPS captured for confirmation');
  check((await api('partner/portfolio/browser-ph-located',cookie)).partner.latitude===44.43,'GPS does not save before confirmation');
  await cdp.evaluate("document.querySelector('dialog form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('dialog output')?.textContent.includes('Datele au fost salvate')"),'GPS save acknowledged');
  const gpsPartner=(await api('partner/portfolio/browser-ph-located',cookie)).partner;
  check(gpsPartner.positionQuality===null,'GPS correction clears geocoding approximation');
  check(gpsPartner.latitude===44.431&&gpsPartner.positionSource==='gps'&&gpsPartner.positionAccuracy===8,'Confirmed GPS persists source and precision');

  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});await sleep(100);
  check(await cdp.evaluate("(()=>{const d=document.querySelector('dialog');return d.scrollWidth<=d.clientWidth+1&&d.getBoundingClientRect().right<=innerWidth;})()"),'Partner detail fits mobile width');
  const sheetShot=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync('work/partner-sheet-390.png',Buffer.from(sheetShot.data,'base64'));
  check(await cdp.evaluate("document.querySelector('dialog').innerText.includes('Date indisponibile momentan')"),'Unknown CRM data is labelled without invented sales');
  await cdp.evaluate("[...document.querySelectorAll('dialog button')].find(b=>b.textContent.includes('Înregistrează vizita acum')).click()");
  await waitFor(()=>cdp.evaluate("document.querySelector('dialog output')?.textContent.includes('Vizita a fost înregistrată')"),'explicit visit saved from browser');checks++;
  await cdp.evaluate("document.querySelector('dialog [aria-label=\"Închide fișa\"]').click()");

  await cdp.evaluate(`(() => {
    window.__browseFetch=window.fetch;
    window.fetch=async(...args)=>String(args[0]).startsWith('/api/partner/browse')
      ?new Response(JSON.stringify({error:'Browse temporarily unavailable'}),{status:503,headers:{'Content-Type':'application/json'}})
      :window.__browseFetch(...args);
    const input=document.querySelector('.partner-filters input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'browse-failure-test');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-hub [role=alert]')?.textContent.includes('Browse temporarily unavailable')"),'browse error reproduced before planner entry');
  await cdp.evaluate('window.fetch=window.__browseFetch');
  await cdp.evaluate(`(() => {
    window.__plannerFetch=window.fetch;window.__catalogRequests=0;
    window.fetch=async(...args)=>{
      if(String(args[0]).startsWith('/api/partner/summary')){
        window.__catalogRequests++;
        if(window.__catalogRequests===1)return new Response(JSON.stringify({error:'Catalog temporarily unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});
      }
      return window.__plannerFetch(...args);
    };
  })()`);
  await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Vizite și traseu')).click()");
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.partner-day').length===5"),'weekly planner has five working days');
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Reîncarcă lista de magazine')"),'failed planner catalog offers inline retry');
  check(await cdp.evaluate("document.querySelector('.partner-planning fieldset').disabled&&document.querySelector('.planner-search-status').textContent.includes('Reîncarcă lista')"),'missing catalog is labelled unavailable rather than an empty search result');
  await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Reîncarcă lista de magazine').click()");
  await waitFor(()=>cdp.evaluate("window.__catalogRequests===2&&!document.querySelector('.partner-planning fieldset').disabled"),'planner catalog recovers without leaving the planner');checks++;
  check(await cdp.evaluate("!document.body.innerText.includes('Browse temporarily unavailable')&&!document.body.innerText.includes('Catalog temporarily unavailable')"),'working planner hides unrelated browse errors and clears recovered catalog errors');
  await cdp.evaluate("window.fetch=window.__plannerFetch");
  check(await cdp.evaluate("document.querySelector('.partner-planning').innerText.includes('browser-ph-located')"),'Central history includes explicit store visit');
  await cdp.evaluate("(()=>{const input=document.querySelector('.partner-planning fieldset input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'browser-ph');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('.planner-store-options [role=option]')].some(b=>b.textContent.includes('browser-ph-located'))"),'planner searchable combobox finds target');
  await cdp.evaluate("[...document.querySelectorAll('.planner-store-options [role=option]')].find(b=>b.textContent.includes('browser-ph-located')).click()");
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('.partner-planning button')].some(b=>b.textContent==='Adaugă în plan'&&!b.disabled)"),'planner add enabled');
  await cdp.evaluate("[...document.querySelectorAll('.partner-planning button')].find(b=>b.textContent==='Adaugă în plan').click()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-day ol').innerText.includes('browser-ph-located')"),'store added to Monday draft');
  await cdp.evaluate("document.querySelector('.partner-day .primary').click()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-planning output')?.textContent.includes('salvat')"),'Monday plan persisted');
  for(const width of [390,768,1440]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await sleep(100);check(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Weekly planner fits '+width+'px');}
  check(await cdp.evaluate("document.querySelectorAll('.partner-day:not([hidden])').length===1&&!document.querySelector('.partner-day .primary')"),'Planner focuses one day and hides unchanged save actions');
  check(await cdp.evaluate("(()=>{window.dispatchEvent(new Event('beforeinstallprompt',{cancelable:true}));return !document.querySelector('.pwa-install')})()"),'No floating install invitation');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:768,height:1024,deviceScaleFactor:1,mobile:true});await sleep(100);
  const planShot=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync('work/partner-planner.png',Buffer.from(planShot.data,'base64'));
  await cdp.evaluate("[...document.querySelectorAll('.partner-planning button')].find(b=>b.textContent.includes('Înapoi la parteneri')).click()");
  await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Vizite și traseu')).click()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-day ol')?.innerText.includes('browser-ph-located')"),'persisted plan restored after remount');checks++;
  await cdp.evaluate("[...document.querySelectorAll('.partner-planning button')].find(b=>b.textContent.includes('Înapoi la parteneri')).click()");
  console.log('PASS: partner sheet and planner browser navigation/save/remount.');
  await clickTab(cdp,'Comenzi');
  const deletedOrderKey=`mobiup-work-v1:order:stock-agent:${deletedDraft.id}`;
  await waitFor(()=>cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(deletedDraft.number)})`),'synthetic combined draft in order history');
  const openedDeletedDraft=await cdp.evaluate(`(()=>{const button=[...document.querySelectorAll('.order-link')].find(node=>node.textContent?.includes(${JSON.stringify(deletedDraft.number)}));if(!button)return false;button.click();return true;})()`);
  check(openedDeletedDraft,'Synthetic combined draft opens before remote deletion');
  await waitFor(()=>cdp.evaluate("!!document.querySelector('.unified-group-tabs')"),'combined editor group controls');
  const groupSemantics=await cdp.evaluate(`(()=>{const group=document.querySelector('.unified-group-tabs'),buttons=[...group.querySelectorAll('button')];return !group.hasAttribute('role')&&buttons.length===2&&buttons.every(button=>!button.hasAttribute('role')&&['true','false'].includes(button.getAttribute('aria-pressed')))&&buttons.filter(button=>button.getAttribute('aria-pressed')==='true').length===1;})()`);
  check(groupSemantics,'Combined product groups use button semantics with one aria-pressed selection');
  await cdp.evaluate(`(()=>{const area=document.querySelector('.cart textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'LOCAL DELETE RECOVERY');area.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await sleep(50);
  await api(`orders/${deletedDraft.id}`,globalCookie,'DELETE',{revision:deletedDraft.revision});
  await cdp.evaluate("document.querySelector('.back-link').click();true");
  await waitFor(()=>cdp.evaluate("document.body.innerText.includes('Comanda a fost ștearsă în altă sesiune.')"),'deleted order recovery state');
  check(await cdp.evaluate("document.body.innerText.includes('Copiază într-o ciornă nouă')"),'Deleted open order exposes recovery action');
  await cdp.send('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.evaluate("document.body.innerText.includes('Comanda nu mai există pe server')"),'orphaned local order recovery after reload');
  const recoveredFromReload=await cdp.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent?.includes('Copiază modificările într-o ciornă nouă'));if(!button)return false;button.click();return true;})()`);
  check(recoveredFromReload,'Orphaned local order can be copied after reload');
  await waitFor(()=>cdp.evaluate("document.querySelector('.cart textarea')?.value==='LOCAL DELETE RECOVERY'"),'recovered local order content');
  check(!(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(deletedOrderKey)})`)),'Old orphaned local checkpoint is cleared after successful recovery');
  await cdp.evaluate("document.querySelector('.back-link').click();true");
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('[role=tab]')].some(node=>node.textContent?.includes('Stocul meu'))"),'main navigation after recovery');
  const inventoryKey=`mobiup-work-v1:inventory:stock-agent:${inventoryA.id}`;
  const partnerKey='mobiup-work-v1:partner:stock-agent:new';
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(inventoryKey)},${JSON.stringify(JSON.stringify({version:1,userId:'stock-agent',documentId:inventoryA.id,updatedAt:new Date().toISOString(),value:{warehouseId:'g-5',scanQueue:[],drafts:{DEMOACC2:{value:'9',baseCounted:0}}}}))});localStorage.setItem(${JSON.stringify(partnerKey)},${JSON.stringify(JSON.stringify({version:1,userId:'stock-agent',documentId:'new',updatedAt:new Date().toISOString(),value:{requestId:stalePartnerId,company:'CERERE VECHE QA',location:'Dumbrava',cui:'RO123456',storeType:'MAGAZIN',contact:'QA',phone:'0700000000',email:'',address:'Strada Principala 1',county:'Prahova'}}))});true`);
  await clickTab(cdp,'Stocul meu');await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('[role=tab]')].some(node=>node.textContent?.includes('Inventar'))"),'inventory subtab');await clickTab(cdp,'Inventar');
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.inventory-history-row').length>0"),'inventory history');
  const openedA=await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('.inventory-history-row')].find(node=>node.textContent?.includes('Inventar total')&&node.textContent?.includes('În lucru'));if(!row)return false;row.querySelector('.inventory-history-main')?.click();return true;})()`);
  check(openedA,'Inventory A opens from history');
  await waitFor(()=>cdp.evaluate("document.body.innerText.includes('Cantități locale în conflict')"),'conflict restored for inventory A');checks++;
  const wentBack=await cdp.evaluate(`(()=>{const button=document.querySelector('.inventory-back');if(!button)return false;button.click();return true;})()`);check(wentBack,'Return from inventory A');
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.inventory-history-row').length>0"),'inventory history after A');
  const openedB=await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('.inventory-history-row')].find(node=>node.textContent?.includes('DEMOACC2')&&node.textContent?.includes('În lucru'));if(!row)return false;row.querySelector('.inventory-history-main')?.click();return true;})()`);
  check(openedB,'Inventory B opens from history');
  await waitFor(()=>cdp.evaluate("document.querySelector('.inventory-header')?.textContent?.includes('DEMOACC2')"),'inventory B content');await sleep(200);
  check(!(await cdp.evaluate("document.body.innerText.includes('Cantități locale în conflict')")),'Inventory A conflict never leaks into inventory B');

  await clickTab(cdp,'Parteneri');await waitFor(()=>cdp.evaluate("!!document.querySelector('[name=requestId]')||[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Adaugă partener'))"),'partner hub');await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Adaugă partener'))?.click()");await waitFor(()=>cdp.evaluate("document.querySelector('input[name=requestId]')!==null"),'partner form');
  check(await cdp.evaluate(`document.querySelector('input[name=requestId]')?.value===${JSON.stringify(stalePartnerId)}`),'Legacy/stale partner request id is restored for the regression scenario');
  check(await cdp.evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent?.includes('Cerere nouă'))"),'New partner request action remains reachable when restored result state is absent');
  await clickTab(cdp,'Vânzări');
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('[role=tab]')].some(node=>node.textContent?.trim()==='Luna curentă')"),'sales tabs');
  const tabLinks=await cdp.evaluate(`(()=>{const labels=['Luna curentă','Istoric'];return labels.every(label=>{const tab=[...document.querySelectorAll('[role="tab"]')].find(node=>node.textContent?.trim()===label);const id=tab?.getAttribute('aria-controls');const panel=id?document.getElementById(id):null;return !!tab&&!!id&&!!panel&&panel.getAttribute('role')==='tabpanel';});})()`);
  check(tabLinks,'Sales tabs expose tab-to-tabpanel associations');
  check(await cdp.evaluate(`(()=>{const tab=[...document.querySelectorAll('[role="tab"]')].find(node=>node.textContent?.trim()==='Luna curentă');if(!tab)return false;tab.focus();return document.activeElement===tab;})()`),'Current sales tab receives keyboard focus');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,nativeVirtualKeyCode:39});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,nativeVirtualKeyCode:39});
  await waitFor(()=>cdp.evaluate("document.activeElement?.textContent?.trim()==='Istoric'"),'ArrowRight moves sales tab focus');checks++;
  await clickTab(cdp,'Parteneri');await waitFor(()=>cdp.evaluate("!!document.querySelector('[name=requestId]')||[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Adaugă partener'))"),'partner hub');await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Adaugă partener'))?.click()");
  await waitFor(()=>cdp.evaluate("!!document.querySelector('[name=requestId]')"),'partner form for delayed response');
  await cdp.evaluate(`window.originalFetch=window.fetch;window.partnerReleases=[];window.fetch=async(...args)=>{const response=await window.originalFetch(...args);if(String(args[0]).endsWith('/partner/mail'))await new Promise(resolve=>window.partnerReleases.push(resolve));return response;};true`);
  const idA=await newPartner(cdp);await fillPartner(cdp,'DELAYED A');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate('window.partnerReleases.length===1'),'A saved with response pending');
  const idB=await newPartner(cdp);await fillPartner(cdp,'DELAYED B');
  await cdp.evaluate('window.partnerReleases.shift()();true');await sleep(250);
  check(await cdp.evaluate(`document.querySelector('[name=requestId]').value===${JSON.stringify(idB)}&&document.querySelector('[name=company]').value==='DELAYED B'&&!document.querySelector('.partner-result')`),'Old response cannot change new request ID, fields or result');
  check(await cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(partnerKey)})).value.company==='DELAYED B'`),'Old response cannot delete new local draft');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate('window.partnerReleases.length===1'),'B saved with response pending');
  await cdp.evaluate('window.partnerReleases.shift()();true');
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('DELAYED B')"),'B result');
  await cdp.evaluate(`(()=>{const input=document.querySelector('[name=company]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'EDIT AFTER GENERATE');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await waitFor(()=>cdp.evaluate("!document.querySelector('.partner-result')"),'generated partner result invalidated after editing');checks++;
  check(await cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(partnerKey)})).value.company==='EDIT AFTER GENERATE'`),'Post-generation partner edit remains locally persisted');
  await cdp.evaluate("window.confirmCalls=0;window.confirm=()=>{window.confirmCalls++;return false};[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cerere nouă')).click();true");
  check(await cdp.evaluate("window.confirmCalls===1&&document.querySelector('[name=company]').value==='EDIT AFTER GENERATE'"),'New request confirms before discarding post-generation edits');
  const savedRequests=(await api('partner/requests',cookie)).requests;
  check(savedRequests.find(r=>r.id===idA)?.company==='DELAYED A'&&savedRequests.find(r=>r.id===idB)?.company==='DELAYED B','Both submitted requests survive separately in server history');

  // R1: a successful save response must acknowledge its new revision even if
  // the same form was edited again before that response reached the browser.
  const r1Id=await newPartner(cdp);await fillPartner(cdp,'R1 BASE');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate('window.partnerReleases.length===1'),'R1 initial response pending');
  await cdp.evaluate('window.partnerReleases.shift()();true');
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('R1 BASE')"),'R1 initial result');
  const r1Revision=Number(await cdp.evaluate("document.querySelector('[name=revision]').value"));
  await fillPartner(cdp,'R1 SERVER ACK');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate('window.partnerReleases.length===1'),'R1 update committed with response pending');
  await fillPartner(cdp,'R1 LOCAL NEWER');
  await cdp.evaluate('window.partnerReleases.shift()();true');
  await waitFor(()=>cdp.evaluate("!document.querySelector('.partner-generate').disabled"),'R1 delayed response released');
  check(Number(await cdp.evaluate("document.querySelector('[name=revision]').value"))===r1Revision+1,'Delayed acknowledged save advances revision despite newer local edits');
  check(await cdp.evaluate("document.querySelector('[name=company]').value==='R1 LOCAL NEWER'&&!document.querySelector('.partner-result')"),'Delayed acknowledged save preserves newer fields and keeps stale mail hidden');
  check(await cdp.evaluate(`(()=>{const value=JSON.parse(localStorage.getItem(${JSON.stringify(partnerKey)})).value;return value.company==='R1 LOCAL NEWER'&&Number(value.revision)===${r1Revision+1};})()`),'Newer partner draft persists with acknowledged revision');
  await cdp.send('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.evaluate("document.body?.innerText.includes('Comenzi')"),'R1 reload');
  await clickTab(cdp,'Parteneri');await waitFor(()=>cdp.evaluate("!!document.querySelector('[name=requestId]')||[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Adaugă partener'))"),'partner hub');await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Adaugă partener'))?.click()");await waitFor(()=>cdp.evaluate("!!document.querySelector('[name=requestId]')"),'R1 partner form after reload');
  check(await cdp.evaluate(`document.querySelector('[name=requestId]').value===${JSON.stringify(r1Id)}&&document.querySelector('[name=company]').value==='R1 LOCAL NEWER'&&Number(document.querySelector('[name=revision]').value)===${r1Revision+1}`),'Reload restores newer local fields with acknowledged revision');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('R1 LOCAL NEWER')"),'R1 retry succeeds after reload');
  let r1Saved=(await api('partner/requests',cookie)).requests.find(r=>r.id===r1Id);
  check(r1Saved?.company==='R1 LOCAL NEWER'&&r1Saved.revision===r1Revision+2,'R1 retry persists newer fields without a 409 loop');

  // A genuine external conflict keeps CAS and presents an explicit reconciliation action.
  await fillPartner(cdp,'R1 LOCAL CONFLICT');
  const external=(await api('partner/mail',cookie,'POST',{requestId:r1Id,revision:r1Saved.revision,company:'R1 EXTERNAL',location:'Bucuresti',cui:'99170926',storeType:'MAGAZIN',contact:'QA',phone:'0700000000',email:'',address:'Strada QA 1',county:'Bucuresti'})).request;
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-conflict')?.textContent.includes('versiune mai nouă')"),'R1 genuine conflict offers reconciliation');
  check(await cdp.evaluate("[...document.querySelectorAll('.partner-conflict button')].some(b=>b.textContent.includes('Păstrează modificările mele'))"),'R1 conflict exposes keep-local reconciliation');
  await cdp.evaluate("[...document.querySelectorAll('.partner-conflict button')].find(b=>b.textContent.includes('Păstrează modificările mele')).click();true");
  check(await cdp.evaluate(`document.querySelector('[name=company]').value==='R1 LOCAL CONFLICT'&&Number(document.querySelector('[name=revision]').value)===${external.revision}`),'R1 reconciliation keeps local fields and rebases only revision');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('R1 LOCAL CONFLICT')"),'R1 reconciled retry succeeds');
  r1Saved=(await api('partner/requests',cookie)).requests.find(r=>r.id===r1Id);
  check(r1Saved?.company==='R1 LOCAL CONFLICT'&&r1Saved.revision===external.revision+1,'R1 explicit reconciliation preserves CAS and saves chosen local version');

  // R3: a delayed conflict lookup for A must never attach to a newly-started request B.
  const r3Id=await newPartner(cdp);await fillPartner(cdp,'R3 REQUEST A');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('R3 REQUEST A')"),'R3 A initial save');
  const r3Revision=Number(await cdp.evaluate("document.querySelector('[name=revision]').value"));
  const r3External=(await api('partner/mail',cookie,'POST',{requestId:r3Id,revision:r3Revision,company:'R3 A EXTERNAL',location:'Bucuresti',cui:'99170926',storeType:'MAGAZIN',contact:'QA',phone:'0700000000',email:'',address:'Strada QA 1',county:'Bucuresti'})).request;
  await fillPartner(cdp,'R3 A LOCAL STALE');
  await cdp.evaluate(`window.originalFetch=window.fetch;window.conflictReleases=[];window.fetch=async(...args)=>{const response=await window.originalFetch(...args);const url=String(args[0]);if(url.includes('/api/partner/requests/')&&!url.endsWith('/confirm')&&(!args[1]||!args[1].method||args[1].method==='GET'))await new Promise(resolve=>window.conflictReleases.push(resolve));return response;};true`);
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate('window.conflictReleases.length===1'),'R3 A conflict lookup pending');
  const r3B=await newPartner(cdp);await fillPartner(cdp,'R3 REQUEST B');
  await cdp.evaluate(`(()=>{const values={cui:'887172002',address:'Different location 99',county:'Ilfov'};for(const [key,value] of Object.entries(values)){const input=document.querySelector('[name="'+key+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
  await cdp.evaluate('window.conflictReleases.shift()();true');await sleep(200);
  check(await cdp.evaluate(`document.querySelector('[name=requestId]').value===${JSON.stringify(r3B)}&&document.querySelector('[name=company]').value==='R3 REQUEST B'&&!document.querySelector('.partner-conflict')`),'R3 delayed conflict for A cannot attach to request B');
  check(await cdp.evaluate(`(()=>{const value=JSON.parse(localStorage.getItem(${JSON.stringify(partnerKey)})).value;return value.requestId===${JSON.stringify(r3B)}&&value.company==='R3 REQUEST B'&&value.cui==='887172002';})()`),'R3 delayed conflict cannot rewrite B localStorage');
  const r3AAfter=(await api(`partner/requests/${r3Id}`,cookie)).request;
  check(r3AAfter.company==='R3 A EXTERNAL'&&r3AAfter.revision===r3External.revision,'R3 request A remains at the external version while B is being edited');
  await cdp.evaluate('window.fetch=window.originalFetch;true');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('R3 REQUEST B')"),'R3 B saves independently');
  const r3BAfter=(await api(`partner/requests/${r3B}`,cookie)).request;
  check(r3BAfter.company==='R3 REQUEST B'&&r3BAfter.cui==='887172002'&&r3BAfter.address==='Different location 99','R3 B is created independently with its own identity');

  // R4: conflict lookup is by request ID, so an older-month request can reconcile normally.
  const r4Id=await newPartner(cdp);await fillPartner(cdp,'R4 PREVIOUS MONTH');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('R4 PREVIOUS MONTH')"),'R4 initial save');
  const r4Revision=Number(await cdp.evaluate("document.querySelector('[name=revision]').value"));
  const now=new Date(),previousMonthDate=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,15,10,0,0)).toISOString();
  const r4Db=new DatabaseSync('work/stock-qa-20260914/mobiup.sqlite');r4Db.prepare('UPDATE partner_requests SET created_at=?,updated_at=? WHERE id=?').run(previousMonthDate,previousMonthDate,r4Id);r4Db.close();
  const r4External=(await api('partner/mail',cookie,'POST',{requestId:r4Id,revision:r4Revision,company:'R4 EXTERNAL',location:'Bucuresti',cui:'99170926',storeType:'MAGAZIN',contact:'QA',phone:'0700000000',email:'',address:'Strada QA 1',county:'Bucuresti'})).request;
  await fillPartner(cdp,'R4 LOCAL CHOICE');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-conflict')?.textContent.includes('versiune mai nouă')"),'R4 previous-month conflict offers reconciliation');
  check(Number(await cdp.evaluate("document.querySelector('[name=revision]').value"))===r4Revision,'R4 stale local revision is preserved until the user chooses reconciliation');
  await cdp.evaluate("[...document.querySelectorAll('.partner-conflict button')].find(b=>b.textContent.includes('Păstrează modificările mele')).click();true");
  check(await cdp.evaluate(`document.querySelector('[name=requestId]').value===${JSON.stringify(r4Id)}&&document.querySelector('[name=company]').value==='R4 LOCAL CHOICE'&&Number(document.querySelector('[name=revision]').value)===${r4External.revision}`),'R4 keep-local rebases the prior-month request by ID');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-result')?.textContent.includes('R4 LOCAL CHOICE')"),'R4 reconciled previous-month save succeeds');
  const r4Saved=(await api(`partner/requests/${r4Id}`,cookie)).request;
  check(r4Saved.company==='R4 LOCAL CHOICE'&&r4Saved.revision===r4External.revision+1,'R4 saves the same prior-month request without duplication');

  await cdp.evaluate(`window.originalFetch=window.fetch;window.partnerReleases=[];window.fetch=async(...args)=>{const response=await window.originalFetch(...args);if(String(args[0]).endsWith('/partner/mail'))await new Promise(resolve=>window.partnerReleases.push(resolve));return response;};true`);
  await newPartner(cdp);await fillPartner(cdp,'DELAYED C');
  await cdp.evaluate("document.querySelector('.partner-form').requestSubmit()");
  await waitFor(()=>cdp.evaluate('window.partnerReleases.length===1'),'C response pending before navigation');
  await clickTab(cdp,'Vânzări');await clickTab(cdp,'Parteneri');await waitFor(()=>cdp.evaluate("!!document.querySelector('[name=requestId]')||[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Adaugă partener'))"),'partner hub');await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Adaugă partener'))?.click()");
  await waitFor(()=>cdp.evaluate("!!document.querySelector('[name=requestId]')"),'partner remounted');
  const idD=await newPartner(cdp);await fillPartner(cdp,'DELAYED D');
  await cdp.evaluate('window.partnerReleases.shift()();true');await sleep(250);
  check(await cdp.evaluate(`document.querySelector('[name=requestId]').value===${JSON.stringify(idD)}&&JSON.parse(localStorage.getItem(${JSON.stringify(partnerKey)})).value.company==='DELAYED D'`),'Unmounted request cannot erase draft after remount');
  await cdp.evaluate('window.fetch=window.originalFetch;true');

  const managerLogin=await cdp.evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'stock-manager',password:${JSON.stringify(password)}})}).then(r=>r.ok)`);
  check(managerLogin,'Manager browser login');await cdp.send('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.evaluate("document.querySelector('.manager-activity h1')?.textContent==='Activitate'"),'manager default activity dashboard');
  check(await cdp.evaluate("(()=>{const tabs=[...document.querySelectorAll('.main-nav [role=tab]')];return tabs[0]?.textContent?.includes('Activitate')&&tabs[0]?.getAttribute('aria-selected')==='true'&&tabs[1]?.textContent?.includes('Echipă');})()"),'Manager defaults to Activitate and Echipă is the second top-level tab');
  check(await cdp.evaluate("!!document.querySelector('.activity-partners-card')"),'Manager dashboard exposes dominant interactive Parteneri noi card');

  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await cdp.send('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.evaluate("document.querySelector('.manager-activity h1')?.textContent==='Activitate'"),'mobile manager activity dashboard');
  await clickTab(cdp,'Vânzări');
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.sales-subnav [role=tab]').length===2"),'mobile sales sub-tabs');
  const mobileSalesNav=await cdp.evaluate("(()=>{const tabs=[...document.querySelectorAll('.sales-subnav [role=tab]')];const rects=tabs.map(tab=>tab.getBoundingClientRect());return {labels:tabs.map(tab=>tab.textContent?.trim()),inside:rects.every(rect=>rect.left>=-0.5&&rect.right<=innerWidth+0.5),viewportWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth};})()");
  check(mobileSalesNav.labels.some(label=>label?.includes('Luna curentă'))&&mobileSalesNav.labels.some(label=>label?.includes('Istoric')),'Mobile Sales shows both Luna curentă and Istoric sub-tabs');
  check(mobileSalesNav.inside,'Mobile Sales sub-tabs stay fully inside the viewport');
  check(mobileSalesNav.scrollWidth<=mobileSalesNav.viewportWidth+1,'Mobile Sales does not create document-level horizontal scrolling');
  await cdp.evaluate("([...document.querySelectorAll('.sales-subnav [role=tab]')].find(tab=>tab.textContent?.includes('Istoric'))).click();true");
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('.sales-subnav [role=tab]')].some(tab=>tab.textContent?.includes('Istoric')&&tab.getAttribute('aria-selected')==='true')"),'mobile sales history tab');
  check(await cdp.evaluate("(()=>{const tabs=[...document.querySelectorAll('.sales-subnav [role=tab]')];return tabs.every(tab=>{const rect=tab.getBoundingClientRect();return rect.left>=-0.5&&rect.right<=innerWidth+0.5;});})()"),'Mobile Sales keeps both sub-tabs visible after switching to Istoric');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.evaluate("document.querySelector('.manager-activity h1')?.textContent==='Activitate'"),'manager activity after mobile viewport regression');
  await waitFor(()=>cdp.evaluate("!!document.querySelector('.activity-partners-card:not(:disabled)')"),'activity partner card ready after viewport reset');

  await cdp.evaluate("document.querySelector('.activity-partners-card').click();true");
  await waitFor(()=>cdp.evaluate("document.querySelector('.partner-activity-detail h1')?.textContent==='Parteneri noi'"),'partner activity drill-down');
  check(await cdp.evaluate("['Toate','În așteptare','Confirmați'].every(label=>[...document.querySelectorAll('.status-filter button')].some(button=>button.textContent===label))"),'Partner drill-down exposes real status filters');
  check(await cdp.evaluate("document.querySelectorAll('.partner-agent-group').length>0"),'Partner drill-down groups requests by agent');
  await cdp.evaluate("document.querySelector('.activity-detail-head .back-link').click();true");
  await waitFor(()=>cdp.evaluate("!!document.querySelector('.manager-activity')"),'back to activity dashboard');
  const expectedR4Month=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'}).format(new Date(previousMonthDate));
  await cdp.evaluate(`history.replaceState(null,'',${JSON.stringify('/?request='+r4Id)});location.reload();true`);
  await waitFor(()=>cdp.evaluate(`!!document.getElementById(${JSON.stringify('partner-request-'+r4Id)})`),'historical partner deep-link');
  check(await cdp.evaluate(`document.querySelector('.activity-toolbar input[type=month]')?.value===${JSON.stringify(expectedR4Month)}`),'Deep-link selects the request Bucharest month');
  check(await cdp.evaluate(`document.getElementById(${JSON.stringify('partner-request-'+r4Id)})?.classList.contains('request-focused')===true`),'Deep-link focuses the exact partner request');
  await cdp.evaluate("history.replaceState(null,'','/');true");
  await clickTab(cdp,'Echipă');
  check(!(await cdp.evaluate("[...document.querySelectorAll('.main-content [role=tab]')].some(node=>node.textContent?.trim()==='Activitate')")),'Echipă is a separate administration area without an Activitate subtab');
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Dezactivează')"),'agent toggle');
  await cdp.evaluate(`window.originalFetch=window.fetch;window.toggleFailure='conflict';window.fetch=async(...args)=>{if(String(args[0]).endsWith('/admin/users')){if(window.toggleFailure==='network')throw new TypeError('Failed to fetch');return new Response(JSON.stringify({error:'Datele agentului s-au modificat. Actualizează lista.'}),{status:409,headers:{'Content-Type':'application/json'}});}return window.originalFetch(...args);};[...document.querySelectorAll('button')].find(b=>b.textContent==='Dezactivează').click();true`);
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('Actualizează lista'))"),'visible stale toggle error');checks++;
  check(!(await cdp.evaluate("!!document.querySelector('[role=dialog]')")),'Toggle conflict visible with no dialog open');
  await cdp.evaluate("window.toggleFailure='network';[...document.querySelectorAll('button')].find(b=>b.textContent==='Dezactivează').click();true");
  await waitFor(()=>cdp.evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('Failed to fetch'))"),'visible network toggle error');checks++;
  await cdp.evaluate('window.fetch=window.originalFetch;true');

  const regionalLogin=await cdp.evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:${JSON.stringify(regionalUsername)},password:${JSON.stringify(password)}})}).then(r=>r.ok)`);
  check(regionalLogin,'Regional manager browser login');await cdp.send('Page.reload',{ignoreCache:true});
  await waitFor(()=>cdp.evaluate("document.querySelector('.manager-activity h1')?.textContent==='Activitate'"),'regional manager default activity dashboard');
  await clickTab(cdp,'Setări');
  await waitFor(()=>cdp.evaluate("document.querySelector('.settings-form')&&[...document.querySelectorAll('.settings-tabs [role=tab]')].some(tab=>tab.textContent?.includes('Importuri'))"),'regional manager settings imports tab');
  check(await cdp.evaluate("[...document.querySelectorAll('.settings-tabs [role=tab]')].some(tab=>tab.textContent?.includes('Importuri'))"),'Regional manager sees Importuri in Settings');
  await cdp.evaluate("[...document.querySelectorAll('.settings-tabs [role=tab]')].find(tab=>tab.textContent?.includes('Importuri')).click();true");
  await waitFor(()=>cdp.evaluate("!!document.querySelector('.sales-import')&&!!document.querySelector('.stock-import')"),'regional manager import tools');
  check(await cdp.evaluate("!!document.querySelector('.sales-import')&&!!document.querySelector('.stock-import')"),'Regional manager sees both sales and stock import tools');
  await waitFor(()=>cdp.evaluate("document.querySelectorAll('.import-last-status').length===2&&[...document.querySelectorAll('.import-last-status')].every(node=>!node.textContent?.includes('se verifică'))"),'manager import timestamps');
  check(await cdp.evaluate("[...document.querySelectorAll('.import-last-status')].map(node=>node.textContent).some(text=>text?.startsWith('Ultimul import vânzări'))&&[...document.querySelectorAll('.import-last-status')].map(node=>node.textContent).some(text=>text?.startsWith('Ultimul import stoc'))"),'Both import sections show latest-import status');
  console.log(`PASS: ${checks} Chrome lifecycle/accessibility and audit regression checks.`);
} finally {
  try{socket?.close();}catch{}
  chromeProcess.kill('SIGTERM');
  await Promise.allSettled([api(`inventory/${inventoryA.id}`,cookie,'DELETE',{revision:inventoryA.revision}),api(`inventory/${inventoryB.id}`,cookie,'DELETE',{revision:inventoryB.revision})]);
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
