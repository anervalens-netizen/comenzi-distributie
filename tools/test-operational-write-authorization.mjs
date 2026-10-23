// Real routes, Node SQLite adapter, revision triggers and a delayed HTTP body.
// Synthetic accounts and data only; no production endpoints or credentials.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

mkdirSync('work',{recursive:true});
const directory=mkdtempSync(resolve('work/operational-write-auth-'));
const previous=Object.fromEntries(['MOBIUP_DATA_DIR','MOBIUP_USAGE_DISABLED'].map(key=>[key,process.env[key]]));
process.env.MOBIUP_DATA_DIR=join(directory,'data');process.env.MOBIUP_USAGE_DISABLED='1';
let server,sql,checks=0;
try{
 const file=join(directory,'route.mjs');
 await build({stdin:{contents:"export * from './app/api/[...path]/route';export {env} from './lib/runtime';export {readCatalog} from './lib/catalog';export {weekKey} from './lib/server';",loader:'ts',resolveDir:resolve('.')},outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'actual-node-runtime',setup(build){
  build.onResolve({filter:/^#mobiup-/},args=>({path:resolve('lib/'+args.path.slice('#mobiup-'.length)+'-node.ts')}));
  build.onResolve({filter:/\.sql\?raw$/},args=>({path:resolve(args.path.replace(/^@\//,'').replace(/\?raw$/,'')),namespace:'raw'}));
  build.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));
 }}]});
 const route=await import(pathToFileURL(file)),db=route.env.DB;
 await db.prepare('SELECT 1').first();
 sql=new DatabaseSync(join(process.env.MOBIUP_DATA_DIR,'mobiup.sqlite'));sql.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');
 sql.prepare("INSERT OR IGNORE INTO settings VALUES('seed-v1','1')").run();
 const actors={agent:{role:'agent',scope:'assigned',warehouse:'synthetic-warehouse'},regional:{role:'manager',scope:'assigned',warehouse:null},global:{role:'manager',scope:'global',warehouse:null},other:{role:'agent',scope:'assigned',warehouse:'synthetic-other-warehouse'}};
 const tokens=Object.fromEntries(Object.keys(actors).map(id=>[id,'synthetic-session-'+id]));
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const prepare=db.prepare.bind(db),batch=db.batch.bind(db);
 const catalog=(await route.readCatalog()).products,product=catalog.find(product=>product.kind==='accessories');assert(product);
 const customer={id:'synthetic-customer',warehouseId:actors.agent.warehouse,warehouseIds:[actors.agent.warehouse],name:'Synthetic company',cui:'EXAMPLE',city:'Synthetic town',county:'Synthetic county',address:'Synthetic street 1',route:''};
 function reset(){
  rmSync(join(process.env.MOBIUP_DATA_DIR,'files','exports'),{recursive:true,force:true});
  sql.exec('DELETE FROM serials;DELETE FROM orders;DELETE FROM sessions;DELETE FROM manager_agents;DELETE FROM users;DELETE FROM customers;');
  sql.prepare("DELETE FROM settings WHERE key LIKE 'transfer-v1:%' OR key LIKE 'order-write-proof-v1:%'").run();
  for(const [id,actor]of Object.entries(actors)){
   sql.prepare('INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,?,?,?,?, ?,0,1,1)').run(id,id,'Synthetic '+id,actor.role,actor.scope,actor.warehouse,actor.warehouse?'Synthetic '+id+' warehouse':null,'not-a-credential');
   sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(tokens[id]),id,Date.now()+3600000);
  }
  sql.prepare('INSERT INTO manager_agents VALUES(?,?)').run('regional','agent');
  sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(customer.id,customer.warehouseId,JSON.stringify(customer));
 }
 function addOrder({id=randomUUID(),kind='accessories',status='draft',serials=[]}={}){
  const order={id,number:'SYN-'+id,userId:'agent',agentName:'Synthetic agent',warehouseId:actors.agent.warehouse,warehouseName:'Synthetic warehouse',kind,status,items:kind==='sim'?[]:[{...product,quantity:1}],serials,client:kind==='sim'?customer:null,notes:'Synthetic original',createdAt:'2026-10-01T12:00:00.000Z',finalizedAt:status==='finalized'?'2026-10-01T12:00:00.000Z':null,sourceOrderId:null,revision:1,total:kind==='sim'?0:product.price,pieces:kind==='sim'?serials.length:1};
  sql.prepare('INSERT INTO orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,week_key,revision) VALUES(?,?,?,?,?,?,?,?,?,?,1)').run(id,order.number,order.userId,order.warehouseId,kind,status,JSON.stringify(order),order.createdAt,order.finalizedAt,route.weekKey());
  if(status==='finalized')for(const serial of serials)sql.prepare('INSERT INTO serials VALUES(?,?)').run(serial,id);
  return order;
 }
 const request=(method,path,id,body)=>new Request('http://synthetic.invalid/api/'+path,{method,headers:{Cookie:'mobiup_session='+tokens[id],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function call(method,path,id,body){const response=await route[method](request(method,path,id,body));return {status:response.status,data:await response.json()};}
 function exportFiles(){const root=join(process.env.MOBIUP_DATA_DIR,'files');try{return readdirSync(root,{recursive:true}).filter(path=>path.endsWith('.xlsx')).sort((a,b)=>a.localeCompare(b));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
 const snapshot=()=>({orders:sql.prepare('SELECT * FROM orders ORDER BY id').all(),serials:sql.prepare('SELECT * FROM serials ORDER BY serial').all(),revision:sql.prepare('SELECT revision FROM order_list_revision WHERE id=1').get(),proofs:sql.prepare("SELECT * FROM settings WHERE key LIKE 'order-write-proof-v1:%'").all(),transfers:sql.prepare("SELECT * FROM settings WHERE key LIKE 'transfer-v1:%' OR key='transfer-mail-v1' ORDER BY key").all(),exports:exportFiles()});

 // Reproduce the independent audit with the authenticated handler already past
 // its order read, while the HTTP client intentionally leaves JSON unfinished.
 reset();const delayedOrder=addOrder();let observed;
 const authenticatedOrderRead=new Promise(resolve=>{observed=resolve;});
 db.prepare=query=>{
  const wrap=statement=>new Proxy(statement,{get(target,key){
   if(key==='bind')return(...args)=>wrap(target.bind(...args));
   if(key==='first'&&query==='SELECT * FROM orders WHERE id=?')return async(...args)=>{const value=await target.first(...args);observed();return value;};
   const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});return wrap(prepare(query));
 };
 server=createServer(async(incoming,outgoing)=>{
  try{
   const body=['GET','HEAD'].includes(incoming.method)?{}:{body:Readable.toWeb(incoming),duplex:'half'};
   const response=await route[incoming.method](new Request('http://127.0.0.1'+incoming.url,{method:incoming.method,headers:incoming.headers,...body}));
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch{outgoing.writeHead(500);outgoing.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;let stream;
 const pending=new Promise((resolve,reject)=>{
  stream=httpRequest(origin+'/api/orders/'+delayedOrder.id,{method:'PUT',headers:{Cookie:'mobiup_session='+tokens.agent,'Content-Type':'application/json'}},response=>{let text='';response.on('data',part=>text+=part);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(text)}));});stream.on('error',reject);stream.write('{');
 });
 await authenticatedOrderRead;
 const revocation=await call('POST','admin/users','regional',{action:'toggle',id:'agent',version:'1'});assert.equal(revocation.status,200);
 assert.equal(sql.prepare('SELECT active FROM users WHERE id=?').get('agent').active,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get('agent').n,0);
 const revoked=snapshot();stream.end('"revision":1,"items":[{"id":'+JSON.stringify(product.id)+',"quantity":1}],"notes":"Synthetic delayed mutation"}');
 const denied=await pending;db.prepare=prepare;
 assert.equal(denied.status,409,'revoked slow-body PUT is refused at its SQL write');assert.deepEqual(snapshot(),revoked,'revoked slow-body PUT has no persistent effect');checks++;

 // Change authority immediately before the actual SQLite mutation or batch.
 // This covers preparation awaits as well as the slow HTTP-body reproduction.
 const originalPrepare=prepare;
 let beforeMutation=null;
 const trip=()=>{const action=beforeMutation;beforeMutation=null;action?.();};
 db.prepare=query=>{
  const wrap=statement=>new Proxy(statement,{get(target,key){
   if(key==='bind')return(...args)=>wrap(target.bind(...args));
   if(key==='run'&&/^(UPDATE orders|INSERT OR IGNORE INTO orders|UPDATE settings SET value=|DELETE FROM settings WHERE key=|INSERT OR IGNORE INTO settings\(key,value\)|INSERT INTO settings\(key,value\) SELECT 'transfer-mail-v1')/.test(query))return async(...args)=>{trip();return target.run(...args);};
   const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});return wrap(originalPrepare(query));
 };
 db.batch=async statements=>{trip();return batch(statements);};
 function addTransfer(){
  const id=randomUUID(),target=id=>({agentId:id,agentName:'Synthetic '+id,warehouseId:actors[id].warehouse,warehouseName:'Synthetic warehouse'});
  const record={id,number:'TRF-SYN',source:target('agent'),destination:target('other'),createdBy:'agent',createdAt:'2026-10-01T12:00:00.000Z',updatedAt:'2026-10-01T12:00:00.000Z',finalizedAt:null,status:'draft',revision:1,lines:[],notes:'Synthetic original'};
  sql.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('transfer-v1:'+id,JSON.stringify(record));
  sql.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('transfer-mail-v1',?)").run(JSON.stringify({to:'distribution@example.invalid',managerEmails:{regional:'manager@example.invalid'}}));
  return record;
 }
 const operations={
  orderSave:()=>{const order=addOrder();return ['PUT','orders/'+order.id,{revision:1,items:[{id:product.id,quantity:2}],notes:'Synthetic changed'}];},
  orderCreate:()=>['POST','orders',{id:randomUUID(),kind:'accessories',agentId:'agent'}],
  orderCopy:()=>{const order=addOrder();return ['POST','orders',{id:randomUUID(),kind:'accessories',agentId:'agent',sourceOrderId:order.id}];},
  orderDelete:()=>{const order=addOrder();return ['DELETE','orders/'+order.id,{revision:1}];},
  orderFinalize:()=>{const order=addOrder();return ['POST','orders/'+order.id+'/finalize',{revision:1}];},
  transferCreate:()=>['POST','transfers',{id:randomUUID(),sourceAgentId:'agent'}],
  transferSave:()=>{const record=addTransfer();return ['PUT','transfers/'+record.id,{revision:1,destinationAgentId:'other',lines:[{id:product.id,quantity:2,serials:[]}],notes:'Synthetic changed'}];},
  transferDelete:()=>{const record=addTransfer();return ['DELETE','transfers/'+record.id,{revision:1}];},
  transferFinalize:()=>{const record=addTransfer();return ['POST','transfers/'+record.id+'/finalize',{revision:1,destinationAgentId:'other',lines:[{id:product.id,quantity:2,serials:[]}],notes:'Synthetic changed'}];},
  transferConfig:()=>['PUT','transfers/config',{to:'new-distribution@example.invalid'}],
 };
 const revocations={
  inactive:id=>sql.prepare('UPDATE users SET active=0 WHERE id=?').run(id),
  logout:id=>sql.prepare('DELETE FROM sessions WHERE user_id=?').run(id),
  expired:id=>sql.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(id),
  role:id=>sql.prepare("UPDATE users SET role=CASE role WHEN 'agent' THEN 'manager' ELSE 'agent' END WHERE id=?").run(id),
  profile:id=>sql.prepare('UPDATE users SET profile_revision=profile_revision+1 WHERE id=?').run(id),
 };
 for(const [name,operation] of Object.entries(operations)){
  const actor=name==='transferConfig'?'global':'agent';
  for(const [reason,revoke]of Object.entries(revocations)){
   reset();const [method,path,body]=operation();let atWrite;
   beforeMutation=()=>{revoke(actor);atWrite=snapshot();};
   const result=await call(method,path,actor,body);
   assert.equal(beforeMutation,null,`${name}/${reason} reached a real mutation`);
   assert.equal(result.status,409,`${name}/${reason}: ${JSON.stringify(result)}`);
   const after=snapshot();
   // A finalization prepares its export before the guard; rejection removes it.
   assert.deepEqual({...after,exports:[]},{...atWrite,exports:[]},`${name}/${reason} persisted no business changes`);
   assert.deepEqual(after.exports,[],`${name}/${reason} leaves no export`);checks++;
  }
  reset();const [method,path,body]=operation();const result=await call(method,path,actor,body);
  assert(result.status>=200&&result.status<300,`${name} valid operation: ${JSON.stringify(result)}`);checks++;
 }
 for(const name of ['orderSave','orderCreate','orderCopy','orderDelete','orderFinalize']){
  reset();const [method,path,body]=operations[name]();let atWrite;
  beforeMutation=()=>{sql.prepare('DELETE FROM manager_agents WHERE manager_id=?').run('regional');atWrite=snapshot();};
  const result=await call(method,path,'regional',body);assert.equal(result.status,409,`${name} removed assignment`);
  assert.deepEqual({...snapshot(),exports:[]},{...atWrite,exports:[]});checks++;
 }
 // Transfer managers intentionally retain national write authority.
 for(const name of ['transferCreate','transferSave','transferDelete','transferFinalize']){
  reset();sql.prepare('DELETE FROM manager_agents').run();const [method,path,body]=operations[name]();
  const result=await call(method,path,'regional',body);assert.equal(result.status,200,`${name} national manager access: ${JSON.stringify(result)}`);checks++;
 }
 for(const change of [()=>sql.prepare("UPDATE users SET manager_scope='assigned' WHERE id='global'").run(),()=>sql.prepare("UPDATE users SET must_change_password=1 WHERE id='global'").run()]){
  reset();const [method,path,body]=operations.transferConfig();let atWrite;beforeMutation=()=>{change();atWrite=snapshot();};
  const result=await call(method,path,'global',body);assert.equal(result.status,409);assert.deepEqual(snapshot(),atWrite);checks++;
 }

 // A competing finalization at the same next revision must not authorize this
 // request's serial inserts; only its own successful CAS can do so.
 reset();const sim=addOrder({kind:'sim',serials:['893900000000000001']});let concurrent;
 beforeMutation=()=>{
  const changed={...sim,status:'finalized',revision:2,serials:['893900000000000002']};
  sql.prepare("UPDATE orders SET status='finalized',revision=2,payload=? WHERE id=?").run(JSON.stringify(changed),sim.id);
  sql.prepare('INSERT INTO serials VALUES(?,?)').run(changed.serials[0],sim.id);concurrent=snapshot();
 };
 const raced=await call('POST','orders/'+sim.id+'/finalize','agent',{revision:1});
 assert.equal(raced.status,200);assert.deepEqual({...snapshot(),exports:[]},{...concurrent,exports:[]});assert.deepEqual(snapshot().exports,[]);checks++;
 reset();const toDelete=addOrder({kind:'sim',status:'finalized',serials:['893900000000000003']});
 beforeMutation=()=>{sql.prepare("UPDATE orders SET status='deleted',revision=2 WHERE id=?").run(toDelete.id);concurrent=snapshot();};
 const racedDelete=await call('DELETE','orders/'+toDelete.id,'global',{revision:1});
 assert.equal(racedDelete.status,409);assert.deepEqual(snapshot(),concurrent,'failed delete CAS cannot clean another write\'s serials');checks++;
 reset();const validSim=addOrder({kind:'sim',serials:['893900000000000004']});
 const finalized=await call('POST','orders/'+validSim.id+'/finalize','agent',{revision:1});assert.equal(finalized.status,200,JSON.stringify(finalized));
 assert.equal(sql.prepare('SELECT order_id FROM serials WHERE serial=?').get(validSim.serials[0]).order_id,validSim.id);assert.equal(snapshot().proofs.length,0);checks++;
 reset();const createId=randomUUID();
 const creates=await Promise.all([call('POST','orders','agent',{id:createId,kind:'accessories'}),call('POST','orders','agent',{id:createId,kind:'accessories'})]);
 assert(creates.every(result=>[200,201].includes(result.status)),JSON.stringify(creates));assert.equal(sql.prepare('SELECT COUNT(*) n FROM orders WHERE id=?').get(createId).n,1);checks++;
 db.prepare=prepare;db.batch=batch;
 console.log(`PASS: ${checks} operational mutation authorization checks with actual HTTP and SQLite.`);
}finally{
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 sql?.close();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 rmSync(directory,{recursive:true,force:true});
}
