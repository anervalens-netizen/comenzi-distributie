import {activationPartnerView} from './activation-partners-node';
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {vodafoneEligibility,type DistributionRules} from './distribution-rules';
import {visibleActivation,type ActivationQuery} from './activation-distribution';
import {emptyActivationCounts,type ActivationReport,type ActivationCounts,type ActivationProvider} from './activation-types';
export const canonicalRules=(r:unknown):string=>JSON.stringify(r&&typeof r==='object'&&!Array.isArray(r)?Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,JSON.parse(canonicalRules(v))])):Array.isArray(r)?r.map(v=>JSON.parse(canonicalRules(v))):r);
type Dimension={month:string;site:string;item_type:string;county:string;handset:string;contradictory:number;count:number;last_date:string};
function add(t:ActivationCounts,r:Dimension,rules:DistributionRules,provider:ActivationProvider){
 t.total+=r.count;t[r.item_type==='SIM'?'sim':r.item_type==='TELSIM'?'telsim':'other']+=r.count;if(!r.site)t.unassigned+=r.count;
 if(provider!=='vodafone')return;
 const a=rules.assignments.find(a=>a.siteCode.toUpperCase()===r.site.toUpperCase());
 const e=vodafoneEligibility(r.county,r.handset,a?.territoryId||null,!!r.contradictory);
 if(e.eligible){t.eligible=(t.eligible||0)+r.count;const key=e.region==='own'?'ownRegion':e.region==='other'?'otherRegion':'unknownRegion';t[key]=(t[key]||0)+r.count;}
 else{t.ineligible=(t.ineligible||0)+r.count;for(const reason of e.reasons){t.reasons??={};t.reasons[reason]=(t.reasons[reason]||0)+r.count;}}
}
/** Every read, including month discovery and drill-down, uses this same SQL scope. */
export function distributionReport(report:DatabaseSync,base:ActivationReport,meta:Record<string,string>,sites:string[]|null,query:ActivationQuery):ActivationReport{
 if(!meta.rules||canonicalRules(JSON.parse(meta.rules))!==canonicalRules(query.rules))throw new Error('Stale distribution rules');
 const {provider}=base,{rules}=query;
 const revision=createHash('sha256').update(meta.version+'|'+meta.builtAt+'|'+meta.sourceImports+'|'+meta.sourceGeneration+'|'+meta.rules+'|'+query.policy+'|'+JSON.stringify(sites)+'|'+JSON.stringify([query.projects,query.months,query.q,query.point,query.company,query.portfolioRevision])).digest('hex');
 if(query.revision&&query.revision!==revision)throw new Error('Stale activation selection');
 const clauses=['provider=?','is_tr=1'],args:(string|number)[]=[provider];
 const selectedSites=rules.assignments.filter(a=>query.projects.includes(a.projectId)).map(a=>a.siteCode.toUpperCase());
 if(query.projects.length<3){clauses.push(`UPPER(site) IN (${selectedSites.map(()=>'?').join(',')||'NULL'})`);args.push(...selectedSites);}
 if(sites!==null){clauses.push(`UPPER(site) IN (${sites.map(()=>'?').join(',')||'NULL'})`);args.push(...sites.map(s=>s.toUpperCase()));}
 report.function('activation_visible',{deterministic:true},(county,handset,conflict)=>visibleActivation(provider,String(county),String(handset),!!conflict,query.policy)?1:0);
 clauses.push('activation_visible(county,handset,contradictory)=1');
 const where=clauses.join(' AND '),monthWhere=query.months.length?`month IN (${query.months.map(()=>'?').join(',')})`:'0';
 const dimensions=report.prepare(`SELECT COALESCE(month,'') month,site,item_type,county,handset,contradictory,count,last_date FROM dimension_monthly WHERE ${where} ORDER BY month DESC,site`).all(...args) as Dimension[];
 const newCounts=():ActivationCounts=>({...emptyActivationCounts(),...(provider==='vodafone'?{eligible:0,ownRegion:0,otherRegion:0,unknownRegion:0,...(query.policy==='south'?{}:{ineligible:0,reasons:{}})}:{})});
 const labels=new Map(report.prepare('SELECT site,label FROM sites').all().map(r=>[String(r.site),String(r.label)])),history=new Map<string,ActivationCounts>(),agents=new Map<string,ActivationCounts>();
 const result={...base,available:JSON.parse(meta.sourceImports).some((i:unknown[])=>i[1]===provider),importedAt:meta.importedAt,latestDate:meta.latestDate||null,revision,rulesRevision:rules.revision,selectedMonths:query.months,builtAt:meta.builtAt,totals:newCounts(),history:[],months:[],sites:[]} as ActivationReport;
 for(const row of dimensions){
   if(!row.month)continue;
   const h=history.get(row.month)||newCounts();add(h,row,rules,provider);history.set(row.month,h);
   if(row.last_date&&(!result.latestDate||row.last_date>result.latestDate))result.latestDate=row.last_date;
   if(!query.months.includes(row.month))continue;
   add(result.totals,row,rules,provider);const a=agents.get(row.site)||newCounts();add(a,row,rules,provider);agents.set(row.site,a);
 }
 result.history=[...history].map(([month,counts])=>({month,...counts}));result.months=result.history.map(({month,total})=>({month,total}));
 result.sites=[...agents].map(([site,counts])=>({site,label:site?(labels.get(site)||site):'Agent de verificat',...counts})).sort((a,b)=>b.total-a.total||a.site.localeCompare(b.site));
 result.coveredMonths=query.months.filter(m=>result.months.some(r=>r.month===m));
 result.sourcePeriods=JSON.parse(meta.sourcePeriods||'[]');
 // Distribution cohort is independent of activation month. Apply only the authorized seller/project scope.
 const cohortClauses=['provider=?'],cohortArgs:(string|number)[]=[provider];
 const allowedSites=rules.assignments.filter(a=>query.projects.includes(a.projectId)&&(sites===null||sites.some(s=>s.toUpperCase()===a.siteCode.toUpperCase()))).map(a=>a.siteCode.toUpperCase());
 cohortClauses.push(`UPPER(site) IN (${allowedSites.map(()=>'?').join(',')||'NULL'})`);cohortArgs.push(...allowedSites);
 cohortClauses.push(`distribution_month IN (${query.months.map(()=>'?').join(',')||'NULL'})`);cohortArgs.push(...query.months);
 const zeroCodes=Object.entries(rules.products).filter(([,group])=>group==='vodafone_0').map(([code])=>code);
 cohortClauses.push(`item_code IN (${zeroCodes.map(()=>'?').join(',')||'NULL'})`);cohortArgs.push(...zeroCodes);
 if(provider==='vodafone'&&query.policy==='manager'){
   const row=report.prepare(`SELECT COUNT(*) distributed,COALESCE(SUM(activated),0) activated FROM cohorts WHERE ${cohortClauses.join(' AND ')}`).get(...cohortArgs)!;
   result.simZero={distributed:Number(row.distributed),activated:Number(row.activated),withoutReportedActivation:Number(row.distributed)-Number(row.activated)};
 }
 // No operator-only serial enters distribution KPI; managers see a separate reconciliation count.
 if(query.policy==='manager'&&sites===null&&query.projects.length===3)result.reconciliation=Number(report.prepare(`SELECT COUNT(*) n FROM details WHERE provider=? AND is_tr=0 AND ${monthWhere}`).get(provider,...query.months)?.n||0);
 activationPartnerView(report,result,where,args,query);
 return result;
}
