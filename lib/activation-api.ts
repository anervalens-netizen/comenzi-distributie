import {emptyActivationCounts,type ActivationReport,type CombinedActivationPartners} from './activation-types';
import {activationPartnerSortKeys,activationTodayWindow,type ActivationPartnerSort,type ActivationSortDirection} from './activation-partner-sort';
import {ActivationPartnerProjectionChanged,portfolioSelection,portfolioPoint,type PortfolioFields,type CombinedPartnerRead} from './activation-portfolio';
import {canViewActivations} from './activation-access';
import {readActivations,readDigiOverview,readVodafoneFocus,readCombinedActivationPartners} from '#mobiup-activation-store';
import {db,fail,isGlobalManager,sha256} from './server';
import {managerFilter} from './manager-scope';
import {bucharestMonthKey} from './bucharest-month';
import {readDistributionRules} from './distribution-config';
import {assignmentFor,projectIds,type DistributionProject,type DistributionRules} from './distribution-rules';
import type {ActivationPolicy,ActivationQuery} from './activation-distribution';
import {isVodafoneFocusView,isVodafoneOverview,vodafoneFocusQuery,vodafoneFocusTerritory} from './vodafone-focus-api';
import {focusProjects,focusSiteScope,focusTerritories} from './vodafone-focus';
import type {User} from './types';
async function activationScope(user:User,params:URLSearchParams,rules:DistributionRules|null){
 let sites:string[]|null;let policy:ActivationPolicy='manager';
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
 return {sites,policy};
}

export async function activationReport(user:User,params:URLSearchParams,internal?:{overviewPhase?:'totals'|'panels'|'cards';returnFocusCards?:boolean;allPartners?:boolean;analysisLimit?:number;omitFocus?:boolean;todayWindow?:{from:string;to:string};revalidateFocus?:()=>Promise<User>}):Promise<ActivationReport|CombinedActivationPartners>{
 if(!canViewActivations(user))fail(403,'Secțiunea Activări nu este disponibilă pentru acest cont.');
 for(const key of params.keys())if(!['provider','month','months','projects','managerId','agentId','siteCode','view','point','company','q','page','revision','sort','direction','focusKind','focusSite','focusTerritory'].includes(key))fail(400,'Filtru necunoscut.');
 const sort=params.get('sort')||'total',direction=params.get('direction')||'desc';
 if(!(activationPartnerSortKeys as readonly string[]).includes(sort)||!['asc','desc'].includes(direction))fail(400,'Sortare invalidă.');
 const provider=params.get('provider')||'vodafone';
 const focusView=isVodafoneFocusView(params.get('view'));
 if(focusView&&provider!=='vodafone')fail(400,'Focus este disponibil pentru Vodafone.');
 if(!focusView&&(params.has('focusKind')||params.has('focusSite')||params.has('focusTerritory')))fail(400,'Filtru Focus necunoscut.');
 if(provider==='both'&&params.get('view')!=='partners')fail(400,'Vedere invalidă pentru ambii operatori.');
 if(provider!=='both'&&provider!=='vodafone'&&provider!=='digi')fail(400,'Alege un operator valid.');
 const month=params.get('month')||bucharestMonthKey(new Date());
 const validMonth=(m:string)=>/^20\d{2}-(0[1-9]|1[0-2])$/.test(m);
 if(!validMonth(month))fail(400,'Alege o lună validă.');
 const values=(key:string,fallback:string[])=>params.has(key)?[...new Set(params.getAll(key).flatMap(v=>v.split(',')).filter(Boolean))].sort():fallback;
 const months=values('months',[month]),projects=values('projects',[...projectIds]);
 if(months.length>36||months.some(m=>!validMonth(m))||projects.some(p=>!(projectIds as readonly string[]).includes(p)))fail(400,'Selecția perioadei sau proiectelor este invalidă.');
 const rules=await readDistributionRules();
 const {sites,policy}=await activationScope(user,params,rules);
 let query:ActivationQuery|undefined;
 if(rules){
   const view=params.get('view')||'';
   if(view&&!focusView&&!['partners','detail','export'].includes(view))fail(400,'Vedere invalidă.');
   const page=params.get('page')||'0';if(!/^\d{1,6}$/.test(page))fail(400,'Pagină invalidă.');
   for(const k of ['point','company','q','revision'])if((params.get(k)?.length||0)>500)fail(400,'Filtru prea lung.');
   query={allPartners:internal?.allPartners,analysisLimit:internal?.analysisLimit,rules,policy,months,projects:projects as DistributionProject[],view:view as ActivationQuery['view'],point:params.get('point')||undefined,company:params.get('company')||undefined,q:params.get('q')||'',page:Number(page),revision:params.get('revision')||undefined};
   if(focusView){
     query.view=undefined;
     const territory=vodafoneFocusTerritory(params);
     if(query.projects.includes(focusProjects[territory])&&(policy==='manager'||rules.assignments.some(a=>a.userId===user.id&&a.territoryId===territory))){
       query.focus=await vodafoneFocusQuery(rules,territory,params,sites,user.role==='manager');
     }else return {month,provider:'vodafone',available:false,scoped:sites!==null,importedAt:'',latestDate:null,months:[],totals:emptyActivationCounts(),sites:[],history:[]};
   }else if(!internal?.omitFocus&&isVodafoneOverview(params)){
     query.returnFocusCards=internal?.returnFocusCards;
     query.progressiveTotals=internal?.overviewPhase==='totals'||internal?.overviewPhase==='panels'||undefined;
     query.focusCardsOnly=internal?.overviewPhase==='cards'||undefined;
     const territories=focusTerritories.filter(territory=>query!.projects.includes(focusProjects[territory])&&
       (policy==='manager'||rules.assignments.some(a=>a.userId===user.id&&a.territoryId===territory)));
     const summaries=await Promise.all(territories.map(territory=>vodafoneFocusQuery(rules,territory,params,sites,user.role==='manager')));
     query.focusSummaries=summaries.filter(summary=>{
       const scope=focusSiteScope(rules,summary.territory,summary.historicalSites,sites,user.role==='manager');
       return scope.regionalVisible||scope.visible.size>0;
     });
   }
   if(view==='partners'){
     query.todayWindow=internal?.todayWindow||activationTodayWindow();
     if(provider!=='both'){
       const scope=await partnerWarehouseScope(user,sites,query);
       const selection=portfolioSelection(scope);
       const rows=await db().prepare(selection.sql).bind(...selection.args).all<PortfolioFields>();
       query.portfolio=rows.results.map(portfolioPoint);
       query.portfolioRevision=sha256(JSON.stringify(query.portfolio));
     }
   }
 }else if(['months','projects','view'].some(k=>params.has(k)))fail(503,'Proiecția pentru proiecte trebuie pregătită.');
 if(provider==='both'){
   if(!query)fail(503,'Proiecția pentru proiecte trebuie pregătită.');
   const readInput=()=>partnerReadInput(user,params,month,sites,query,sort as ActivationPartnerSort,direction as ActivationSortDirection);
   let input=await readInput(),result:CombinedActivationPartners;
   for(let attempt=0;;attempt++){
     try {result=await readCombinedActivationPartners(input,query.page||0);break;}
     catch(error){
       if(!(error instanceof ActivationPartnerProjectionChanged))fail(503,'Raportul partenerilor nu este disponibil momentan. Încearcă din nou mai târziu.');
       if(attempt>0 || query.page || params.has('revision'))fail(409,'Proiecția s-a modificat. Reîncarcă lista.');
       // Only an unpinned first page may restart on a newer publication.
       input=await readInput();
     }
   }
   // Rights and assignments can change while a report is queued off-thread.
   const current=internal?.revalidateFocus ? await internal.revalidateFocus() : user;
   if(current.id!==user.id || current.profileVersion!==user.profileVersion || current.role!==user.role ||
      current.managerScope!==user.managerScope || current.warehouseId!==user.warehouseId ||
      current.siteCode!==user.siteCode || !canViewActivations(current))fail(409,'Accesul la raport s-a modificat. Reîncarcă lista.');
   const latestRules=await readDistributionRules();
   const latest=await activationScope(current,params,latestRules);
   if (JSON.stringify(latestRules)!==JSON.stringify(query.rules) || JSON.stringify(latest.sites)!==JSON.stringify(sites) ||
       latest.policy!==query.policy || JSON.stringify(await partnerReadInput(current,params,month,latest.sites,query,input.sort,input.direction))!==JSON.stringify(input)) {
     fail(409,'Proiecția s-a modificat. Reîncarcă lista.');
   }
   if(params.has('revision') && result.revision!==params.get('revision'))fail(409,'Proiecția s-a modificat. Reîncarcă lista.');
   return result;
 }
 // Only the HTTP overview supplies a session recheck. Internal analysis reads
 // retain their existing reader and authorization boundary.
 const digiOverview=provider==='digi'&&!params.get('view')&&!!internal?.revalidateFocus;
 let result:ActivationReport;
 const focusQueries=query?.focus?[query.focus]:query?.focusSummaries??[];
 try{
   if(digiOverview)result=await readDigiOverview(month,sites,query);
   else if(query&&(query.focus||query.focusSummaries))result=await readVodafoneFocus(month,sites,query,internal?.overviewPhase==='totals');
   else result=readActivations(month,sites,provider,query);
 }catch{
   fail(503,'Activările nu sunt disponibile momentan. Încearcă din nou mai târziu.');
 }
 // Report calculations can wait for a worker while assignments change.
 // Recheck the exact session and reproduce its authorized scope before publishing.
 if((digiOverview||query?.focus||query?.focusSummaries)&&internal?.revalidateFocus){
   const current=await internal.revalidateFocus();
   if(!canViewActivations(current))fail(403,'Secțiunea Activări nu este disponibilă pentru acest cont.');
   const currentRules=await readDistributionRules();
   const currentScope=await activationScope(current,params,currentRules);
   if(current.id!==user.id||current.profileVersion!==user.profileVersion||current.role!==user.role||
      current.managerScope!==user.managerScope||currentScope.policy!==policy||
      JSON.stringify(currentScope.sites)!==JSON.stringify(sites)||JSON.stringify(currentRules)!==JSON.stringify(rules)){
     fail(409,'Accesul la raport s-a modificat. Reîncarcă activările.');
   }
   const currentQueries=await Promise.all(focusQueries.map(focus=>vodafoneFocusQuery(currentRules!,focus.territory,params,currentScope.sites,current.role==='manager')));
   if(currentQueries.some((focus,index)=>JSON.stringify(focus.historicalSites)!==JSON.stringify(focusQueries[index].historicalSites))){
     fail(409,'Configurarea gestiunilor istorice s-a modificat. Reîncarcă activările.');
   }
 }
 if(focusView&&query?.revision&&result.focus?.revision!==query.revision)fail(409,'Sursele Focus s-au modificat. Reîncarcă raportul.');
 return result;
}


async function partnerWarehouseScope(user:User, sites:string[]|null, query:ActivationQuery) {
  const siteCodes=new Set(sites?.map(site=>site.toUpperCase()));
  const projectSites=query.rules.assignments.filter(a=>query.projects.includes(a.projectId) && (sites===null || siteCodes.has(a.siteCode.toUpperCase()))).map(a=>a.siteCode.toUpperCase());
  const warehouses=async (sql:string,args:string[])=>{
    const {results}=await db().prepare(sql).bind(...args).all<{id:string}>();
    return results.map(row=>row.id);
  };
  const selected=await warehouses(`SELECT DISTINCT warehouse_id id FROM users WHERE role='agent' AND active=1
    AND warehouse_id IS NOT NULL AND UPPER(TRIM(site_code)) IN (SELECT value FROM json_each(?)) ORDER BY warehouse_id`,[JSON.stringify(projectSites)]);
  const owned=isGlobalManager(user)?null:user.role==='agent'?[user.warehouseId||'']:await warehouses(`SELECT DISTINCT a.warehouse_id id
    FROM users a JOIN manager_agents ma ON ma.agent_id=a.id WHERE ma.manager_id=? AND a.active=1 AND a.warehouse_id IS NOT NULL ORDER BY a.warehouse_id`,[user.id]);
  return {selected,owned};
}

async function partnerReadInput(user:User,params:URLSearchParams,month:string,sites:string[]|null,query:ActivationQuery,sort:ActivationPartnerSort,direction:ActivationSortDirection):Promise<CombinedPartnerRead>{
  const scope=await partnerWarehouseScope(user,sites,query);
  const revision=await db().prepare('SELECT revision FROM crm_directory_revision WHERE id=1').first<{revision:number}>();
  if(!revision)fail(503,'Indexul portofoliului nu este disponibil.');
  const managerIds=(process.env.MOBIUP_ACTIVATIONS_VODAFONE_ONLY_MANAGER_IDS||'').split(',').map(id=>id.trim()).filter(Boolean);
  const showDigi=user.role==='manager'?!managerIds.includes(user.id):!managerIds.length||
    !await db().prepare('SELECT 1 ok FROM manager_agents WHERE agent_id=? AND manager_id IN (SELECT value FROM json_each(?)) LIMIT 1').bind(user.id,JSON.stringify(managerIds)).first();
  return {userId:user.id,profileVersion:user.profileVersion,role:user.role,managerScope:user.managerScope,month,sites,
    query:{...query,revision:undefined,page:undefined},sort,direction,scope,showDigi,selectionParams:[params.get('months'),params.get('projects'),params.get('q')],crmRevision:revision.revision};
}
