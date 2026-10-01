// Generic, build-generated shell only. Private data live in per-account IndexedDB.
const CACHE='mobiup-shell-v3-__SHELL_VERSION__';
const ESSENTIAL_FILES=/*__SHELL_ESSENTIAL__*/[];
const OPTIONAL_FILES=/*__SHELL_OPTIONAL__*/[];
const isPublicShellFile=path=>typeof path==='string'&&path.startsWith('/')&&!path.startsWith('/api/')&&!path.startsWith('/api?');
const ESSENTIAL_SHELL=ESSENTIAL_FILES.filter(isPublicShellFile);
const OPTIONAL_SHELL=OPTIONAL_FILES.filter(isPublicShellFile);
const PUBLIC_FILES=new Set([...ESSENTIAL_SHELL,...OPTIONAL_SHELL]);
let preparation=null;
let preparationState={state:'preparing',completed:0,total:PUBLIC_FILES.size};
const verifiedClients=new Set();
async function retireUnusedShells(){
 const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
 // Unknown/legacy documents retain every old asset. Only verified current documents permit collection.
 if(!clients.length||clients.some(client=>!verifiedClients.has(client.id)))return;
 const current=await caches.open(CACHE);
 for(const path of PUBLIC_FILES)if(!await current.match(path))return;
 for(const key of await caches.keys())if(key.startsWith('mobiup-shell-')&&key!==CACHE)await caches.delete(key);
}
const preparationListeners=new Set();
const publishPreparation=detail=>{
 preparationState=detail;
 for(const notify of preparationListeners)try{notify({type:'OFFLINE_SHELL_PREPARATION',...detail});}catch{}
};
const prepareOfflineShell=notify=>{
 if(notify)preparationListeners.add(notify);
 if(preparation){
  if(notify)notify({type:'OFFLINE_SHELL_PREPARATION',...preparationState});
  return preparation;
 }
 preparation=(async()=>{
  const total=PUBLIC_FILES.size;
  let completed=0;
  publishPreparation({state:'preparing',completed,total});
  try{
   const cache=await caches.open(CACHE);
   for(const path of PUBLIC_FILES){
    if(!await cache.match(path)){
     const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
     try{
      const response=await fetch(path,{credentials:'same-origin',cache:'reload',signal:controller.signal});
      if(!response.ok)throw new Error(`HTTP ${response.status} pentru ${path}`);
      await cache.put(path,response);
     }finally{clearTimeout(timer);}
    }
    completed++;
    publishPreparation({state:'preparing',completed,total});
   }
   publishPreparation({state:'ready',completed,total});
  }catch(error){
   publishPreparation({state:'error',completed,total,error:error instanceof Error?error.message:String(error)});
  }finally{
   preparation=null;
   preparationListeners.clear();
  }
 })();
 return preparation;
};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ESSENTIAL_SHELL)));});
self.addEventListener('message',event=>{
 if(event.data?.type==='CLIENT_SHELL_ASSETS'){
  const paths=event.data.paths,id=event.source?.id;
  const identifiable=Array.isArray(paths)&&paths.some(path=>typeof path==='string'&&(/\/distribution-app-[^/]+\.js$/.test(path)||/\/_next\/static\/offline\/app-[^/]+\.js$/.test(path)));
  if(id&&identifiable&&paths.length<=500&&paths.every(path=>PUBLIC_FILES.has(path)))verifiedClients.add(id);
  else if(id)verifiedClients.delete(id);
  event.waitUntil(retireUnusedShells());return;
 }
 if(event.data?.type==='ACTIVATE_SAFE'){self.skipWaiting();return;}
 if(event.data?.type!=='PREPARE_OFFLINE_SHELL')return;
 const port=event.ports?.[0];
 const source=event.source;
 const notify=message=>{if(port)port.postMessage(message);else source?.postMessage(message);};
 event.waitUntil(prepareOfflineShell(notify));
});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
// Old version assets are retained because client APIs do not prove that no open
// tab still references them. There is no forced reload or speculative eviction.
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(req.mode==='navigate'){event.respondWith(fetch(req).catch(async()=>await caches.open(CACHE).then(c=>c.match('/offline.html'))||await caches.match('/offline.html')));return;}
 if(PUBLIC_FILES.has(url.pathname)||url.pathname.startsWith('/_next/static/'))event.respondWith(caches.open(CACHE).then(async cache=>{
  const cached=await cache.match(req)||await cache.match(url.pathname)||await caches.match(req);if(cached)return cached;
  const response=await fetch(req);
  if(response.ok&&PUBLIC_FILES.has(url.pathname))event.waitUntil(cache.put(url.pathname,response.clone()));
  return response;
 }));
});

self.addEventListener('push',event=>{
  if(!event.data)return;
  let data;try{data=event.data.json();}catch{return;}
  if(!data||typeof data.title!=='string'||!data.title)return;
  let url=self.location.origin+'/';try{if(typeof data.url==='string'){const target=new URL(data.url,self.location.origin);if(target.origin===self.location.origin)url=target.href;}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{body:typeof data.body==='string'?data.body:'',tag:typeof data.tag==='string'?data.tag:undefined,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',data:{url}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const target=event.notification.data?.url;if(!target)return;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{const open=windows.find(client=>new URL(client.url).origin===self.location.origin);if(open){if('navigate' in open)await open.navigate(target);return open.focus();}return self.clients.openWindow(target);}));
});
