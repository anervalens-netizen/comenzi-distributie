'use client';
import {useEffect,useMemo,useState} from 'react';
import {AlertTriangle} from 'lucide-react';
import {api,errorMessage} from '@/lib/client-api';
import {bucharestReportingMonthKey} from '@/lib/bucharest-month';
import type {ClientSalesResult} from '@/lib/client-sales-types';
import type {PartnerFollowUp} from '@/lib/partner-portfolio-types';
import type {PartnerSummary} from '@/lib/partner-map-types';
import {positionNeedsConfirmation} from '@/lib/partner-position';
import {OFFLINE_EVENT,pendingOperations,type PendingOperation} from '@/lib/offline-work';

type Reconciliation={state:'ready';total:number;window:{imported:boolean};exceptions:{key:string;reason:string}[]};
type AttentionItem={key:string;title:string;reason:string;action:string;run:()=>void};

const day=(value:string|null|undefined)=>value?value.split('-').reverse().join('.'):'indisponibilă';
const moment=(value:string|null|undefined)=>value?new Date(value).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'}):'indisponibil';

export function PartnerAttention({userId,manager,scopeQuery,partners,onOpen,onPlanning,onSales}:{userId:string;manager:boolean;scopeQuery:string;partners:PartnerSummary[];onOpen:(id:string)=>void;onPlanning:()=>void;onSales:()=>void}){
  const [local,setLocal]=useState<PendingOperation[]>([]),[followUps,setFollowUps]=useState<PartnerFollowUp[]>([]),[sales,setSales]=useState<ClientSalesResult|null>(null),[reconciliation,setReconciliation]=useState<Reconciliation|null>(null),[error,setError]=useState('');
  useEffect(()=>{let alive=true;const refresh=()=>void pendingOperations(userId).then(rows=>{if(alive)setLocal(rows.filter(row=>row.path.startsWith('partner/')));}).catch(e=>{if(alive)setError(errorMessage(e));});refresh();window.addEventListener(OFFLINE_EVENT,refresh);return()=>{alive=false;window.removeEventListener(OFFLINE_EVENT,refresh);};},[userId]);
  useEffect(()=>{let alive=true;const controller=new AbortController(),month=bucharestReportingMonthKey(new Date()),params=new URLSearchParams(scopeQuery);params.set('month',month);params.set('page','0');
    const reads:Promise<void>[]=[api<{followUps:PartnerFollowUp[]}>('partner/attention?'+new URLSearchParams(scopeQuery),'GET',undefined,controller.signal).then(value=>{if(alive)setFollowUps(Array.isArray(value.followUps)?value.followUps:[]);}),api<ClientSalesResult>('sales/clients?'+params,'GET',undefined,controller.signal,{preferCache:true,maxAgeMs:30000}).then(value=>{if(alive)setSales(value);})];
    if(manager)reads.push(api<Reconciliation>('sales/clients/reconciliation?'+new URLSearchParams({month,page:'0'}),'GET',undefined,controller.signal,{preferCache:true,maxAgeMs:30000}).then(value=>{if(alive)setReconciliation(value);}));
    void Promise.allSettled(reads).then(results=>{if(alive){const failed=results.find(result=>result.status==='rejected') as PromiseRejectedResult|undefined;setError(failed?errorMessage(failed.reason):'');}});return()=>{alive=false;controller.abort();};
  },[manager,scopeQuery]);
  const ready=sales?.state==='ready'?sales:null;
  const items=useMemo(()=>{
    const unique=new Map<string,AttentionItem>(),add=(item:AttentionItem)=>{if(!unique.has(item.key))unique.set(item.key,item);};
    for(const state of ['blocked','pending'] as const){const rows=local.filter(row=>row.state===state),row=rows[0];if(!row)continue;const match=row.path.match(/^partner\/portfolio\/([^/]+)/),partnerId=match?decodeURIComponent(match[1]):'';add({key:'local:'+state,title:state==='blocked'?`Lucru local de verificat · ${rows.length}`:`Sincronizări locale în așteptare · ${rows.length}`,reason:`${row.error||'Operațiunea nu este încă confirmată de server.'} Vizibil doar pe acest dispozitiv și în contul curent.`,action:partnerId?'Deschide prima fișă':'Deschide planul',run:()=>partnerId?onOpen(partnerId):onPlanning()});}
    for(const row of followUps.slice(0,3))add({key:`follow:${row.customerId}:${row.agentId}:${row.followUpDate}`,title:`Revenire scadentă · ${row.customerName}`,reason:`${row.nextStep||'Revenire la partener'} · planificată pentru ${day(row.followUpDate)}${manager?` · ${row.agentName}`:''}.`,action:'Deschide fișa',run:()=>onOpen(row.customerId)});
    const positions=partners.filter(positionNeedsConfirmation),firstPosition=positions[0];if(firstPosition)add({key:'position:page',title:`Poziții de confirmat · ${positions.length}`,reason:firstPosition.latitude===null?`${firstPosition.name}: nu există un pin înregistrat în pagina curentă.`:`${firstPosition.name}: pin aproximativ sau cu proveniență neconfirmată; nu indică o vizită și nu permite o estimare exactă.`,action:'Confirmă prima poziție',run:()=>onOpen(firstPosition.id)});
    if(ready){
      const signals:[keyof typeof ready.counts,string,string][]=[['new','Clienți noi','Prima facturare recentă'],['repeat','Repetări noi','Repetare observată în istoricul existent'],['waiting','Repetare în așteptare','Fereastra de observație nu s-a încheiat'],['overdue','Revenire comercială de verificat','Semnal scadent conform istoricului acoperit'],['reactivated','Clienți reactivați','Activitate reluată după o pauză acoperită']];
      const active=signals.filter(([key])=>ready.counts[key]);if(active.length)add({key:'sales:signals',title:'Semnale comerciale existente',reason:active.map(([key,title])=>`${title}: ${ready.counts[key]}`).join(' · ')+'. Fiecare stare păstrează definiția și acoperirea raportului pe clienți.',action:'Deschide raportul pe clienți',run:onSales});
      if(!ready.window.imported||!ready.window.covered)add({key:'coverage:'+ready.month,title:ready.window.imported?'Acoperire sursă de verificat':'Lună fără sursă importată',reason:`Încărcare: ${moment(ready.source.updatedAt)}. Acoperire efectivă până la ${day(ready.source.effectiveCutoff)}. Alerta este bazată pe acoperire, nu pe numărul de zile trecute.`,action:'Deschide sursa și acoperirea',run:onSales});
    }
    if(manager&&reconciliation?.total)add({key:'crm:national',title:`Excepții CRM facturate · ${reconciliation.total}`,reason:'Reconciliere națională T09: firme inactive/absente sau identități neasociate, fără alocare forțată la un punct.',action:'Deschide reconcilierea CRM',run:onSales});
    return [...unique.values()];
  },[followUps,local,manager,onOpen,onPlanning,onSales,partners,ready,reconciliation]);
  if(!items.length&&!error&&!ready)return null;
  return <section className="partner-attention" aria-label="Necesită atenție"><header><span><AlertTriangle size={18}/><strong>Necesită atenție</strong></span><small>Acțiuni, nu clasament</small></header>{error&&<p className="muted">Unele semnale nu au putut fi actualizate: {error}</p>}<div>{items.map(item=><article key={item.key}><span><strong>{item.title}</strong><small>{item.reason}</small></span><button type="button" className="quiet" onClick={item.run}>{item.action}</button></article>)}</div>{followUps.length>3&&<p className="muted">Sunt afișate primele 3 reveniri scadente; deschide planul pentru restul.</p>}{ready&&<footer>Încărcare sursă: {moment(ready.source.updatedAt)} · acoperire efectivă: {day(ready.source.effectiveCutoff)}. „Fără vizite” înseamnă doar lipsă de înregistrări.</footer>}</section>;
}
