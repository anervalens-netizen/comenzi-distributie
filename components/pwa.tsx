'use client';
import {useEffect,useState} from 'react';
import {pendingOperations,OFFLINE_EVENT} from '@/lib/offline-work';
import {currentLocalWorkUserId} from '@/lib/local-work';
type InstallEvent=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>};
export type OfflineShellPreparationDetail={state:'preparing'|'ready'|'error';completed:number;total:number;error?:string};
let shellPreparation:OfflineShellPreparationDetail={state:'preparing',completed:0,total:0};
let preparation:Promise<OfflineShellPreparationDetail>|null=null;
const publish=(detail:OfflineShellPreparationDetail)=>{shellPreparation=detail;window.dispatchEvent(new CustomEvent('mobiup-shell-preparation',{detail}));};
export function getOfflineShellPreparation(){return {...shellPreparation};}
function deadline<T>(promise:Promise<T>,ms:number,message:string):Promise<T>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(message)),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}
function announceAssets(){
 const worker=navigator.serviceWorker?.controller;if(!worker)return;
 const urls=[...Array.from(document.scripts,script=>script.src),...performance.getEntriesByType('resource').map(entry=>entry.name)];
 const paths=[...new Set(urls.flatMap(value=>{try{const url=new URL(value,location.href);return url.origin===location.origin&&url.pathname.startsWith('/_next/static/')?[url.pathname]:[];}catch{return [];}}))];
 worker.postMessage({type:'CLIENT_SHELL_ASSETS',paths});
}
/** Explicit preparation completes only after both essential and optional generic assets are present. */
export function prepareOfflineShell():Promise<OfflineShellPreparationDetail>{
 if(preparation)return preparation;
 preparation=(async()=>{
  publish({state:'preparing',completed:0,total:0});
  try{
   if(!('serviceWorker'in navigator))throw new Error('Service Worker indisponibil');
   const registration=await deadline(navigator.serviceWorker.ready,15000,'Interfața offline nu este încă instalată. Reîncearcă după încărcare.');
   const worker=navigator.serviceWorker.controller??registration.active;
   if(!worker)throw new Error('Service Worker inactiv');
   return await new Promise<OfflineShellPreparationDetail>((resolve,reject)=>{
    const channel=new MessageChannel();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const arm=(ms:number)=>{clearTimeout(timer);timer=setTimeout(()=>{channel.port1.close();reject(new Error('Pregătirea interfeței a expirat. Activează actualizarea disponibilă și reîncearcă.'));},ms);};
    arm(5000);
    channel.port1.onmessage=event=>{
     const message=event.data;
     if(message?.type!=='OFFLINE_SHELL_PREPARATION'||!['preparing','ready','error'].includes(message.state))return;
     const detail:OfflineShellPreparationDetail={state:message.state,completed:Number(message.completed)||0,total:Number(message.total)||0,...(typeof message.error==='string'?{error:message.error}:{})};
     publish(detail);
     if(detail.state==='preparing'){arm(30000);return;}
     clearTimeout(timer);channel.port1.close();
     if(detail.state==='ready'){announceAssets();resolve(detail);}else reject(new Error(detail.error||'Pregătirea offline nu a reușit'));
    };
    channel.port1.start();
    try{worker.postMessage({type:'PREPARE_OFFLINE_SHELL'},[channel.port2]);}catch(error){clearTimeout(timer);channel.port1.close();reject(error);}
   });
  }catch(error){publish({state:'error',completed:shellPreparation.completed,total:shellPreparation.total,error:error instanceof Error?error.message:String(error)});throw error;}
 })().finally(()=>{preparation=null;});
 return preparation;
}
export function PwaInstall(){
 const [install,setInstall]=useState<InstallEvent|null>(null),[waiting,setWaiting]=useState<ServiceWorker|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
 useEffect(()=>{
  let disposed=false,bootstrapReady=false,idleId:number|undefined,timerId:ReturnType<typeof setTimeout>|undefined;
  const offer=(event:Event)=>{event.preventDefault();setInstall(event as InstallEvent);};
  const update=()=>void pendingOperations(currentLocalWorkUserId()).then(rows=>{if(!disposed)setPending(rows.length>0);}).catch(()=>{if(!disposed)setPending(true);});
  const requestPreparation=()=>{void prepareOfflineShell().catch(()=>{});};
  const schedule=()=>{
   announceAssets();
   const connection=(navigator as Navigator&{connection?:{saveData?:boolean;effectiveType?:string}}).connection;
   if(disposed||!bootstrapReady||!navigator.onLine||connection?.saveData||['slow-2g','2g'].includes(connection?.effectiveType||''))return;
   if(idleId!==undefined)window.cancelIdleCallback(idleId);if(timerId!==undefined)clearTimeout(timerId);
   timerId=setTimeout(()=>{if(disposed)return;if('requestIdleCallback'in window)idleId=window.requestIdleCallback(requestPreparation,{timeout:5000});else requestPreparation();},2000);
  };
  const fresh=(event:Event)=>{const detail=(event as CustomEvent<{path?:string;source?:string}>).detail;if(detail?.path==='bootstrap'&&detail.source==='network'){bootstrapReady=true;schedule();}};
  window.addEventListener('beforeinstallprompt',offer);window.addEventListener(OFFLINE_EVENT,update);window.addEventListener('mobiup-prepare-shell',requestPreparation);window.addEventListener('mobiup-data-freshness',fresh);window.addEventListener('focus',announceAssets);update();
  navigator.serviceWorker?.addEventListener('controllerchange',schedule);
  if('storage'in navigator)void navigator.storage.persist?.().catch(()=>{});
  if('serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js').then(reg=>{
   if(disposed)return;if(reg.waiting)setWaiting(reg.waiting);
   reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker?.addEventListener('statechange',()=>{if(!disposed&&worker.state==='installed'&&navigator.serviceWorker.controller)setWaiting(worker);});});schedule();
  }).catch(()=>{if(!disposed)setError('Pregătirea offline nu a reușit. Reîncarcă atunci când ai conexiune.');});
  return()=>{disposed=true;if(idleId!==undefined)window.cancelIdleCallback(idleId);if(timerId!==undefined)clearTimeout(timerId);window.removeEventListener('beforeinstallprompt',offer);window.removeEventListener(OFFLINE_EVENT,update);window.removeEventListener('mobiup-prepare-shell',requestPreparation);window.removeEventListener('mobiup-data-freshness',fresh);window.removeEventListener('focus',announceAssets);navigator.serviceWorker?.removeEventListener('controllerchange',schedule);};
 },[]);
 useEffect(()=>{if(!waiting)return;const changed=()=>{if(waiting.state==='activated')setWaiting(null);};waiting.addEventListener('statechange',changed);return()=>waiting.removeEventListener('statechange',changed);},[waiting]);
 return <>{error&&<p className="error-banner" role="alert">{error}</p>}{install&&<button className="secondary" onClick={()=>void install.prompt().then(()=>setInstall(null))}>Instalează aplicația</button>}{waiting&&<output className="muted">Actualizare disponibilă. {pending?'Sincronizează lucrul local înainte de actualizare.':<button onClick={()=>waiting.postMessage({type:'ACTIVATE_SAFE'})}>Activează pentru următoarea deschidere</button>}</output>}</>;
}
