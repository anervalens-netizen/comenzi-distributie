import {distributionReport} from './activation-distribution-node';
import {activationFactsVersion} from './activation-semantics';
import type {ActivationQuery} from './activation-distribution';
import {DatabaseSync} from 'node:sqlite';
import {resolve,dirname} from 'node:path';
import {existsSync,lstatSync,realpathSync} from 'node:fs';
import {emptyActivationCounts,type ActivationCounts,type ActivationReport,type ActivationProvider} from './activation-types';

type Row={month:string;item_type:string;site:string;count:number;last_date:string|null};
function add(totals:ActivationCounts,row:Row){
  totals.total+=row.count;
  if(row.item_type==='SIM')totals.sim+=row.count;
  else if(row.item_type==='TELSIM')totals.telsim+=row.count;
  else totals.other+=row.count;
  if(!row.site)totals.unassigned+=row.count;
}
export function readActivations(month:string,sites:string[]|null,provider:ActivationProvider='vodafone',query?:ActivationQuery):ActivationReport{
  const result:ActivationReport={month,provider,available:false,scoped:sites!==null,importedAt:'',latestDate:null,months:[],totals:emptyActivationCounts(),sites:[],history:[]};
  const base=resolve(process.env.MOBIUP_ACTIVATIONS_DIR||process.env.MOBIUP_DATA_DIR||'./work/server-data');
  const network=provider==='digi'?resolve(base,'digi'):base;
  let directory=network;
  const pointer=resolve(network,'current');
  const pointerInfo=lstatSync(pointer,{throwIfNoEntry:false});
  if(pointerInfo){if(!pointerInfo.isSymbolicLink())throw new Error('Invalid generation pointer');directory=realpathSync(pointer);if(dirname(directory)!==resolve(network,'generations'))throw new Error('Invalid generation location');}
  const path=resolve(directory,'activation-report.sqlite');
  if(!existsSync(path))return result;
  const report=new DatabaseSync(path,{readOnly:true});
  let source:DatabaseSync|undefined;
  try{
    const meta=Object.fromEntries(report.prepare('SELECT key,value FROM report_meta').all().map(r=>[String(r.key),String(r.value)]));
    if(!['1','2','3','4'].includes(meta.version))throw new Error('Unsupported activation report');
    source=new DatabaseSync(resolve(directory,'activations.sqlite'),{readOnly:true});
    const schema=String(source.prepare("SELECT value FROM activation_meta WHERE key='schema_version'").get()?.value);
    if(!['2','3'].includes(schema))throw new Error('Unsupported activation ledger');
    if(schema==='3'&&(meta.factsVersion!==activationFactsVersion||String(source.prepare("SELECT value FROM activation_meta WHERE key='facts_version'").get()?.value||'')!==activationFactsVersion))throw new Error('Activation facts require semantic rebuild');
    const imports=source.prepare("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").all().map(r=>[r.sha256,r.operator,r.row_count,r.parser_version]);
    if(JSON.stringify(imports)!==meta.sourceImports)throw new Error('Stale activation report');
    if(meta.sourceGeneration!==undefined&&meta.sourceGeneration!==String(source.prepare("SELECT value FROM activation_meta WHERE key='generation'").get()?.value||''))throw new Error('Stale activation generation');
    if(['3','4'].includes(meta.version)&&meta.rules&&!query)throw new Error('Distribution rules required');
    if(query){if(meta.version!=='4')throw new Error('Distribution projection requires rebuild');return distributionReport(report,result,meta,sites,query);}
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
