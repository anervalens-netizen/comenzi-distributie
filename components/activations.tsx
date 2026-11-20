'use client';
import {lazy,Suspense,useEffect,useId,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {api,ApiError,errorMessage} from '@/lib/client-api';
import {bucharestMonthKey} from '@/lib/bucharest-month';
import type {ActivationReport,ActivationProvider} from '@/lib/activation-types';
import {activationDateLabel} from '@/lib/activation-labels';
import {OperatorLogo} from './distribution-cards';
import {MonthlyActivationsDialog} from './monthly-activations';
import {activationMonthlyPoints,type ActivationTrendMetric} from '@/lib/activation-monthly';
import {ActivationPartners} from './activation-partners';
import {focusTerritoryLabels} from '@/lib/vodafone-focus-labels';
import type {FocusReport} from '@/lib/vodafone-focus';
import {VodafoneFocusPanel} from './vodafone-focus';
import './activations.css';
const VodafoneBonus=lazy(()=>import('./vodafone-bonus').then(module=>({default:module.VodafoneBonus})));
const number=(n:number)=>n.toLocaleString('ro-RO');
function ActivationMetric({label,value,network,onClick}:{label:string;value:number;network:string;onClick:()=>void}){const id=useId();return <div><dt>{label}</dt><dd><button type="button" className="activation-trend-value" aria-label={'Evoluție lunară · '+label+' · '+network} aria-describedby={id} onClick={onClick}><span id={id}>{number(value)}</span><small aria-hidden="true"> ↗</small></button></dd></div>;}
export function ActivationOperatorCard({userId,query,provider,reload}:{userId:string;query:string;provider:ActivationProvider;reload:number}){
 const [trend,setTrend]=useState<{label:string;metric:ActivationTrendMetric}|null>(null),countId=useId(),network=provider==='vodafone'?'Vodafone':'Digi';
 const openTrend=(label:string,metric:ActivationTrendMetric)=>setTrend({label,metric});
 const params=new URLSearchParams(query);params.set('provider',provider);const search=params.toString(),key=userId+'|'+search+'|'+reload;
 const [read,setRead]=useState<{
   key:string; data?:ActivationReport; complete?:boolean; error?:string;
   focus?:FocusReport[]; focusError?:string; focusUnavailable?:ActivationReport['focusUnavailable'];
 }>();
 useEffect(()=>{
   const controller=new AbortController();
   const path='activations?'+search;
   const fetchReport=(phase?:string)=>api<ActivationReport>(path+(phase?'&overviewPhase='+phase:''),'GET',undefined,controller.signal);
   const update=(fields:Partial<NonNullable<typeof read>>)=>{
     if(!controller.signal.aborted)setRead(old=>({...(old?.key===key?old:{}),key,...fields}));
   };
   let final=false, separateStarted=false, panelError='';
   function scopeFailure(error:unknown) {
     if(!(error instanceof ApiError)||![401,403,404,409].includes(error.status))return false;
     update({error:errorMessage(error),data:undefined,focus:undefined,focusError:undefined,focusUnavailable:undefined});
     controller.abort();
     return true;
   }
   function accept(data:ActivationReport,complete:boolean){
     if(controller.signal.aborted||final)return;
     final=complete;
     update({data,complete:complete||!!panelError,error:panelError||undefined,...(!data.separateFocusScope?{focus:data.focusCards,focusUnavailable:data.focusUnavailable}:{})});
     if(data.separateFocusScope&&!separateStarted){
       separateStarted=true;
       void fetchReport('cards').then(cards=>update({focus:cards.focusCards??[],focusUnavailable:cards.focusUnavailable}),error=>{
         // The restricted Focus request has its own permission scope.
         update({focus:undefined,focusUnavailable:undefined,focusError:errorMessage(error)});
       });
     }
   }
   if(provider==='vodafone'){
     void fetchReport('totals').then(data=>accept(data,false),error=>{if(!controller.signal.aborted)scopeFailure(error);});
     void fetchReport('panels').then(data=>accept(data,true),error=>{
       if(!controller.signal.aborted&&!scopeFailure(error)){
         panelError=errorMessage(error);
         update({error:panelError,complete:true});
       }
     });
   }else{
     void fetchReport().then(data=>accept(data,true),error=>update({error:errorMessage(error)}));
   }
   return()=>controller.abort();
 },[key,search,provider]);
 const current=read?.key===key?read:undefined,data=current?.data,message=!data?current?.error:'';
 const commissionMessage=!current?.complete&&!current?.error?'se calculează…':current?.error||data?.commissionCoverage==='unavailable'?'calcul indisponibil temporar'
   :data?.commissionCoverage==='outside_scope'?'fără gestiuni eligibile în selecție':'fără sursă Vodafone pentru selecție';
 return <article className="panel distribution-card activation-operator" aria-label={'Activări '+provider}>
  <OperatorLogo provider={provider}/>
  {message?<p role="alert">{message}</p>:!data?<output>Se încarcă activările…</output>:!data.available?<p>Nu sunt încă date de activare pentru acest operator.</p>:<>
   <button type="button" className="activation-primary" aria-label={'Evoluție lunară · Activări '+network} aria-describedby={countId} onClick={()=>openTrend('Activări','total')}><span>Activări în perioada selectată</span><strong id={countId}>{number(data.totals.total)}</strong><small>{provider==='digi'?'Suma activărilor lunare · Evoluție lunară ↗':'SIM-uri distincte activate · Evoluție lunară ↗'}</small></button>
   {provider==='vodafone'&&data.productBreakdown&&<dl className="activation-product-breakdown">{(['zero','credit','packages','other','unknown'] as const).filter(key=>key==='zero'||key==='credit'||data.productBreakdown![key]>0).map(key=><ActivationMetric key={key} network={network} label={{zero:'SIM 0',credit:'SIM cu credit',packages:'Pachete telefon + SIM',other:'Alte produse',unknown:'Produs neprecizat'}[key]} value={data.productBreakdown![key]} onClick={()=>openTrend({zero:'SIM 0',credit:'SIM cu credit',packages:'Pachete telefon + SIM',other:'Alte produse',unknown:'Produs neprecizat'}[key],`product:${key}`)}/>)}<small>După produsul din vânzarea internă.</small></dl>}
   <p className="activation-source-date">Sursă până la <strong>{activationDateLabel(data.latestDate)}</strong></p>
   {data.selectedMonths?.some(month=>!data.coveredMonths?.includes(month))&&<output className="activation-coverage-warning">Există luni fără activări raportate în selecție. Acoperirea poate fi incompletă.</output>}
   {provider==='vodafone'&&(data.totals.eligible!==undefined?
     <dl className="activation-eligibility"><ActivationMetric network={network} label="Comisionabile" value={data.totals.eligible} onClick={()=>openTrend('Comisionabile','eligible')}/></dl>
     :<p className="activation-source-date">Comisionabile · {commissionMessage}</p>)}
   {data.commissionCoverage==='partial'&&
     <p className="activation-coverage-warning">Comisionabile · total parțial pentru datele Vodafone disponibile. Verifică acoperirea pe teritorii și luni.</p>}
   {data.simZero&&<section className="activation-sim-zero"><h3>SIM 0 · distribuite în selecție</h3><dl>{(['distributed','activated','withoutReportedActivation'] as const).map(key=><ActivationMetric key={key} network={network} label={{distributed:'Distribuite',activated:'Activate dintre aceleași SIM-uri',withoutReportedActivation:'Fără activare raportată'}[key]} value={data.simZero![key]} onClick={()=>openTrend({distributed:'Distribuite',activated:'Activate dintre aceleași SIM-uri',withoutReportedActivation:'Fără activare raportată'}[key],`cohort:${key}`)}/>)}</dl><small>La data sursei; nu reprezintă stocul fizic.</small></section>}
   <details className="commerce-details"><summary>Detalii despre sursă</summary><p>Ultima activare: {activationDateLabel(data.latestDate)}. Import: {data.importedAt?new Date(data.importedAt).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'}):'—'}.</p>{!!data.totals.unassigned&&<p>Agent de verificat: {number(data.totals.unassigned)}. Incluse o singură dată în total.</p>}{!data.operatorReported&&data.reconciliation!==undefined&&data.reconciliation>0&&<p>În afara distribuției TR: {number(data.reconciliation)}. Excluse din totalul distribuției.</p>}</details>
   <details className="commerce-details"><summary>Pe agent și istoric lunar</summary><div className="distribution-table-scroll">
     <table className="distribution-table"><thead><tr><th>Agent / TR</th><th>Activări</th>{data.totals.eligible!==undefined&&<th>Comisionabile</th>}</tr></thead><tbody>{data.sites.map(site=><tr key={site.site}><th>{site.site||provider==='digi'?site.label:'Agent de verificat'}</th><td>{number(site.total)}</td>{data.totals.eligible!==undefined&&<td>{site.eligible===undefined?'—':number(site.eligible)}</td>}</tr>)}</tbody></table>
     <table className="distribution-table"><thead><tr><th>Luna</th><th>Activări</th>{data.totals.eligible!==undefined&&<th>Comisionabile</th>}</tr></thead><tbody>{data.history.map(month=><tr key={month.month}><th>{month.month}</th><td>{number(month.total)}</td>{data.totals.eligible!==undefined&&<td>{month.eligible===undefined?'—':number(month.eligible)}</td>}</tr>)}</tbody></table>
   </div></details>
   {trend&&<MonthlyActivationsDialog key={trend.metric} title={trend.label+' · '+network} cohort={trend.metric.startsWith('cohort:')} points={activationMonthlyPoints(data,data.selectedMonths||params.get('months')?.split(',').filter(Boolean)||[data.month],trend.metric)} onClose={()=>setTrend(null)}/>}
  </>}
  {provider==='vodafone'&&current?.focusUnavailable?.map(territory=><p key={territory} role="alert">Focus Vodafone {focusTerritoryLabels[territory]} · date indisponibile temporar.</p>)}
  {provider==='vodafone'&&current?.focusError&&<p role="alert">Focus Vodafone · {current.focusError}</p>}
  {provider==='vodafone'&&current?.focus&&<VodafoneFocusPanel key={key} query={search} reports={current.focus}/>}
 </article>;
}
export function ActivationsPanel({userId,scopeQuery='',scopeLabel='Activările mele',compact=false,embedded=false,distributionConfigured=false,refreshVersion=0,manager=false,onContextChange}:{userId:string;scopeQuery?:string;scopeLabel?:string;compact?:boolean;embedded?:boolean;distributionConfigured?:boolean;refreshVersion?:number;manager?:boolean;onContextChange?:(context:{section:string;period:string})=>void}){
 const [selected,setSelected]=useState(()=>bucharestMonthKey(new Date())),[reload,setReload]=useState(0),[view,setView]=useState<'general'|'partners'|'bonuses'>('general');
 const params=new URLSearchParams(scopeQuery);params.set('month',params.get('months')?.split(',')[0]||selected);const query=params.toString(),shared=params.has('months');
 const bonusParams=new URLSearchParams([...params].filter(([key])=>['managerId','agentId','siteCode'].includes(key)));
 const lastSelectedMonth=params.get('months')?.split(',').filter(Boolean).sort().at(-1) || selected;
 bonusParams.set('month',lastSelectedMonth);
 const bonusScope=bonusParams.toString();
 const section=view==='bonuses'?'Prepay › Bonusuri Vodafone':view==='partners'?'Prepay › Activări pe partener':'Prepay › Activări';
 const period=view==='bonuses'?lastSelectedMonth:shared?params.get('months')!.split(',').filter(Boolean).join(', '):selected;
 useEffect(()=>{onContextChange?.({section,period});},[onContextChange,section,period]);
 return <div className="activation-workspace">{!compact&&!embedded&&<div className="page-heading"><div><span className="eyebrow">ACTIVĂRI SIM</span><h1>Activări</h1><p>{scopeLabel}</p></div><button className="icon-button refresh" aria-label="Actualizează activările" onClick={()=>setReload(v=>v+1)}><RefreshCw size={19}/></button></div>}{!compact&&<div className="distribution-partner-toolbar">{!shared&&<label>Luna activării<input type="month" aria-label="Luna activării" value={selected} onChange={e=>{if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(e.target.value))setSelected(e.target.value);}}/></label>}<button type="button" className="secondary" aria-pressed={view==='general'} onClick={()=>setView('general')}>Vedere generală</button>{distributionConfigured&&<button type="button" className="secondary" aria-pressed={view==='partners'} onClick={()=>setView('partners')}>Pe partener</button>}{manager&&distributionConfigured&&<button type="button" className="secondary" aria-pressed={view==='bonuses'} onClick={()=>setView('bonuses')}>Bonusuri Vodafone</button>}</div>}{view==='general'||compact?<><div className="distribution-operators">{(['vodafone','digi'] as const).map(provider=><ActivationOperatorCard key={provider} userId={userId} query={query} provider={provider} reload={reload+refreshVersion}/>)}</div><p className="activation-note">Activările sunt grupate după data activării, inclusiv pentru SIM-uri distribuite în anii anteriori. Fiecare operator are propria sursă și dată de actualizare.</p></>:view==='bonuses'&&manager?<Suspense fallback={<output>Se încarcă bonusurile Vodafone…</output>}><VodafoneBonus key={userId+'|'+bonusScope+'|'+refreshVersion} scopeQuery={bonusScope}/></Suspense>:<ActivationPartners key={userId+'|'+query} userId={userId} query={query} reload={reload+refreshVersion}/>}</div>;
}
