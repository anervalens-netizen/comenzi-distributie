// Generic, build-generated shell only. Private data live in per-account IndexedDB.
const CACHE='mobiup-shell-v3-__SHELL_VERSION__';
const PUBLIC_FILES=/*__SHELL_ASSETS__*/[];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PUBLIC_FILES)));});
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_SAFE')self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
// Old version assets are retained for open tabs; no forced reload or unsafe eviction.
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(req.mode==='navigate'){event.respondWith(fetch(req).catch(async()=>await caches.open(CACHE).then(c=>c.match('/offline.html'))||await caches.match('/offline.html')));return;}
 if(PUBLIC_FILES.includes(url.pathname)||url.pathname.startsWith('/_next/static/'))event.respondWith(caches.open(CACHE).then(async cache=>await cache.match(req)||await caches.match(req)||fetch(req)));
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
