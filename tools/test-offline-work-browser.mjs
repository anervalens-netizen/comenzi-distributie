import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer,request as proxyRequest} from 'node:http';
const upstream=new URL(process.env.BROWSER_TEST_ORIGIN||'http://127.0.0.1:3014');let disconnected=false;
// Cut requests reaching both page and ServiceWorker: CDP page offline alone does
// not necessarily cut a worker's own network requests in every Chrome version.
const proxy=createServer((req,res)=>{if(disconnected){req.socket.destroy();return;}const target=proxyRequest({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});target.on('error',()=>{res.destroy();});req.pipe(target);});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+proxy.address().port;
const profile=mkdtempSync(join(tmpdir(),'mobile-offline-'));let chrome,socket,checks=0;
const bundle=await build({entryPoints:['lib/offline-work.ts'],write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});const moduleUrl='data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64');
const clientBundle=await build({stdin:{contents:"export {api} from './lib/client-api';export {setLocalWorkUserId,currentLocalWorkUserId} from './lib/local-work';",resolveDir:process.cwd(),loader:'ts'},write:false,bundle:true,format:'esm',platform:'browser',logLevel:'silent'});const clientUrl='data:text/javascript;base64,'+Buffer.from(clientBundle.outputFiles[0].text).toString('base64');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Cdp{constructor(socket){this.socket=socket;this.n=1;this.pending=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')console.error('Browser exception',m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'&&m.params.type==='beforeunload'){void this.send('Page.handleJavaScriptDialog',{accept:true});return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);});}send(method,params={}){return new Promise((resolve,reject)=>{const id=this.n++,timer=setTimeout(()=>reject(new Error('Timeout '+method)),25000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,replMode:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}}
async function wait(fn,label,attempts=160){for(let i=0;i<attempts;i++){if(await fn())return;await sleep(100);}throw new Error('Timeout: '+label);}
const check=(v,label)=>{assert.ok(v,label);checks++;};
try{
 chrome=spawn(process.env.CHROME_BIN||'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,origin],{stdio:['ignore','ignore','pipe'],detached:true});let stderr='';chrome.stderr.on('data',c=>stderr=(stderr+c).slice(-3000));let port;await wait(async()=>{try{port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);return !!port;}catch{if(chrome.exitCode!==null)throw new Error(stderr);return false;}},'Chrome startup',300);
 const page=await fetch(`http://127.0.0.1:${port}/json/new?${origin}`,{method:'PUT'}).then(r=>r.json());socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));const cdp=new Cdp(socket);await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');await wait(()=>cdp.eval(`location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'`),'page',300);
 await cdp.eval(`window.work=await import(${JSON.stringify(moduleUrl)})`);
 // Actual browser IndexedDB, not a hand-written storage mock.
 check(await cdp.eval(`await work.saveWork('offline-test-a','partner','p',{latitude:44,revision:1});(await work.readWork('offline-test-a','partner','p')).latitude===44`),'durable GPS/profile work');
 check(await cdp.eval(`(await work.readWork('offline-test-b','partner','p'))===undefined`),'account isolation');
 check(await cdp.eval(`await work.enqueue('offline-test-a','partner/planning','PUT',{date:'2026-10-05',stops:['p'],revision:0},{scope:'plans',id:'week',value:{stops:['p']}});(await work.pendingOperations('offline-test-a')).length===1&&(await work.readWork('offline-test-a','plans','week')).stops[0]==='p'`),'transactional work plus outbox');
 await cdp.send('Page.reload');await wait(()=>cdp.eval("document.readyState==='complete'"),'reload');await cdp.eval(`window.work=await import(${JSON.stringify(moduleUrl)})`);
 check(await cdp.eval(`(await work.pendingOperations('offline-test-a')).length===1&&(await work.readWork('offline-test-a','partner','p')).latitude===44`),'browser reopen persistence');
 check(await cdp.eval(`let sends=0;await work.replay('offline-test-a',async()=>{sends++;return {};},()=> 'offline-test-b');sends===0`),'different active account cannot replay');
 await cdp.eval(`await work.saveSnapshot('offline-test-a','partner/planning?week=2026-10-05',{week:'2026-10-05',plans:[],visits:[{id:'retained'}]})`);
 check(await cdp.eval(`await work.replay('offline-test-a',async(path,method)=>method==='GET'?{plans:[]}:{date:'2026-10-05',stops:['p'],revision:1},()=> 'offline-test-a');(await work.pendingOperations('offline-test-a')).length===0`),'foreground replay confirms then removes operation');
 for(const status of [400,403,409]){check(await cdp.eval(`await work.enqueue('status-${status}','partner/portfolio/p','PATCH',{revision:1});await work.replay('status-${status}',async()=>{throw Object.assign(new Error('status'),{status:${status}})},()=> 'status-${status}');(await work.pendingOperations('status-${status}'))[0].state==='blocked'`),'status '+status+' retained as conflict');}
 check(await cdp.eval(`await work.enqueue('status-401','partner/portfolio/p','PATCH',{revision:1});await work.replay('status-401',async()=>{throw Object.assign(new Error('session'),{status:401})},()=> 'status-401');const op=(await work.pendingOperations('status-401'))[0];op.state==='pending'&&op.next>Date.now()`),'401 pauses sync without removing data');
 check(await cdp.eval(`const week=(await work.snapshot('offline-test-a','partner/planning?week=2026-10-05')).value;week.plans[0].revision===1&&week.visits[0].id==='retained'`),'replay refreshes cached planning revision and preserves visits');
 // Two concurrent senders in this context use the same IDB lease/Web Lock contract.
 check(await cdp.eval(`await work.enqueue('tabs','partner/portfolio/p/visits','POST',{id:crypto.randomUUID(),notes:'once'});let writes=0;const send=async()=>{writes++;await new Promise(r=>setTimeout(r,100));return {};};await Promise.all([work.replay('tabs',send,()=> 'tabs'),work.replay('tabs',send,()=> 'tabs')]);writes===1`),'concurrent senders do not duplicate writes');
 const second=await fetch(`http://127.0.0.1:${port}/json/new?${origin}`,{method:'PUT'}).then(r=>r.json());const secondSocket=new WebSocket(second.webSocketDebuggerUrl);await new Promise(r=>secondSocket.addEventListener('open',r,{once:true}));const secondCdp=new Cdp(secondSocket);await secondCdp.send('Runtime.enable');await wait(()=>secondCdp.eval(`location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'`),'second tab');await secondCdp.eval(`window.work=await import(${JSON.stringify(moduleUrl)})`);
 await cdp.eval(`await work.enqueue('real-tabs','partner/portfolio/p/visits','POST',{id:crypto.randomUUID(),notes:'once'});window.tabWrites=0`);await secondCdp.eval('window.tabWrites=0');
 const sendExpression=`await work.replay('real-tabs',async()=>{window.tabWrites++;await new Promise(r=>setTimeout(r,500));return {};},()=> 'real-tabs')`;
 await Promise.all([cdp.eval(sendExpression),secondCdp.eval(sendExpression)]);check((await cdp.eval('window.tabWrites'))+(await secondCdp.eval('window.tabWrites'))===1,'two real tabs share exclusive replay lock');secondSocket.close();await fetch(`http://127.0.0.1:${port}/json/close/${second.id}`);
 // Lost response: first POST is retained with its exact stable UUID, then reconciled by the server.
 check(await cdp.eval(`const id=crypto.randomUUID();await work.enqueue('lost','partner/portfolio/p/visits','POST',{id,notes:'same'});await work.replay('lost',async()=>{throw new TypeError('lost reply')},()=> 'lost');const op=(await work.pendingOperations('lost'))[0];op.body.id===id&&op.attempts===1&&op.state==='pending'`),'lost reply retains original identity');
 // Transaction abort leaves both stores unchanged.
 check(await cdp.eval(`const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('mobiup-offline-v3');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});const tx=db.transaction(['work','outbox'],'readwrite');tx.objectStore('work').put({key:'abort',value:'never'});tx.abort();await new Promise(resolve=>tx.onabort=resolve);const read=db.transaction('work').objectStore('work').get('abort');const missing=await new Promise(r=>read.onsuccess=()=>r(read.result));db.close();missing===undefined`),'atomic abort has no false saved work');
 // Inject the browser's QuotaExceededError at the actual IDB write boundary.
 check(await cdp.eval(`const originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(value.key?.startsWith('quota|'))throw new DOMException('Quota exhausted','QuotaExceededError');return originalPut.call(this,value,...args);};let quotaFailed=false;try{await work.enqueue('quota','orders','POST',{id:crypto.randomUUID(),kind:'stands'},{scope:'order',id:'never',value:{notes:'unsaved'}});}catch(e){quotaFailed=e.name==='QuotaExceededError';}finally{IDBObjectStore.prototype.put=originalPut;}quotaFailed&&(await work.readWork('quota','order','never'))===undefined&&(await work.pendingOperations('quota')).length===0`),'quota exception atomically rejects work and outbox');
 await cdp.eval(`window.client=await import(${JSON.stringify(clientUrl)})`);
 check(await cdp.eval(`const savedFetch=window.fetch;client.setLocalWorkUserId('race-a');let resolveFetch;window.fetch=()=>new Promise(r=>resolveFetch=r);const oldRequest=client.api('partner/summary');client.setLocalWorkUserId('race-b');resolveFetch(new Response(JSON.stringify({partners:[{id:'private-to-a'}]})));let rejected=false;try{await oldRequest;}catch(e){rejected=e.status===409;}finally{window.fetch=savedFetch;}rejected&&client.currentLocalWorkUserId()==='race-b'&&(await work.snapshot('race-b','partner/summary'))===null`),'late portfolio response cannot cross accounts');
 check(await cdp.eval(`const originalFetch=window.fetch;client.setLocalWorkUserId('session-a');let resolveSession;window.fetch=()=>new Promise(r=>resolveSession=r);const oldSession=client.api('auth/session');client.setLocalWorkUserId('session-b');resolveSession(new Response(JSON.stringify({user:{id:'session-a'}})));let rejected=false;try{await oldSession;}catch(e){rejected=e.status===409;}finally{window.fetch=originalFetch;}rejected&&client.currentLocalWorkUserId()==='session-b'`),'late session response cannot switch the active account back');
 check(await cdp.eval(`for(let i=0;i<651;i++)await work.saveSnapshot('bounded','item/'+i,{i});(await work.snapshot('bounded','item/0'))===null&&(await work.snapshot('bounded','item/640')).value.i===640&&(await work.readWork('offline-test-a','partner','p')).latitude===44`),'snapshot limit evicts oldest regenerable items without deleting work');
 console.log('PASS: IndexedDB/outbox module scenarios');
 const {password}=JSON.parse(readFileSync('work/stock-qa-20260914/credentials.json','utf8'));
 check(await cdp.eval(`(await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'stock-agent',password:${JSON.stringify(password)}})})).ok`),'synthetic agent login');
 check(await cdp.eval(`const crossed=crypto.randomUUID();const denied=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json','X-Operation-User':'another-account'},body:JSON.stringify({id:crossed,kind:'stands'})});denied.status===409&&(await fetch('/api/orders/'+crossed)).status===404`),'server rejects a replay under another account before any write');
 await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:"window.loginFlashes=0;new MutationObserver(()=>{if(document.querySelector('.login-form'))window.loginFlashes++;}).observe(document,{childList:true,subtree:true});"});await cdp.send('Page.reload');await wait(()=>cdp.eval("!!document.querySelector('.main-nav')&&!!document.querySelector('.action-card')"),'agent UI');
 await wait(()=>cdp.eval("!!navigator.serviceWorker.controller"),'versioned SW activated',300);
 check(await cdp.eval("!document.querySelector('.login-form')&&window.loginFlashes===0"),'valid session has zero login DOM flash');await cdp.eval(`window.work=await import(${JSON.stringify(moduleUrl)})`);
 console.log('PASS: online application warmup');disconnected=true;await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await cdp.eval("document.querySelector('.action-card').click()");await wait(()=>cdp.eval("!!document.querySelector('.cart textarea')"),'offline create',300);
 await cdp.eval("const input=document.querySelector('.cart textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Offline restart QA');input.dispatchEvent(new Event('input',{bubbles:true}));");await sleep(2000);
 const id=await cdp.eval("const rows=await work.pendingOperations('stock-agent');rows.find(o=>o.path==='orders').body.id");check(!!id,'stable offline draft UUID');
 // Reload from SW generic shell with network unavailable, then inspect the real persisted work.
 console.log('PASS: offline create/editor persistence');await cdp.send('Page.navigate',{url:origin+'/'});await wait(()=>cdp.eval("!!document.querySelector('.main-nav')"),'offline shell reopen',300);
 check(await cdp.eval("location.pathname==='/'&&!document.querySelector('.login-form')"),'offline reopen renders local account without login flash');
 // Module entry may not be in SW cache, so retrieve persisted work using IndexedDB directly.
 check(await cdp.eval(`const db=await new Promise(r=>{const q=indexedDB.open('mobiup-offline-v3');q.onsuccess=()=>r(q.result);});const req=db.transaction('work').objectStore('work').get('stock-agent|order|'+${JSON.stringify(id)});const row=await new Promise(r=>req.onsuccess=()=>r(req.result));db.close();row?.value.local.notes==='Offline restart QA'`),'actual editor changes survive offline reopen');
 console.log('PASS: offline generic shell reopen');disconnected=false;await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await wait(()=>cdp.eval(`fetch('/api/orders/${id}').then(r=>r.ok?r.json():null).then(d=>d?.order.notes==='Offline restart QA')`),'replay creates and edits once',400);
 check(await cdp.eval(`fetch('/api/orders').then(r=>r.json()).then(d=>d.orders.filter(o=>o.id===${JSON.stringify(id)}).length===1)`),'exactly one real synthetic server draft');
 console.log('PASS: '+checks+' offline browser checks including real application create/reopen/replay.');
 }finally{
 socket?.close();
 // Chrome descendants share this test's process group and may outlive its launcher.
 if(chrome){
  const signalGroup=signal=>{try{process.kill(-chrome.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
  signalGroup('SIGTERM');
  if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(r=>chrome.once('exit',r)),sleep(3000)]);
  signalGroup('SIGKILL');
 }
 proxy.closeAllConnections();await new Promise(r=>proxy.close(r));
 rmSync(profile,{recursive:true,force:true,maxRetries:30,retryDelay:100});
}
