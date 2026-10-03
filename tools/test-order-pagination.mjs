import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';

const db=new DatabaseSync('work/qa/mobiup.sqlite'),root='http://127.0.0.1:3000/api/',token='synthetic-order-pagination-token',userId='pagination-agent';
const cookie=`mobiup_session=${token}`;let checks=0,requests=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
async function call(path,method='GET',body,expected=200){requests++;const response=await fetch(root+path,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const bytes=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(bytes);}catch{data=null;}assert.equal(response.status,expected,`${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0,500)}`);return {data,bytes:bytes.length};}
const payload=(i,status='finalized')=>{const createdAt=new Date(Date.UTC(2026,9,3-Math.floor(i/500),12)).toISOString();return {id:`page-${String(i).padStart(5,'0')}`,number:`PERF-${String(i).padStart(5,'0')}`,kind:i%4?'accessories':'sim',userId,agentName:'Agent sintetic paginare',warehouseId:'g-5',warehouseName:'Gestiune sintetică',status,items:[],serials:[],client:{id:`pc-${i}`,warehouseId:'g-5',name:i===9999?'Needle Deep 9999':`Client sintetic ${i}`,cui:`RO${String(i).padStart(8,'0')}`,city:'Oraș',county:'Județ',address:'Adresă',route:'R'},notes:'',createdAt,finalizedAt:status==='finalized'?createdAt:null,sourceOrderId:null,revision:1,total:i,pieces:i%20};};
function cleanup(){try{db.exec('BEGIN');db.prepare('DELETE FROM serials WHERE order_id IN (SELECT id FROM orders WHERE user_id=?)').run(userId);db.prepare('DELETE FROM orders WHERE user_id=?').run(userId);db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);db.prepare('DELETE FROM users WHERE id=?').run(userId);db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}}
try{
 db.exec('BEGIN');
 db.prepare("INSERT OR REPLACE INTO users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,password_hash,must_change_password,active) VALUES(?,?,?,'agent','assigned','g-5','Gestiune sintetică',?,0,1)").run(userId,'pagination.agent','Agent sintetic paginare','scrypt:'+'0'.repeat(32)+':'+'0'.repeat(64));
 db.prepare('INSERT OR REPLACE INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),userId,Date.now()+3600000);
 const insert=db.prepare('INSERT INTO orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,revision) VALUES(?,?,?,?,?,?,?,?,?,1)');
 for(let i=0;i<10000;i++){const order=payload(i,i%5?'finalized':'draft');insert.run(order.id,order.number,userId,'g-5',order.kind,order.status,JSON.stringify(order),order.createdAt,order.finalizedAt);}
 db.exec('COMMIT');

 requests=0;const session=await call('auth/session'),legacy=await call('bootstrap');
 ok(session.data.user.id===userId,'synthetic session is authenticated');ok(legacy.data.orders.length===10000&&legacy.data.products.length>0,'legacy bootstrap contract remains complete for old installed clients');
 requests=0;const newSession=await call('auth/session'),compact=await call('bootstrap?compact=1');
 ok(compact.data.orders.length<=40,'compact bootstrap order page is bounded');ok(!('products'in compact.data),'compact bootstrap does not read or return catalog');ok(compact.bytes<150000&&compact.bytes<legacy.bytes/20,'compact bootstrap bytes are bounded and materially below legacy');
 const compactStartup={requestCount:requests,totalBytes:newSession.bytes+compact.bytes};
 const beforeCatalogRequests=requests,catalog=await call('catalog');ok(catalog.data.products.length===legacy.data.products.length&&requests===beforeCatalogRequests+1,'catalog is fetched only by the explicit intent request');

 const first=(await call('orders?page=1&kind=all&status=all&range=all&limit=100')).data;
 let page=first,pageRequests=1;const all=[...page.orders];
 while(page.orderPage.nextCursor){page=(await call(`orders?page=1&kind=all&status=all&range=all&limit=100&revision=${encodeURIComponent(first.orderPage.revision)}&cursor=${encodeURIComponent(page.orderPage.nextCursor)}`)).data;all.push(...page.orders);pageRequests++;}
 ok(all.length===10000&&new Set(all.map(order=>order.id)).size===10000,'cursor pagination covers 10k orders without gaps or duplicates');
 ok(all.every((order,index)=>!index||all[index-1].createdAt>order.createdAt||all[index-1].createdAt===order.createdAt&&all[index-1].id>order.id),'equal timestamps use descending id as a stable tie-breaker');
 const staleFirst=(await call('orders?page=1&kind=all&status=all&range=all&limit=40')).data;db.prepare('UPDATE orders SET revision=revision+1 WHERE id=?').run('page-09999');
 await call(`orders?page=1&kind=all&status=all&range=all&limit=40&revision=${staleFirst.orderPage.revision}&cursor=${encodeURIComponent(staleFirst.orderPage.nextCursor)}`,'GET',undefined,409);checks++;
 const search=(await call('orders?page=1&kind=all&status=all&range=all&q=needle%20deep%209999')).data;ok(search.orderPage.total===1&&search.orders[0].id==='page-09999','server search covers records outside the loaded page');
 const drafts=(await call('orders?page=1&kind=all&status=draft&range=day&limit=40')).data;ok(drafts.orderPage.total===2000&&drafts.orders.every(order=>order.status==='draft'),'status/date filters cover the full server selection and retain drafts');
 const createdId=randomUUID(),created=(await call('orders','POST',{id:createdId,kind:'accessories',agentId:userId},201)).data.order;ok(created.id===createdId,'create remains available with paginated reads');
 const products=catalog.data.products.filter(product=>product.kind==='accessories');assert(products.length);const saved=(await call(`orders/${createdId}`,'PUT',{revision:created.revision,items:[{id:products[0].id,quantity:1}],serials:[],clientId:null,notes:'Synthetic pagination finalize'})).data.order;
 const finalized=(await call(`orders/${createdId}/finalize`,'POST',{revision:saved.revision})).data.order;ok(finalized.status==='finalized','finalize remains correct after compact bootstrap and lazy catalog');
 const deleteId=randomUUID(),deleteDraft=(await call('orders','POST',{id:deleteId,kind:'stands',agentId:userId},201)).data.order;await call(`orders/${deleteId}`,'DELETE',{revision:deleteDraft.revision});const deletedSearch=(await call(`orders?page=1&kind=all&status=all&range=all&q=${encodeURIComponent(deleteDraft.number)}`)).data;ok(deletedSearch.orderPage.total===0,'deleted drafts stay out of paginated search');

 mkdirSync('work/evidence',{recursive:true});
 const before=JSON.parse(readFileSync('work/evidence/t11-bootstrap-before.json','utf8'));
 const evidence={fixtureOrders:10000,before:{requestCount:before.requestCount,totalBytes:before.totalBytes,bootstrapBytes:before.requests.find(row=>row.path==='bootstrap').bytes,orders:before.requests.find(row=>row.path==='bootstrap').items,catalog:before.requests.find(row=>row.path==='bootstrap').catalog},after:{...compactStartup,bootstrapBytes:compact.bytes,orders:compact.data.orders.length,catalogIncluded:false,catalogIntentBytes:catalog.bytes},pagination:{pageRequests,rows:all.length,unique:new Set(all.map(order=>order.id)).size}};
 writeFileSync('work/evidence/t11-bootstrap-orders-after.json',JSON.stringify(evidence,null,2));
 console.log(`PASS: ${checks} compact bootstrap/order pagination checks.`,JSON.stringify(evidence));
}finally{cleanup();}
