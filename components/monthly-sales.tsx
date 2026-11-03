'use client';
import {useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from './ui/dialog';
import {money} from '@/lib/client-api';
import type {DistributionSalesMetric} from '@/lib/distribution-sales';
import './monthly-sales.css';

export type MonthlySalesPoint={month:string;imported:boolean;source?:'client-history';value:DistributionSalesMetric};
const number=(v:number)=>v.toLocaleString('ro-RO',{maximumFractionDigits:3});
const axisNumber=(v:number)=>v.toLocaleString('ro-RO',{notation:'compact',maximumFractionDigits:1});
export const trendMonth=(month:string)=>new Date(month+'-01T00:00:00Z').toLocaleDateString('ro-RO',{month:'short',year:'numeric',timeZone:'UTC'});
function TrendPlot({points,quantity,net}:{points:MonthlySalesPoint[];quantity:boolean;net:boolean}){
 const values=points.map(p=>!p.imported||!quantity&&p.value.missingValueRows?null:quantity?p.value.quantity:net?p.value.valueExVat??null:p.value.valueCents/100);
 const known=values.filter((v):v is number=>v!==null),min=Math.min(0,...known),max=Math.max(0,...known),span=max-min||1;
 const x=(i:number)=>55+(points.length===1?325:i*650/Math.max(1,points.length-1)),y=(v:number)=>175-(v-min)/span*150;
 const path=values.map((v,i)=>v===null?'':(i>0&&values[i-1]!==null?'L':'M')+x(i)+','+y(v)).join(' ');
 return <svg className="monthly-trend-plot" viewBox="0 0 760 225" aria-label={'Evoluție lunară · '+(quantity?'cantitate':net?'valoare fără TVA':'valoare raportată')}>
 {[0,.5,1].map(r=>{const v=min+r*span;return <g key={r}><line x1="55" x2="705" y1={y(v)} y2={y(v)} stroke="#e4e8ed"/><text x="48" y={y(v)+4} textAnchor="end">{axisNumber(v)}</text></g>;})}
 <path d={path} fill="none" stroke="#df2637" strokeWidth="2.5"/>
 {values.map((v,i)=>v===null?null:<circle key={points[i].month} cx={x(i)} cy={y(v)} r="4" fill="#df2637"><title>{trendMonth(points[i].month)}: {quantity?number(v)+' buc.':money(v)}</title></circle>)}
 {points.map((p,i)=>i%Math.ceil(points.length/8)===0||i===points.length-1?<text key={p.month} x={x(i)} y="202" textAnchor="middle">{trendMonth(p.month)}</text>:null)}
 {!known.length&&<text x="380" y="90" textAnchor="middle">Nu există valori disponibile pentru grafic.</text>}
 </svg>;
}
export function MonthlySalesDialog({title,points,open,onOpenChange,vat=false,average=false}:{title:string;points:MonthlySalesPoint[];open:boolean;onOpenChange:(open:boolean)=>void;vat?:boolean;average?:boolean}){
 const [quantity,setQuantity]=useState(false);
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="monthly-sales-dialog"><DialogHeader><DialogTitle>Evoluție lunară · {title}</DialogTitle><DialogDescription>{points.length} {points.length===1?'lună selectată':'luni selectate'} · aceleași filtre ca în raport. Cantitățile și valorile includ retururile.</DialogDescription></DialogHeader>
 <fieldset className="monthly-trend-switch" aria-label="Indicator grafic"><button type="button" aria-pressed={!quantity} onClick={()=>setQuantity(false)}>Valoare{vat?' fără TVA':''}</button><button type="button" aria-pressed={quantity} onClick={()=>setQuantity(true)}>Cantitate</button></fieldset>
 <div className="monthly-plot-scroll" aria-label="Grafic lunar"><TrendPlot points={points} quantity={quantity} net={vat}/></div>
 {points.length>1&&<p className="monthly-scroll-hint">Glisează graficul pentru a vedea toate lunile →</p>}
 <div className="monthly-sales-table"><table><thead><tr><th>Lună</th><th>Cantitate</th>{vat&&<th>Fără TVA</th>}<th>{vat?'Cu TVA':'Valoare raportată'}</th>{average&&<th>Medie / SIM</th>}</tr></thead><tbody>{points.map(p=><tr key={p.month} data-month={p.month}><th>{trendMonth(p.month)}{p.source&&<small>Istoric vânzări</small>}</th>{p.imported?<><td>{number(p.value.quantity)} buc.</td>{vat&&<td>{p.value.missingValueRows||p.value.valueExVat===undefined?'—':money(p.value.valueExVat)}</td>}<td>{money(p.value.valueCents/100)}{!!p.value.missingValueRows&&<small>Valoare parțială · {p.value.missingValueRows} rând fără valoare</small>}</td>{average&&<td>{p.value.missingValueRows||p.value.average===null?'—':money(p.value.average)}</td>}</>:<td colSpan={(vat?3:2)+(average?1:0)} className="monthly-sales-missing">Fără import · nu este inclusă în total</td>}</tr>)}</tbody></table></div>
 {points.some(p=>!p.imported)&&<p className="monthly-sales-note">Lunile fără import rămân marcate ca lipsă și nu sunt transformate în vânzări zero.</p>}
 {vat&&<p className="monthly-sales-note">Fără TVA: cota fiecărei luni, cu rotunjire la afișare.</p>}
 </DialogContent></Dialog>;
}
