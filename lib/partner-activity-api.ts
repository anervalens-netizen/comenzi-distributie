import {validBillingPeriod,billingPeriodMatches} from './partner-billing-period';
import {portfolioSummary} from './partner-portfolio';
import {createHash} from 'node:crypto';
import {clientSalesPortfolio,clientPortfolioVersion} from './client-sales-portfolio';
import {fileGeneration} from './history-source-generation';
import {salesYield,salesSort} from './client-sales-cooperative';
import {managerFilter} from './manager-scope';
import {db,fail} from './server';
import {readActivitySnapshotAsync,normalizedCui,type ActivitySnapshotRow,type PartnerPeriodMetrics} from './partner-activity-snapshot';
import type {User} from './types';
export const activityFilters=['all','attention','regular','overdue','inactive','reactivated','new','occasional','incomplete'] as const;
export const activitySorts=['value','documents','lastBilling','name','county','agent'] as const;
export type ActivitySort=typeof activitySorts[number];
export type ActivityFilter=typeof activityFilters[number];
const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export type PartnerActivityOverview=Awaited<ReturnType<typeof partnerActivityOverview>>;
/** Request-local fence; neither membership nor authorization is retained between calls. */
export async function activityReadFence(readUser:User,params:URLSearchParams,authenticatedUser:User=readUser){
  const directory=process.env.MOBIUP_DATA_DIR||'./work/server-data',source=fileGeneration(directory);
  const access=async()=>{
    const current=await db().prepare('SELECT role,warehouse_id,manager_scope,active FROM users WHERE id=?').bind(authenticatedUser.id).first<{role:string;warehouse_id:string|null;manager_scope:string|null;active:number}>();
    const persistedScope=current?.role==='manager'&&current.manager_scope==='global'?'global':'assigned';
    if(!current?.active||current.role!==authenticatedUser.role||(current.warehouse_id||'')!==(authenticatedUser.warehouseId||'')||persistedScope!==authenticatedUser.managerScope)fail(403,'Permisiunile s-au modificat. Reîncearcă.');
    const version=await clientPortfolioVersion();
    if(version!==null)return JSON.stringify([version,current]);
    // Legacy adapters have no revision hook. Re-read the actual READ scope while
    // authenticating against the unpromoted account identity.
    const scope=await managerFilter(readUser,params),partners=await portfolioSummary(readUser,undefined,scope?.warehouseIds),hash=createHash('sha256');
    for(let i=0;i<partners.length;i++){hash.update(JSON.stringify(partners[i]));if(i%128===0)await salesYield();}
    return JSON.stringify([current,scope,hash.digest('hex')]);
  };
  const before=await access();
  return async()=>{
    if(before!==await access())fail(503,'Portofoliul sau permisiunile s-au modificat. Reîncearcă.');
    if(source!==fileGeneration(directory))fail(409,'Istoricul s-a modificat. Reîncearcă.');
  };
}
export async function partnerActivityOverview(user:User,params:URLSearchParams,authenticatedUser:User=user){
  const verify=await activityReadFence(user,params,authenticatedUser);
  const result=await activityOverview(user,params);
  await verify();return result;
}
async function activityOverview(user:User,params:URLSearchParams){
  const period=params.get('salesPeriod')||'';
  if(!validBillingPeriod(period))fail(400,'Perioada de facturare este invalidă.');
  const filter=params.get('activity')||'all',rawPage=params.get('page')||'0';
  if(!activityFilters.includes(filter as ActivityFilter)||!/^\d{1,5}$/.test(rawPage))fail(400,'Filtrul de activitate este invalid.');
  for(const key of ['q','county'])if((params.get(key)?.length||0)>300)fail(400,'Filtrul este prea lung.');
  const sort=params.get('sort')||'value',direction=params.get('direction')||'desc';
  if(!activitySorts.includes(sort as ActivitySort)||!['asc','desc'].includes(direction))fail(400,'Sortarea este invalidă.');
  const scope=await managerFilter(user,params),partners=await clientSalesPortfolio(user,scope?.warehouseIds);
  const counties=[...new Set(partners.map(p=>p.county).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ro'));
  const q=normalize(params.get('q')||''),county=params.get('county')||'';
  const selected:typeof partners=[];
  for(let i=0;i<partners.length;i++){const p=partners[i];if((!county||p.county===county)&&(!q||normalize([p.name,p.cui,p.address,p.city].join(' ')).includes(q)))selected.push(p);if(i%128===0)await salesYield();}
  const snapshot=await readActivitySnapshotAsync(selected,undefined,undefined,{period,scope:'company'});
  if(snapshot.state!=='ready')return snapshot;
  const agents=(await db().prepare("SELECT id,name,warehouse_id FROM users WHERE role='agent' AND active=1 ORDER BY name,id").all<{id:string;name:string;warehouse_id:string}>()).results;
  const groups=new Map<string,typeof selected>();
  let work=0;
  for(const partner of selected){
    if(++work%128===0)await salesYield();
    if(!billingPeriodMatches(snapshot.rows.get(partner.id),period,snapshot.asOf))continue;
    const key=normalizedCui(partner.cui),groupKey=snapshot.rows.get(partner.id)?.scope==='company'?'company:'+key:'point:'+partner.id;
    const members=groups.get(groupKey)||[];members.push(partner);groups.set(groupKey,members);
  }
  const all:{partner:typeof selected[number];sales:ActivitySnapshotRow|null;metrics:PartnerPeriodMetrics|null;pointCount:number;counties:string[];scope:'company'|'point';agents:{id:string;name:string}[]}[]=[];
  for(const members of groups.values()){
    if(++work%128===0)await salesYield();
    // Choose a visible card with company history; never expose an out-of-portfolio card.
    const sorted=await salesSort(members,(a,b)=>(Number(snapshot.rows.get(b.id)?.scope==='company')-Number(snapshot.rows.get(a.id)?.scope==='company'))||a.id.localeCompare(b.id));
    const partner=sorted[0],sales=snapshot.rows.get(partner.id)||null;
    const warehouseIds=new Set(members.flatMap(p=>p.warehouseIds||[]));
    const counties=[...new Set(members.map(p=>p.county).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ro'));
    all.push({partner,sales,metrics:snapshot.metrics.get(partner.id)||null,pointCount:members.length,counties,scope:sales?.scope||'point' as const,agents:agents.filter(a=>warehouseIds.has(a.warehouse_id)).map(a=>({id:a.id,name:a.name}))});
  }
  const matches=(r:typeof all[number],kind:string)=>{
    const a=r.sales?.activity;
    if(kind==='all')return true;
    if(kind==='incomplete')return !a||a.status==='insufficient_history';
    if(!a)return false;
    if(kind==='attention')return a.alertEligible;
    if(kind==='new')return a.isNew;
    if(kind==='reactivated')return a.reactivated;
    return a.status===kind;
  };
  const counts=Object.fromEntries(activityFilters.map(kind=>[kind,all.filter(r=>matches(r,kind)).length])) as Record<ActivityFilter,number>;
  const filtered=await salesSort(all.filter(r=>matches(r,filter)),(a,b)=>{
    const value=(r:typeof a):number|string|null=>sort==='value'?r.metrics?.valueCents??null:sort==='documents'?r.metrics?.documents??null:sort==='lastBilling'?r.metrics?.lastBilling??null:sort==='name'?r.partner.name:sort==='county'?r.counties.join(', ')||null:r.agents.map(a=>a.name).join(', ')||null;
    const aa=value(a),bb=value(b);
    if(aa===null&&bb!==null)return 1;if(bb===null&&aa!==null)return -1;
    const comparison=aa===null||bb===null?0:typeof aa==='number'&&typeof bb==='number'?aa-bb:String(aa).localeCompare(String(bb),'ro');
    return comparison*(direction==='asc'?1:-1)||a.partner.name.localeCompare(b.partner.name,'ro')||a.partner.id.localeCompare(b.partner.id);
  });
  const page=Number(rawPage),total=filtered.length;
  return {state:'ready' as const,through:snapshot.through,asOf:snapshot.asOf,recentStart:snapshot.recentStart,previousStart:snapshot.previousStart,stale:snapshot.stale,
    range:snapshot.range,sort:sort as ActivitySort,direction:direction as 'asc'|'desc',counties,counts,total,page,hasMore:(page+1)*50<total,partners:filtered.slice(page*50,(page+1)*50)};
}
