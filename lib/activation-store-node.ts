import {vodafoneFocusWorkbook} from './vodafone-focus-export';
import {readFocusSlips} from './vodafone-focus-documents-node';
import {selectFocusSource, vodafoneFocusReport} from './vodafone-focus-node';
import {applyVodafoneFocusOverview,readFocusSummaries} from './vodafone-focus-overview';
import {activationPublicationVersion} from './activation-publication-node';
import {distributionReport} from './activation-distribution-node';
import {digiOperatorReported} from './digi-operator-source';
import {activationFactsVersion} from './activation-semantics';
import type {ActivationQuery} from './activation-distribution';
import {DatabaseSync} from 'node:sqlite';
import {resolve,dirname} from 'node:path';
import {existsSync,lstatSync,realpathSync} from 'node:fs';
import {emptyActivationCounts,type ActivationCounts,type ActivationReport,type ActivationProvider} from './activation-types';

// Concurrent read-only opens can briefly contend during native SQLite WAL recovery.
const readerOptions={readOnly:true,timeout:500};
type Row={month:string;item_type:string;site:string;count:number;last_date:string|null};
function add(totals:ActivationCounts,row:Pick<Row,'count'|'item_type'|'site'>){
  totals.total+=row.count;
  if(row.item_type==='SIM')totals.sim+=row.count;
  else if(row.item_type==='TELSIM')totals.telsim+=row.count;
  else totals.other+=row.count;
  if(!row.site)totals.unassigned+=row.count;
}
export function readActivations(month:string,sites:string[]|null,provider:ActivationProvider='vodafone',query?:ActivationQuery,onOverviewBase?:(report:ActivationReport)=>void):ActivationReport{
  const result:ActivationReport={month,provider,available:false,scoped:sites!==null,importedAt:'',latestDate:null,months:[],totals:emptyActivationCounts(),sites:[],history:[]};
  const base=resolve(process.env.MOBIUP_ACTIVATIONS_DIR||process.env.MOBIUP_DATA_DIR||'./work/server-data');
  const network=provider==='digi'?resolve(base,'digi'):base;
  let directory=network;
  const pointer=resolve(network,'current');
  const pointerInfo=lstatSync(pointer,{throwIfNoEntry:false});
  if(pointerInfo){if(!pointerInfo.isSymbolicLink())throw new Error('Invalid generation pointer');directory=realpathSync(pointer);if(dirname(directory)!==resolve(network,'generations'))throw new Error('Invalid generation location');}
  if(onOverviewBase||query?.focus||query?.focusSummaries)result.publication=activationPublicationVersion(provider,directory);
  const path=resolve(directory,'activation-report.sqlite');
  if(!existsSync(path))return result;
  const report=new DatabaseSync(path,readerOptions);
  let source:DatabaseSync|undefined;
  try{
    const meta=Object.fromEntries(report.prepare('SELECT key,value FROM report_meta').all().map(r=>[String(r.key),String(r.value)]));
    if(!['1','2','3','4'].includes(meta.version))throw new Error('Unsupported activation report');
    source=new DatabaseSync(resolve(directory,'activations.sqlite'),readerOptions);
    if(query?.focus||query?.focusSummaries?.length)source.exec('BEGIN');
    const schema=String(source.prepare("SELECT value FROM activation_meta WHERE key='schema_version'").get()?.value);
    if(!['2','3'].includes(schema))throw new Error('Unsupported activation ledger');
    // Activation generation switches are atomic, but an application deploy can
    // precede the next importer-run semantic rebuild. Keep the previously
    // certified v2 read model readable until its complete v3 generation exists.
    const factsVersion=String(source.prepare("SELECT value FROM activation_meta WHERE key='facts_version'").get()?.value||'');
    if(schema==='3'&&(meta.factsVersion!==factsVersion||!['2',activationFactsVersion].includes(factsVersion)))throw new Error('Activation facts require semantic rebuild');
    const imports=source.prepare("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").all().map(r=>[r.sha256,r.operator,r.row_count,r.parser_version]);
    if(JSON.stringify(imports)!==meta.sourceImports)throw new Error('Stale activation report');
    if(meta.sourceGeneration!==undefined&&meta.sourceGeneration!==String(source.prepare("SELECT value FROM activation_meta WHERE key='generation'").get()?.value||''))throw new Error('Stale activation generation');
    if(['3','4'].includes(meta.version)&&meta.rules&&!query)throw new Error('Distribution rules required');
    if(query){
      if(meta.version!=='4')throw new Error('Distribution projection requires rebuild');
      const focusLabels=()=>new Map(report.prepare('SELECT site,label FROM sites').all().map(row=>[String(row.site).toUpperCase(),String(row.label)]));
      const focusGeneration=JSON.stringify([directory,meta.sourceGeneration,meta.sourceImports,meta.builtAt]);
      if(query.focus&&provider==='vodafone'&&schema==='3'){
        const focus=vodafoneFocusReport(source,focusLabels(),sites,query,focusGeneration,readFocusSlips());
        const available=!!focus?.months.some(month=>month.coveredThrough);
        if(query.focus.exportAll&&available&&focus&&(!query.revision||query.revision===focus.revision)){
          return {...result,available,focus:{...focus,detail:undefined},focusWorkbook:vodafoneFocusWorkbook(focus)};
        }
        return {...result,available,focus};
      }
      const scoped=query.focusCardsOnly?result:distributionReport(report,result,meta,sites,query,
        query.progressiveTotals ? onOverviewBase : undefined);
      if(provider==='vodafone'&&query.focusSummaries){
        if(query.returnFocusCards)scoped.focusCards=[];
        if(!query.focusSummaries.length) return applyVodafoneFocusOverview(scoped,[]);
        if(schema!=='3') return {...scoped,commissionCoverage:'missing'};
        // Ordinary totals leave the worker before commercial attribution begins.
        if(!query.focusCardsOnly)onOverviewBase?.({...scoped,commissionCoverage:'unavailable'});
        const labels=focusLabels(),slips=readFocusSlips(),sourceFacts=selectFocusSource(source,query.months);
        return readFocusSummaries(scoped,query.focusSummaries,
          focus=>vodafoneFocusReport(source!,labels,sites,{...query,focus},focusGeneration,slips,sourceFacts),
          !!query.returnFocusCards,!!query.focusCardsOnly);
      }
      if(provider==='digi'){
        for(const entry of scoped.monthly||[])if(entry.reported)entry.source='internal';
        for(const entry of scoped.history)entry.source='internal';
      }
      if(provider==='digi'&&schema==='3'&&sites===null&&!query.view&&query.analysisLimit===undefined&&
          query.policy==='manager'&&new Set(query.projects).size===3){
        const certified=digiOperatorReported(source,query.months);
        if(certified){
          scoped.operatorReported=certified;
          const other=certified.otherChannels+certified.noCommercialMatch+certified.unattributedTR;
          const counts=(total:number,unassigned:number)=>({...emptyActivationCounts(),total,sim:total,unassigned});
          const bySite=new Map(certified.sites.map(row=>[row.site,counts(row.total,0)]));
          if(other)bySite.set('',counts(other,other));
          const certifiedByMonth=new Map(certified.monthly.map(entry=>[entry.month,entry]));
          scoped.monthly=scoped.monthly?.map(internal=>{
            const official=certifiedByMonth.get(internal.month);
            return official?{month:official.month,reported:true,source:'operator' as const,
              counts:counts(official.total,official.otherChannels+official.noCommercialMatch)}:internal;
          });
          scoped.history=(scoped.monthly||[]).filter(entry=>entry.reported)
            .map(({month,source,counts})=>({month,source,...counts}));
          // Use the same months for the selection total, chart and per-site rows.
          const totals=counts(certified.total,other);
          const internalMonths:string[]=[];
          for(const entry of scoped.history){
            if(entry.source!=='internal')continue;
            internalMonths.push(entry.month);
            totals.total+=entry.total;
            totals.sim+=entry.sim;
            totals.telsim+=entry.telsim;
            totals.other+=entry.other;
            totals.unassigned+=entry.unassigned;
          }
          scoped.totals=totals;
          if(internalMonths.length){
            const internalSites=report.prepare(`SELECT site,item_type,SUM(count) count
              FROM dimension_monthly WHERE provider='digi' AND is_tr=1
              AND month IN (SELECT value FROM json_each(?)) GROUP BY site,item_type`
            ).all(JSON.stringify(internalMonths)) as Pick<Row,'site'|'item_type'|'count'>[];
            for(const row of internalSites){
              const site=bySite.get(row.site)||emptyActivationCounts();
              add(site,row);
              bySite.set(row.site,site);
            }
          }
          const labels=new Map(report.prepare('SELECT site,label FROM sites').all().map(r=>[String(r.site),String(r.label)]));
          scoped.sites=[...bySite].map(([site,total])=>({
            site,label:site?(labels.get(site)||site):'Fără gestiune TR atribuită',...total,
          })).sort((a,b)=>b.total-a.total||a.site.localeCompare(b.site));
          scoped.months=scoped.history.map(({month,total})=>({month,total}));
          scoped.coveredMonths=scoped.history.map(entry=>entry.month);
          // The old reconciliation value sums obsolete overlapping operator
          // snapshots, so it is not a unique-SIM metric.
          scoped.reconciliation=undefined;
        }
      }
      return scoped;
    }
    const allowed=sites===null?null:new Set(sites);
    const rows=(meta.version!=='1'
      ?report.prepare("SELECT month,item_type,site,count,last_date FROM monthly WHERE month<>'' AND provider=? ORDER BY month DESC,site").all(provider)
      :provider==='vodafone'?report.prepare("SELECT month,item_type,site,count,last_date FROM monthly WHERE month<>'' ORDER BY month DESC,site").all():[]) as Row[];
    const scopedRows=rows.filter(r=>allowed===null||allowed.has(r.site));
    const labels=new Map(report.prepare('SELECT site,label FROM sites').all().map(r=>[String(r.site),String(r.label)]));
    const history=new Map<string,ActivationCounts>(),agents=new Map<string,ActivationCounts>();
    for(const row of scopedRows){
      const monthly=history.get(row.month)||emptyActivationCounts();add(monthly,row);history.set(row.month,monthly);
      if(row.last_date&&(!result.latestDate||row.last_date>result.latestDate))result.latestDate=row.last_date;
      if(row.month!==month)continue;
      add(result.totals,row);
      const agent=agents.get(row.site)||emptyActivationCounts();add(agent,row);agents.set(row.site,agent);
    }
    result.available=meta.version==='1'?provider==='vodafone'&&imports.length>0:imports.some(r=>r[1]===provider);
    result.importedAt=meta.importedAt;
    result.history=[...history].map(([month,counts])=>({month,...counts}));
    result.months=result.history.map(({month,total})=>({month,total}));
    result.sites=[...agents].map(([site,counts])=>({site,label:site?(labels.get(site)||site):'De repartizat',...counts})).sort((a,b)=>b.total-a.total||a.site.localeCompare(b.site));
    return result;
  }finally{source?.close();report.close();}
}

export {activationPublicationVersion};
export {verifySim} from './sim-verification-node';

export {readDigiOverview,readVodafoneFocus} from './vodafone-focus-runtime-node';

export {readVodafoneBonusAsync,readVodafoneSim0RankingAsync} from './vodafone-bonus-runtime-node';

export {readCombinedActivationPartners} from './activation-partners-runtime-node';
