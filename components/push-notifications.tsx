'use client';
import { useEffect, useState } from 'react';
import { BellRing, BellOff, LoaderCircle } from 'lucide-react';
import { getCurrentSubscription, getNotificationPermission, isPushSupported, serializeSubscription, subscribe, unsubscribe } from '@mmmike/web-push/client';
import { api, errorMessage } from '@/lib/client-api';

type PushConfig={publicKey:string};
type PushState='checking'|'unsupported'|'default'|'denied'|'enabled'|'disabled';

export function PushNotifications(){
  const [state,setState]=useState<PushState>('checking'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[publicKey,setPublicKey]=useState('');
  useEffect(()=>{
    let cancelled=false;
    void (async()=>{
      if(!isPushSupported()){if(!cancelled)setState('unsupported');return;}
      try{
        const config=await api<PushConfig>('notifications/push');if(cancelled)return;setPublicKey(config.publicKey);
        const permission=getNotificationPermission();
        if(permission==='denied'){setState('denied');return;}
        if(permission!=='granted'){setState('default');return;}
        const current=await getCurrentSubscription();
        if(current){await api('notifications/push','POST',serializeSubscription(current));if(!cancelled)setState('enabled');}
        else if(!cancelled)setState('disabled');
      }catch(err){if(!cancelled){setError(errorMessage(err));setState('disabled');}}
    })();
    return()=>{cancelled=true;};
  },[]);
  async function enable(){
    if(!publicKey||busy)return;setBusy(true);setError('');
    try{
      const result=await subscribe(publicKey);
      if(result.status==='unsupported')setState('unsupported');
      else if(result.status==='denied')setState('denied');
      else{await api('notifications/push','POST',serializeSubscription(result.subscription));setState('enabled');}
    }catch(err){setError(errorMessage(err));}
    finally{setBusy(false);}
  }
  async function disable(){
    if(busy)return;setBusy(true);setError('');
    try{const endpoint=await unsubscribe();if(endpoint)await api('notifications/push','DELETE',{endpoint});setState('disabled');}
    catch(err){setError(errorMessage(err));}
    finally{setBusy(false);}
  }
  const enabled=state==='enabled';
  return <section className="panel push-settings">
    <div className="section-heading">{enabled?<BellRing size={22}/>:<BellOff size={22}/>}<div><h2>Notificări push</h2><p>Primești alerte native când un agent trimite o solicitare de partener nou, inclusiv când PWA este închisă.</p></div></div>
    <div className="push-settings-status"><span className={'badge '+(enabled?'finalized':'draft')}>{state==='checking'?'Se verifică…':state==='unsupported'?'Indisponibil':state==='denied'?'Blocat în browser':enabled?'Active':'Inactive'}</span>
      {state==='unsupported'&&<small>Browserul sau modul curent nu oferă Web Push. Pe iPhone este necesară instalarea PWA pe ecranul principal.</small>}
      {state==='denied'&&<small>Permisiunea a fost refuzată. Reactiveaz-o din setările browserului/PWA, apoi revino aici.</small>}
      {state==='default'&&<small>Activarea va cere permisiunea sistemului o singură dată.</small>}
      {state==='disabled'&&<small>Poți activa notificările pe acest dispozitiv.</small>}
      {enabled&&<small>Acest dispozitiv este abonat la solicitările din aria ta.</small>}
    </div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {!['checking','unsupported','denied'].includes(state)&&<button type="button" className={enabled?'secondary':'primary'} disabled={busy} onClick={()=>void (enabled?disable():enable())}>{busy?<LoaderCircle className="spin" size={18}/>:enabled?<BellOff size={18}/>:<BellRing size={18}/>} {busy?'Se actualizează…':enabled?'Dezactivează pe acest dispozitiv':'Activează notificările'}</button>}
  </section>;
}
