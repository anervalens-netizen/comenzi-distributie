'use client';
import {useEffect,useState} from 'react';
import {ChevronLeft,ChevronRight,CalendarDays} from 'lucide-react';
import {bucharestMonthKey} from '@/lib/bucharest-month';
import './distribution.css';

const months=['Ian','Feb','Mar','Apr','Mai','Iun','Iul','Aug','Sep','Oct','Noi','Dec'];
const fullMonths=['ianuarie','februarie','martie','aprilie','mai','iunie','iulie','august','septembrie','octombrie','noiembrie','decembrie'];
export function periodLabel(selected:string[]){
  if(!selected.length)return 'Nicio lună selectată';
  return [...selected].sort().map(value=>`${months[Number(value.slice(5))-1]} ${value.slice(0,4)}`).join(' · ');
}

/** One direct month selection pattern, with single-month mode for operational reports. */
export function ReportPeriod({selected,onChange,multiple=true,label='Perioadă'}:{selected:string[];onChange:(months:string[])=>void;multiple?:boolean;label?:string}){
  const current=bucharestMonthKey(new Date()),[year,setYear]=useState(()=>Number((selected.at(-1)||current).slice(0,4)));
  const selection=selected.join(',');
  useEffect(()=>{const values=selection.split(',').filter(Boolean);if(!values.length)return;queueMicrotask(()=>setYear(previous=>values.some(value=>Number(value.slice(0,4))===previous)?previous:Number(values.at(-1)!.slice(0,4))));},[selection]);
  const firstYear=Math.min(2020,year,...selected.map(value=>Number(value.slice(0,4))));
  const lastYear=Math.max(Number(current.slice(0,4))+1,year);
  const years=Array.from({length:lastYear-firstYear+1},(_,index)=>firstYear+index);
  return <fieldset className="report-period" aria-label={label}>
    <legend><CalendarDays size={15}/>{label}{multiple&&<small>alege una sau mai multe luni</small>}</legend>
    <div className="report-period-body"><div className="report-year"><button type="button" aria-label="Anul anterior" disabled={year<=2000} onClick={()=>setYear(value=>value-1)}><ChevronLeft size={16}/></button><select aria-label={'An · '+label} value={year} onChange={event=>setYear(Number(event.target.value))}>{years.map(value=><option key={value}>{value}</option>)}</select><button type="button" aria-label="Anul următor" disabled={year>=2099} onClick={()=>setYear(value=>value+1)}><ChevronRight size={16}/></button></div>
      <div className="report-month-grid">{months.map((name,index)=>{const key=`${year}-${String(index+1).padStart(2,'0')}`,active=selected.includes(key);return <button type="button" key={key} aria-label={`${fullMonths[index]} ${year}`} aria-pressed={active} disabled={multiple&&!active&&selected.length>=36} onClick={()=>onChange(multiple?(active?selected.filter(value=>value!==key):[...selected,key].sort()):[key])}>{name}</button>;})}</div>
    </div>
    <p className="report-period-selection" aria-live="polite">{periodLabel(selected)}{multiple&&selected.length>=36?' · maximum 36 de luni':''}</p>
  </fieldset>;
}
