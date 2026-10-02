import {DatabaseSync} from 'node:sqlite';
import {existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {salesYield} from './client-sales-cooperative';
import {resolve} from 'node:path';
import {activityVersion,bucharestToday,historyStamp} from './partner-activity-snapshot';
import {normalizedCui} from './partner-company-identity';
import type {PartnerSummary} from './partner-map-types';
import type {ClientHealth,ClientMetrics,ClientSalesRow,MonthWindow,SourceCoverage} from './client-sales-types';

const DAY=86400000;
export const daysBetween=(a:string,b:string)=>Math.floor((Date.parse(b)-Date.parse(a))/DAY);
export const nextDay=(date:string)=>new Date(Date.parse(date)+DAY).toISOString().slice(0,10);
export function shiftMonth(month:string,offset:number){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+offset,1)).toISOString().slice(0,7);}
export const monthEnd=(month:string)=>new Date(Date.parse(shiftMonth(month,1)+'-01')-DAY).toISOString().slice(0,10);
const min=(...dates:string[])=>dates.sort()[0];
export function coverageIntervals(coverage:SourceCoverage[],today:string){
  return coverage.flatMap(p=>p.observedEnd?[{from:p.start,to:min(p.declaredEnd,p.observedEnd,today)}]:[]).filter(p=>p.to>=p.from).sort((a,b)=>a.from.localeCompare(b.from));
}
export function isCovered(from:string,to:string,intervals:{from:string;to:string}[]){
  let cursor=from;
  for(const p of intervals){if(p.to<cursor)continue;if(p.from>cursor)return false;cursor=nextDay(p.to);if(cursor>to)return true;}
  return false;
}
export function monthlyWindow(month:string,intervals:{from:string;to:string}[],day?:number):MonthWindow{
  const from=month+'-01',end=monthEnd(month),target=day?month+'-'+String(Math.min(day,Number(end.slice(8)))).padStart(2,'0'):end;
  const overlaps=intervals.filter(p=>p.from<=target&&p.to>=from);
  const to=overlaps.length?min(target,overlaps.map(p=>p.to).sort().at(-1)!):null;
  return {month,from,to,imported:!!to,covered:!!to&&(!day||to===target)&&isCovered(from,to,intervals),complete:!!to&&to===end&&isCovered(from,end,intervals)};
}
type Daily={company_id:string;date:string;value_cents:number|null;missing_values:number;documents:number;last_billing:string|null};
const emptyMetrics=():ClientMetrics=>({valueCents:null,documents:null,lastBilling:null,missingValues:0});
function metrics(days:Daily[],window:MonthWindow,linked:boolean):ClientMetrics{
  if(!window.imported||!linked)return emptyMetrics();
  const selected=days.filter(d=>d.date>=window.from&&d.date<=window.to!);
  const known=selected.filter(d=>d.value_cents!==null);
  return {valueCents:selected.length&&!known.length?null:known.reduce((s,d)=>s+d.value_cents!,0),documents:selected.reduce((s,d)=>s+d.documents,0),lastBilling:selected.map(d=>d.last_billing).filter((d):d is string=>!!d).sort().at(-1)||null,missingValues:selected.reduce((s,d)=>s+d.missing_values,0)};
}
function health(days:Daily[],cutoff:string|null,linked:boolean,identityComplete:boolean,intervals:{from:string;to:string}[],today:string,window:MonthWindow):ClientHealth{
  const bills=days.filter(d=>d.documents>0),first=bills[0]?.date||null,last=bills.at(-1)?.date||null;
  const elapsed=first&&cutoff?daysBetween(first,cutoff):null;
  const covered=!!first&&!!cutoff&&isCovered(first,cutoff,intervals);
  const clean=identityComplete&&!days.some(d=>d.missing_values);
  // Historical signals are evaluated at their cutoff. Current signals also need fresh imports.
  const fresh=!!cutoff&&(window.complete||(window.month===today.slice(0,7)&&daysBetween(cutoff,today)<=3));
  const recent=identityComplete&&elapsed!==null&&elapsed<60,repeat=identityComplete&&!!first&&!!last&&last>first;
  const eligible=recent&&covered&&clean&&fresh&&window.covered;
  let status:ClientHealth['status']=!linked||!cutoff?'unknown':!recent?'established':repeat?'repeat':!eligible?'uncertain':elapsed!<30?'waiting':'overdue';
  if(!first&&linked&&cutoff)status='established';
  if(linked&&cutoff&&!identityComplete)status='uncertain';
  // An actual earlier purchase and >=60 covered inactive days are required.
  const reactivated=clean&&fresh&&window.covered&&bills.some((d,i)=>i>0&&d.date>=window.from&&daysBetween(bills[i-1].date,d.date)>=60&&isCovered(bills[i-1].date,d.date,intervals));
  const reason=status==='unknown'?'Istoric neasociat sau lună neimportată.':status==='repeat'?'Facturare repetată într-o zi ulterioară primei facturări observate.':status==='waiting'?'Client recent; încă nu s-au împlinit 30 de zile de observație.':status==='overdue'?'Fără repetare după cel puțin 30 de zile acoperite; semnal de verificat, nu abandon dovedit.':status==='uncertain'?'Acoperire, asociere sau valori incomplete / sursă întârziată; alerta este suspendată.':first?'Prima facturare observată este în afara ferestrei recente de 60 de zile.':'Fără facturare pozitivă documentată în istoricul asociat.';
  return {firstBilling:first,lastBilling:last,documents:linked&&cutoff?bills.reduce((s,d)=>s+d.documents,0):null,elapsedDays:elapsed,observedDays:covered?elapsed||0:0,recent,repeat,status,alertEligible:status==='overdue',reactivated,reason};
}
/** Only current authorized cards enter this reader. Source DBs are never writable.
 * All raw-history scans happen in the batch builder, not in HTTP requests. */
function* calculateClientSales(partners:PartnerSummary[],month:string,directory=process.env.MOBIUP_DATA_DIR||'./work/server-data',today=bucharestToday()){
  yield;
  let work=0;
  const base=resolve(directory,'client-history'),source=resolve(base,'client-sales-history.sqlite'),path=resolve(base,'partner-activity.sqlite');
  const unavailable={state:'unavailable' as const,message:'Centralizarea raportului pe clienți lipsește sau este învechită. Trebuie recalculată după import.'};
  if(!existsSync(source)||!existsSync(path))return unavailable;
  const c=new DatabaseSync(source,{readOnly:true});let s:DatabaseSync|undefined;
  try{
    s=new DatabaseSync(path,{readOnly:true});
    c.exec('BEGIN');s.exec('BEGIN');
    if(Number(s.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('meta','company_identity','company_daily')").get()?.n)!==3)return unavailable;
    const stamp=historyStamp(c),meta=JSON.parse(String(s.prepare("SELECT value FROM meta WHERE key='snapshot'").get()?.value||'null')) as {version:string;signature:string;builtAt:string;coverage:SourceCoverage[]}|null;
    if(!meta||meta.version!==activityVersion||meta.signature!==stamp.signature||!meta.coverage)return unavailable;
    const intervals=coverageIntervals(meta.coverage,today),window=monthlyWindow(month,intervals);
    const effectiveCutoff=intervals.map(p=>p.to).sort().at(-1)||null;
    const day=!window.complete&&window.to?Number(window.to.slice(8)):undefined;
    const comparisons=[1,2,3].map(i=>monthlyWindow(shiftMonth(month,-i),intervals,day));
    const groups=new Map<string,PartnerSummary[]>();
    for(const p of partners){if(++work%256===0)yield;const cui=normalizedCui(p.cui),key=cui&&cui!=='CLIENTGEN'?'company:'+cui:'point:'+p.id;const group=groups.get(key)||[];group.push(p);groups.set(key,group);}
    const keys=JSON.stringify([...new Set(partners.map(p=>normalizedCui(p.cui)))]);
    const identities=new Map<string,boolean>();
    for(const r of s.prepare('SELECT company_id,complete FROM company_identity WHERE company_id IN (SELECT value FROM json_each(?))').iterate(keys)){identities.set(String(r.company_id),!!r.complete);if(++work%256===0)yield;}
    const byCompany=new Map<string,Daily[]>();
    // Bounded by the selected cutoff: future facts cannot influence first/repeat/quality.
    for(const d of s.prepare('SELECT * FROM company_daily WHERE company_id IN (SELECT value FROM json_each(?)) AND date<=? AND date>=? ORDER BY company_id,date').iterate(keys,window.to||min(monthEnd(month),today),window.to?'':comparisons.at(-1)!.from) as Iterable<Daily>){if(++work%256===0)yield;const days=byCompany.get(d.company_id)||[];days.push(d);byCompany.set(d.company_id,days);}
    const rows:ClientSalesRow[]=[],comparisonMetrics=new Map<string,ClientMetrics[]>();
    for(const [key,members] of groups){
      if(++work%128===0)yield;
      members.sort((a,b)=>a.id.localeCompare(b.id));const p=members[0],cui=normalizedCui(p.cui),linked=identities.has(cui),identityComplete=identities.get(cui)===true,days=byCompany.get(cui)||[];
      const periodMetrics=(w:MonthWindow)=>metrics(days,w,linked&&(identityComplete||days.some(d=>d.date>=w.from&&!!w.to&&d.date<=w.to)));
      const current=periodMetrics(window),prior=comparisons.map(periodMetrics);comparisonMetrics.set(key,prior);
      const h=health(days.filter(d=>!!window.to&&d.date<=window.to),window.to,linked,identityComplete,intervals,today,window);
      const flags:ClientSalesRow['flags']=['all'];
      if(!linked||!identityComplete||current.missingValues)flags.push('unknown');
      if(current.documents!==null&&current.documents>0)flags.push('billed');
      const absent=window.covered&&identityComplete&&linked&&!current.missingValues&&current.documents===0;
      if(absent)flags.push('unbilled');
      if(absent&&comparisons[0].covered&&!prior[0].missingValues&&(prior[0].documents||0)>0)flags.push('absentPrevious');
      if(absent&&comparisons.every(w=>w.covered)&&prior.every(m=>!m.missingValues)&&prior.some(m=>(m.documents||0)>0))flags.push('absentThree');
      if(h.recent)flags.push('new');if(h.recent&&h.repeat)flags.push('repeat');
      if(h.status==='waiting')flags.push('waiting');if(h.status==='overdue')flags.push('overdue');if(h.reactivated)flags.push('reactivated');
      rows.push({key,id:p.id,name:p.name,cui:p.cui,city:p.city,counties:[...new Set(members.map(p=>p.county).filter(Boolean))].sort(),pointCount:members.length,points:members.map(p=>({id:p.id,name:p.name,city:p.city})),linked,identityComplete,metrics:current,previous:prior[0],health:h,visits:0,flags});
    }
    return {state:'ready' as const,rows,comparisonMetrics,window,comparisons,source:{label:'Raport pe clienți',builtAt:meta.builtAt,updatedAt:meta.coverage.map(p=>p.importedAt).filter((s):s is string=>!!s).sort().at(-1)||null,declaredEnd:stamp.through,observedEnd:meta.coverage.map(p=>p.observedEnd).filter((s):s is string=>!!s).sort().at(-1)||null,effectiveCutoff,latestMonth:effectiveCutoff?.slice(0,7)||null,coverage:meta.coverage}};
  }finally{c.close();s?.close();}
}

/** Synchronous reader for batch tools/tests only. HTTP must use the cooperative reader. */
export function readClientSales(...args:Parameters<typeof calculateClientSales>){
  const calculation=calculateClientSales(...args);let step=calculation.next();
  while(!step.done)step=calculation.next();return step.value;
}
type Report=ReturnType<typeof readClientSales>;
// Only billing is cached. Current portfolio, actors and visits are read on every request.
// Entries are private; every caller receives independently mutable records.
const reports=new Map<string,{report:Report;bytes:number}>(),flights=new Map<string,Promise<Report>>();
const MAX_BYTES=48*1024*1024;
let cacheBytes=0;
export const clientSalesCacheStats={hits:0,builds:0,bytes:0};
function fileGeneration(directory:string){
  return ['client-sales-history.sqlite','partner-activity.sqlite'].flatMap(name=>['','-wal'].map(suffix=>{
    try{const s=statSync(resolve(directory,'client-history',name+suffix),{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}catch{return 'missing';}
  })).join('|');
}
async function copyReport(report:Report,selection?:ReadonlySet<string>):Promise<Report>{
  if(report.state!=='ready')return {...report};
  const rows:ClientSalesRow[]=[],comparisonMetrics=new Map<string,ClientMetrics[]>();
  let visited=0;
  for(const r of report.rows){
    if(++visited%256===0)await salesYield();
    if(selection&&!selection.has(r.key))continue;
    rows.push({...r,metrics:{...r.metrics},previous:{...r.previous},health:{...r.health},flags:[...r.flags],counties:[...r.counties],points:r.points.map(p=>({...p}))});
    comparisonMetrics.set(r.key,report.comparisonMetrics.get(r.key)!.map(m=>({...m})));
  }
  return {...report,rows,comparisonMetrics,window:{...report.window},comparisons:report.comparisons.map(w=>({...w})),source:{...report.source,coverage:report.source.coverage.map(c=>({...c}))}};
}
export async function readClientSalesAsync(partners:PartnerSummary[],month:string,directory=process.env.MOBIUP_DATA_DIR||'./work/server-data',today=bucharestToday(),selection?:ReadonlySet<string>):Promise<Report>{
  directory=resolve(directory);
  const generation=fileGeneration(directory),hash=createHash('sha256');
  // Include every displayed identity field, so live CUI edits/merges/splits cannot reuse
  // old group membership. Search and ACL selection always use the current input.
  for(let i=0;i<partners.length;i++){
    const p=partners[i];hash.update(JSON.stringify([p.id,p.cui,p.name,p.city,p.county]));
    if(i%256===0)await salesYield();
  }
  const deliver=async(report:Report)=>{
    const copy=await copyReport(report,selection);
    return generation===fileGeneration(directory)?copy:{state:'unavailable' as const,message:'Sursa se actualizează. Reîncearcă raportul.'};
  };
  const key=JSON.stringify([activityVersion,directory,generation,month,today,hash.digest('hex')]);
  const hit=reports.get(key);
  if(hit){clientSalesCacheStats.hits++;reports.delete(key);reports.set(key,hit);return deliver(hit.report);}
  let flight=flights.get(key);
  if(!flight){
    if(flights.size>=4)throw new Error('Prea multe rapoarte în calcul. Reîncearcă.');
    flight=(async()=>{
      clientSalesCacheStats.builds++;
      const calculation=calculateClientSales(partners,month,directory,today);
      let step;
      try{do{step=calculation.next();if(!step.done)await salesYield();}while(!step.done);}finally{calculation.return(undefined as never);}
      const report=step.value;
      // A replacement/reimport while yielding must not publish or return stale facts.
      if(generation!==fileGeneration(directory))return {state:'unavailable' as const,message:'Sursa se actualizează. Reîncearcă raportul.'};
      if(report.state==='ready'){
        let bytes=0;
        for(let i=0;i<report.rows.length;i++){const r=report.rows[i];bytes+=2*(JSON.stringify(r).length+JSON.stringify(report.comparisonMetrics.get(r.key)).length)+256;if(i%256===0)await salesYield();}
        if(bytes<=MAX_BYTES&&generation===fileGeneration(directory)){
          while(reports.size&&(reports.size>=4||cacheBytes+bytes>MAX_BYTES)){const oldest=reports.keys().next().value!;cacheBytes-=reports.get(oldest)!.bytes;reports.delete(oldest);}
          reports.set(key,{report,bytes});cacheBytes+=bytes;clientSalesCacheStats.bytes=cacheBytes;
        }
      }
      return report;
    })().finally(()=>{flights.delete(key);});
    flights.set(key,flight);
  }
  return deliver(await flight);
}
