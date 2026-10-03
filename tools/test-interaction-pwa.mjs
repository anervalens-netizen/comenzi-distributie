import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const origin='https://synthetic.invalid';
const essential=['/offline.html','/manifest.webmanifest','/_next/static/offline/app-bootstrap.js'];
const optional=['/_next/static/lazy-partners.js','/_next/static/lazy-map.js'];
const source=(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'))
 .replace('__SHELL_VERSION__','synthetic')
 .replace('/*__SHELL_ESSENTIAL__*/[]',JSON.stringify(essential))
 .replace('/*__SHELL_OPTIONAL__*/[]',JSON.stringify(optional));
const listeners=new Map();
const stores=new Map();
const fetched=[];
const key=value=>new URL(typeof value==='string'?value:value.url,origin).pathname;
const cache=name=>{
 if(!stores.has(name))stores.set(name,new Map());
 const entries=stores.get(name);
 return {
  addAll:async paths=>{for(const path of paths)entries.set(key(path),new Response(`installed:${path}`));},
  match:async request=>entries.get(key(request)),
  put:async(request,response)=>{entries.set(key(request),response);},
 };
};
const cacheStorage={
 open:async name=>cache(name),
 keys:async()=>[...stores.keys()],
 match:async request=>{for(const entries of stores.values()){const response=entries.get(key(request));if(response)return response;}},
 delete:async name=>stores.delete(name),
};
let claims=0,skipWaitingCalls=0;
let openClients=[];
const thisWorker={scriptURL:origin+'/sw.js',state:'activated'};
const self={
 location:{origin},
 serviceWorker:thisWorker,
 registration:{active:thisWorker,showNotification:async()=>{}},
 clients:{claim:async()=>{claims++;},matchAll:async()=>openClients,openWindow:async()=>{}},
 addEventListener:(type,handler)=>listeners.set(type,handler),
 skipWaiting:()=>{skipWaitingCalls++;},
};
const syntheticFetch=async request=>{
 const path=key(request);
 fetched.push(path);
 if(path.startsWith('/api/'))return new Response('private',{status:200});
 return new Response(`network:${path}`,{status:200});
};
vm.runInNewContext(source,{self,caches:cacheStorage,fetch:syntheticFetch,URL,Request,Response,AbortController,setTimeout,clearTimeout,console},{filename:'sw.js'});
const dispatchWait=async(type,event={})=>{
 let pending=Promise.resolve();
 listeners.get(type)({...event,waitUntil:value=>{pending=Promise.resolve(value);}});
 await pending;
};
const dispatchFetch=request=>{
 let response;
 listeners.get('fetch')({request,respondWith:value=>{response=Promise.resolve(value);}});
 return response;
};

await dispatchWait('install');
const current=stores.get('mobiup-shell-v3-synthetic');
assert.deepEqual([...current.keys()].sort((a,b)=>a.localeCompare(b)),essential.slice().sort((a,b)=>a.localeCompare(b)),'install caches only the bootstrap shell');
assert.equal(current.has(optional[0]),false,'lazy modules are not fetched during install');

stores.set('mobiup-shell-v2-retained',new Map([
 ['/_next/static/legacy-open-tab.js',new Response('legacy asset')],
 ['/offline.html',new Response('legacy shell')],
]));
await dispatchWait('activate');
assert.equal(claims,1,'activation claims clients');
assert.equal(stores.has('mobiup-shell-v2-retained'),true,'activation retains an older cache used by an open tab');
assert.equal(skipWaitingCalls,0,'install and activation never force a waiting worker');
const legacyResponse=await Promise.resolve(dispatchFetch(new Request(origin+'/_next/static/legacy-open-tab.js')));
assert.equal(await legacyResponse.text(),'legacy asset','current worker serves an old immutable asset from the retained cache');

let apiResponded=false;
listeners.get('fetch')({
 request:new Request(origin+'/api/private-account-data'),
 respondWith:()=>{apiResponded=true;},
});
assert.equal(apiResponded,false,'private API requests are not intercepted');
assert.equal([...stores.values()].some(entries=>[...entries.keys()].some(path=>path.startsWith('/api/'))),false,'CacheStorage contains no API response');

openClients=[{id:'current'}];
await dispatchWait('message',{data:{type:'CLIENT_SHELL_ASSETS',paths:[essential[2]]},source:{id:'current'}});
assert(stores.has('mobiup-shell-v2-retained'),'current-document proof cannot retire the older cache before full preparation');
const progress=[];
let preparation;
listeners.get('message')({
 data:{type:'PREPARE_OFFLINE_SHELL'},
 ports:[{postMessage:message=>progress.push(structuredClone(message))}],
 source:null,
 waitUntil:value=>{preparation=Promise.resolve(value);},
});
await Promise.resolve(preparation);
assert.deepEqual(optional.map(path=>current.has(path)),[true,true],'explicit preparation caches every optional module');
assert.equal(progress.at(0).state,'preparing','preparation announces its initial state');
assert.deepEqual(progress.at(-1),{type:'OFFLINE_SHELL_PREPARATION',role:'legacy',state:'ready',completed:essential.length+optional.length,total:essential.length+optional.length,transferred:optional.length,transferBytes:optional.reduce((sum,path)=>sum+Buffer.byteLength('network:'+path),0)},'ready reports only network transfers and waits for every legacy optional module');
assert.deepEqual(fetched,optional,'only optional public shell assets are fetched during preparation');

openClients=[{id:'current'},{id:'unknown-legacy'}];
await dispatchWait('message',{data:{type:'CLIENT_SHELL_ASSETS',paths:[essential[2]]},source:{id:'current'}});
assert(stores.has('mobiup-shell-v2-retained'),'unknown older tab protects its assets');
self.registration.waiting={state:'installed'};
openClients=[{id:'current'}];
await dispatchWait('message',{data:{type:'CLIENT_SHELL_ASSETS',paths:[essential[2]]},source:{id:'current'}});
assert(stores.has('mobiup-shell-v2-retained'),'waiting version prevents active-worker cleanup');
self.registration.waiting=null;
openClients=[{id:'current'}];
// An old cleanup can resume after each awaited stage of a new activation.
// Both versions deliberately have the same scriptURL; object identity matters.
const nextWorker={scriptURL:thisWorker.scriptURL,state:'activated'};
const announce=()=>dispatchWait('message',{data:{type:'CLIENT_SHELL_ASSETS',paths:[essential[2]]},source:{id:'current'}});
for(const stage of ['clients','keys','delete']){
 self.registration.active=thisWorker;
 stores.set('mobiup-shell-v2-retained',new Map([['/offline.html',new Response('legacy')]]));
 stores.set('mobiup-shell-v3-new-active',new Map([['/offline.html',new Response('new active')],[optional[0],new Response('new lazy')]]));
 const matchAll=self.clients.matchAll,keys=cacheStorage.keys,remove=cacheStorage.delete;
 if(stage==='clients')self.clients.matchAll=async()=>{const result=await matchAll();self.registration.active=nextWorker;return result;};
 if(stage==='keys')cacheStorage.keys=async()=>{const result=await keys();self.registration.active=nextWorker;return result;};
 if(stage==='delete')cacheStorage.delete=async name=>{const result=await remove(name);self.registration.active=nextWorker;return result;};
 try{await announce();}finally{self.clients.matchAll=matchAll;cacheStorage.keys=keys;cacheStorage.delete=remove;}
 assert(stores.has('mobiup-shell-v3-new-active'),'retired worker must retain the new active shell after '+stage);
 assert(stores.get('mobiup-shell-v3-new-active').has(optional[0]),'new prepared lazy asset survives '+stage);
}
self.registration.active=thisWorker;self.serviceWorker=undefined;
await announce();
assert(stores.has('mobiup-shell-v3-new-active'),'unknown own-worker identity retains caches rather than guessing from script URL');
self.serviceWorker=thisWorker;
stores.set('mobiup-shell-v2-retained',new Map([['/offline.html',new Response('legacy')]]));
await dispatchWait('message',{data:{type:'CLIENT_SHELL_ASSETS',paths:[essential[2]]},source:{id:'current'}});
assert(!stores.has('mobiup-shell-v2-retained'),'only caches unused by every verified client are retired');
listeners.get('message')({data:{type:'ACTIVATE_SAFE'},ports:[],source:null,waitUntil:()=>{}});
assert.equal(skipWaitingCalls,1,'skipWaiting remains restricted to explicit safe activation');
console.log('PASS: staged PWA shell, upgrade retention, progress, and private-cache isolation.');
