// Actual editor/API/IndexedDB with a synthetic authoritative HTTP transport.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';
const source=String.raw`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{OrderEditor}from'./components/order-editor';import{OrderResult}from'./components/order-result';
import * as api from './lib/client-api';import * as work from './lib/offline-work';import * as local from './lib/local-work';
window.m={...api,...work,...local};window.calls=[];window.warnings=[];window.failure='none';window.failCleanup=false;
window.addEventListener('mobiup-storage-error',e=>warnings.push(e.detail));
const product={id:'p',code:'P',name:'Synthetic',brand:'',category:'Stands',kind:'stands',price:10,netPrice:8,sourceRow:1,image:null};
const put=IDBObjectStore.prototype.put,remove=Storage.prototype.removeItem;
IDBObjectStore.prototype.put=function(row){if(failCleanup&&failure==='idb'&&this.name==='work'&&row.key?.endsWith('|order-list|confirmed'))throw new DOMException('Synthetic cache failure','QuotaExceededError');return put.apply(this,arguments);};
Storage.prototype.removeItem=function(key){if(failCleanup&&failure==='local'&&key.includes('mobiup-work-v1:order:'))throw new DOMException('Synthetic mirror failure','SecurityError');return remove.apply(this,arguments);};
window.fetch=async(input,init={})=>{const path=String(input).replace('/api/',''),method=init.method||'GET';calls.push({path,method});let result;
 if(path==='auth/session')result={user:{id:'agent'}};
 else if(path.endsWith('/finalize')){serverOrder={...serverOrder,status:'finalized',revision:serverOrder.revision+1,finalizedAt:'2026-10-01T12:00:00Z'};failCleanup=true;result={order:serverOrder};}
 else if(path.endsWith('/mail'))result={mail:{filename:'synthetic.xlsx',subject:'Synthetic',body:'Synthetic',to:'synthetic@example.invalid',cc:[],mailto:'mailto:synthetic@example.invalid'}};
 else if(path.startsWith('orders/')){if(method==='PUT')serverOrder={...serverOrder,...JSON.parse(init.body),revision:serverOrder.revision+1};result={order:serverOrder};}
 else if(path.startsWith('stock'))result={warehouseId:'w',rows:[],depot:{},importedAt:null,depotImportedAt:null};
 else result={};return Response.json(result);
};
await api.api('auth/session');
window.mount=async(mode)=>{failure=mode;failCleanup=false;calls=[];warnings=[];window.finalOrder=null;window.serverOrder={id:'order-'+mode,number:'Synthetic',kind:'stands',status:'draft',userId:'agent',agentName:'Synthetic',warehouseId:'w',warehouseName:'Synthetic',items:[{...product,quantity:1}],serials:[],client:null,notes:'',createdAt:'2026-10-01T12:00:00Z',finalizedAt:null,revision:1,total:10,pieces:1,sourceOrderId:null};await work.saveOrderWork('agent',serverOrder.id,{base:serverOrder,local:serverOrder});local.writeLocalWork('order','agent',serverOrder.id,{base:serverOrder,local:serverOrder});
 function Fixture(){const[order,setOrder]=useState(serverOrder);return order.status==='finalized'?<OrderResult order={order} onClose={()=>{}} onCopy={()=>{}}/>:<OrderEditor initial={order} products={[product]} canEdit onClose={()=>{}} onSaved={()=>{}} onRecovered={()=>{}} onFinalized={o=>{window.finalOrder=o;setOrder(o);}}/>;}
 window.root=createRoot(document.getElementById('root'));root.render(<Fixture/>);};window.ready=true;
`;
const output=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},write:false,outdir:'out',bundle:true,format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent',alias:{'next/image':resolve('tools/offline-image.tsx')}});
const js=output.outputFiles.find(file=>file.path.endsWith('.js')).text;let server,browser,checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;};
try{
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?js:'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);const evaluate=browser.evaluate;
 await waitFor(()=>evaluate('window.ready'),'fixture');
 for(const mode of ['idb','local','none']){
  await evaluate(`await mount(${JSON.stringify(mode)})`);await waitFor(()=>evaluate("!!document.querySelector('.cart-footer button.primary')&&!document.querySelector('.cart-footer button.primary').disabled"),'editor');
  await evaluate("document.querySelector('.cart-footer button.primary').click()");await waitFor(()=>evaluate("!!document.querySelector('.review-dialog .dialog-actions button.primary')"),'review');
  // The pre-finalize save may refresh the comparison base; seed a clean mirror
  // against that exact server version so the failing removal is exercised.
  await evaluate("m.writeLocalWork('order','agent',serverOrder.id,{base:serverOrder,local:serverOrder});document.querySelector('.review-dialog .dialog-actions button.primary').click()");
  await waitFor(()=>evaluate("finalOrder?.status==='finalized'&&!!document.querySelector('.result-buttons')"),'finalized result despite '+mode+' cleanup');await delay(100);
  check(await evaluate("calls.filter(c=>c.path.endsWith('/finalize')).length===1&&(await m.pendingOperations('agent')).length===0"),mode+' never retries or queues duplicate finalization');
  check(await evaluate(`warnings.length===${mode==='none'?0:1}`),mode+' uses existing local storage warning');
  if(mode==='none')check(await evaluate("!(await m.readWork('agent','order',serverOrder.id))&&!m.readLocalWork('order','agent',serverOrder.id).value&&(await m.readWork('agent','order-list','confirmed'))[serverOrder.id].status==='finalized'"),'healthy storage cleans projection and clean recovery');
  else{
   check(await evaluate("(await m.networkApi('orders/'+serverOrder.id)).order.status==='finalized'"),mode+' authoritative GET also returns success');
   check(await evaluate('warnings.length===2'),mode+' GET warns about failed cleanup');
  }
  await evaluate('failCleanup=false;root.unmount()');
 }
 console.log(`PASS: ${checks} finalized UI, authoritative GET, storage-failure and duplicate-write checks.`);
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
