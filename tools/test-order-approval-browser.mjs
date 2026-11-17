import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { browserFixture, waitFor } from './offline-browser-fixture.mjs';

const source = String.raw`
import { createRoot } from 'react-dom/client';
import App from './app/distribution-app';
import { setLocalWorkUserId } from './lib/local-work';
import { orderLimitViolations } from './lib/order-limits';

const agent = {id:'synthetic-agent',role:'agent',name:'Synthetic agent',warehouseId:'w',warehouseName:'Synthetic warehouse',managerScope:'assigned',profileVersion:'1',active:1,mustChangePassword:false};
const manager = {id:'synthetic-manager',role:'manager',name:'Synthetic manager',warehouseId:null,warehouseName:null,managerScope:'assigned',profileVersion:'1',active:1,mustChangePassword:false,managedAgentIds:[agent.id]};
const product = {id:'charger',code:'TEST-CHARGER',name:'Synthetic charger',category:'Încărcătoare',kind:'accessories',brand:'Synthetic',price:10,netPrice:8,sourceRow:1,image:null};
const sim = {id:'prepaid',code:'TEST-PREPAID',name:'Synthetic prepaid SIM',category:'Cartele',kind:'stands',brand:'Synthetic',price:null,netPrice:null,sourceRow:2,image:null};
const peer = {...product,id:'charger-peer',code:'  test-charger ',name:'Synthetic catalog peer',category:'Promoționale',sourceRow:3};
const products = [product,peer,sim];
const date = new Date().toISOString();
const orderId = '10000000-0000-0000-0000-000000000001';
const approvalId = '20000000-0000-0000-0000-000000000001';
const record = (id,number,kind) => ({id,number,kind,userId:agent.id,agentName:agent.name,warehouseId:'w',warehouseName:'Synthetic warehouse',status:'draft',items:[{...product,quantity:1}],standItems:[],serials:[],client:null,notes:'',createdAt:date,finalizedAt:null,sourceOrderId:null,revision:1,total:10,pieces:1});
const order = {...record(orderId,'TEST-COMBINED','combined'),items:[{...product,quantity:4},{...peer,quantity:4}],pieces:8,total:80};
const legacy = record('10000000-0000-0000-0000-000000000002','TEST-LEGACY','accessories');
const fixture = window.fixture = {
  user:agent, order, approval:null, requests:[], read:{}, edits:0, failLimits:false,
  switch(role){
    this.user=role==='manager'?manager:agent;
    setLocalWorkUserId(this.user.id);
    window.dispatchEvent(new StorageEvent('storage',{key:'mobiup-work-user-v1'}));
  },
};
const period={from:'2026-08',to:'2026-10'};
const metrics=[
  {productId:product.id,code:product.code,name:product.name,salesQuantity:null,floor:10,limit:10,source:'unavailable',period},
  {productId:peer.id,code:peer.code,name:peer.name,salesQuantity:null,floor:10,limit:10,source:'unavailable',period},
  {productId:sim.id,code:sim.code,name:sim.name,salesQuantity:null,floor:250,limit:250,source:'unavailable',period},
];
function limits(order) {
  const violations=orderLimitViolations(order,metrics);
  return {enabled:true,orderId:order.id,revision:order.revision,period,products:metrics,violations,request:order===fixture.order?approv(fixture.user.id):null};
}
function approv(owner){
  const a=fixture.approval;
  if (!a) return null;
  const status=a.orderRevision===fixture.order.revision?a.status:'superseded';
  return {...a,status,canDecide:status==='pending'&&owner===manager.id};
}
function feed(owner){
  const approval=approv(owner);
  const visible=approval&&(owner===manager.id||approval.status==='approved'||approval.status==='rejected');
  const rows=visible?[{id:'30000000-0000-0000-0000-000000000001',category:'order',
    title:'Synthetic order confirmation',body:'Synthetic approval for TEST-COMBINED',targetType:'order-approval',
    targetId:approvalId,createdAt:date,readAt:fixture.read[owner]||null}]:[];
  const unread=rows.filter(row=>!row.readAt).length;
  return {items:rows,unread,categoryUnread:unread,total:rows.length,hasMore:false};
}
window.fetch=async(input,init={})=>{
  const path=new URL(String(input),location.origin).pathname.replace('/api/','');
  const owner=new Headers(init.headers).get('X-Operation-User')||fixture.user.id;
  const method=init.method||'GET';
  const body=init.body?JSON.parse(init.body):null;
  fixture.requests.push({path,owner,method,body});
  const draft=path.includes(legacy.id)?legacy:fixture.order;
  const json=(value,status=200)=>Response.json(value,{status});
  if(path==='auth/session')return json({user:fixture.user});
  if(path==='bootstrap'||path==='orders')return json({user:fixture.user,users:[agent,manager],warehouses:[{id:'w',name:'Synthetic warehouse'}],orders:[fixture.order,legacy],products,weekKey:'2026-11-16'});
  if(path==='catalog')return json({products});
  if(path==='notifications/feed')return json(feed(owner));
  if(path==='notifications/read'){fixture.read[owner]=date;return json(feed(owner));}
  if(path.startsWith('stock'))return json({warehouseId:'w',rows:[],depot:{},warehouses:[]});
  if(path==='manager/activity')return json({activity:{totals:{finalizedInventories:0},agents:[],partnerRequests:[]},confirmed:0,confirmedByAgent:{},finalizedOrders:0,finalizedNotices:0});
  if(path==='order-limit-approvals'){
    const status=new URL(String(input),location.origin).searchParams.get('status');
    const request=approv(owner);
    return json({items:request&&(!status||request.status===status)?[request]:[],hasMore:false});
  }
  if(path==='order-limit-approvals/'+approvalId)return json({request:approv(owner)});
  if(path==='order-limit-approvals/'+approvalId+'/decision'){
    if(owner!==manager.id||body.revision!==fixture.approval.revision||approv(owner).status!=='pending')return json({error:'Conflict'},409);
    Object.assign(fixture.approval,{status:body.decision,revision:fixture.approval.revision+1,comment:body.comment||'',decidedByName:manager.name,decidedAt:date});
    return json({request:approv(owner)});
  }
  if(path==='orders/'+draft.id+'/limits')return fixture.failLimits?json({error:'Synthetic limits error'},503):json(limits(draft));
  if(path==='orders/'+draft.id+'/limit-approval'){
    if(owner!==agent.id||body.revision!==draft.revision||!limits(draft).violations.length)return json({error:'Invalid approval'},409);
    fixture.approval={id:approvalId,orderId:draft.id,orderNumber:draft.number,agentId:agent.id,agentName:agent.name,
      orderRevision:draft.revision,revision:1,status:'pending',reason:body.reason||'',comment:'',decidedByName:null,decidedAt:null,
      createdAt:date,updatedAt:date,violations:limits(draft).violations,canDecide:false};
    return json({request:approv(owner)});
  }
  if(path==='orders/'+draft.id+'/finalize'){
    if(fixture.approval?.status!=='approved'||body.revision!==fixture.approval?.orderRevision)return json({error:'Approval required'},409);
    draft.status='finalized';return json({order:draft});
  }
  if(path==='orders/'+draft.id){
    if(method==='PUT'){
      if(body.revision!==draft.revision)return json({error:'Conflict'},409);
      const items=body.items.map(i=>({...products.find(p=>p.id===i.id),quantity:i.quantity}));
      if(JSON.stringify(items)!==JSON.stringify(draft.items)||body.notes!==draft.notes){
        Object.assign(draft,{items,notes:body.notes,revision:draft.revision+1,total:items.reduce((n,i)=>n+i.quantity*i.price,0),pieces:items.reduce((n,i)=>n+i.quantity,0)});
        fixture.edits++;
      }
    }
    return json({order:draft});
  }
  return json({});
};
createRoot(document.getElementById('root')).render(<App/>);
`;
const bundle=await build({
  stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},
  write:false,outdir:'out',bundle:true,format:'esm',platform:'browser',jsx:'automatic',
  alias:{'next/image':resolve('tools/offline-image.tsx')},
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',
});
const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css=bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
const server=createServer((req,res)=>{
  const script=req.url==='/fixture.js';
  res.setHeader('Content-Type',script?'text/javascript':'text/html');
  res.end(script?js:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js" type="module"></script>`);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
let browser;
try {
  browser=await browserFixture('http://127.0.0.1:'+server.address().port);
  const evaluate=browser.evaluate;
  const wait=(expr,label)=>waitFor(()=>evaluate(expr),label);
  const click=(selector)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const button=(text,scope='body')=>evaluate(`[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(node=>node.textContent.trim().includes(${JSON.stringify(text)})).click()`);
  const setQuantity=qty=>evaluate(`(()=>{
    const input=document.querySelector('.product-card input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(qty))});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  const finalizedDisabled="document.querySelector('.review-dialog .dialog-actions .primary')?.disabled";
  await wait("document.querySelectorAll('.order-link').length===2",'both synthetic drafts visible');
  await evaluate('fixture.failLimits=true');
  await button('TEST-LEGACY','.orders-table');
  await wait("document.querySelector('.cart .order-limit-controls [role=alert]')?.textContent==='Synthetic limits error'",'starting limits failure is visible');
  await button('Verifică comanda','.cart');
  await wait(finalizedDisabled,'review fails closed before a valid limits response');
  assert.equal(await evaluate("document.querySelector('.review-dialog .order-limit-title')?.textContent.includes('Comanda este în limite')"),false);
  await evaluate('fixture.failLimits=false');
  await button('Actualizează starea','.review-dialog');
  await wait(`(${finalizedDisabled})===false`,'manual retry enables authoritative no-violation review');
  await wait("document.querySelector('.product-card .order-limit-quantity')?.textContent.includes('10 buc.')",'single order editor displays its SKU cap');
  await button('Înapoi la editare','.review-dialog');
  await click('.editor-top .back-link');
  await wait("document.querySelectorAll('.order-link').length===2",'returns to order history');
  await button('TEST-COMBINED','.orders-table');
  await wait("document.querySelector('.product-card .order-limit-quantity')?.textContent .includes('10 buc.')",'combined editor displays its SKU cap');
  await setQuantity(7);
  await wait("document.querySelector('.product-card .order-limit-quantity-exceeded')?.textContent.includes('Depășită cu 1')",'warning updates before server save');
  assert.equal(await evaluate('fixture.edits'),0,'warning was derived immediately from the loaded SKU policy');
  assert.equal(await evaluate("document.querySelectorAll('.product-card .order-limit-quantity-exceeded').length"),2,'Capped product and uncapped-category peer show their aggregate code violation');
  assert.equal(await evaluate("document.querySelector('.cart .order-limit-violations li')?.textContent.includes('11 solicitate')"),true,'One normalized code has one summed exception');
  await button('Solicită confirmarea managerului','.cart');
  await wait("document.querySelector('.cart .order-limit-title')?.textContent.includes('În așteptarea managerului')",'saved draft waits for a decision');
  const submitted=await evaluate("fixture.requests.filter(req=>req.path.endsWith('/limit-approval')||req.method==='PUT')");
  const before=submitted.at(-2), after=submitted.at(-1);
  assert.equal(before.method,'PUT');
  assert.deepEqual(before.body.items.map(line=>line.quantity),[7,4]);
  assert.equal(after.body.revision,before.body.revision+1,'Approval targets the newly persisted revision');
  await button('Verifică comanda','.cart');
  await wait(finalizedDisabled,'review modal blocks pending draft finalization');
  assert.equal(await evaluate("fixture.requests.filter(req=>req.path.endsWith('/limit-approval')).length"),1,'Review does not create a duplicate request');

  await evaluate("fixture.switch('manager')");
  await wait("document.querySelector('.profile strong')?.textContent==='Synthetic manager'&&!!document.querySelector('.request-count')",'manager receives approval notice');
  await click('.request-bell');
  await wait("document.querySelector('.notification-dialog .notification-row strong')?.textContent==='Synthetic order confirmation'",'manager notification is actionable');
  await button('Deschide','.notification-dialog');
  await wait("document.querySelector('.order-approvals h1')?.textContent==='Confirmare comandă'&&document.querySelector('.order-limit-violations')?.textContent.includes('11 solicitate')",'notification deep-links to exact snapshot');
  await button('Aprobă versiunea solicitată','.order-approvals');
  await wait("document.querySelector('.order-approval-state')?.textContent==='Confirmare aprobată'",'manager approval reflected');
  const decision=await evaluate("fixture.requests.find(req=>req.path.endsWith('/decision'))");
  assert.deepEqual(decision.body,{revision:1,decision:'approved'});
  await button('Înapoi','.order-approvals');
  await wait("document.querySelector('.order-approvals h1')?.textContent==='Confirmări comenzi'",'approval list remains reachable');
  assert.equal(await evaluate("document.querySelector('.order-approvals select').value"),'pending');

  await evaluate("fixture.switch('agent')");
  await wait("document.querySelector('.profile strong')?.textContent==='Synthetic agent'&&!!document.querySelector('.request-count')",'agent receives result');
  await click('.request-bell');
  await wait("document.querySelector('.notification-dialog .notification-row strong')?.textContent==='Synthetic order confirmation'",'agent sees approval result notification');
  await button('Deschide','.notification-dialog');
  await wait("document.querySelector('.order-approval-state')?.textContent==='Confirmare aprobată'",'agent reads confirmed version');
  assert.equal(await evaluate("[...document.querySelectorAll('.order-approvals button')].some(b=>b.textContent.includes('Aprobă'))"),false,'agent detail has no decision action');
  await button('Deschide comanda','.order-approvals');
  await wait("document.querySelector('.cart .order-limit-title')?.textContent.includes('Confirmare aprobată')",'approved draft opens from agent decision');
  await button('Verifică comanda','.cart');
  await wait(`(${finalizedDisabled})===false`,'review allows exact approved revision after unchanged save');
  await button('Înapoi la editare','.review-dialog');
  await setQuantity(8);
  await wait("document.querySelector('.cart .order-limit-title')?.textContent.includes('Este necesară confirmarea managerului')",'local editable changes invalidate approved indication immediately');
  await button('Verifică comanda','.cart');
  await wait(finalizedDisabled,'review blocks updated draft');
  assert.equal(await evaluate("fixture.requests.some(req=>req.path.endsWith('/finalize'))"),false,'Neither pending nor edited draft was sent to finalization');
  // The review can be visible while save/revalidation is still in flight. Chrome
  // silently ignores .click() on a disabled button, masking the original race.
  await wait("[...document.querySelectorAll('.review-dialog button')].some(node=>node.textContent.includes('Solicită confirmarea managerului')&&!node.disabled)",'updated draft approval action is ready');
  const approvalPostsBefore=await evaluate("fixture.requests.filter(req=>req.path.endsWith('/limit-approval')).length");
  await button('Solicită confirmarea managerului','.review-dialog');
  await wait(`fixture.requests.filter(req=>req.path.endsWith('/limit-approval')).length===${approvalPostsBefore+1}`,'updated draft approval was submitted');
  await wait("document.querySelector('.review-dialog .order-limit-title')?.textContent.includes('În așteptarea managerului')",'updated draft creates a new pending request');
  await evaluate("Object.assign(fixture.approval,{status:'rejected',comment:'Synthetic manager feedback',decidedByName:'Synthetic manager',decidedAt:fixture.order.createdAt})");
  await button('Actualizează starea','.review-dialog');
  await wait("document.querySelector('.review-dialog .order-limit-title')?.textContent.includes('Confirmare respinsă')",'manual refresh surfaces the rejection');
  assert.equal(await evaluate("document.querySelector('.review-dialog .order-limit-controls')?.textContent.includes('Synthetic manager feedback')"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('.review-dialog button')].some(node=>node.textContent.includes('Solicită confirmarea managerului'))"),false,'The same rejected snapshot cannot create another request');
  console.log('PASS: SKU thresholds in both editors, failed-load retry, immediate normalized-code warnings, save-before-request, scoped approval navigation, exact-revision review and stale-approval refusal');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(done=>server.close(done));
}
