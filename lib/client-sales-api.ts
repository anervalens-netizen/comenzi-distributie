import {db,fail} from './server';
import {managerFilter} from './manager-scope';
import {portfolioSummary} from './partner-portfolio';
import {bucharestReportingMonthKey,bucharestMonthUtcRange} from './bucharest-month';
import {monthEnd,readClientSales} from './client-sales-store';
import {clientFilters,clientSorts,type ClientFilter,type ClientSort,type ClientSalesResult,type ClientSalesRow,type ClientSalesTotals,type ClientMetrics} from './client-sales-types';
import type {User} from './types';

export function clientSalesParams(params:URLSearchParams){
  const month=params.get('month')??bucharestReportingMonthKey(new Date()),filter=params.get('filter')??'all',sort=params.get('sort')??'value',direction=params.get('direction')??'desc',rawPage=params.get('page')??'0';
  if(!/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(month))fail(400,'Luna este invalidă.');
  if(!clientFilters.includes(filter as ClientFilter)||!clientSorts.includes(sort as ClientSort)||!['asc','desc'].includes(direction)||!/^(0|[1-9]\d{0,4})$/.test(rawPage))fail(400,'Filtrul, sortarea sau pagina este invalidă.');
  for(const key of ['q','county'])if((params.get(key)?.length||0)>300)fail(400,'Filtrul este prea lung.');
  for(const key of params.keys())if(params.getAll(key).length!==1)fail(400,'Parametru duplicat.');
  // No site-code shortcut: shared source codes cannot establish personal attribution.
  for(const key of params.keys())if(!['month','filter','sort','direction','page','q','county','agentId','managerId'].includes(key))fail(400,'Parametru necunoscut.');
  return {month,filter:filter as ClientFilter,sort:sort as ClientSort,direction,page:Number(rawPage),q:params.get('q')||'',county:params.get('county')||''};
}
const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function sortClientRows(rows:ClientSalesRow[],sort:ClientSort,direction:string){
  const value=(r:ClientSalesRow)=>sort==='value'?r.metrics.valueCents:sort==='previous'?r.previous.valueCents:sort==='documents'?r.metrics.documents:sort==='lastBilling'?r.health.lastBilling:sort==='county'?r.counties.join(', ')||null:r.name;
  return [...rows].sort((a,b)=>{const aa=value(a),bb=value(b);if(aa===null&&bb!==null)return 1;if(bb===null&&aa!==null)return -1;const cmp=aa===null||bb===null?0:typeof aa==='number'&&typeof bb==='number'?aa-bb:String(aa).localeCompare(String(bb),'ro');return cmp*(direction==='asc'?1:-1)||a.name.localeCompare(b.name,'ro')||a.id.localeCompare(b.id);});
}
function totals(rows:ClientSalesRow[],imported:boolean,metrics:(r:ClientSalesRow)=>ClientMetrics,visits:Map<string,number>):ClientSalesTotals{
  const values=rows.map(metrics),known=values.filter(m=>m.valueCents!==null);
  const available=imported&&(!rows.length||values.some(m=>m.documents!==null));
  const billed=available?values.filter(m=>(m.documents||0)>0).length:null,documents=available?values.reduce((s,m)=>s+(m.documents||0),0):null;
  return {valueCents:imported&&(known.length||!rows.length)?known.reduce((s,m)=>s+m.valueCents!,0):null,billed,documents,perClient:billed&&documents!==null?documents/billed:null,missingValues:values.reduce((s,m)=>s+m.missingValues,0),unknown:rows.filter(r=>!r.linked||!r.identityComplete).length,visited:rows.filter(r=>r.key.startsWith('company:')&&(visits.get(r.key)||0)>0).length,visitedUnidentified:rows.filter(r=>r.key.startsWith('point:')&&(visits.get(r.key)||0)>0).length,visits:rows.reduce((s,r)=>s+(visits.get(r.key)||0),0)};
}
export async function clientSalesOverview(user:User,params:URLSearchParams):Promise<ClientSalesResult>{
  const input=clientSalesParams(params),scope=await managerFilter(user,params);
  const partners=await portfolioSummary(user,undefined,scope?.warehouseIds);
  const snapshot=readClientSales(partners,input.month);
  if(snapshot.state!=='ready')return snapshot;
  const pointCompany=new Map(snapshot.rows.flatMap(r=>r.points.map(p=>[p.id,r.key] as const)));
  const ids=JSON.stringify([...pointCompany.keys()]),actors=user.role==='agent'?[user.id]:scope?.agentIds;
  const months=[input.month,...snapshot.comparisons.map(w=>w.month)];
  // Visits are completed records, not plans. Calendar boundaries use Bucharest DST.
  // Fetch all four months in one grouped query, using disjoint UTC bounds.
  const bounds=months.map(bucharestMonthUtcRange);
  const visits=(await db().prepare(`SELECT customer_id customerId,CASE ${bounds.map((_,i)=>'WHEN visited_at>=? AND visited_at<? THEN '+i).join(' ')} END period,COUNT(*) n FROM partner_visits WHERE customer_id IN (SELECT value FROM json_each(?)) AND visited_at>=? AND visited_at<? ${actors?'AND agent_id IN (SELECT value FROM json_each(?))':''} GROUP BY customer_id,period`).bind(...bounds.flatMap(b=>[b.start,b.end]),ids,bounds.at(-1)!.start,bounds[0].end,...(actors?[JSON.stringify(actors)]:[])).all<{customerId:string;period:number;n:number}>()).results;
  const visitMaps=months.map(()=>new Map<string,number>());
  for(const v of visits){const key=pointCompany.get(v.customerId),map=visitMaps[v.period];if(key&&map)map.set(key,(map.get(key)||0)+v.n);}
  const counties=[...new Set(partners.map(p=>p.county).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ro'));
  // Search and geography select companies through any visible point, retaining full company amounts.
  const q=normalize(input.q),selectedPoints=new Set(partners.filter(p=>(!input.county||p.county===input.county)&&(!q||normalize([p.name,p.cui,p.address,p.city,p.county].join(' ')).includes(q))).map(p=>p.id));
  const rows=snapshot.rows.filter(r=>r.points.some(p=>selectedPoints.has(p.id)));
  for(const r of rows){r.visits=visitMaps[0].get(r.key)||0;r.flags.push(r.visits?'visited':'unvisited');if(!r.visits&&(visitMaps[1].get(r.key)||0)>0)r.flags.push('unvisitedPrevious');if(!r.visits&&visitMaps.slice(1).some(map=>(map.get(r.key)||0)>0))r.flags.push('unvisitedThree');}
  const counts=Object.fromEntries(clientFilters.map(f=>[f,rows.filter(r=>r.flags.includes(f)).length])) as Record<ClientFilter,number>;
  const filtered=sortClientRows(rows.filter(r=>r.flags.includes(input.filter)),input.sort,input.direction);
  return {state:'ready',month:input.month,source:snapshot.source,window:snapshot.window,totals:totals(rows,snapshot.window.imported,r=>r.metrics,visitMaps[0]),counts,
    comparisons:snapshot.comparisons.map((w,i)=>({...w,...totals(rows,w.imported,r=>snapshot.comparisonMetrics.get(r.key)![i],visitMaps[i+1]),visitsFrom:w.from,visitsTo:monthEnd(w.month)})),
    absenceEligible:snapshot.window.covered&&snapshot.comparisons.every(w=>w.covered),counties,total:filtered.length,page:input.page,hasMore:(input.page+1)*50<filtered.length,rows:filtered.slice(input.page*50,(input.page+1)*50).map(r=>({...r,points:r.points.slice(0,20)})),visitRange:{from:input.month+'-01',to:monthEnd(input.month)},noVisitRecords:rows.every(r=>r.visits===0)};
}
