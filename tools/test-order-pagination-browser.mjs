import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';

const source=String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import App from './app/distribution-app';import * as work from './lib/offline-work';
const user={id:'page-agent',name:'Agent paginare',username:'page.agent',role:'agent',managerScope:'assigned',warehouseId:'w',warehouseName:'Gestiune',active:1,mustChangePassword:false};
const product={id:'p1',code:'P1',name:'Produs sintetic',brand:'Brand',category:'Accesorii',kind:'accessories',price:10,netPrice:8,sourceRow:1,image:null};
const make=(i,extra={})=>({id:'o'+String(i).padStart(3,'0'),number:'ORDER-'+String(i).padStart(3,'0'),kind:'accessories',userId:user.id,agentName:user.name,warehouseId:'w',warehouseName:'Gestiune',status:i%3?'finalized':'draft',items:[],serials:[],client:null,notes:'',createdAt:new Date(Date.UTC(2026,9,3,12,0,-i)).toISOString(),finalizedAt:i%3?new Date(Date.UTC(2026,9,3,12,0,-i)).toISOString():null,sourceOrderId:null,revision:1,total:i,pieces:i,...extra});
window.allOrders=Array.from({length:120},(_,i)=>make(i));window.requests=[];window.held={};window.releaseOld=null;window.listRevision="r1";
await work.saveWork(user.id,'draft-list','all',[make(999,{id:'local-only',number:'Ciornă locală',status:'draft',finalizedAt:null})]);
window.fetch=async(input,init={})=>{const path=String(input).replace(/^.*\/api\//,'');requests.push({path,method:init.method||'GET'});let value;
 if(path==='auth/session')value={user};
 else if(path==='bootstrap?compact=1')value={user,users:[],warehouses:[{id:'w',name:'Gestiune'}],settings:{weeklyLimit:2},orders:allOrders.slice(0,40),orderPage:{revision:'r1',total:120,limit:40,nextCursor:'40',stats:{drafts:40,weekly:80}},weekKey:'2026-09-29'};
 else if(path==='catalog')value={products:[product]};
 else if(path.startsWith('orders?')){const p=new URLSearchParams(path.split('?')[1]),q=(p.get('q')||'').toLowerCase(),start=Number(p.get('cursor')||0);if(p.has('revision')&&p.get('revision')!==listRevision)return new Response(JSON.stringify({error:'Stale revision'}),{status:409});let rows=allOrders.filter(o=>!q||o.number.toLowerCase().includes(q));if(q==='hold-a')return new Promise(resolve=>releaseOld=()=>resolve(new Response(JSON.stringify({user,orders:[make(1,{id:'old-result',number:'HOLD-A'})],orderPage:{revision:'r1',total:1,limit:40,nextCursor:null,stats:{drafts:40,weekly:80}},weekKey:'2026-09-29'}),{headers:{'Content-Type':'application/json'}})));if(q==='hold-b')rows=[make(2,{id:'new-result',number:'HOLD-B'})];value={user,orders:rows.slice(start,start+40),orderPage:{revision:listRevision,total:rows.length,limit:40,nextCursor:start+40<rows.length?String(start+40):null,stats:{drafts:40,weekly:80}},weekKey:'2026-09-29'};}
 else if(path==='orders'&&(init.method||'GET')==='POST'){const body=JSON.parse(init.body);value={order:make(0,{id:body.id,number:'NEW-DRAFT',kind:body.kind,status:'draft',finalizedAt:null})};}
 else if(path.startsWith('orders/'))value={order:allOrders.find(o=>o.id===path.slice(7))};
 else value={};return new Response(JSON.stringify(value),{status:path==='orders'&&init.method==='POST'?201:200,headers:{'Content-Type':'application/json'}});};
window.work=work;window.make=make;window.mount=()=>{window.root=createRoot(document.getElementById('root'));root.render(<App/>);};mount();window.ready=true;`;
const output=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},write:false,outdir:'out',bundle:true,format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent',alias:{'next/image':resolve('tools/offline-image.tsx')}});
const js=output.outputFiles.find(file=>file.path.endsWith('.js')).text;let server,browser,checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?js:'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);const evaluate=browser.evaluate;
 await waitFor(()=>evaluate("!!document.querySelector('[data-order-id=local-only]')&&document.querySelectorAll('[data-order-id]').length===41"),'compact page plus local draft');
 check(await evaluate("requests.filter(row=>row.path==='catalog').length===0&&requests.some(row=>row.path==='bootstrap?compact=1')"),'startup uses compact bootstrap and does not fetch catalog');
 check(await evaluate("document.querySelector('.list-pagination output').textContent.includes('din 120')&&document.body.innerText.includes('1 ciorne locale')"),'server pagination total and local-only draft are explicit');
 await evaluate("document.querySelector('.list-pagination button:last-child').click()");await waitFor(()=>evaluate("!!document.querySelector('[data-order-id=o040]')"),'second server page');
 check(await evaluate("document.querySelectorAll('[data-order-id]').length===41&&!!document.querySelector('[data-order-id=local-only]')&&!document.querySelector('[data-order-id=o000]')"),'next page has no prior-page duplicates and retains local draft');
 await evaluate("listRevision='r2';document.querySelector('.list-pagination button:first-child').click()");
 await waitFor(()=>evaluate("!!document.querySelector('[data-order-id=o000]')"),'Previous refreshes page zero after revision changed');
 check(await evaluate("!new URLSearchParams(requests.filter(r=>r.path.startsWith('orders?')).at(-1).path.split('?')[1]).has('revision')"),'page zero omits stale revision');
 const input="document.querySelector('[aria-label=\"Caută comenzi\"]')";
 await evaluate(`(()=>{const i=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'ORDER-095');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await waitFor(()=>evaluate("!!document.querySelector('[data-order-id=o095]')"),'deep server search');check(true,'search reaches an order outside loaded pages');
 await evaluate(`(()=>{const i=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'hold-a');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await waitFor(()=>evaluate('!!releaseOld'),'held stale filter request');
 await evaluate(`(()=>{const i=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'hold-b');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await waitFor(()=>evaluate("!!document.querySelector('[data-order-id=new-result]')"),'newer filter result');await evaluate('releaseOld()');await delay(150);
 check(await evaluate("!!document.querySelector('[data-order-id=new-result]')&&!document.querySelector('[data-order-id=old-result]')"),'late stale page cannot overwrite the latest filter');
 await evaluate(`(()=>{const i=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await waitFor(()=>evaluate("!!document.querySelector('.order-action')"),'reset search');
 await evaluate("document.querySelector('.order-action').click()");await waitFor(()=>evaluate("requests.some(row=>row.path==='catalog')&&requests.some(row=>row.path==='orders'&&row.method==='POST')"),'catalog intent and create');
 check(await evaluate("requests.findIndex(row=>row.path==='catalog')<requests.findIndex(row=>row.path==='orders'&&row.method==='POST')"),'catalog lazy load occurs at editor/create intent before draft creation');
 await evaluate("root.unmount();window.confirmed=make(777,{id:'acknowledged-local',number:'CONFIRMED-DRAFT',status:'draft',finalizedAt:null});await work.enqueue('page-agent','orders','POST',{id:confirmed.id,kind:confirmed.kind,agentId:'page-agent'},{scope:'draft-list',id:'all',value:[confirmed]});await work.replay('page-agent',async()=>({order:confirmed}),()=> 'page-agent');window.fetch=async()=>{throw new TypeError('Synthetic offline reopen')};mount()");
 await waitFor(()=>evaluate("document.querySelectorAll('[data-order-id=acknowledged-local]').length===1"),'acknowledged draft on rendered offline reopen');
 check(await evaluate("document.querySelector('[data-order-id=acknowledged-local]').textContent.includes('CONFIRMED-DRAFT')&&(await work.pendingOperations('page-agent')).length===0"),'D exactly one confirmed draft is visible offline before list refresh');
 await evaluate(`(()=>{const i=${input};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'ORDER-095');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await waitFor(()=>evaluate("!!document.querySelector('[data-order-id=o095]')"),'cached filtered page offline');
 check(await evaluate("!document.querySelector('[data-order-id=acknowledged-local]')"),'D confirmed local projection respects the visible search without fabricating cached membership');
 console.log(`PASS: ${checks} rendered compact bootstrap, lazy catalog, local draft, cursor and stale-response checks.`);
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
