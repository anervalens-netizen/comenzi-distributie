import {salesYield} from './client-sales-cooperative';
import type {ClientHealth,ClientMetrics,ClientSalesRow} from './client-sales-types';
import type {readClientSales} from './client-sales-store';

type ReadyReport=Extract<ReturnType<typeof readClientSales>,{state:'ready'}>;
type Metrics=[number|null,number|null,string|null,number];
type Health=[string|null,string|null,number|null,number|null,number,boolean,boolean,ClientHealth['status'],boolean,boolean,number];
type Row=[string,string,string,string,string,string[],number,ClientSalesRow['points'],boolean,boolean,Metrics,Metrics,Health,number,ClientSalesRow['flags'],Metrics[]];
export type PackedClientSales={header:string;reasons:string[];chunks:string[];bytes:number};
const packMetrics=(m:ClientMetrics):Metrics=>[m.valueCents,m.documents,m.lastBilling,m.missingValues];
const unpackMetrics=([valueCents,documents,lastBilling,missingValues]:Metrics):ClientMetrics=>({valueCents,documents,lastBilling,missingValues});

/** Private cache representation, never a wire/storage format. Repeated field names
 * and explanations need not occupy a national report's retained memory. Keep only
 * bounded serialized chunks, not both encoded and decoded copies. */
export async function packClientSales(report:ReadyReport,maxBytes:number):Promise<PackedClientSales|undefined>{
  const {rows,comparisonMetrics,...metadata}=report;
  const header=JSON.stringify(metadata),reasons:string[]=[],chunks:string[]=[];
  let bytes=header.length*2+1024;
  for(let start=0;start<rows.length;start+=128){
    const packed:Row[]=rows.slice(start,start+128).map(r=>{
      const h=r.health;let reason=reasons.indexOf(h.reason);
      if(reason<0){reason=reasons.length;reasons.push(h.reason);bytes+=h.reason.length*2+64;}
      return [r.key,r.id,r.name,r.cui,r.city,r.counties,r.pointCount,r.points,r.linked,r.identityComplete,packMetrics(r.metrics),packMetrics(r.previous),[h.firstBilling,h.lastBilling,h.documents,h.elapsedDays,h.observedDays,h.recent,h.repeat,h.status,h.alertEligible,h.reactivated,reason],r.visits,r.flags,comparisonMetrics.get(r.key)!.map(packMetrics)];
    });
    const json=JSON.stringify(packed);bytes+=json.length*2+256;
    if(bytes>maxBytes)return undefined;
    chunks.push(json);await salesYield();
  }
  if(bytes>maxBytes)return undefined;
  return {header,reasons,chunks,bytes};
}
/** Decoding gives each reader independent mutable rows, including nested arrays.
 * Yield between chunks just as the uncached reader does. */
export async function unpackClientSales(packed:PackedClientSales,selection?:ReadonlySet<string>):Promise<ReadyReport>{
  const rows:ClientSalesRow[]=[],comparisonMetrics=new Map<string,ClientMetrics[]>();
  for(const chunk of packed.chunks){
    for(const [key,id,name,cui,city,counties,pointCount,points,linked,identityComplete,metrics,previous,h,visits,flags,comparisons] of JSON.parse(chunk) as Row[]){
      if(selection&&!selection.has(key))continue;
      const [firstBilling,lastBilling,documents,elapsedDays,observedDays,recent,repeat,status,alertEligible,reactivated,reason]=h;
      rows.push({key,id,name,cui,city,counties,pointCount,points,linked,identityComplete,metrics:unpackMetrics(metrics),previous:unpackMetrics(previous),health:{firstBilling,lastBilling,documents,elapsedDays,observedDays,recent,repeat,status,alertEligible,reactivated,reason:packed.reasons[reason]},visits,flags});
      comparisonMetrics.set(key,comparisons.map(unpackMetrics));
    }
    await salesYield();
  }
  return {...JSON.parse(packed.header),rows,comparisonMetrics};
}
