'use client';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
export function Choice({value,onChange,options,label,id}:{value:string;onChange:(v:string)=>void;options:{value:string;label:string}[];label:string;id?:string}) {
  return <Select value={value} onValueChange={v=>{if(v!==null) onChange(v);}} items={options}><SelectTrigger id={id} aria-label={label} className="choice"><SelectValue/></SelectTrigger><SelectContent>{options.map(o=><SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>;
}
