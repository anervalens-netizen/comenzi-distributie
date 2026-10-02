// Actual routes, synthetic SQLite and two same-origin tabs without localStorage.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';

mkdirSync('work',{recursive:true});const directory=mkdtempSync(resolve('work/private-fence-'));
const previousDirectory=process.env.MOBIUP_DATA_DIR;process.env.MOBIUP_DATA_DIR=join(directory,'data');
let browser,server,checks=0,holdRead=false,releaseRead;
const requests=[],tokens=new Map(),hash=value=>createHash('sha256').update(value).digest('hex');
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const modulePath=join(directory,'route.mjs');
 await build({stdin:{contents:"export * from './app/api/[...path]/route';export {env} from './lib/runtime';",loader:'ts',resolveDir:resolve('.')},outfile:modulePath,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'node-runtime',setup(b){b.onResolve({filter:/^#mobiup-/},args=>({path:resolve('lib/'+args.path.slice('#mobiup-'.length)+'-node.ts')}));b.onResolve({filter:/\.sql\?raw$/},args=>({path:resolve(args.path.replace(/^@\//,'').replace(/\?raw$/,'')),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));}}]});
 const route=await import(pathToFileURL(modulePath)),db=route.env.DB;
 await db.prepare('SELECT 1').first();
 for(const id of ['account-A','account-B']){
  await db.prepare("INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active) VALUES(?,?,?,'agent','w','not-a-credential',0,1)").bind(id,id,id).run();
  const token=randomUUID();tokens.set(id,token);
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(hash(token),id,Date.now()+3600000).run();
 }
 const compiled=await build({stdin:{contents:"export * from './lib/client-api';export * from './lib/offline-work';export * from './lib/local-work';",loader:'ts',resolveDir:resolve('.')},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 server=createServer(async(req,res)=>{
  try{
   if(req.url.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    const row={path:req.url,method:req.method,owner:req.headers['x-operation-user']};requests.push(row);
    const result=await route[req.method](new Request('http://'+req.headers.host+req.url,{method:req.method,headers:new Headers(req.headers),...body.length?{body}:{}}));
    row.status=result.status;
    const text=await result.text();
    if(holdRead&&req.url==='/api/partner/summary'&&req.method==='GET'){
     holdRead=false;await new Promise(resolve=>releaseRead=resolve);
    }
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(text);return;
   }
   res.setHeader('Content-Type',req.url==='/fixture.mjs'?'text/javascript':'text/html');
   res.end(req.url==='/fixture.mjs'?compiled.outputFiles[0].text:'<!doctype html><title>Synthetic private authority</title>');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);const a=browser,b=await browser.newTab();
 for(const tab of [a,b])await tab.evaluate(`Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Synthetic unavailable','SecurityError')}});window.m=await import('/fixture.mjs');window.nativeFetch=fetch;window.calls=0;window.fetch=(...args)=>{calls++;return nativeFetch(...args)};window.denied=async(run)=>{try{await run();return false}catch(e){return e.status===409}};`);
 const cookie=async(id)=>a.send('Network.setCookie',{name:'mobiup_session',value:tokens.get(id),url:origin,httpOnly:true});
 const authenticate=async(tab,id)=>{await cookie(id);check(await tab.evaluate(`(await m.api('auth/session')).user.id===${JSON.stringify(id)}`),'HTTP authenticates '+id);};
 const blocked=async(expression,label)=>{
  const before=requests.length;
  check(await a.evaluate(`window.before=calls;await denied(()=>${expression})&&calls===before`),label);
  check(requests.length===before,label+' has no HTTP dispatch');
 };
 await authenticate(a,'account-A');
 await a.evaluate("await m.api('partner/summary');window.cachedAt=(await m.snapshot('account-A','partner/summary')).at");
 await authenticate(b,'account-B');
 check(await a.evaluate("m.currentLocalWorkUserId()==='account-A'"),'Tab A retains its local owner without storage events');
 for(const expression of ["m.api('partner/summary')","m.networkApi('partner/summary')","m.api('orders','POST',{id:crypto.randomUUID(),kind:'stands'})","m.networkApi('orders','POST',{id:crypto.randomUUID(),kind:'stands'})","m.api('auth/logout','POST')","m.api('partner/summary','GET',undefined,undefined,{preferCache:true})"]){
  await blocked(expression,'superseded tab rejects '+expression);
 }
 check(await a.evaluate("(await m.snapshot('account-A','partner/summary')).at===cachedAt"),'rejected reads do not overwrite A snapshots');

 // Revocation followed by the same account is a new admission, even though the
 // local owner string has never changed. Reauthentication is the explicit reset.
 await authenticate(a,'account-A');await a.evaluate("await m.api('partner/summary')");
 await b.evaluate('await m.rejectSessionFence()');
 await blocked("m.api('partner/summary','GET',undefined,undefined,{preferCache:true})",'shared tombstone rejects memory hit');
 await authenticate(b,'account-A');
 await blocked("m.api('partner/summary')",'same-owner read rejects old revocation epoch');
 await blocked("m.api('orders','POST',{})",'same-owner write rejects old revocation epoch');
 await authenticate(a,'account-A');await a.evaluate("await m.api('partner/summary')");
 await b.evaluate('await m.rejectSessionFence()');await authenticate(b,'account-A');
 await blocked("m.api('partner/summary','GET',undefined,undefined,{preferCache:true})",'same-owner new admission rejects still-populated memory cache');

 // The real HTTP response has succeeded but remains in flight while another
 // tab switches accounts. Cover both A -> B and A -> B -> A.
 for(const scenario of ['switch','round-trip','offline-round-trip']){
  const roundTrip=scenario!=='switch';
  await authenticate(a,'account-A');await a.evaluate("await m.api('partner/summary');window.cachedAt=(await m.snapshot('account-A','partner/summary')).at");
  if(scenario==='offline-round-trip')await a.evaluate("window.fetch=async(...args)=>{calls++;await nativeFetch(...args);throw new TypeError('Synthetic lost response')};");
  holdRead=true;releaseRead=undefined;
  await a.evaluate("window.pending=denied(()=>m.api('partner/summary'));void 0");
  await waitFor(()=>!!releaseRead,'private HTTP response held');
  await authenticate(b,'account-B');if(roundTrip)await authenticate(b,'account-A');
  releaseRead();releaseRead=undefined;
  check(await a.evaluate("await pending&&(await m.snapshot('account-A','partner/summary')).at===cachedAt"),'delayed GET is neither exposed nor cached after '+scenario);
  await blocked("m.api('partner/summary','GET',undefined,undefined,{preferCache:true})",'stale response cannot populate memory');
  await a.evaluate('window.fetch=(...args)=>{calls++;return nativeFetch(...args)};');
 }

 // Source-v1 data also uses the general in-memory fast path, including paths
 // outside the durable offline allowlist. No network or offline retry on denial.
 for(const path of ['partner/summary','sales/clients?source=v1']){
  await authenticate(a,'account-A');
  await a.evaluate(`window.fetch=async()=>Response.json(${path.startsWith('sales/')?"{state:'unavailable',message:'Synthetic source v1',source:'v1'}":"{partners:[{id:'synthetic-v1'}],source:'v1'}"});await m.api(${JSON.stringify(path)});window.fetch=(...args)=>{calls++;return nativeFetch(...args)};window.before=calls;`);
  check(await a.evaluate(`(await m.api(${JSON.stringify(path)},'GET',undefined,undefined,{preferCache:true})).source==='v1'&&calls===before`),'source-v1 memory cache works for current authority');
  await authenticate(b,'account-B');
  await blocked(`m.api(${JSON.stringify(path)},'GET',undefined,undefined,{preferCache:true})`,'source-v1 cache rejects changed account');
 }

 // Change the local generation while the persisted fence is being read.
 await authenticate(a,'account-A');await a.evaluate("await m.api('partner/summary')");
 check(await a.evaluate(`const original=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(key){const result=original.call(this,key);if(this.name==='meta'&&key==='session-fence')m.setLocalWorkUserId('account-B');return result};const before=calls;let result;try{result=await denied(()=>m.api('partner/summary','GET',undefined,undefined,{preferCache:true}))}finally{IDBObjectStore.prototype.get=original}result&&calls===before`),'memory hit rechecks local scope after awaiting the persisted fence');

 // Delay native dispatch AFTER client preflight. Only the cookie changes, so
 // the server must reject the expected-user header, not rely on a client fence.
 for(const {path,body} of [{path:'orders',body:{id:randomUUID(),kind:'stands'}},{path:'auth/logout',body:{}}]){
  await authenticate(a,'account-A');
  await a.evaluate(`window.releaseDispatch=null;window.fetch=async(...args)=>{calls++;await new Promise(resolve=>releaseDispatch=resolve);return nativeFetch(...args)};window.pending=denied(()=>m.api(${JSON.stringify(path)},'POST',${JSON.stringify(body)}));void 0`);
  await waitFor(()=>a.evaluate('!!releaseDispatch'),'write reached dispatch boundary');await cookie('account-B');
  await a.evaluate('releaseDispatch();');check(await a.evaluate('await pending'),'actual HTTP rejects cookie switch for '+path);
  const request=requests.at(-1);check(request.owner==='account-A'&&request.status===409,'ordinary '+path+' carries enforced X-Operation-User without operation id');
  check(!!await db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').bind(hash(tokens.get('account-B'))).first(),'stale logout/write preserves B session');
  if(path==='orders')check(!await db.prepare('SELECT 1 FROM orders WHERE id=?').bind(body.id).first(),'mismatched ordinary write creates no order');
  await a.evaluate('window.fetch=(...args)=>{calls++;return nativeFetch(...args)};');
 }
 await authenticate(a,'account-A');
 const orderId=randomUUID();
 check(await a.evaluate(`(await m.api('orders','POST',{id:${JSON.stringify(orderId)},kind:'stands'})).order.userId==='account-A'`),'ordinary same-account HTTP write succeeds');
 check(requests.at(-1).owner==='account-A'&&requests.at(-1).status===201,'successful ordinary creation sends the guard and returns its 201 contract');
 check(await a.evaluate("await denied(()=>m.networkApi('orders','POST',{},undefined,'synthetic-replay','account-B'))"),'replay cannot override captured owner');

 // A confirmed logout outranks a refresh within the SAME admission, but must
 // not reject a later login even when the account string is unchanged.
 for(const noLocks of [false,true]){
  if(noLocks)for(const tab of [a,b])await tab.evaluate("Object.defineProperty(navigator,'locks',{configurable:true,value:undefined})");
  await authenticate(a,'account-A');await authenticate(b,'account-A');
  await b.evaluate("await m.api('partner/summary')");
  await a.evaluate("window.logoutFence=await m.sessionFence();window.releaseLogout=null;window.fetch=async(...args)=>{calls++;await new Promise(resolve=>releaseLogout=resolve);return nativeFetch(...args)};window.logoutResult=m.api('auth/logout','POST').then(()=>({ok:true}),e=>({ok:false,status:e.status}));void 0");
  await waitFor(()=>a.evaluate('!!releaseLogout'),'logout captured its admission before dispatch');
  await b.evaluate("await m.api('auth/session')");
  check(await a.evaluate("(await m.sessionFence()).epoch!==logoutFence.epoch"),'same-account refresh rotates epoch while logout is pending');
  await a.evaluate('releaseLogout();');
  check(await a.evaluate("(await logoutResult).ok&&m.currentLocalWorkUserId()===''&&(await m.sessionFence()).rejected"),'confirmed logout clears current binding despite refresh '+noLocks);
  check(await b.evaluate("window.before=calls;await denied(()=>m.api('partner/summary','GET',undefined,undefined,{preferCache:true}))&&calls===before"),'other-tab cached read is rejected without network after confirmed logout '+noLocks);
  check(!await db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').bind(hash(tokens.get('account-A'))).first(),'actual logout removed the synthetic server session');
  await a.evaluate('window.fetch=(...args)=>{calls++;return nativeFetch(...args)};');
  const token=randomUUID();tokens.set('account-A',token);
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(hash(token),'account-A',Date.now()+3600000).run();
  await authenticate(a,'account-A');
  check(await a.evaluate("!await m.rejectSessionFence(logoutFence,'account-A')&&!(await m.sessionFence()).rejected"),'old confirmed admission cannot reject a new same-account login '+noLocks);
 }

 // A legacy local account with an unbound fence keeps working without silently
 // writing that account into the shared fence. Real HTTP verifies the identity.
 const legacy=await browser.newTab();
 await legacy.evaluate(`Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Synthetic unavailable','SecurityError')}});window.m=await import('/fixture.mjs');m.setLocalWorkUserId('account-A');const q=indexedDB.open('mobiup-offline-v3',1);const db=await new Promise((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete('session-fence');await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});db.close();`);
 check(await legacy.evaluate("Array.isArray((await m.api('partner/summary')).partners)&&!(await m.sessionFence()).userId"),'legacy unbound fence allows existing owner with server assertion, without binding metadata');
 await authenticate(a,'account-A');await a.evaluate("await m.api('partner/summary');window.cachedAt=(await m.snapshot('account-A','partner/summary')).at");
 await cookie('account-B');
 check(await a.evaluate("await denied(()=>m.api('partner/summary'))&&(await m.snapshot('account-A','partner/summary')).at===cachedAt"),'explicit HTTP 409 cannot fall back to an A snapshot');
 await cookie('account-A');await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hash(tokens.get('account-A'))).run();
 check(await a.evaluate("let status;try{await m.api('partner/summary')}catch(e){status=e.status}status===401&&m.currentLocalWorkUserId()===''&&(await m.snapshot('account-A','partner/summary')).at===cachedAt"),'explicit HTTP 401 rejects cached fallback and clears only current authority');
 console.log(`PASS: ${checks} private session fence checks, two tabs and actual HTTP writes.`);
}finally{
 releaseRead?.();await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 if(previousDirectory===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previousDirectory;
 rmSync(directory,{recursive:true,force:true});
}
