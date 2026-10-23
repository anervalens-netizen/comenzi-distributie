// Real report components and API client; isolated synthetic origin and account.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';

const bundle=await build({stdin:{contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ActivationOperatorCard} from './components/activations';
import {ActivationPartners} from './components/activation-partners';
import ClientSales from './components/client-sales';
import {ClientSalesReconciliation} from './components/client-sales-reconciliation';
import {setLocalWorkUserId} from './lib/local-work';
setLocalWorkUserId('synthetic-report-owner');
function Fixture(){const [mode,setMode]=useState('operator'),[month,setMonth]=useState('2026-09');window.fixture={setMode,setMonth};return <main id="report">{mode==='operator'?<ActivationOperatorCard userId="synthetic-report-owner" query={'month='+month} provider="digi" reload={0}/>:mode==='partners'?<ActivationPartners userId="synthetic-report-owner" query={'month='+month} reload={0}/>:mode==='clients'?<ClientSales initialMonth="2026-09"/>:<ClientSalesReconciliation month="2026-09"/>}</main>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,loader:'tsx',resolveDir:resolve('.')},outdir:resolve('work/report-recovery-fixture'),write:false,bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});

const requests=[],failed=new Set();
const counts=Object.fromEntries(['all','billed','unbilled','absentPrevious','absentThree','new','repeat','waiting','overdue','reactivated','visited','unvisited','unvisitedPrevious','unvisitedThree','unknown'].map(key=>[key,0]));
function responseFor(url){
 const month=url.searchParams.get('month');
 if(url.pathname==='/api/activations')return url.searchParams.get('view')==='partners'
  ?{operators:{digi:{available:true,latestDate:month+'-20'}},partners:{realPointCount:42,unassignedActivations:0,genericActivations:0,unresolvedActivations:0,rows:[],hasMore:false}}
  :{available:true,totals:{total:42},sites:[],history:[],latestDate:month+'-20',selectedMonths:[month],coveredMonths:[month]};
 if(url.pathname==='/api/sales/clients/reconciliation')return {state:'ready',scope:'national',month,explanation:'Synthetic recovered reconciliation',window:{from:month+'-01',to:month+'-20',imported:true},source:{revision:'synthetic',builtAt:month+'-21'},buckets:{},exceptions:[],total:0,hasMore:false};
 return {state:'ready',month,source:{updatedAt:month+'-21',coverage:[]},window:{from:month+'-01',to:month+'-20',imported:true,covered:true,complete:false},comparisons:[{month:'2026-07',from:'2026-07-01',to:'2026-07-20',covered:true,billed:0,documents:0,valueCents:0,visits:0,visited:0,visitsFrom:'2026-07-01',visitsTo:'2026-07-31',missingValues:0,unknown:0}],totals:{valueCents:0,billed:0,documents:0,perClient:0,unknown:0,missingValues:0,visits:0,visited:0,visitedUnidentified:0},counts,counties:[],total:0,rows:[],hasMore:false,absenceEligible:true,visitRange:{from:month+'-01',to:month+'-30'},noVisitRecords:true};
}
const server=createServer((request,response)=>{
 const url=new URL(request.url,'http://fixture.invalid');response.setHeader('Cache-Control','no-store');
 if(url.pathname==='/fixture.js'){response.setHeader('Content-Type','text/javascript');response.end(bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents);return;}
 if(url.pathname.startsWith('/api/')){
  assert.equal(request.method,'GET');requests.push(url.pathname+url.search);response.setHeader('Content-Type','application/json');
  const kind=url.pathname+(url.searchParams.get('view')||'');
  if(!failed.has(kind)){failed.add(kind);response.statusCode=503;response.end(JSON.stringify({error:'Synthetic transient report failure'}));return;}
  response.end(JSON.stringify(responseFor(url)));return;
 }
 response.setHeader('Content-Type','text/html');response.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,checks=0;
try{
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);
 const evaluate=browser.evaluate;
 const check=(condition,label)=>{assert.ok(condition,label);checks++;};
 const failure=()=>waitFor(()=>evaluate("document.querySelector('#report [role=alert]')?.textContent.includes('Synthetic transient report failure')"),'transient report failure is visible');
 const recovered=async(condition)=>{
  await waitFor(()=>evaluate(condition),'successful report is rendered');
  check(await evaluate("!document.querySelector('#report [role=alert]')"),'successful response clears the previous report error');
 };
 for(const mode of ['operator','partners']){
  if(mode==='partners')await evaluate("fixture.setMode('partners')");
  await failure();
  await evaluate("fixture.setMonth('2026-08')");
  await recovered(mode==='operator'?"document.querySelector('.activation-primary strong')?.textContent==='42'":"document.querySelector('#report').textContent.includes('42 puncte identificate')");
  await evaluate("fixture.setMonth('2026-09')");
  await recovered(mode==='operator'?"document.querySelector('.activation-primary strong')?.textContent==='42'":"document.querySelector('#report').textContent.includes('42 puncte identificate')");
 }
 await evaluate("fixture.setMode('clients')");await failure();
 const month=async(value)=>{await evaluate(`(()=>{const input=document.querySelector('[aria-label="Luna raportului pe clienți"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
 await month('2026-08');await recovered("document.querySelector('.client-sales-period')?.textContent.includes('01.08.2026')");
 await month('2026-09');await recovered("document.querySelector('.client-sales-period')?.textContent.includes('01.09.2026')");
 await evaluate("fixture.setMode('reconciliation')");
 await evaluate("document.querySelector('#report details').open=true");await failure();
 await evaluate("document.querySelector('#report details').open=false");await delay(75);
 await evaluate("document.querySelector('#report details').open=true");await recovered("document.querySelector('#report').textContent.includes('Synthetic recovered reconciliation')");
 check(requests.filter(path=>path.startsWith('/api/activations?')&&!path.includes('view=partners')).length===3,'operator retries the original failed month');
 check(requests.filter(path=>path.includes('view=partners')).length===3,'partner report retries the original failed month');
 check(requests.filter(path=>path.startsWith('/api/sales/clients?')).length===3,'client report retries the original failed month');
 check(requests.filter(path=>path.startsWith('/api/sales/clients/reconciliation?')).length===2,'reopened reconciliation retries the failed request');
 console.log(`PASS: ${checks} report recovery checks across operators, activation partners, clients and reconciliation.`);
}finally{
 await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
