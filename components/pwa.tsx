'use client';
import {useEffect,useState} from 'react';
import {pendingOperations,OFFLINE_EVENT} from '@/lib/offline-work';
import {currentLocalWorkGeneration,currentLocalWorkUserId} from '@/lib/local-work';
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
 // An older controller can retire caches on this message. Do not give it
 // cleanup proof while a different version is installing or waiting.
 void navigator.serviceWorker.getRegistration().then(reg=>{
  if(reg&&reg.active===worker&&!reg.waiting&&!reg.installing&&navigator.serviceWorker.controller===worker)worker.postMessage({type:'CLIENT_SHELL_ASSETS',paths});
 }).catch(()=>{});
}
/** A dedicated port binds every acknowledgement to the exact worker object. */
function prepareWorker(worker:ServiceWorker,onProgress:(detail:OfflineShellPreparationDetail)=>void):Promise<OfflineShellPreparationDetail>{
 return new Promise((resolve,reject)=>{
  const channel=new MessageChannel();
  let timer:ReturnType<typeof setTimeout>|undefined,settled=false;
  const finish=(error?:Error,detail?:OfflineShellPreparationDetail)=>{
   if(settled)return;settled=true;clearTimeout(timer);channel.port1.close();channel.port2.close();worker.removeEventListener('statechange',changed);
   if(error)reject(error);else resolve(detail!);
  };
  const changed=()=>{if(worker.state==='redundant')finish(new Error('Versiunea disponibilă s-a schimbat. Reîncearcă pregătirea.'));};
  const arm=(ms:number)=>{clearTimeout(timer);timer=setTimeout(()=>finish(new Error('Pregătirea interfeței a expirat. Reîncearcă.')),ms);};
  worker.addEventListener('statechange',changed);changed();if(settled)return;arm(5000);
  channel.port1.onmessage=event=>{
   if(settled)return;
   const message=event.data;
   if(message?.type!=='OFFLINE_SHELL_PREPARATION'||!['preparing','ready','error'].includes(message.state))return;
   if(!Number.isInteger(message.completed)||!Number.isInteger(message.total)||message.completed<0||message.total<message.completed)return;
   const detail:OfflineShellPreparationDetail={state:message.state,completed:message.completed,total:message.total,...(typeof message.error==='string'?{error:message.error}:{})};
   if(detail.state==='preparing'){onProgress(detail);arm(30000);return;}
   if(detail.state==='ready'&&detail.completed===detail.total)finish(undefined,detail);
   else finish(new Error(detail.error||'Pregătirea offline nu a reușit'));
  };
  channel.port1.start();
  try{worker.postMessage({type:'PREPARE_OFFLINE_SHELL'},[channel.port2]);}catch(error){finish(error instanceof Error?error:new Error(String(error)));}
 });
}
/** Prepare both this document's worker and the exact waiting version, without activating either. */
export function prepareOfflineShell():Promise<OfflineShellPreparationDetail>{
 if(preparation)return preparation;
 preparation=(async()=>{
  publish({state:'preparing',completed:0,total:0});
  try{
   if(!('serviceWorker'in navigator))throw new Error('Service Worker indisponibil');
   const registration=await deadline(navigator.serviceWorker.ready,15000,'Interfața offline nu este încă instalată. Reîncearcă după încărcare.');
   const active=navigator.serviceWorker.controller??registration.active,waiting=registration.waiting;
   if(!active)throw new Error('Service Worker inactiv');
   const workers=[...new Set([active,...(waiting?[waiting]:[])])];
   let completed=0,total=0;
   for(const worker of workers){
    const result=await prepareWorker(worker,detail=>publish({...detail,completed:completed+detail.completed,total:total+detail.total}));
    completed+=result.completed;total+=result.total;
   }
   if((navigator.serviceWorker.controller??registration.active)!==active||registration.waiting!==waiting||registration.installing||workers.some(worker=>worker.state==='redundant'))throw new Error('Versiunea disponibilă s-a schimbat. Reîncearcă pregătirea.');
   const result:OfflineShellPreparationDetail={state:'ready',completed,total};
   publish(result);announceAssets();return result;
  }catch(error){publish({state:'error',completed:shellPreparation.completed,total:shellPreparation.total,error:error instanceof Error?error.message:String(error)});throw error;}
 })().finally(()=>{preparation=null;});
 return preparation;
}
export function PwaInstall(){
 const [install,setInstall]=useState<InstallEvent|null>(null),[waiting,setWaiting]=useState<ServiceWorker|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(true),[activating,setActivating]=useState(false);
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
  const controllerChanged=()=>{publish({state:'preparing',completed:0,total:0});schedule();};
  navigator.serviceWorker?.addEventListener('controllerchange',controllerChanged);
  if('storage'in navigator)void navigator.storage.persist?.().catch(()=>{});
  if('serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js').then(reg=>{
   if(disposed)return;if(reg.waiting){setWaiting(reg.waiting);publish({state:'preparing',completed:0,total:0});}
   reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker?.addEventListener('statechange',()=>{if(!disposed&&worker.state==='installed'&&navigator.serviceWorker.controller){setWaiting(worker);publish({state:'preparing',completed:0,total:0});schedule();}});});schedule();
  }).catch(()=>{if(!disposed)setError('Pregătirea offline nu a reușit. Reîncarcă atunci când ai conexiune.');});
  return()=>{disposed=true;if(idleId!==undefined)window.cancelIdleCallback(idleId);if(timerId!==undefined)clearTimeout(timerId);window.removeEventListener('beforeinstallprompt',offer);window.removeEventListener(OFFLINE_EVENT,update);window.removeEventListener('mobiup-prepare-shell',requestPreparation);window.removeEventListener('mobiup-data-freshness',fresh);window.removeEventListener('focus',announceAssets);navigator.serviceWorker?.removeEventListener('controllerchange',controllerChanged);};
 },[]);
 useEffect(()=>{if(!waiting)return;const changed=()=>{if(waiting.state==='activated'||waiting.state==='redundant'){setWaiting(null);if(waiting.state==='redundant')publish({state:'preparing',completed:0,total:0});}};waiting.addEventListener('statechange',changed);return()=>waiting.removeEventListener('statechange',changed);},[waiting]);
 const activate=async()=>{
  if(!waiting||activating)return;
  const worker=waiting,userId=currentLocalWorkUserId(),generation=currentLocalWorkGeneration();setActivating(true);setError('');
  publish({state:'preparing',completed:0,total:0});
  try{
   const reg=await navigator.serviceWorker.getRegistration();
   if(!reg||reg.waiting!==worker)throw new Error('Versiunea disponibilă s-a schimbat. Reîncearcă.');
   // Older active workers may not implement preparation. Activation needs proof
   // from the waiting worker itself, and still leaves the current document open.
   const prepared=await prepareWorker(worker,publish);
   const rows=await pendingOperations(userId);
   if(currentLocalWorkUserId()!==userId||currentLocalWorkGeneration()!==generation||rows.length){setPending(true);throw new Error('Lucrul local trebuie verificat înainte de actualizare.');}
   if(reg.waiting!==worker||reg.installing||worker.state!=='installed')throw new Error('Versiunea disponibilă s-a schimbat. Reîncearcă.');
   publish({state:'preparing',completed:0,total:0});
   await new Promise<void>((resolve,reject)=>{
    const changed=()=>{if(navigator.serviceWorker.controller===worker){cleanup();resolve();}};
    const cleanup=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',changed);};
    const timer=setTimeout(()=>{cleanup();reject(new Error('Activarea nu a fost confirmată. Reîncearcă.'));},15000);
    navigator.serviceWorker.addEventListener('controllerchange',changed);
    try{worker.postMessage({type:'ACTIVATE_SAFE'});changed();}catch(error){cleanup();reject(error);}
   });
   if(reg.active!==worker||reg.waiting||reg.installing||['redundant'].includes(worker.state))throw new Error('Versiunea disponibilă s-a schimbat. Reîncearcă pregătirea.');
   publish(prepared);
  }catch(error){const message=error instanceof Error?error.message:String(error);setError(message);publish({state:'error',completed:0,total:0,error:message});}
  finally{setActivating(false);}
 };
 return <>{error&&<p className="error-banner" role="alert">{error}</p>}{install&&<button className="secondary" onClick={()=>void install.prompt().then(()=>setInstall(null))}>Instalează aplicația</button>}{waiting&&<output className="muted">Actualizare disponibilă. {pending?'Sincronizează lucrul local înainte de actualizare.':<button disabled={activating} onClick={()=>void activate()}>Activează pentru următoarea deschidere</button>}</output>}</>;
}
