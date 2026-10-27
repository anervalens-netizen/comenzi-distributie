'use client';
import type {DistributionSales,DistributionSalesMetric} from '@/lib/distribution-sales';
import {money} from '@/lib/client-api';
import './distribution.css';
const number=(n:number)=>n.toLocaleString('ro-RO');
export function Metric({label,value}:{label:string;value:DistributionSalesMetric}){return <div className="distribution-metric"><span>{label}</span><strong>{number(value.quantity)} <small>buc.</small></strong><span>{money(value.valueCents/100)}</span></div>;}
export function OperatorLogo({provider}:{provider:'vodafone'|'digi'}){const width=provider==='vodafone'?140:110,height=provider==='vodafone'?94:38;return <div className={'distribution-logo '+provider}><svg aria-label={provider==='vodafone'?'Vodafone':'Digi'} viewBox={`0 0 ${width} ${height}`}><title>{provider==='vodafone'?'Vodafone':'Digi'}</title><image href={'/operators/'+(provider==='vodafone'?'vodafone.png':'digi.svg')} width={width} height={height}/></svg></div>;}

export function DistributionSalesCards({data}:{data:DistributionSales}){
 return <section className="prepay-sales" aria-label="Vânzări Prepay"><div className="distribution-operators"><article className="panel distribution-card"><OperatorLogo provider="vodafone"/><div className="prepay-sim-metrics"><Metric label="SIM cu credit" value={data.vodafoneCredit}/><Metric label="SIM 0" value={data.groups.vodafone_0}/></div><p className="prepay-average">Media / SIM cu credit <strong>{data.vodafoneCredit.average===null?'—':money(data.vodafoneCredit.average)}</strong></p><details className="commerce-details"><summary>Detalii după credit</summary><div className="distribution-segments">{(['vodafone_3','vodafone_5','vodafone_credit'] as const).map((key,index)=><Metric key={key} label={['SIM 3','SIM 5','Alte SIM cu credit'][index]} value={data.groups[key]}/>)}</div></details></article><article className="panel distribution-card"><OperatorLogo provider="digi"/><Metric label="SIM Digi" value={data.groups.digi}/><p className="prepay-average">Media / SIM <strong>{data.groups.digi.average===null?'—':money(data.groups.digi.average)}</strong></p></article></div></section>;
}
