import {portfolioSummary} from './partner-portfolio';
import {managerFilter} from './manager-scope';
import {fail} from './server';
import {readActivitySnapshot} from './partner-activity-snapshot';
import type {User} from './types';
export const activityFilters=['all','attention','regular','overdue','inactive','reactivated','new','occasional','incomplete'] as const;
export type ActivityFilter=typeof activityFilters[number];
const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export type PartnerActivityOverview=Awaited<ReturnType<typeof partnerActivityOverview>>;
export async function partnerActivityOverview(user:User,params:URLSearchParams){
  const filter=params.get('activity')||'all',rawPage=params.get('page')||'0';
  if(!activityFilters.includes(filter as ActivityFilter)||!/^\d{1,5}$/.test(rawPage))fail(400,'Filtrul de activitate este invalid.');
  for(const key of ['q','county'])if((params.get(key)?.length||0)>300)fail(400,'Filtrul este prea lung.');
  const scope=await managerFilter(user,params),partners=await portfolioSummary(user,undefined,scope?.warehouseIds);
  const counties=[...new Set(partners.map(p=>p.county).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ro'));
  const q=normalize(params.get('q')||''),county=params.get('county')||'';
  const selected=partners.filter(p=>(!county||p.county===county)&&(!q||normalize([p.name,p.cui,p.address,p.city].join(' ')).includes(q)));
  const snapshot=readActivitySnapshot(selected);
  if(snapshot.state!=='ready')return snapshot;
  const all=selected.map(partner=>({partner,sales:snapshot.rows.get(partner.id)||null}));
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
  const filtered=all.filter(r=>matches(r,filter)).sort((a,b)=>{
    const aa=a.sales?.activity,bb=b.sales?.activity;
    const score=(v:typeof aa)=>v?.alertEligible?(v.daysSinceBilling||0)/Math.max(1,v.cadenceDays||1):0;
    return score(bb)-score(aa)||(b.sales?.previousCents||0)-(a.sales?.previousCents||0)||a.partner.name.localeCompare(b.partner.name,'ro')||a.partner.id.localeCompare(b.partner.id);
  });
  const page=Number(rawPage),total=filtered.length;
  return {state:'ready' as const,through:snapshot.through,asOf:snapshot.asOf,recentStart:snapshot.recentStart,previousStart:snapshot.previousStart,stale:snapshot.stale,
    counties,counts,total,page,hasMore:(page+1)*50<total,partners:filtered.slice(page*50,(page+1)*50)};
}
