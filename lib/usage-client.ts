import {USAGE_IDLE_MS,USAGE_PULSE_MS,type UsagePulse} from './usage-model';
export class UsageTimeline {
  last:number; interacted:number; visible:boolean; spans:{start:number;end:number;active:boolean}[]=[];
  constructor(now:number,visible:boolean){this.last=now;this.interacted=now;this.visible=visible;}
  sample(now:number){
    const start=this.last;this.last=now;
    // A suspended/throttled process cannot attest to elapsed foreground time.
    if(!this.visible||now<=start||now-start>45_000)return;
    const activeEnd=Math.min(now,this.interacted+USAGE_IDLE_MS);
    const add=(a:number,b:number,active:boolean)=>{if(b<=a)return;const prev=this.spans.at(-1);if(prev&&prev.active===active&&prev.end===a)prev.end=b;else this.spans.push({start:a,end:b,active});};
    add(start,activeEnd,true);add(Math.max(start,activeEnd),now,false);
  }
  interact(now:number){this.sample(now);this.interacted=now;}
  visibility(now:number,visible:boolean){this.sample(now);this.visible=visible;}
  take(now:number){this.sample(now);const spans=this.spans;this.spans=[];return spans.filter(s=>s.end>now-90_000).slice(-24).map(s=>({from:Math.min(90_000,now-s.start),to:Math.max(0,now-s.end),active:s.active}));}
}
export function startUsageTracking(owner:string,screen:()=>string){
  const now=()=>performance.now();let timeline=new UsageTimeline(now(),document.visibilityState==='visible');
  let id=crypto.randomUUID(),seq=0,inFlight=false,stopped=false,backoff=0,day=new Date().toISOString().slice(0,10);
  const send=(closed=false)=>{
    if(stopped||(!closed&&inFlight))return;
    const at=now(),spans=timeline.take(at);
    if(!closed&&at<backoff)return;
    const pulse:UsagePulse={owner,id,seq:++seq,screen:screen(),closed,spans};
    inFlight=true;
    void fetch('/api/usage/pulse',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Operation-User':owner},body:JSON.stringify(pulse),keepalive:closed,signal:AbortSignal.timeout(5000)})
      .then(async response=>{if(!response.ok||((await response.json()) as {recorded?:boolean}).recorded!==true)backoff=now()+60_000;})
      .catch(()=>{backoff=now()+60_000;}).finally(()=>{inFlight=false;});
  };
  const restart=()=>{id=crypto.randomUUID();seq=0;timeline=new UsageTimeline(now(),document.visibilityState==='visible');day=new Date().toISOString().slice(0,10);};
  const visibility=()=>{
    const visible=document.visibilityState==='visible';timeline.visibility(now(),visible);
    if(visible){restart();send();}else send(true);
  };
  const interact=()=>{if(!stopped)timeline.interact(now());};
  const pagehide=()=>{timeline.visibility(now(),false);send(true);};
  const pageshow=(event:PageTransitionEvent)=>{if(event.persisted){restart();send();}};
  const logout=()=>{send(true);restart();};
  const events=['pointerdown','keydown','scroll','touchstart'] as const;
  for(const event of events)window.addEventListener(event,interact,{passive:true});
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',pagehide);window.addEventListener('pageshow',pageshow);window.addEventListener('mobiup-usage-logout',logout);
  const timer=setInterval(()=>{if(!stopped&&document.visibilityState==='visible'){
    if(day!==new Date().toISOString().slice(0,10)){send(true);restart();}send();
  }},USAGE_PULSE_MS);
  if(document.visibilityState==='visible')send();
  return ()=>{send(true);stopped=true;clearInterval(timer);for(const event of events)window.removeEventListener(event,interact);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',pageshow);window.removeEventListener('mobiup-usage-logout',logout);};
}
