'use client';
import {useEffect,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import type {SalesView} from '@/lib/sales-types';
import {DistributionSalesCards} from './distribution-cards';
import {ActivationsPanel} from './activations';
export function DistributionOverview({userId,query,canViewActivations}:{userId:string;query:string;canViewActivations:boolean}){
 const params=new URLSearchParams(query);params.set('month',params.get('months')?.split(',')[0]||new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'}).format(new Date()));const search=params.toString(),key=userId+'|'+search;
 const [result,setResult]=useState<{key:string;data:SalesView}|null>(null),[error,setError]=useState<{key:string;text:string}|null>(null);
 useEffect(()=>{const c=new AbortController();api<SalesView>('sales?'+search,'GET',undefined,c.signal).then(data=>{if(!c.signal.aborted)setResult({key,data});}).catch(e=>{if(!c.signal.aborted)setError({key,text:errorMessage(e)});});return()=>c.abort();},[key,search]);
 const data=result?.key===key?result.data:null;
 return <section aria-label="Sinteză distribuție"><h2>Distribuție · {params.get('months')?.replaceAll(',',' + ')||'Nicio lună'}</h2>{error?.key===key?<p role="alert">{error.text}</p>:data?.distribution?<DistributionSalesCards data={data.distribution}/>:<output>Se încarcă vânzările distribuției…</output>}{canViewActivations&&<ActivationsPanel userId={userId} scopeQuery={query} compact/>}</section>;
}
