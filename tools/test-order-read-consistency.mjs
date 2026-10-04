// Exercise the real route and revision triggers with deterministic interleavings.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
mkdirSync('work',{recursive:true});const directory=mkdtempSync(resolve('work/order-read-consistency-'));
const previous=process.env.MOBIUP_DATA_DIR;process.env.MOBIUP_DATA_DIR=join(directory,'data');
let checks=0;
try{
 const file=join(directory,'route.mjs');
 await build({stdin:{contents:"export * from './app/api/[...path]/route';export {env} from './lib/runtime';",loader:'ts',resolveDir:resolve('.')},outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'node-runtime',setup(b){b.onResolve({filter:/^#mobiup-/},args=>({path:resolve('lib/'+args.path.slice('#mobiup-'.length)+'-node.ts')}));b.onResolve({filter:/\.sql\?raw$/},args=>({path:resolve(args.path.replace(/^@\//,'').replace(/\?raw$/,'')),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));}}]});
 const route=await import(pathToFileURL(file)),db=route.env.DB;
 await db.prepare('SELECT 1').first();
 for(const [id,role] of [['agent','agent'],['other','agent'],['manager','manager']]){
  await db.prepare("INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,active) VALUES(?,?,?,?,'assigned','w','not-a-credential',0,1)").bind(id,id,'Synthetic '+id,role).run();
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(createHash('sha256').update('synthetic-'+id).digest('hex'),id,Date.now()+3600000).run();
 }
 const order=(id,userId)=>({id,number:'Synthetic '+id,userId,agentName:'Synthetic',warehouseId:'w',warehouseName:'Synthetic',kind:'stands',status:'draft',items:[],serials:[],client:null,notes:'',createdAt:'2026-10-01T12:00:00Z',finalizedAt:null,revision:1,total:0,pieces:0});
 for(const [id,user] of [['a','agent'],['b','agent'],['c','other']]){const o=order(id,user);await db.prepare('INSERT INTO orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,revision) VALUES(?,?,?,?,?,?,?,?,1)').bind(id,o.number,user,'w',o.kind,o.status,JSON.stringify(o),o.createdAt).run();}
 const prepare=db.prepare.bind(db);
 const intercept=after=>{const wrap=statement=>new Proxy(statement,{get(target,key){if(key==='bind')return(...args)=>wrap(target.bind(...args));if(key==='first'||key==='all')return async(...args)=>{const result=await target[key](...args);await after(target.sql);return result;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});db.prepare=sql=>wrap(prepare(sql));};
 const revision=async()=>String((await prepare('SELECT revision FROM order_list_revision WHERE id=1').first()).revision);
 const call=async(params='',user='agent')=>{const response=await route.GET(new Request('http://localhost/api/orders?page=1&kind=all&range=all&limit=1'+params,{headers:{Cookie:'mobiup_session=synthetic-'+user}}));return {status:response.status,data:await response.json()};};
 const reset=()=>prepare("UPDATE orders SET status='draft',revision=revision+1 WHERE id='b'").run();
 const mutate=()=>prepare("UPDATE orders SET status=CASE status WHEN 'deleted' THEN 'draft' ELSE 'deleted' END,revision=revision+1 WHERE id='b'").run();
 // Hook the adapter only, after SQLite has computed each selected query result.
 // The mutation therefore lies strictly between the route's independent reads.
 for(const stage of ['count','rows','stats','revision']){
  for(const later of [false,true]){
   await reset();const first=await call();assert.equal(first.status,200);const initialRevision=first.data.orderPage.revision;
   let mutations=0,revisionReads=0;
   intercept(async sql=>{const isRevision=sql==='SELECT revision FROM order_list_revision WHERE id=1';if(isRevision)revisionReads++;const selected=stage==='count'?sql.startsWith('SELECT COUNT(*) count FROM orders o'):stage==='rows'?sql.startsWith('SELECT o.id,'):stage==='stats'?sql.startsWith('SELECT SUM(CASE'):isRevision&&revisionReads===1;if(selected&&!mutations){mutations++;await mutate();}});
   let result;try{result=await call(later?'&cursor='+encodeURIComponent(first.data.orderPage.nextCursor)+'&revision='+initialRevision:'');}finally{db.prepare=prepare;}
   assert.equal(mutations,1,stage+' fixture fired');
   if(later){assert.equal(result.status,409);assert.equal(result.data.currentRevision,await revision());assert.equal(result.data.orders,undefined);}
   else{assert.equal(result.status,200);assert.equal(result.data.orderPage.revision,await revision());assert.notEqual(result.data.orderPage.revision,initialRevision);assert.equal(result.data.orderPage.total,1);assert.equal(result.data.orderPage.stats.drafts,1);assert.deepEqual(result.data.orders.map(o=>o.id),['a']);}
   checks++;
  }
 }
 // A write after the search rows but before stats also requires a retry.
 await reset();let searchMutations=0;
 intercept(async sql=>{if(sql.startsWith('SELECT o.id,')&&!searchMutations++){await mutate();}});
 let searched;try{searched=await call('&q=Synthetic');}finally{db.prepare=prepare;}
 assert.equal(searched.status,200);assert.equal(searched.data.orderPage.total,1);assert.equal(searched.data.orderPage.stats.drafts,1);assert.equal(searched.data.orderPage.revision,await revision());checks++;
 await reset();let mutations=0;
 intercept(async sql=>{if(sql.startsWith('SELECT SUM(CASE')){mutations++;await mutate();}});
 let unstable;try{unstable=await call();}finally{db.prepare=prepare;}
 assert.equal(unstable.status,409);assert.equal(mutations,3,'initial read and at most two retries');assert.equal(unstable.data.currentRevision,await revision());checks++;
 await reset();const agent=await call(),manager=await call('','manager');
 assert.equal(agent.data.orderPage.total,2);assert.equal(manager.data.orderPage.total,3,'regional managers retain national read scope');assert.equal(agent.data.orders[0].id,'b','stable descending id tie breaker');checks++;
 const stale=await call('&cursor='+encodeURIComponent(agent.data.orderPage.nextCursor)+'&revision=0');assert.equal(stale.status,409);assert.equal(stale.data.currentRevision,await revision());checks++;
 console.log(`PASS: ${checks} deterministic pagination concurrency, bounded retry, cursor and scope regressions.`);
}finally{if(previous===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previous;rmSync(directory,{recursive:true,force:true});}
