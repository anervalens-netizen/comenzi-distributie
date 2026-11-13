import {normalizeAnafCui, validAnafCui} from './anaf-types.ts';
import type {AnafResult} from './anaf-types.ts';

const endpoint='https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
const boolean=(v:unknown)=>typeof v==='boolean'?v:null;
function day(now:number){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
 return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-');
}
// One bounded instance per application process. No persistent customer mutation.
export function createAnafLookup({fetcher=fetch,clock=Date.now,timeoutMs=8000,intervalMs=1100}:
 {fetcher?:typeof fetch;clock?:()=>number;timeoutMs?:number;intervalMs?:number}={}){
 const cache=new Map<string,{at:number;result:AnafResult}>();
 const pending=new Map<string,Promise<AnafResult>>();
 let nextStart=0;
 async function lookup(raw:string):Promise<AnafResult>{
  const cui=normalizeAnafCui(raw),now=clock(),queriedFor=day(now);
  const base={source:'ANAF' as const,cui,queriedFor,checkedAt:null};
  if(!validAnafCui(cui))return {...base,status:'invalid',message:'CUI invalid: verifică cifrele introduse.'};
  const key=queriedFor+':'+cui,cached=cache.get(key);
  if(cached&&now-cached.at<3600000)return {...cached.result,cached:true};
  const inflight=pending.get(key);if(inflight)return inflight;
  if(pending.size||now<nextStart)return {...base,status:'unavailable',message:'Verificarea ANAF este ocupată. Reîncearcă în câteva secunde.'};
  nextStart=now+intervalMs;
  const work=(async():Promise<AnafResult>=>{
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
   try{
    const response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify([{cui:Number(cui),data:queriedFor}]),signal:controller.signal,redirect:'error'});
    if((!response.ok&&response.status!==404)||!response.body)throw new Error('upstream');
    const reader=response.body.getReader();let size=0,body='';const decoder=new TextDecoder();
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072)throw new Error('oversize');body+=decoder.decode(value,{stream:true});}body+=decoder.decode();}
    finally{await reader.cancel().catch(()=>{});}
    const payload=record(JSON.parse(body));
    if(('cod' in payload&&payload.cod!==200)||!Array.isArray(payload.found)||!Array.isArray(payload.notFound))throw new Error('shape');
    const entries=payload.found.map(record).filter(item=>String(record(item.date_generale).cui)===cui);
    let result:AnafResult;
    if(response.ok&&entries.length===1){
     const entry=entries[0],general=record(entry.date_generale),name=text(general.denumire,200);
     if(!name||general.data!==queriedFor||payload.notFound.some(v=>String(v)===cui))throw new Error('mismatched');
     result={...base,checkedAt:new Date(clock()).toISOString(),status:'found',message:'Firmă identificată în ANAF.',company:{cui,name,fiscalAddress:text(general.adresa),registrationNumber:text(general.nrRegCom,100),registrationState:text(general.stare_inregistrare,200),vatRegistered:boolean(record(entry.inregistrare_scop_Tva).scpTVA),inactive:boolean(record(entry.stare_inactiv).statusInactivi)}};
    }else if(!payload.found.length&&payload.notFound.some(v=>String(v)===cui)){
     result={...base,checkedAt:new Date(clock()).toISOString(),status:'not_found',message:'CUI negăsit în răspunsul ANAF. Verifică datele firmei.'};
    }else throw new Error('mismatched');
    if(cache.size>=500)cache.delete(cache.keys().next().value!);
    cache.set(key,{at:clock(),result});return result;
   }catch{
    return {...base,status:'unavailable',message:'Verificare ANAF indisponibilă momentan. Poți continua manual și reîncerca.'};
   }finally{clearTimeout(timer);}
  })();
  pending.set(key,work);
  try{return await work;}finally{pending.delete(key);}
 }
 return lookup;
}
export const lookupAnafCompany=createAnafLookup();
