'use client';

import {useEffect, useRef, useState} from 'react';
import {useAiApi} from './api-context';

export function MessagePresentation({conversationId,messageId}:{conversationId:string;messageId:string}) {
  const api=useAiApi();
  const holder=useRef<HTMLDivElement>(null);
  const [loaded,setLoaded]=useState<{api:typeof api; conversationId:string; messageId:string; panel:React.ReactNode}>();
  useEffect(() => {
    let active=true;
    const load=() => Promise.all([api.getPresentation(conversationId,messageId),import('./PresentationSurface')])
      .then(([data,{default:Surface}]) => {
        if(active) setLoaded({api,conversationId,messageId,panel:<Surface data={data} id={messageId}/>});
      }).catch(() => {
        if(active) setLoaded({api,conversationId,messageId,panel:<p>Fișa nu este disponibilă pentru selecția curentă.</p>});
      });
    let observer:IntersectionObserver | undefined;
    if(holder.current && typeof IntersectionObserver!=='undefined') {
      observer=new IntersectionObserver(entries=>{
        if(entries.some(entry=>entry.isIntersecting)) {
          observer?.disconnect();
          void load();
        }
      },{rootMargin:'200px'});
      observer.observe(holder.current);
    } else { void load(); }
    return () => { active=false; observer?.disconnect(); };
  },[api,conversationId,messageId]);
  return <div ref={holder} className="mt-3 min-h-px">
    {loaded?.api===api && loaded.conversationId===conversationId && loaded.messageId===messageId && loaded.panel}
  </div>;
}
