// Real SalesPanel, Team links and partner sheet; wholly synthetic HTTP responses.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
const root=resolve('.'),directory=mkdtempSync(join(tmpdir(),'client-sales-browser-'));
const chrome=process.env.CHROME_BIN||'/usr/bin/google-chrome';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let checks=0;function check(value,label){assert.ok(value,label);checks++;}
const source=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {SalesPanel} from './components/sales';import {ManagerAccessories,ManagerPrepay} from './components/manager-commerce';import {AgentCommerce} from './components/agent-commerce';import {ManagerTeamLinks} from './components/manager-workspace';
import {setLocalWorkUserId} from './lib/local-work';
setLocalWorkUserId('synthetic-manager');
const user={id:'synthetic-manager',role:'manager',managerScope:'global',name:'Manager sintetic'};
const agents=[{id:'a',name:'Agent sintetic A',role:'agent',active:1},{id:'b',name:'Agent sintetic B',role:'agent',active:1}];
function Fixture(){const [view,setView]=useState('team'),[agent,setAgent]=useState('a'),[initial,setInitial]=useState('clients');window.fixture={setAgent};return <main className="main-content"><button onClick={()=>setView('team')}>Echipă fixture</button><button onClick={()=>{setAgent('a');setView('manager-sales');}}>Accesorii manager fixture</button><button onClick={()=>{setAgent('a');setView('prepay');}}>Prepay fără proiecte fixture</button><button onClick={()=>{setAgent('a');setView('agent-sales');}}>Accesorii agent fixture</button><button onClick={()=>setView('agent-prepay')}>Prepay agent fixture</button>{view==='team'?<ManagerTeamLinks scope={{selectedAgents:agents}} onAgent={(id,dest)=>{setAgent(id);setInitial(dest==='clients'?'clients':'current');setView('sales');}}/>:view==='manager-sales'?<ManagerAccessories userId={user.id} query={'agentId='+agent+'&months=2026-09'} scopeQuery={'agentId='+agent} scopeLabel={'Agent sintetic '+agent.toUpperCase()} initialView="clients" onViewChange={()=>{}}/>:view.startsWith('agent-')?<AgentCommerce key={view} user={{...agents.find(item=>item.id===agent),distributionConfigured:true,canViewActivations:false}} mode={view==='agent-sales'?'sales':'activations'} initialView={view==='agent-sales'?'clients':undefined} onViewChange={()=>{}}/>:view==='prepay'?<ManagerPrepay userId={user.id} query={'agentId='+agent+'&month=2026-09'} scopeLabel={'Agent sintetic '+agent.toUpperCase()} distributionConfigured={false} canViewActivations={false}/>:<SalesPanel user={user} users={agents} scopeQuery={'agentId='+agent} scopeLabel={'Agent sintetic '+agent.toUpperCase()} initialView={initial}/>}</main>;}createRoot(document.getElementById('root')).render(<Fixture/>);

`;
await build({stdin:{contents:source,resolveDir:root,sourcefile:'monthly-fixture.tsx',loader:'tsx'},outfile:join(directory,'after.js'),bundle:true,minify:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},tsconfig:join(root,'tsconfig.json'),logLevel:'silent',loader:{'.woff2':'empty'}});
const requests=[];let failNext=false;
const metrics={valueCents:10000,documents:1,lastBilling:'2026-09-12',missingValues:0};
const flags=['all','billed','new','waiting','unvisited'];
const filters=['all','billed','unbilled','absentPrevious','absentThree','new','repeat','waiting','overdue','reactivated','visited','unvisited','unvisitedPrevious','unvisitedThree','unknown'];
function report(params){
 const month=params.get('month'),imported=month==='2026-09',page=Number(params.get('page')||0),agent=params.get('agentId');
 const rows=Array.from({length:51},(_,i)=>({key:'c'+i,id:'p'+i,name:'Client sintetic '+agent+' '+String(i).padStart(2,'0'),cui:'TEST'+i,city:'Oraș test',counties:['Județ test'],pointCount:1,points:[{id:'p'+i,name:'Client sintetic '+i,city:'Oraș test'}],linked:true,identityComplete:true,metrics:imported?metrics:{valueCents:null,documents:null,lastBilling:null,missingValues:0},previous:metrics,health:{firstBilling:'2026-09-12',lastBilling:'2026-09-12',documents:1,elapsedDays:16,observedDays:16,recent:imported,repeat:false,status:imported?'waiting':'unknown',alertEligible:false,reactivated:false,reason:'Client recent; încă nu s-au împlinit 30 de zile de observație.'},visits:0,flags:imported?flags:['all','unvisited']})).filter(r=>r.name.includes(params.get('q')||''));
 const counts=Object.fromEntries(filters.map(f=>[f,rows.filter(r=>r.flags.includes(f)).length]));
 const shown=rows.filter(r=>r.flags.includes(params.get('filter')||'all'));if(params.get('direction')==='asc')shown.reverse();
 return {state:'ready',month,source:{label:'Raport pe clienți',builtAt:'2026-09-29T00:00:00Z',updatedAt:'2026-09-29T00:00:00Z',declaredEnd:'2026-09-30',observedEnd:'2026-09-28',effectiveCutoff:'2026-09-28',latestMonth:'2026-09',coverage:[]},window:{month,from:month+'-01',to:imported?'2026-09-28':null,imported,covered:imported,complete:false},comparisons:[1,2,3].map(i=>({month:'2026-0'+(9-i),from:'2026-0'+(9-i)+'-01',to:'2026-0'+(9-i)+'-28',covered:true,billed:2,documents:3,valueCents:1000,visits:0,visited:0,visitsFrom:'2026-0'+(9-i)+'-01',visitsTo:'2026-0'+(9-i)+'-30'})),totals:{valueCents:imported?510000:null,billed:imported?51:null,documents:imported?51:null,perClient:imported?1:null,missingValues:0,unknown:0,visited:0,visitedUnidentified:0,visits:0},counts,absenceEligible:imported,counties:['Județ test'],total:shown.length,page,hasMore:(page+1)*50<shown.length,rows:shown.slice(page*50,(page+1)*50),visitRange:{from:month+'-01',to:month+'-30'},noVisitRecords:true};
}
const server=createServer(async(request,response)=>{
 const url=new URL(request.url,'http://fixture.invalid');
 if(url.pathname.startsWith('/api/')){
  requests.push(url.pathname+url.search);response.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/fail-next'){failNext=true;response.end('{}');return;}
  if(url.pathname==='/api/sales/clients/reconciliation'){response.end(JSON.stringify({state:'ready',scope:'national',month:url.searchParams.get('month'),explanation:'Istoricul tuturor vânzătorilor, nu vânzări personale ale responsabilului actual.',window:{from:'2026-09-01',to:'2026-09-28',imported:true},source:{revision:'synthetic-revision',builtAt:'2026-09-29'},buckets:{raw:{knownCents:10000,missingValues:0,sourceRows:3},consumer:{knownCents:1000,missingValues:0,sourceRows:1},linkedCompany:{knownCents:9000,missingValues:0,sourceRows:2}},exceptions:[{key:'identity:1',category:'identity',companyId:null,clientCode:'SYNTH',reason:'Synthetic identity exception',knownCents:-123,missingValues:1,sourceRows:1}],total:1,hasMore:false}));return;}
  if(url.pathname==='/api/sales'){
   const historical=url.searchParams.get('month')==='2026-08',month=url.searchParams.get('month');
   const product=(itemCode,quantity,value,segment,subsegment)=>({itemCode,itemName:'Produs sintetic '+itemCode,brand:'Example',category:segment==='accessories'?'Cabluri':'Cartele',subCategory:'',rows:1,quantity,value,segment,subsegment});
   const products=[product('SIM',historical?3:5,historical?30:50,'cardsSim','sim'),product('CARD',historical?1:2,historical?10:20,'cardsSim','cards'),product('CABLE',99,990,'accessories'),product('VOUCHER',40,400,'cardsSim','vouchers')];
   const aggregate=items=>({rows:items.length,quantity:items.reduce((sum,p)=>sum+p.quantity,0),value:items.reduce((sum,p)=>sum+p.value,0)});
   const segments=Object.fromEntries(['cardsSim','accessories','phones','unclassified'].map(segment=>{const items=products.filter(p=>p.segment===segment);return [segment,{summary:aggregate(items),products:items}]}));
   segments.cardsSim.subsegments=Object.fromEntries(['cards','sim','vouchers','valueVouchers'].map(subsegment=>[subsegment,aggregate(products.filter(p=>p.subsegment===(subsegment==='valueVouchers'?'vouchers':subsegment)))]));
   response.end(JSON.stringify({month,filename:'synthetic.xlsx',importedAt:'2026-09-29T00:00:00Z',products,segments,summary:aggregate(products),sites:[],daily:[{date:month+'-20',...aggregate(products)}],months:[],monthly:[]}));return;
  }
  if(url.pathname==='/api/sales/clients'){
   if(failNext){failNext=false;response.statusCode=503;response.end(JSON.stringify({error:'Eroare sintetică'}));return;}
   await delay(url.searchParams.get('q')==='slow'?700:50);response.end(JSON.stringify(report(url.searchParams)));return;
  }
  if(/^\/api\/partner\/portfolio\/p[0-9]+$/.test(url.pathname)){const id=url.pathname.split('/').at(-1);response.end(JSON.stringify({partner:{id,name:'Client sintetic detaliu',cui:'TEST',city:'Oraș test',county:'Județ test',address:'',phone:'',email:'',contact:'',warehouseIds:[],canEdit:false,revision:0,latitude:null,longitude:null,positionSource:'',positionQuality:'',route:''},visits:[],visitCount:0,nextCursor:null}));return;}
  if(url.pathname.endsWith('/sales')){response.end(JSON.stringify({state:'unavailable',message:'Fișă sintetică: vânzător sursă disponibil în documente.'}));return;}
  response.statusCode=500;response.end(JSON.stringify({error:'Unexpected API: '+url.pathname}));return;
 }
 if(url.pathname==='/base.css'){response.setHeader('Content-Type','text/css');response.end(readFileSync('app/globals.css','utf8').replace(/^@import .*;$/gm,''));return;}
 const file=['/after.js','/after.css'].includes(url.pathname)?join(directory,url.pathname.slice(1)):null;
 if(file&&existsSync(file)){response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');response.end(readFileSync(file));return;}
 response.setHeader('Content-Type','text/html');response.end('<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/after.css"></head><body><div id="root"></div><script src="/after.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const profile = join(directory, 'chrome');
const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let chromeError, chromeStderr = '', childClosed = false;
child.on('error', error => { chromeError = error; });
child.stderr.on('data', chunk => { chromeStderr = (chromeStderr + chunk.toString()).slice(-8000); });
// `close` also fires when spawning fails, while `exit` does not.
const closed = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
const chromeFailure = reason => new Error(`${reason} (${chrome}); exit=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}${chromeError ? `; ${chromeError.message}` : ''}\nChrome stderr (last 8000 chars):\n${chromeStderr || '(empty)'}`);
let socket, closeBrowser, testError, cleanupError;
try {
  let port;
  const startupDeadline = performance.now() + 30000;
  while (!port && performance.now() < startupDeadline) {
    if (chromeError || childClosed || child.exitCode !== null || child.signalCode !== null) throw chromeFailure('Chrome failed before DevTools became ready');
    // The file may be absent or only partially written during startup.
    try {
      const candidate = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) port = candidate;
    } catch {}
    if (!port) await delay(100);
  }
  if (!port) throw chromeFailure('Timeout after 30000 ms waiting for Chrome DevTools port');
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).catch(error => { throw chromeFailure(`Chrome DevTools connection failed: ${error.message}`); });
  if (!response.ok) throw chromeFailure(`Chrome DevTools returned HTTP ${response.status}`);
  const target = await response.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(chromeFailure('Timeout opening Chrome DevTools WebSocket')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(chromeFailure('Chrome DevTools WebSocket failed')); }, { once: true });
  });
  let next = 1;
  const pending = new Map(), errors = [], apiRequests = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/api/')) apiRequests.push(message.params.request.url);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++, timer = setTimeout(() => reject(new Error('Timeout: ' + method)), method === 'Page.navigate' ? 45000 : 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  closeBrowser = () => send('Browser.close');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  async function waitFor(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error('Not ready: ' + expression);
  }
  const fill = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  const select = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

  await send('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});
  await send('Page.navigate',{url:origin});await waitFor("document.querySelector('.manager-team-links')!==null");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Vânzări pe clienți').click();true");
  await waitFor("document.querySelector('.client-sales-source')!==null");
  check(requests.some(p=>p.includes('sales/clients?')&&p.includes('agentId=a')),'Team link carries agent into actual monthly panel');
  check(!requests.some(p=>p.startsWith('/api/sales?')),'Entering client subtab never requests daily TR sales');
  check(await evaluate("document.body.textContent.includes('Agent sintetic A')"),'Selected agent label visible');
  await fill('[aria-label="Luna raportului pe clienți"]','2026-10');
  await waitFor("document.body.textContent.includes('Lună neimportată')");
  check(await evaluate("document.querySelector('.client-sales-cards').textContent.includes('—')"),'Unimported month does not render zero KPIs');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Ultima lună disponibilă')).click();true");
  await waitFor("document.querySelectorAll('.client-sales-table tbody tr').length===50");
  check(await evaluate("document.querySelector('[aria-label=\"Luna raportului pe clienți\"]').value==='2026-09'"),'Latest available shortcut explicitly selects month');
  check(await evaluate('document.documentElement.scrollWidth<=360'),'No document horizontal overflow at 360px');
  await evaluate("[...document.querySelectorAll('summary')].find(s=>s.textContent==='Reconciliere națională și excepții CRM').click();true");
  await waitFor("document.body.textContent.includes('synthetic-revision')");
  check(await evaluate('document.documentElement.scrollWidth<=360'),'Open reconciliation table stays within mobile scroll container');
  check(requests.some(p=>p.startsWith('/api/sales/clients/reconciliation?')&&!p.includes('agentId')),'National reconciliation never carries selected agent scope');
  check(await evaluate("document.body.textContent.includes('Synthetic identity exception')&&document.body.textContent.includes('independent de filtrele de agent')"),'Manager sees source explanation and identity exception');
  check(await evaluate("document.querySelector('a[href*=reconciliation]').getAttribute('href').includes('format=csv')&&!document.querySelector('a[href*=reconciliation]').getAttribute('href').includes('agentId')"),'Reconciliation export is explicitly national');
  await evaluate("[...document.querySelectorAll('summary')].find(s=>s.textContent==='Reconciliere națională și excepții CRM').click();true");

  await click('.client-sales-cards button:nth-child(2)');await waitFor("[...document.querySelectorAll('.client-sales-chips button')].some(b=>b.textContent.startsWith('Facturați')&&b.getAttribute('aria-pressed')==='true')");
  await waitFor("document.querySelectorAll('.client-sales-table tbody tr').length===50");
  check(requests.some(p=>p.includes('filter=billed')),'Billed KPI opens the billed client list');
  await click('.client-sales-cards button:first-child');await waitFor("document.querySelector('.client-sales-chips button:first-child')?.getAttribute('aria-pressed')==='true'");
  await click('.client-sales-advanced summary');
  check(await evaluate("document.querySelector('.client-sales-advanced').open"),'Advanced geography and sorting are accessible');
  await select('[aria-label="Ordine clienți"]','asc');await waitFor("document.querySelector('.client-sales-table')?.textContent.includes('a 50')");
  await select('[aria-label="Ordine clienți"]','desc');await waitFor("document.querySelector('.client-sales-table')?.textContent.includes('a 00')");
  await click('.client-sales-pagination button:last-child');await waitFor("document.querySelectorAll('.client-sales-table tbody tr').length===1");
  check(await evaluate("document.querySelector('.client-sales-table')?.textContent.includes('a 50')"),'Page 2 is reachable');
  await fill('[aria-label="Caută client în raport"]','a 07');await waitFor("document.querySelector('.client-sales-table')?.textContent.includes('a 07')");
  check(await evaluate("document.querySelector('.client-sales-pagination').textContent.includes('Pagina 1')"),'Search resets pagination');
  await click('.client-sales-table tbody th button');await waitFor("document.querySelector('dialog[open]')!==null");
  await waitFor("document.querySelector('dialog').textContent.includes('Fișă sintetică')");
  check(requests.some(p=>p.includes('/partner/portfolio/p7/sales?')&&p.includes('from=2026-09-01')&&p.includes('to=2026-09-28')),'Real partner sales drilldown uses selected cutoff');
  await click('[aria-label="Închide fișa"]');
  await fill('[aria-label="Caută client în raport"]','slow');await waitFor("document.querySelector('.client-sales output')!==null");
  await fill('[aria-label="Caută client în raport"]','a 09');await waitFor("document.querySelector('.client-sales-table')?.textContent.includes('a 09')");await delay(800);
  check(await evaluate("document.querySelector('.client-sales-table')?.textContent.includes('a 09')"),'Late old search cannot replace current results');
  await evaluate("fetch('/api/fail-next');true");await delay(100);
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Actualizează raportul').click();true");await waitFor("document.querySelector('[role=alert]')!==null");
  check(await evaluate("document.querySelector('[role=alert]').textContent.includes('Eroare sintetică')"),'Real error displayed');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Reîncearcă').click();true");await waitFor("document.querySelector('.client-sales-table')!==null");
  await fill('[aria-label="Caută client în raport"]','');await waitFor("document.querySelectorAll('.client-sales-table tbody tr').length===50");
  await evaluate("[...document.querySelectorAll('.client-sales-chips button')].find(b=>b.textContent.startsWith('Fără facturare')).click();true");await waitFor("document.body.textContent.includes('Nu există clienți pentru filtrele selectate.')");
  await evaluate("window.fixture.setAgent('b');true");await waitFor("document.querySelector('.client-sales-source')!==null&&document.body.textContent.includes('Agent sintetic B')");
  check(await evaluate("document.querySelector('[aria-label=\"Luna raportului pe clienți\"]').value!=='2026-09'||document.querySelector('.client-sales-table')?.textContent.includes('b 00')"),'Changing scope clears old rows');
  // The simplified manager view owns a separately keyed customer report.
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Accesorii manager fixture').click();true");
  await waitFor("document.querySelector('.manager-commerce')!==null&&document.querySelector('.client-sales-table')?.textContent.includes('a 00')");
  await click('[aria-label="septembrie 2026"]');
  await waitFor("document.querySelector('.client-sales-source')?.textContent.includes('28.09.2026')");
  await click('.client-sales-cards button:nth-child(2)');
  await fill('[aria-label="Caută client în raport"]','a 07');
  await waitFor("document.querySelector('.client-sales-table')?.textContent.includes('a 07')");
  await click('.client-sales-table tbody th button');await waitFor("document.querySelector('dialog[open]')!==null");
  await waitFor("document.querySelector('dialog')?.textContent.includes('Fișă sintetică')");
  await evaluate("window.fixture.setAgent('b');true");
  await waitFor("document.querySelector('.client-sales header')?.textContent.includes('Agent sintetic B')&&document.querySelector('.client-sales-table')?.textContent.includes('b 00')&&!document.querySelector('dialog[open]')");
  check(await evaluate("document.querySelector('[aria-label=\"Caută client în raport\"]').value===''") ,'Manager scope change clears previous agent search');
  check(await evaluate("document.querySelector('.client-sales-chips button:first-child')?.getAttribute('aria-pressed')==='true'"),'Manager scope change resets previous filter');
  check(!(await evaluate("document.body.textContent.includes('Client sintetic a 07')||document.querySelector('dialog[open]')!==null")),'Manager scope change closes the prior agent partner detail');
  // Keep a desktop viewport while constraining the actual nested report container.
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  for(const width of [440,320]){
   await evaluate("document.querySelector('main').style.width='"+width+"px';true");
   const geometry=await evaluate("(()=>{const period=document.querySelector('.client-sales .report-period'),controls=period.parentElement,rect=period.getBoundingClientRect();return {width:rect.width,parentWidth:controls.getBoundingClientRect().width,buttons:[...period.querySelectorAll('.report-month-grid button')].map(button=>({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height,nowrap:getComputedStyle(button).whiteSpace,overflow:button.scrollWidth>button.clientWidth}))}})()");
   check(geometry.width>=geometry.parentWidth-2,'Customer calendar spans the controls row at '+width+'px');
   check(geometry.buttons.length===12&&geometry.buttons.every(button=>button.width>=24&&button.height<=40&&button.nowrap==='nowrap'&&!button.overflow),'Month labels stay on one line in a '+width+'px nested card: '+JSON.stringify(geometry));
  }
  await evaluate("document.querySelector('main').style.width='';true");
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});
  const calendar=await evaluate("(()=>{const current=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'}).format(new Date());return {current,year:Number(current.slice(0,4))}})()");
  await select('[aria-label="An · Luna raportului pe clienți"]',String(calendar.year+1));
  check(await evaluate("[...document.querySelectorAll('.client-sales .report-month-grid button')].every(button=>button.disabled)"),'Customer calendar disables all months in a future year');
  const previousRequests=requests.filter(path=>path.startsWith('/api/sales/clients?')).length;
  const previousSelection=await evaluate("document.querySelector('.client-sales .report-period-selection').textContent");
  await click('.client-sales .report-month-grid button:first-child');await delay(100);
  check(await evaluate("document.querySelector('.client-sales .report-period-selection').textContent")==previousSelection,'Disabled future month preserves selected report period');
  check(requests.filter(path=>path.startsWith('/api/sales/clients?')).length===previousRequests,'Disabled future month never requests a customer report');
  await select('[aria-label="An · Luna raportului pe clienți"]',String(calendar.year));
  check(await evaluate("[...document.querySelectorAll('.client-sales .report-month-grid button')].slice(0,"+Number(calendar.current.slice(5))+").every(button=>!button.disabled)"),'Current and past months stay selectable');
  check(errors.length===0,JSON.stringify(errors));
  check(!requests.some(p=>p.startsWith('/api/sales?')),'All monthly filters/refreshes remain separate from daily sales');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Prepay fără proiecte fixture').click();true");
  await waitFor("document.querySelector('.prepay-legacy-sales .distribution-metric strong')?.textContent==='7 buc.'");
  check(await evaluate("document.querySelector('.prepay-legacy-sales .distribution-metric>span:last-child').textContent.replaceAll(String.fromCharCode(160),' ')==='70,00 RON'"),'Unconfigured Prepay preserves legacy card and SIM quantities/value');
  check(await evaluate("document.querySelectorAll('.prepay-workspace .report-period').length===1"),'Unconfigured Prepay offers one monthly selector');
  check(!(await evaluate("document.querySelector('.distribution-filters')!==null")),'Unconfigured sales do not depend on project filters');
  check(!(await evaluate("[...document.querySelectorAll('.prepay-workspace .commerce-tabs button')].some(button=>button.textContent==='Activări')")),'Unconfigured sales retain the activation permission gate');
  check(!(await evaluate("document.querySelector('.prepay-legacy-sales').textContent.includes('CABLE')||document.querySelector('.prepay-legacy-sales').textContent.includes('VOUCHER')")),'Legacy Prepay excludes accessory and voucher product duplication');
  check(!(await evaluate("document.querySelector('.prepay-legacy-sales').textContent.includes('Media')")),'Legacy segment totals do not invent a credit-only mean');
  await click('.prepay-legacy-sales .commerce-details summary');
  check(await evaluate("document.querySelectorAll('.prepay-legacy-sales .commerce-product-table tbody tr').length===2"),'Legacy Prepay keeps the underlying SIM and card products reachable');
  await click('[aria-label="august 2026"]');
  await waitFor("document.querySelector('.prepay-legacy-sales .distribution-metric strong')?.textContent==='4 buc.'");
  check(await evaluate("document.querySelector('.prepay-legacy-sales .distribution-metric>span:last-child').textContent.replaceAll(String.fromCharCode(160),' ')==='40,00 RON'"),'Changing the legacy month updates quantities and value');
  check(requests.some(path=>path.startsWith('/api/sales?')&&path.includes('agentId=a')&&path.includes('month=2026-08')&&!path.includes('months=')),'Legacy month selection uses the ordinary authorized sales API');

  const agentStart=requests.length;
  await evaluate("localStorage.setItem('agent-report-months-v1:a',JSON.stringify(['2026-09']));[...document.querySelectorAll('button')].find(button=>button.textContent==='Accesorii agent fixture').click();true");
  await waitFor("document.querySelector('.agent-commerce .client-sales-table')!==null");
  check(!(await evaluate("document.querySelector('.client-sales').textContent.includes('Reconciliere națională')")),'Agent customer report never exposes national manager reconciliation');
  check(!(await evaluate("document.querySelector('.agent-report-scope')!==null")),'Agent customer report uses only its contextual monthly selector');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate("document.querySelector('main').style.width='440px';true");
  const agentMonths=await evaluate("[...document.querySelectorAll('.client-sales .report-month-grid button')].map(button=>({width:button.getBoundingClientRect().width,nowrap:getComputedStyle(button).whiteSpace,overflow:button.scrollWidth>button.clientWidth}))");
  check(agentMonths.length===12&&agentMonths.every(button=>button.width>=24&&button.nowrap==='nowrap'&&!button.overflow),'Agent customer calendar fits a 440px nested card');
  await evaluate("document.querySelector('main').style.width='';true");
  await evaluate("[...document.querySelectorAll('.agent-commerce .commerce-tabs button')].find(button=>button.textContent==='Accesorii').click();true");
  await waitFor("document.querySelector('.agent-report-scope .report-month-grid button[aria-pressed=true]')?.getAttribute('aria-label')==='septembrie 2026'");
  await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Prepay agent fixture').click();true");
  await waitFor("document.querySelector('.agent-commerce .prepay-workspace')!==null&&document.querySelector('.prepay-legacy-sales .distribution-metric strong')?.textContent==='7 buc.'");
  check(await evaluate("document.querySelector('.agent-report-scope .report-month-grid button[aria-pressed=true]')?.getAttribute('aria-label')==='septembrie 2026'"),'Agent report months persist from accessories to Prepay');
  check(!(await evaluate("document.querySelector('.distribution-projects')!==null||[...document.querySelectorAll('.prepay-workspace .commerce-tabs button')].some(button=>button.textContent==='Activări')")),'Agent has no project selector and denied activation tab');
  const agentRequests=requests.slice(agentStart);
  check(agentRequests.some(path=>path.startsWith('/api/sales?')&&path.includes('months=2026-09')),'Configured agent sales use the shared multi-month report');
  check(agentRequests.some(path=>path.startsWith('/api/sales/clients?')),'Agent customer report remains reachable');
  check(agentRequests.every(path=>!/[?&](agentId|managerId|siteCode)=/.test(path)),'Agent report queries never forge manager or seller scope');
  check(!agentRequests.some(path=>path.includes('/activations')||path.includes('/reconciliation')),'Denied agent never requests activation or national reconciliation APIs');
  check(agentRequests.filter(path=>path.startsWith('/api/sales/clients?')).every(path=>!/[?&](months|projects)=/.test(path)),'Own customer report never receives product-report period filters');
  console.log('PASS: '+checks+' synthetic monthly browser checks, Team navigation, pagination/search/filter, loading/error/retry, stale responses, month/drilldown, scope, legacy Prepay month/totals and 360px overflow.');
} catch (error) {
  testError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  await closeBrowser?.().catch(() => {});
  try { socket?.close(); } catch (error) { cleanupErrors.push(error); }
  await Promise.race([closed, delay(2000)]);
  // Signal only the dedicated process group we spawned, including descendants
  // that may outlive Chrome's main process. A failed spawn has no pid.
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); }
    await Promise.race([closed, delay(2000)]);
    if (!childClosed) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); }
      await Promise.race([closed, delay(2000)]);
      if (!childClosed) cleanupErrors.push(chromeFailure('Chrome did not close after SIGKILL'));
    }
  }
  // Chromium subprocesses may flush profile files briefly after their exit.
  await delay(200);
  try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { cleanupErrors.push(error); }
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    cleanupError = new AggregateError(cleanupErrors, 'Browser fixture cleanup failed');
    if (testError) console.error(cleanupError);
  }
}
if (cleanupError) throw cleanupError;
