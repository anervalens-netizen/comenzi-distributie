'use client';
import {useEffect,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import {normalizeAnafCui,validAnafCui} from '@/lib/anaf-types';
import type {AnafCompany,AnafResult} from '@/lib/anaf-types';
import './partner-anaf.css';

export function PartnerAnaf({cui,onUseName}:{cui:string;onUseName?:(company:AnafCompany)=>void}){
 const normalized=normalizeAnafCui(cui);
 const [attempt,setAttempt]=useState(0);
 const [state,setState]=useState<{key:string;result?:AnafResult;error?:string}|null>(null);
 const key=normalized+':'+attempt;
 useEffect(()=>{
  if(!validAnafCui(normalized))return;
  const controller=new AbortController();
  const timer=setTimeout(()=>{
   void api<AnafResult>('partner/anaf?cui='+encodeURIComponent(normalized),'GET',undefined,controller.signal)
    .then(result=>{if(!controller.signal.aborted)setState({key,result});})
    .catch(error=>{if(!controller.signal.aborted)setState({key,error:errorMessage(error)});});
  },650);
  return()=>{controller.abort();clearTimeout(timer);};
 },[normalized,key]);
 if(!normalized)return null;
 const valid=validAnafCui(normalized),current=state?.key===key?state:null,result=current?.result,company=result?.company;
 return <section className="partner-anaf" aria-label="Verificare ANAF" aria-live="polite">
  <strong>Verificare ANAF · CUI {normalized}</strong>
  {!valid?<p>CUI invalid: verifică cifrele introduse.</p>:!current?<p>Se verifică firma în ANAF…</p>:<>
   <p>{current.error||result?.message}</p>
   {result?.status==='found'&&company&&<>
    <strong>{company.name}</strong>
    {company.fiscalAddress&&<p>Adresă fiscală: {company.fiscalAddress}</p>}
    {company.registrationNumber&&<p>Registrul Comerțului: {company.registrationNumber}</p>}
    <p>{company.inactive===true?'Atenție: contribuabil inactiv fiscal.':company.inactive===false?'Nu figurează ca inactiv fiscal.':'Inactivitate fiscală: informație indisponibilă.'} · {company.vatRegistered===true?'Plătitor TVA':company.vatRegistered===false?'Neplătitor TVA':'TVA: informație indisponibilă'}</p>
    {company.registrationState&&<p>Stare înregistrare: {company.registrationState}</p>}
    {onUseName&&<><button type="button" className="secondary" onClick={()=>onUseName(company)}>Preia denumirea firmei</button><small>Adresa magazinului se completează separat.</small></>}
   </>}
   {result?.checkedAt&&<small>Verificat la {new Date(result.checkedAt).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})}{result.cached?' · rezultat reutilizat (maximum o oră)':''}</small>}
   <button type="button" className="secondary" onClick={()=>setAttempt(n=>n+1)}>Reîncearcă verificarea</button>
  </>}
 </section>;
}
