// Only the public offline page and brand assets are cached. Authenticated
// requests, client portfolios, orders and exports are always network-only.
const CACHE='mobiup-shell-v2';
const PUBLIC_FILES=['/offline.html','/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-512.png','/mobiup-logo.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PUBLIC_FILES)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('mobiup-')&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()]));});
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(req.mode==='navigate'){event.respondWith(fetch(req).catch(()=>caches.match('/offline.html')));return;}
  if(PUBLIC_FILES.includes(url.pathname))event.respondWith(caches.match(req).then(cached=>cached||fetch(req)));
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
