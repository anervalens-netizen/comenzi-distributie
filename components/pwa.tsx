'use client';
import {useEffect,useState} from 'react';
import {pendingOperations,OFFLINE_EVENT} from '@/lib/offline-work';
import {currentLocalWorkUserId} from '@/lib/local-work';
type InstallEvent=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>};
export function PwaInstall(){
 const [install,setInstall]=useState<InstallEvent|null>(null),[waiting,setWaiting]=useState<ServiceWorker|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
 useEffect(()=>{const offer=(event:Event)=>{event.preventDefault();setInstall(event as InstallEvent);};window.addEventListener('beforeinstallprompt',offer);
  const update=()=>void pendingOperations(currentLocalWorkUserId()).then(rows=>setPending(rows.length>0)).catch(()=>setPending(true));window.addEventListener(OFFLINE_EVENT,update);update();
  if('storage'in navigator)void navigator.storage.persist?.().catch(()=>{});
  if('serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js').then(reg=>{if(reg.waiting)setWaiting(reg.waiting);reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)setWaiting(worker);});});}).catch(()=>setError('Pregătirea offline nu a reușit. Reîncarcă atunci când ai conexiune.'));
  return()=>{window.removeEventListener('beforeinstallprompt',offer);window.removeEventListener(OFFLINE_EVENT,update);};
 },[]);
 useEffect(()=>{if(!waiting)return;const changed=()=>{if(waiting.state==='activated')setWaiting(null);};waiting.addEventListener('statechange',changed);return()=>waiting.removeEventListener('statechange',changed);},[waiting]);
 return <>{error&&<p className="error-banner" role="alert">{error}</p>}{install&&<button className="secondary" onClick={()=>void install.prompt().then(()=>setInstall(null))}>Instalează aplicația</button>}{waiting&&<output className="muted">Actualizare disponibilă. {pending?'Sincronizează lucrul local înainte de actualizare.':<button onClick={()=>waiting.postMessage({type:'ACTIVATE_SAFE'})}>Activează pentru următoarea deschidere</button>}</output>}</>;
}
