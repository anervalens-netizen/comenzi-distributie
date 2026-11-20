'use client';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from './ui/dialog';
import {TrendPlot,trendMonth} from './monthly-sales';
import type {activationMonthlyPoints} from '@/lib/activation-monthly';
import './monthly-sales.css';
export function MonthlyActivationsDialog({title,points,cohort,onClose}:{title:string;points:ReturnType<typeof activationMonthlyPoints>;cohort:boolean;onClose:()=>void}){
 return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="monthly-sales-dialog"><DialogHeader><DialogTitle>Evoluție lunară · {title}</DialogTitle><DialogDescription>{points.length} {points.length===1?'lună selectată':'luni selectate'} · aceleași filtre ca în raport. {cohort?'Luna distribuirii SIM-urilor; activarea este verificată la data sursei.':'Luna activării SIM-urilor.'}</DialogDescription></DialogHeader>
 <div className="monthly-plot-scroll"><TrendPlot quantity net={false} unit={cohort?'SIM-uri':'activări'} points={points.map(p=>({month:p.month,imported:p.reported,value:{quantity:p.total??0,valueCents:0,average:null}}))}/></div>
 {points.length>1&&<p className="monthly-scroll-hint">Glisează graficul pentru a vedea toate lunile →</p>}
 <div className="monthly-sales-table"><table><thead><tr><th>Lună</th><th>{cohort?'SIM-uri':'Activări'}</th></tr></thead><tbody>{points.map(p=><tr key={p.month} data-month={p.month}><th>{trendMonth(p.month)}</th><td>{p.reported?p.total?.toLocaleString('ro-RO'):<span className="monthly-sales-missing">Fără date raportate · acoperire de verificat</span>}</td></tr>)}</tbody></table></div>
 <p className="monthly-sales-note">{cohort?'SIM-urile activate sunt din aceeași cohortă de distribuție. Valorile nu reprezintă stocul fizic.':'Sunt numărate SIM-uri distincte. Lunile fără date raportate rămân marcate și nu sunt reprezentate ca activări zero.'}</p>
 </DialogContent></Dialog>;
}
