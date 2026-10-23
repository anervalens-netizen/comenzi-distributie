import type {ActivationReport,CombinedActivationPartners} from './activation-types';
import {activationPartnerSummary} from './activation-partner-summary';
import {partnerScope} from './partner-portfolio';
import {normalizedCui} from './partner-company-identity';
import {canViewActivations} from './activation-access';
import {readActivations} from '#mobiup-activation-store';
import {db,fail,isGlobalManager,sha256} from './server';
import {managerFilter} from './manager-scope';
import {bucharestMonthKey} from './bucharest-month';
import {readDistributionRules} from './distribution-config';
import {assignmentFor,projectIds,type DistributionProject} from './distribution-rules';
import type {ActivationPolicy,ActivationQuery} from './activation-distribution';
import type {User} from './types';
export async function activationReport(user:User,params:URLSearchParams,internal?:{allPartners:boolean}):Promise<ActivationReport|CombinedActivationPartners>{
 if(!canViewActivations(user))fail(403,'Secțiunea Activări nu este disponibilă pentru acest cont.');
 for(const key of params.keys())if(!['provider','month','months','projects','managerId','agentId','siteCode','view','point','company','q','page','revision'].includes(key))fail(400,'Filtru necunoscut.');
 const provider=params.get('provider')||'vodafone';
 if(provider==='both'){
   if(params.get('view')!=='partners')fail(400,'Vedere invalidă pentru ambii operatori.');
   const rawPage=params.get('page')||'0';if(!/^\d{1,6}$/.test(rawPage))fail(400,'Pagină invalidă.');
   const page=Number(rawPage),operators:CombinedActivationPartners['operators']={},groups=new Map<string,import('./activation-types').ActivationPartner&{vodafone:number;digi:number}>();
   const revisions:string[]=[];
   for(const network of ['vodafone','digi'] as const){
     const q=new URLSearchParams(params);q.set('provider',network);q.set('page','0');q.delete('revision');
     try{
       const report=await activationReport(user,q,{allPartners:true});
       if(report.provider==='both')throw new Error('Invalid network report');
       operators[network]={available:report.available,latestDate:report.latestDate,importedAt:report.importedAt};revisions.push(report.revision||'');
       for(const p of report.partners?.rows||[]){const existing=groups.get(p.key)||{...p,total:0,vodafone:0,digi:0,recent:{'7':0,'14':0,'30':0}};existing.total+=p.total;existing[network]+=p.total;for(const days of ['7','14','30'])existing.recent[days]+=p.recent[days]||0;if(p.lastDate&&(!existing.lastDate||p.lastDate>existing.lastDate))existing.lastDate=p.lastDate;groups.set(p.key,existing);}
     }catch{operators[network]={available:false,error:'Datele operatorului nu sunt disponibile.'};revisions.push('unavailable');}
   }
   const revision=sha256(JSON.stringify([revisions,user.id,params.get('months'),params.get('projects'),params.get('q')]));
   if(params.has('revision')&&params.get('revision')!==revision)fail(409,'Proiecția s-a modificat. Reîncarcă lista.');
   const activePortfolio=new Set([...groups.values()].filter(p=>p.total>0&&p.portfolioId).map(p=>p.portfolioId));
   const values=[...groups.values()].filter(p=>p.total>0||!p.portfolioId||!activePortfolio.has(p.portfolioId)).sort((a,b)=>b.total-a.total||a.key.localeCompare(b.key));
   return {provider:'both' as const,operators,revision,partners:{...activationPartnerSummary(values),rows:values.slice(page*50,(page+1)*50),total:values.length,page,hasMore:(page+1)*50<values.length}};
 }

 if(provider!=='vodafone'&&provider!=='digi')fail(400,'Alege un operator valid.');
 const month=params.get('month')||bucharestMonthKey(new Date());
 const validMonth=(m:string)=>/^20\d{2}-(0[1-9]|1[0-2])$/.test(m);
 if(!validMonth(month))fail(400,'Alege o lună validă.');
 const values=(key:string,fallback:string[])=>params.has(key)?[...new Set(params.getAll(key).flatMap(v=>v.split(',')).filter(Boolean))].sort():fallback;
 const months=values('months',[month]),projects=values('projects',[...projectIds]);
 if(months.length>36||months.some(m=>!validMonth(m))||projects.some(p=>!(projectIds as readonly string[]).includes(p)))fail(400,'Selecția perioadei sau proiectelor este invalidă.');
 let sites:string[]|null;let policy:ActivationPolicy='manager';
 const rules=await readDistributionRules();
 if(user.role==='manager'){
   const filter=await managerFilter(user,params);
   sites=filter?.siteCodes??null;
   if(!isGlobalManager(user)&&!filter)sites=(await managerFilter(user,new URLSearchParams({managerId:user.id})))?.siteCodes||[];
 }else{
   if(['agentId','managerId','siteCode'].some(k=>params.has(k)))fail(403,'Filtrul nu este disponibil pentru acest cont.');
   const code=user.siteCode?.trim();
   const owners=code?(await db().prepare("SELECT id FROM users WHERE role='agent' AND UPPER(TRIM(site_code))=UPPER(?)").bind(code).all<{id:string}>()).results:[];
   sites=code&&owners.length===1&&owners[0].id===user.id?[code]:[];
   if(rules){const a=assignmentFor(rules,user.id,code||'');if(!a)sites=[];policy=a?.projectId==='vodafone_nord'?'north':a?.projectId==='vodafone_sud'?'south':'nonexclusive';}
 }
 if(params.has('siteCode')){
   const site=params.get('siteCode')?.trim()||'';
   sites=site&&(sites===null||sites.some(s=>s.toUpperCase()===site.toUpperCase()))?[site]:[];
 }
 let query:ActivationQuery|undefined;
 if(rules){
   const view=params.get('view')||'';
   if(view&&!['partners','detail','export'].includes(view))fail(400,'Vedere invalidă.');
   const page=params.get('page')||'0';if(!/^\d{1,6}$/.test(page))fail(400,'Pagină invalidă.');
   for(const k of ['point','company','q','revision'])if((params.get(k)?.length||0)>500)fail(400,'Filtru prea lung.');
   query={allPartners:internal?.allPartners,rules,policy,months,projects:projects as DistributionProject[],view:view as ActivationQuery['view'],point:params.get('point')||undefined,company:params.get('company')||undefined,q:params.get('q')||'',page:Number(page),revision:params.get('revision')||undefined};
   if(view==='partners'){
     const scope=partnerScope(user);
     const agentSites=rules.assignments.filter(a=>projects.includes(a.projectId)&&(sites===null||sites.some(s=>s.toUpperCase()===a.siteCode.toUpperCase()))).map(a=>a.siteCode.toUpperCase());
     const rows=(await db().prepare(`SELECT c.id,c.data FROM customers c WHERE c.active=1 AND ${scope.sql} AND EXISTS(SELECT 1 FROM users u JOIN json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w ON w.value=u.warehouse_id WHERE u.role='agent' AND u.active=1 AND UPPER(TRIM(u.site_code)) IN (SELECT value FROM json_each(?))) ORDER BY c.id`).bind(...scope.args,JSON.stringify(agentSites)).all<{id:string;data:string}>()).results;
     query.portfolio=rows.map(r=>{const p=JSON.parse(r.data);return {id:r.id,name:p.name||'',client:normalizedCui(p.cui||''),codes:[...new Set([...(p.historyFranchises||[]),p.historyCatalog?.franchiseCode||''].filter(Boolean).map(c=>String(c).trim().toUpperCase()))] as string[]};});
     // Include current membership in pagination identity; no authorization result is cached.
     query.portfolioRevision=sha256(JSON.stringify(query.portfolio));
   }
 }else if(['months','projects','view'].some(k=>params.has(k)))fail(503,'Proiecția pentru proiecte trebuie pregătită.');
 try{return readActivations(month,sites,provider,query);}catch{fail(503,'Activările nu sunt disponibile momentan. Încearcă din nou mai târziu.');}
}
