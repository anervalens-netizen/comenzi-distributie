import {fail,sha256} from './server';
/** Opaque, query-bound revision. Page/offset are deliberately not identity. */
export function paginationRevision(params:URLSearchParams,inputs:unknown,clock=0){
 const query=[...params].filter(([key])=>!['revision','page','offset'].includes(key)).sort(([a,av],[b,bv])=>a.localeCompare(b)||av.localeCompare(bv));
 const revision=clock+'.'+sha256(JSON.stringify([query,inputs,clock]));
 if(params.has('revision')&&params.get('revision')!==revision)fail(409,'Revizia paginării s-a schimbat. Reîncepe de la prima pagină fără tokenul de revizie.');
 return revision;
}
export function paginationClock(params:URLSearchParams){
 if(!params.has('revision'))return Date.now();
 const raw=params.get('revision')!.split('.')[0],clock=Number(raw);
 if(!/^\d{13}$/.test(raw)||!Number.isSafeInteger(clock)||clock>Date.now())fail(409,'Revizia paginării este invalidă. Reîncepe de la prima pagină.');
 return clock;
}
