'use client';
import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {RefreshCw,Package,Smartphone,Users,Search,ArrowRight} from 'lucide-react';
import {api,errorMessage,invalidateApiReadCache,money} from '@/lib/client-api';
import {bucharestReportingMonthKey} from '@/lib/bucharest-month';
import type {SalesProduct,SalesView} from '@/lib/sales-types';
import {managerCategoryLabels,managerCategoryRows,managerProductCategory,type ManagerProductCategory} from '@/lib/manager-sales-report';
import {DistributionSalesCards,Metric} from './distribution-cards';
import {ActivationsPanel} from './activations';
import {ReportPeriod,periodLabel} from './report-period';
import './manager-commerce.css';

const ClientSales=lazy(()=>import('./client-sales'));
const number=(value:number)=>value.toLocaleString('ro-RO');
function useReport(userId:string,query:string,reload:number,enabled=true){
  const params=new URLSearchParams(query);params.set('month',params.get('months')?.split(',')[0]||params.get('month')||bucharestReportingMonthKey(new Date()));
  const search=params.toString(),key=userId+'|'+search,[result,setResult]=useState<{key:string;value:SalesView}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null),lastReload=useRef(reload);
  useEffect(()=>{if(!enabled)return;const controller=new AbortController(),forceRefresh=lastReload.current!==reload;lastReload.current=reload;api<SalesView>('sales?'+search,'GET',undefined,controller.signal,{preferCache:true,maxAgeMs:15000,forceRefresh}).then(value=>{if(!controller.signal.aborted){setResult({key,value});setFailure(null);}}).catch(error=>{if(!controller.signal.aborted)setFailure({key,message:errorMessage(error)});});return()=>controller.abort();},[key,search,reload,enabled]);
  return {data:result?.key===key?result.value:null,error:failure?.key===key?failure.message:''};
}
function useSalesRefresh(){
  const [reload,setReload]=useState(0);
  useEffect(()=>{const refresh=()=>{invalidateApiReadCache('sales');setReload(value=>value+1);};window.addEventListener('sales-imported',refresh);return()=>window.removeEventListener('sales-imported',refresh);},[]);
  return {reload,refresh:()=>setReload(value=>value+1)};
}
function ReportStatus({data,error}:{data:SalesView|null;error:string}){
  if(error)return <p className="error-banner" role="alert">{error}</p>;
  if(!data)return <output className="commerce-loading">Se încarcă vânzările…</output>;
  if(data.distribution?.missingMonths.length)return <output className="commerce-source-warning">Fără import în {periodLabel(data.distribution.missingMonths)}. Valorile afișate acoperă doar lunile importate.</output>;
  if(!data.filename)return <p className="commerce-source-warning">Nu există vânzări importate pentru perioada aleasă.</p>;
  return null;
}
function SalesCoverage({data}:{data:SalesView}){
  const from=data.daily.map(day=>day.date).sort()[0],to=data.daily.map(day=>day.date).sort().at(-1);
  return <p className="commerce-source">{from&&to?`Vânzări raportate: ${from.split('-').reverse().join('.')} – ${to.split('-').reverse().join('.')}`:'Fără vânzări în selecție'}{data.importedAt&&(!data.distribution||data.distribution.months.length===1)?` · Import ${new Date(data.importedAt).toLocaleDateString('ro-RO',{timeZone:'Europe/Bucharest'})}`:''}. Cantități și valori nete, cu retururi.</p>;
}
function ProductDetails({products,label}:{products:SalesProduct[];label:string}){
  const [query,setQuery]=useState(''),[limit,setLimit]=useState(30);
  const filtered=products.filter(product=>`${product.itemName} ${product.itemCode} ${product.brand}`.toLocaleLowerCase('ro').includes(query.toLocaleLowerCase('ro')));
  return <details className="commerce-details"><summary>{label} <span>{products.length}</span></summary><label className="commerce-search"><Search size={16}/><input aria-label={'Caută · '+label} placeholder="Caută produs sau cod" value={query} onChange={event=>{setQuery(event.target.value);setLimit(30);}}/></label><div className="distribution-table-scroll"><table className="distribution-table commerce-product-table"><thead><tr><th>Produs</th><th>Cantitate</th><th>Valoare</th></tr></thead><tbody>{filtered.slice(0,limit).map((product,index)=><tr key={JSON.stringify([product.itemCode,product.itemName,index])}><th>{product.itemName}<small>{product.itemCode}{product.brand?' · '+product.brand:''}</small></th><td>{number(product.quantity)}</td><td>{money(product.value)}</td></tr>)}</tbody></table></div>{!filtered.length&&<p>Niciun produs pentru această căutare.</p>}{filtered.length>limit&&<button className="secondary" onClick={()=>setLimit(value=>value+30)}>Arată încă {Math.min(30,filtered.length-limit)}</button>}</details>;
}
function CategoryReport({data,other=false}:{data:SalesView;other?:boolean}){
  const categories:ManagerProductCategory[]=other?['phones','vouchers','other']:['accessories','varta','scent'];
  const rows=managerCategoryRows(data.products).filter(row=>categories.includes(row.category));
  const detailedRows=other?rows:rows.filter(row=>row.category==='accessories');
  return <><div className="commerce-category-cards">{categories.map(category=>{
    const subset=rows.filter(row=>row.category===category),quantity=subset.reduce((sum,row)=>sum+row.quantity,0),valueCents=subset.reduce((sum,row)=>sum+row.valueCents,0);
    const authoritative=category==='accessories'||category==='varta'||category==='scent'?data.distribution?.groups[category]:null;
    return <article className="panel commerce-category-card" key={category}><h2>{managerCategoryLabels[category]}</h2><strong>{number(authoritative?.quantity??quantity)} <small>buc.</small></strong><b>{money((authoritative?.valueCents??valueCents)/100)}</b></article>;
  })}</div>
    <section className="panel commerce-categories"><div className="panel-heading"><h2>{other?'Categorii și produse':'Vânzări pe categorii'}</h2><span className="count-pill">{detailedRows.length}</span></div>{detailedRows.length?<div className="distribution-table-scroll"><table className="distribution-table"><thead><tr><th>Categorie</th><th>Cantitate</th><th>Valoare</th></tr></thead><tbody>{detailedRows.map(row=><tr key={JSON.stringify([row.category,row.name])}><th>{row.name}</th><td>{number(row.quantity)} buc.</td><td>{money(row.valueCents/100)}</td></tr>)}</tbody></table></div>:<p className="commerce-empty">Nu există accesorii din aceste categorii în selecție.</p>}
      <ProductDetails key={categories.join(',')} products={data.products.filter(product=>categories.includes(managerProductCategory(product)!))} label="Detalii pe produse"/>
    </section><SalesCoverage data={data}/></>;
}
function LegacyPrepaySales({data}:{data:SalesView}){
  const {cards,sim}=data.segments.cardsSim.subsegments;
  const products=data.segments.cardsSim.products.filter(product=>product.subsegment!=='vouchers');
  return <section className="panel distribution-card prepay-legacy-sales" aria-label="Vânzări cartele și SIM"><h2>Cartele cu număr / SIM</h2><Metric label="Vânzări în luna selectată" value={{quantity:cards.quantity+sim.quantity,valueCents:Math.round(cards.value*100)+Math.round(sim.value*100),average:null}}/><ProductDetails products={products} label="Produse Prepay"/></section>;
}
export function ManagerAccessories({userId,query,scopeQuery,scopeLabel,initialView,onViewChange,onMonthChange,manager=true}:{userId:string;query:string;scopeQuery:string;scopeLabel:string;initialView?:'current'|'history'|'clients';onViewChange:(value:'current'|'history'|'clients')=>void;onMonthChange?:(month:string)=>void;manager?:boolean}){
  const [view,setView]=useState<'current'|'history'|'clients'>(initialView||'current');
  const {reload,refresh}=useSalesRefresh(),{data,error}=useReport(userId,query,reload,view!=='clients');
  return <div className="manager-commerce"><div className="page-heading"><div><span className="eyebrow">VÂNZĂRI DE PRODUSE</span><h1>Accesorii</h1><p>{scopeLabel}</p></div>{view!=='clients'&&<button className="icon-button" aria-label="Actualizează accesoriile" onClick={refresh}><RefreshCw size={18}/></button>}</div>
    <nav className="commerce-tabs" aria-label="Rapoarte de produse">{([['current','Accesorii',Package],['history','Telefoane & Prepay',Smartphone],['clients','Pe clienți',Users]] as const).map(([value,label,Icon])=><button type="button" key={value} aria-pressed={view===value} onClick={()=>{setView(value);onViewChange(value);}}><Icon size={17}/>{label}</button>)}</nav>
    {view==='clients'?<><p className="commerce-context">Raport lunar pentru {manager?'portofoliul selectat':'portofoliul meu'}. Alege o singură lună mai jos; {manager?'selecția de proiecte și lunile multiple':'lunile multiple'} se păstrează pentru rapoartele de produse.</p><Suspense fallback={<output>Se încarcă raportul pe clienți…</output>}><ClientSales key={userId+'|'+scopeQuery} manager={manager} monthGrid scopeQuery={scopeQuery} scopeLabel={scopeLabel}/></Suspense></>:<>{!new URLSearchParams(query).has('months')&&onMonthChange&&<ReportPeriod selected={[new URLSearchParams(query).get('month')||bucharestReportingMonthKey(new Date())]} onChange={months=>onMonthChange(months[0])} multiple={false}/>}<ReportStatus data={data} error={error}/>{data&&!error&&<CategoryReport data={data} other={view==='history'}/>}</>}
  </div>;
}
export function ManagerPrepay({userId,query,scopeLabel,distributionConfigured,canViewActivations,month:controlledMonth,onMonthChange}:{userId:string;query:string;scopeLabel:string;distributionConfigured:boolean;canViewActivations:boolean;month?:string;onMonthChange?:(month:string)=>void}){
  const [localMonth,setLocalMonth]=useState(()=>new URLSearchParams(query).get('month')||bucharestReportingMonthKey(new Date()));
  const month=controlledMonth??localMonth;
  function selectMonth(next:string){if(controlledMonth===undefined)setLocalMonth(next);onMonthChange?.(next);}
  const params=new URLSearchParams(query);if(!distributionConfigured)params.set('month',month);
  const [view,setView]=useState<'sales'|'activations'>(!distributionConfigured&&canViewActivations?'activations':'sales'),{reload,refresh}=useSalesRefresh(),{data,error}=useReport(userId,params.toString(),reload,view==='sales');
  return <div className="manager-commerce prepay-workspace"><div className="page-heading"><div><span className="eyebrow">VODAFONE + DIGI</span><h1>Prepay</h1><p>{scopeLabel}</p></div><button className="icon-button" aria-label="Actualizează Prepay" onClick={refresh}><RefreshCw size={18}/></button></div>
    <nav className="commerce-tabs" aria-label="Prepay"><button type="button" aria-pressed={view==='sales'} onClick={()=>setView('sales')}>Vânzări</button>{canViewActivations&&<button type="button" aria-pressed={view==='activations'} onClick={()=>setView('activations')}>Activări</button>}</nav>
    {view==='sales'||!canViewActivations?<>{!distributionConfigured&&<ReportPeriod label="Luna vânzărilor Prepay" selected={[month]} multiple={false} onChange={months=>selectMonth(months[0])}/>}<ReportStatus data={data} error={error}/>{data&&!error&&<>{data.distribution?<><DistributionSalesCards data={data.distribution}/><ProductDetails products={data.products.filter(product=>product.distributionGroup&&['vodafone_0','vodafone_3','vodafone_5','vodafone_credit','digi'].includes(product.distributionGroup))} label="Produse Prepay"/></>:<LegacyPrepaySales data={data}/>}<SalesCoverage data={data}/></>}</>:<ActivationsPanel refreshVersion={reload} embedded distributionConfigured={distributionConfigured} userId={userId} scopeQuery={query} scopeLabel={scopeLabel}/>}
    {view==='sales'&&<p className="commerce-link-note"><ArrowRight size={15}/> Telefoanele și voucherele sunt în Accesorii → Telefoane & Prepay.</p>}
  </div>;
}
