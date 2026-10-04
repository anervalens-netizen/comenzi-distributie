// Real rendered application and IndexedDB; deterministic synthetic HTTP replies.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';
const baseline=process.env.RECOVERY_BASELINE_REF;
const baselinePlugin={name:'baseline',setup(b){b.onLoad({filter:/app\/distribution-app\.tsx$/},args=>({contents:execFileSync('git',['show',`${baseline}:${args.path.slice(process.cwd().length+1)}`],{encoding:'utf8'}),loader:args.path.endsWith('tsx')?'tsx':'ts',resolveDir:resolve(args.path,'..')}));}};
const source=String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import App from './app/distribution-app';import * as work from './lib/offline-work';import * as client from './lib/client-api';import * as local from './lib/local-work';
window.work=work;window.client=client;window.local=local;
const user={id:'synthetic-agent',name:'Synthetic agent',username:'synthetic',role:'agent',warehouseId:'w',warehouseName:'Synthetic',active:1,mustChangePassword:false};
const order={id:'A',number:'TEST-A',kind:'accessories',userId:user.id,agentName:user.name,warehouseId:'w',warehouseName:'Synthetic',status:'draft',items:[],serials:[],client:null,notes:'A',createdAt:new Date().toISOString(),finalizedAt:null,sourceOrderId:null,revision:1,total:0,pieces:0};
window.detailOnly={...order,id:'paged',number:'TEST-PAGED'};window.sessionUser=user;window.orders=[order,{...order,id:'B',number:'TEST-B',notes:'B'}];window.held={};window.requests=[];window.holdOrders=false;window.holdList=false;
window.fetch=async(input,init={})=>{const path=String(input).replace(/^.*\/api\//,'');window.requests.push(path);let value;
 if(path==='auth/session')value={user:window.sessionUser};else if(path.startsWith('bootstrap'))value={user:window.sessionUser,users:[window.sessionUser],warehouses:[{id:'w',name:'Synthetic'}],products:[],orders:window.sessionUser.id===user.id?window.orders:[],weekKey:'2026-10-03'};
 else if(path==='orders'||path.startsWith('orders?')){value={user,orders:window.orders,weekKey:'2026-10-03'};if(window.holdList)return new Promise(r=>window.held['list'+window.requests.filter(p=>p==='orders'||p.startsWith('orders?')).length]=()=>r(new Response(JSON.stringify(value))));}
 else if(path.startsWith('orders/')){value={order:window.orders.find(o=>o.id===path.slice(7))||(path==='orders/paged'?window.detailOnly:undefined)};if(window.holdOrders)return new Promise(r=>window.held[path]=()=>r(new Response(JSON.stringify(value))));}
 else if(path.startsWith('stock'))value={warehouseId:'w',rows:[],depot:{},warehouses:[]};else value={};return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});};
await work.saveWork(user.id,'draft-list','all',[{...order,id:'local',number:'Ciornă locală',notes:''}]);
if(${!baseline}){const value={base:window.detailOnly,local:{...window.detailOnly,notes:'Unlisted local work'}};await work.saveWork(user.id,'order','paged',value);local.writeLocalWork('order',user.id,'paged',value);}
window.root=createRoot(document.getElementById('root'));root.render(<App/>);window.ready=true;
`;
const output=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},write:false,outdir:'out',bundle:true,format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent',alias:{'next/image':resolve('tools/offline-image.tsx')},plugins:baseline?[baselinePlugin]:[]});
const js=output.outputFiles.find(f=>f.path.endsWith('.js')).text;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?js:'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser,checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);const evaluate=browser.evaluate;
 await waitFor(()=>evaluate('!!document.querySelector("[data-order-id=local]")'),'initial local draft');
 await evaluate('document.querySelector("[aria-label=\\"Actualizează comenzile\\"]").click()');await delay(200);
 if(process.env.RECOVERY_CASE!=='navigation')check(await evaluate('!!document.querySelector("[data-order-id=local]")'),'T03 actual UI refresh keeps local draft');
 if(!baseline){
  await waitFor(()=>evaluate('requests.includes("orders/paged")'),'unlisted draft verified by live detail');
  check(await evaluate('!document.body.innerText.includes("Comanda nu mai există pe server")&&(await work.readWork("synthetic-agent","order","paged")).local.notes==="Unlisted local work"'),'T03 missing page row is not a deletion');
  await evaluate('window.orders=[...orders,{...orders[0],id:"local",number:"TEST-LOCAL"}];window.dispatchEvent(new CustomEvent("mobiup-sync-confirmed",{detail:{userId:"synthetic-agent",path:"orders",result:{order:orders.at(-1)}}}))');
  await waitFor(()=>evaluate('document.querySelector("[data-order-id=local]")?.textContent.includes("TEST-LOCAL")'),'sync reconciles list');
  check(await evaluate('document.querySelectorAll("[data-order-id=local]").length===1'),'T03 rendered sync collapses local and server copy');
 }
 await evaluate('window.holdOrders=true;document.querySelector("[data-order-id=A] .order-link").click();document.querySelector("[data-order-id=B] .order-link").click()');
 await waitFor(()=>evaluate('!!held["orders/A"]&&!!held["orders/B"]'),'both detail requests');
 await evaluate('held["orders/B"]()');await waitFor(()=>evaluate('document.querySelector(".cart textarea")?.value==="B"'),'B editor');
 await evaluate('const input=document.querySelector(".cart textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"B edited");input.dispatchEvent(new Event("input",{bubbles:true}));held["orders/A"]()');await delay(200);
 check(await evaluate('document.querySelector(".cart textarea")?.value==="B edited"'),'T05 late A cannot replace B in real editor');
 await evaluate('const input=document.querySelector(".cart textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"B");input.dispatchEvent(new Event("input",{bubbles:true}));window.holdOrders=false;document.querySelector(".back-link").click()');
 await waitFor(()=>evaluate('!!document.querySelector("[data-order-id=A]")'),'back to list');
 // Closing B also invalidates A while its response is still outstanding.
 await evaluate('window.held={};window.holdOrders=true;document.querySelector("[data-order-id=A] .order-link").click();document.querySelector("[data-order-id=B] .order-link").click()');
 await waitFor(()=>evaluate('!!held["orders/A"]&&!!held["orders/B"]'),'close race requests');
 await evaluate('held["orders/B"]()');await waitFor(()=>evaluate('document.querySelector(".cart textarea")?.value==="B"'),'B before close');
 await evaluate('window.holdOrders=false;document.querySelector(".back-link").click()');await waitFor(()=>evaluate('!!document.querySelector("[data-order-id=A]")'),'closed B');
 await evaluate('held["orders/A"]()');await delay(100);
 check(await evaluate('!document.querySelector(".cart textarea")'),'T05 close does not reopen late A');
 await evaluate('window.held={};window.holdOrders=true;document.querySelector("[data-order-id=A] .order-link").click()');await waitFor(()=>evaluate('!!held["orders/A"]'),'pending A');
 await evaluate('const input=document.querySelector("[aria-label=\\"Caută comenzi\\"]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"TEST-B");input.dispatchEvent(new Event("input",{bubbles:true}));');await delay(50);await evaluate('held["orders/A"]()');await delay(200);
 check(await evaluate('!document.querySelector(".cart textarea")&&!!document.querySelector("[data-order-id=B]")'),'T05 filter change invalidates pending open');
 // Wait for the search debounce to issue its own request before holding manual
 // refreshes. Otherwise two distinct requests race into the first held slot.
 await waitFor(()=>evaluate('requests.some(path=>path.startsWith("orders?")&&new URLSearchParams(path.split("?")[1]).get("q")==="TEST-B")'),'search request before manual refresh');
 // Reverse list responses must not restore removed rows or older data.
 await evaluate('window.holdOrders=false;window.holdList=true;window.held={};document.querySelector("[aria-label=\\"Actualizează comenzile\\"]").click()');await waitFor(()=>evaluate('Object.keys(held).length===1'),'old list');
 await evaluate('window.orders=orders.filter(o=>o.id!=="B");document.querySelector("[aria-label=\\"Actualizează comenzile\\"]").click()');await waitFor(()=>evaluate('Object.keys(held).length===2'),'new list');
 await evaluate('held[Object.keys(held)[1]]()');await delay(100);await evaluate('held[Object.keys(held)[0]]()');await delay(100);
 check(await evaluate('!document.querySelector("[data-order-id=B]")'),'T05 late refresh does not restore old list');
 await evaluate('window.holdList=false;const input=document.querySelector("[aria-label=\\"Caută comenzi\\"]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"");input.dispatchEvent(new Event("input",{bubbles:true}));');
 await waitFor(()=>evaluate('!!document.querySelector("[data-order-id=A]")'),'reset filter');
 await evaluate('window.held={};window.holdOrders=true;document.querySelector("[data-order-id=A] .order-link").click()');await waitFor(()=>evaluate('!!held["orders/A"]'),'navigation pending A');
 await evaluate('[...document.querySelectorAll("[role=tab]")].find(b=>b.textContent.includes("Avize")).click()');await delay(50);await evaluate('held["orders/A"]()');await delay(100);
 check(await evaluate('!document.querySelector(".cart textarea")&&!!document.querySelector("[aria-label=\\"Caută avize\\"]")'),'T05 tab navigation rejects late A');
 await evaluate('[...document.querySelectorAll("[role=tab]")].find(b=>b.textContent.includes("Comenzi")).click()');await waitFor(()=>evaluate('!!document.querySelector("[data-order-id=A]")'),'orders before account switch');
 await evaluate('window.held={};window.holdOrders=true;document.querySelector("[data-order-id=A] .order-link").click()');await waitFor(()=>evaluate('!!held["orders/A"]'),'account pending A');
 await evaluate('window.sessionUser={...sessionUser,id:"other-agent"};local.setLocalWorkUserId("other-agent");window.dispatchEvent(new StorageEvent("storage",{key:"mobiup-work-user-v1"}))');await delay(100);await evaluate('held["orders/A"]()');await delay(100);
 check(await evaluate('!document.querySelector(".cart textarea")&&!document.querySelector("[data-order-id=local]")&&!document.querySelector("[data-order-id=A]")'),'T05 account change rejects old response and local rows');
 console.log('PASS: '+checks+' rendered application navigation/reconciliation contracts.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
