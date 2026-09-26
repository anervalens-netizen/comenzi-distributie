import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const folder=resolve('work/stock-qa-20260914');
const db=new DatabaseSync(resolve(folder,'mobiup.sqlite'));
assert(db.prepare("SELECT id FROM users WHERE id='stock-manager' AND username='stock-manager'").get(),'Dedicated QA fixture required');
const previous=db.prepare("SELECT value FROM settings WHERE key='catalog'").get();
db.prepare("DELETE FROM settings WHERE key='catalog'").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory-ean-v1',?)").run(JSON.stringify({'6425700075877':'DEMOACC2'}));
const {password}=JSON.parse(readFileSync(resolve(folder,'credentials.json'),'utf8'));
let checks=0;
const check=(x,label)=>{assert(x,label);checks++;};
async function req(path,cookie,method='GET',body,status=200){
 const r=await fetch('http://127.0.0.1:3014/api/'+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(data)}`);checks++;return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
try{
const login=async username=>(await req('auth/login',null,'POST',{username,password})).cookie;
const manager=await login('stock-manager'),agent=await login('stock-agent'),other=await login('stock-agent2');
await req('inventory',null,'GET',null,401);
await req('inventory?warehouseId=g-3',agent,'GET',null,403);
const products=(await req('admin/products',manager)).data.products;
const p=products.find(p=>p.code==='DEMOACC2');check(p.ean==='6425700075877','Imported EAN shown');
await req('admin/products/'+p.id,agent,'PUT',p,403);
await req('admin/products/'+p.id,manager,'PUT',{...p,ean:'123'},400);
await req('admin/products/'+p.id,manager,'PUT',{...p,ean:'6425700075878'},400);
const otherProduct=products.find(q=>q.code!==p.code&&q.kind==='accessories');
await req('admin/products/'+otherProduct.id,manager,'PUT',{...otherProduct,ean:p.ean},409);
let updated=(await req('admin/products/'+p.id,manager,'PUT',{...p,ean:'012345678905'})).data.products.find(q=>q.id===p.id);
check(updated.ean==='012345678905','Leading zero preserved');
await req('admin/products/'+p.id,manager,'PUT',p,409);
updated=(await req('admin/products/'+p.id,manager,'PUT',{...updated,ean:p.ean})).data.products.find(q=>q.id===p.id);
const start={id:crypto.randomUUID(),warehouseId:'g-5',scope:'all',value:''};
let inv=(await req('inventory',agent,'POST',start)).data.inventory;
check(inv.lines.length===2&&inv.lines.every(l=>l.counted===null),'Uncounted null');
check((await req('inventory',agent,'POST',start)).data.inventory.id===inv.id,'Creation idempotent');
await req('inventory/'+inv.id,other,'GET',null,404);
check((await req('inventory/'+inv.id,manager)).data.inventory.canEdit,'Manager can edit draft');
const op=(action,extra={})=>({revision:inv.revision,operationId:crypto.randomUUID(),action,...extra});
inv=(await req('inventory/'+inv.id,manager,'PATCH',op('set',{code:'ERP-ONLY',quantity:0}))).data.inventory;
check(inv.lines.find(l=>l.code==='ERP-ONLY').counted===0,'Manager edit is applied');
await req('inventory/'+inv.id,agent,'PATCH',op('scan',{ean:'123'}),422);
await req('inventory/'+inv.id,agent,'PATCH',op('scan',{ean:'4006381333931'}),422);
await req('inventory/'+inv.id,agent,'PATCH',op('finalize'),409);
const scan=op('scan',{ean:p.ean,quantity:2});
inv=(await req('inventory/'+inv.id,agent,'PATCH',scan)).data.inventory;
check(inv.lines.find(l=>l.code===p.code).counted===2,'Scan counts two');
inv=(await req('inventory/'+inv.id,agent,'PATCH',scan)).data.inventory;
check(inv.lines.find(l=>l.code===p.code).counted===2,'Retry never double counts');
await req('inventory/'+inv.id,agent,'PATCH',{...scan,quantity:3},409);
await req('inventory/'+inv.id,agent,'PATCH',{...op('scan',{ean:p.ean}),revision:1},409);
for(const quantity of [-1,1.5,'',null])await req('inventory/'+inv.id,agent,'PATCH',op('set',{code:'ERP-ONLY',quantity}),400);
inv=(await req('inventory/'+inv.id,agent,'PATCH',op('set',{code:'ERP-ONLY',quantity:0}))).data.inventory;
check(inv.lines.find(l=>l.code==='ERP-ONLY').counted===0,'Explicit zero kept');
const stockRaw=db.prepare("SELECT value FROM settings WHERE key='agent-stock-v1'").get().value;
const stock=JSON.parse(stockRaw);stock.warehouses['g-5'].rows[0].quantity=999;
db.prepare("UPDATE settings SET value=? WHERE key='agent-stock-v1'").run(JSON.stringify(stock));
try{check((await req('inventory/'+inv.id,agent)).data.inventory.lines.find(l=>l.code===p.code).expected===12,'Frozen baseline');}
finally{db.prepare("UPDATE settings SET value=? WHERE key='agent-stock-v1'").run(stockRaw);}
inv=(await req('inventory/'+inv.id,agent,'PATCH',op('set',{code:p.code,quantity:7}))).data.inventory;
inv=(await req('inventory/'+inv.id,agent,'PATCH',op('set',{code:'ERP-ONLY',quantity:5}))).data.inventory;
inv=(await req('inventory/'+inv.id,agent,'PATCH',op('finalize'))).data.inventory;
check(inv.status==='finalized'&&!inv.canEdit,'Finalized readonly');
const activity=(await req(`activity/team?month=${inv.createdAt.slice(0,7)}`,manager)).data;
const activityAgent=activity.agents.find(item=>item.agentId==='stock-agent');
const expectedDelta=inv.lines.reduce((sum,line)=>sum+(line.counted??0)-line.expected,0);
check(activityAgent.inventories===1&&activityAgent.finalizedInventories===1&&activityAgent.latestInventory.id===inv.id,'Manager activity includes the agent finalized inventory');
check(expectedDelta===0&&activityAgent.latestInventory.delta===0&&activity.totals.inventoryDelta===0,'Signed inventory delta can be zero');
check(activityAgent.latestInventory.shortage===5&&activityAgent.latestInventory.surplus===5&&activityAgent.latestInventory.discrepantLines===2,'Latest inventory keeps shortages and surpluses separate when signed delta cancels');
check(activity.totals.inventoryShortage===5&&activity.totals.inventorySurplus===5&&activity.totals.inventoryDiscrepantLines===2,'Manager totals never turn compensating discrepancies into OK');
const boundaryInventory=(await req('inventory',agent,'POST',{id:crypto.randomUUID(),warehouseId:'g-5',scope:'product',value:'ERP-ONLY'})).data.inventory;
const boundaryKey=`inventory-v1:${boundaryInventory.id}`,boundaryRow=db.prepare('SELECT value FROM settings WHERE key=?').get(boundaryKey),boundaryRecord=JSON.parse(boundaryRow.value);boundaryRecord.createdAt='2026-08-31T21:30:00.000Z';db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(boundaryRecord),boundaryKey);
const augustActivity=(await req('activity/team?month=2026-08',manager)).data.agents.find(item=>item.agentId==='stock-agent');
const septemberActivity=(await req('activity/team?month=2026-09',manager)).data.agents.find(item=>item.agentId==='stock-agent');
check(augustActivity.inventories===0&&septemberActivity.inventories>=2,'Inventory at 1 September 00:30 Bucharest belongs only to September');
await req('inventory/'+boundaryInventory.id,agent,'PATCH',{revision:boundaryInventory.revision,operationId:crypto.randomUUID(),action:'cancel'});
await req('inventory/'+inv.id,agent,'PATCH',op('scan',{ean:p.ean}),409);
const staleDeleteStart=(await req('inventory',agent,'POST',{id:crypto.randomUUID(),warehouseId:'g-5',scope:'product',value:'ERP-ONLY'})).data.inventory;
const staleDeleteRevision=staleDeleteStart.revision;
let staleDelete=(await req('inventory/'+staleDeleteStart.id,agent,'PATCH',{revision:staleDeleteStart.revision,operationId:crypto.randomUUID(),action:'set',code:'ERP-ONLY',quantity:0})).data.inventory;
staleDelete=(await req('inventory/'+staleDelete.id,agent,'PATCH',{revision:staleDelete.revision,operationId:crypto.randomUUID(),action:'finalize'})).data.inventory;
await req('inventory/'+staleDelete.id,manager,'DELETE',{revision:staleDeleteRevision},409);
check((await req('inventory/'+staleDelete.id,manager)).data.inventory.status==='finalized','Stale delete cannot remove a newer finalized inventory');
await req('inventory/'+staleDelete.id,manager,'DELETE',{revision:staleDelete.revision});
await req('inventory/'+staleDelete.id,manager,'GET',null,404);
for(const [scope,value] of [['product','ERP-ONLY'],['category','Necategorizate']]){
 const scoped=(await req('inventory',agent,'POST',{id:crypto.randomUUID(),warehouseId:'g-5',scope,value})).data.inventory;
 check(scoped.lines.length===1&&scoped.lines[0].code==='ERP-ONLY','Scope respected');
 await req('inventory/'+scoped.id,agent,'PATCH',{revision:1,operationId:crypto.randomUUID(),action:'scan',ean:p.ean},422);
 const cancel=(await req('inventory/'+scoped.id,agent,'PATCH',{revision:1,operationId:crypto.randomUUID(),action:'cancel'})).data.inventory;
 check(cancel.status==='cancelled'&&!cancel.canEdit,'Cancelled readonly');
}
console.log(`PASS: ${checks} inventory, EAN, authorization and concurrency checks.`);
}finally{
 if(previous)db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('catalog',?)").run(previous.value);
 else db.prepare("DELETE FROM settings WHERE key='catalog'").run();
 db.close();
}