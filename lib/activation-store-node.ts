import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {emptyActivationCounts,type ActivationCounts,type ActivationReport} from './activation-types';

type Row={month:string;item_type:string;site:string;count:number;last_date:string|null};
function add(totals:ActivationCounts,row:Row){
  totals.total+=row.count;
  if(row.item_type==='SIM')totals.sim+=row.count;
  else if(row.item_type==='TELSIM')totals.telsim+=row.count;
  else totals.other+=row.count;
  if(!row.site)totals.unassigned+=row.count;
}
export function readActivations(month:string,sites:string[]|null):ActivationReport{
  const result:ActivationReport={month,available:false,scoped:sites!==null,importedAt:'',latestDate:null,months:[],totals:emptyActivationCounts(),sites:[],history:[]};
  const directory=resolve(process.env.MOBIUP_ACTIVATIONS_DIR||process.env.MOBIUP_DATA_DIR||'./work/server-data');
  const path=resolve(directory,'activation-report.sqlite');
  if(!existsSync(path))return result;
  const report=new DatabaseSync(path,{readOnly:true});
  let source:DatabaseSync|undefined;
  try{
    const meta=Object.fromEntries(report.prepare('SELECT key,value FROM report_meta').all().map(r=>[String(r.key),String(r.value)]));
    if(meta.version!=='1')throw new Error('Unsupported activation report');
    source=new DatabaseSync(resolve(directory,'activations.sqlite'),{readOnly:true});
    if(source.prepare("SELECT value FROM activation_meta WHERE key='schema_version'").get()?.value!=='2')throw new Error('Unsupported activation ledger');
    const imports=source.prepare("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").all().map(r=>[r.sha256,r.operator,r.row_count,r.parser_version]);
    if(JSON.stringify(imports)!==meta.sourceImports)throw new Error('Stale activation report');
    const allowed=sites===null?null:new Set(sites);
    const rows=(report.prepare("SELECT month,item_type,site,count,last_date FROM monthly WHERE month<>'' ORDER BY month DESC,site").all() as Row[]).filter(r=>allowed===null||allowed.has(r.site));
    const labels=new Map(report.prepare('SELECT site,label FROM sites').all().map(r=>[String(r.site),String(r.label)]));
    const history=new Map<string,ActivationCounts>(),agents=new Map<string,ActivationCounts>();
    for(const row of rows){
      const monthly=history.get(row.month)||emptyActivationCounts();add(monthly,row);history.set(row.month,monthly);
      if(row.month!==month)continue;
      add(result.totals,row);
      const agent=agents.get(row.site)||emptyActivationCounts();add(agent,row);agents.set(row.site,agent);
      if(row.last_date&&(!result.latestDate||row.last_date>result.latestDate))result.latestDate=row.last_date;
    }
    result.available=imports.length>0;result.importedAt=meta.importedAt;
    result.history=[...history].map(([month,counts])=>({month,...counts}));
    result.months=result.history.map(({month,total})=>({month,total}));
    result.sites=[...agents].map(([site,counts])=>({site,label:site?(labels.get(site)||site):'De repartizat',...counts})).sort((a,b)=>b.total-a.total||a.site.localeCompare(b.site));
    return result;
  }finally{source?.close();report.close();}
}
