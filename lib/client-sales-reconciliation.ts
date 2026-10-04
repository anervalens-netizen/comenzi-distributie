import {paginationRevision} from './pagination-revision';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {db,fail,requireManager,response,sha256} from './server';
import {clientSalesParams} from './client-sales-api';
import {clientPortfolioVersion} from './client-sales-portfolio';
import {fileGeneration,cooperativeStamp} from './history-source-stamp';
import {activityVersion,bucharestToday} from './partner-activity-snapshot';
import {normalizedCui} from './partner-company-identity';
import {coverageIntervals,monthlyWindow} from './client-sales-store';
import {salesYield} from './client-sales-cooperative';
import {createReadProjectionCache} from './read-projection-cache';
import type {SourceCoverage} from './client-sales-types';
import type {User} from './types';

export type RevenueBucket={knownCents:number;missingValues:number;sourceRows:number};
export type RevenueException={key:string;category:'absent'|'inactive'|'identity';companyId:string|null;clientCode:string;reason:string}&RevenueBucket;
type Fact={identity_id:number;category:string;company_id:string|null;client_code:string;reason:string;cents:number|null;missing:number;rows:number};
const empty=():RevenueBucket=>({knownCents:0,missingValues:0,sourceRows:0});
const cache=createReadProjectionCache(16*1024*1024,8),flights=new Map<string,Promise<Facts>>();
type Facts={window:ReturnType<typeof monthlyWindow>;source:{revision:string;reference:string;builtAt:string;coverage:SourceCoverage[]};rows:Fact[]};
async function sourceFacts(directory:string,month:string,today:string,generation:string):Promise<Facts>{
  const key=JSON.stringify([directory,month,today]);const hit=cache.get<Facts>(key,generation);if(hit)return hit;
  const flightKey=key+generation;let flight=flights.get(flightKey);
  if(!flight){
    if(flights.size>=4)fail(503,'Prea multe rapoarte în calcul. Reîncearcă.');
    flight=(async()=>{
      const stamp=await cooperativeStamp(directory,generation);if(!stamp)fail(503,'Centralizarea trebuie recalculată după import.');
      const path=resolve(directory,'client-history','partner-activity.sqlite');
      if(!existsSync(path))fail(503,'Centralizarea trebuie recalculată după import.');
      const s=new DatabaseSync(path,{readOnly:true});
      try{
        s.exec('BEGIN');
        const meta=JSON.parse(String(s.prepare("SELECT value FROM meta WHERE key='snapshot'").get()?.value||'null'));
        if(!s.prepare("SELECT name FROM sqlite_master WHERE name='revenue_daily'").get())fail(503,'Centralizarea trebuie recalculată după import.');
        if(!meta||meta.version!==activityVersion||meta.signature!==stamp.signature||meta.reference!==stamp.reference||meta.sourceGeneration!==stamp.sourceGeneration)fail(503,'Centralizarea trebuie recalculată după import.');
        const window=monthlyWindow(month,coverageIntervals(meta.coverage,today)),rows:Fact[]=[];
        if(window.to)for(const row of s.prepare('SELECT identity_id,category,company_id,client_code,reason,SUM(value_cents) cents,SUM(missing_values) missing,SUM(row_count) rows FROM revenue_daily WHERE date>=? AND date<=? GROUP BY identity_id ORDER BY identity_id').iterate(window.from,window.to)){
          rows.push(row as Fact);if(rows.length%128===0)await salesYield();
        }
        const facts={window,rows,source:{revision:sha256(JSON.stringify([stamp.signature,stamp.sourceGeneration])),reference:stamp.reference,builtAt:meta.builtAt,coverage:meta.coverage as SourceCoverage[]}};
        if(generation!==fileGeneration(directory))fail(503,'Sursa se actualizează. Reîncearcă.');
        cache.put(key,generation,facts,30000);return facts;
      }finally{s.close();}
    })().finally(()=>flights.delete(flightKey));flights.set(flightKey,flight);
  }
  return flight;
}
/** National reconciliation is manager-only. It is never inferred from selected agents,
 * nor joined to sellers. Current CRM membership is rechecked after every cached read. */
export async function clientSalesReconciliation(user:User,params:URLSearchParams,now=new Date()){
  requireManager(user);
  for(const key of params.keys())if(!['month','page','format','revision'].includes(key)||params.getAll(key).length!==1)fail(400,'Parametru invalid pentru reconcilierea națională.');
  const input=clientSalesParams(new URLSearchParams([...params].filter(([k])=>k!=='format')),now);
  if(params.has('format')&&params.get('format')!=='csv')fail(400,'Format invalid.');
  const directory=resolve(process.env.MOBIUP_DATA_DIR||'./work/server-data'),generation=fileGeneration(directory),version=await clientPortfolioVersion();
  const facts=await sourceFacts(directory,input.month,bucharestToday(now),generation).catch(error=>{
    if(params.has('revision')&&error?.status===503)fail(409,'Sursa paginării nu mai este disponibilă. Reîncepe de la prima pagină.');
    throw error;
  });
  // Project only the identity JSON value. Preserve its original JS coercion,
  // including legacy numeric/boolean values, without decoding unrelated CRM data.
  const current=new Map<string,boolean>();let cursor='';
  for(;;){
    const rows=(await db().prepare("SELECT id,active,data->'$.cui' cui FROM customers WHERE id>? ORDER BY id LIMIT 512").bind(cursor).all<{id:string;active:number;cui:string|null}>()).results;
    for(const r of rows){const cui=normalizedCui(String(JSON.parse(r.cui??'null')||''));if(cui&&cui!=='CLIENTGEN')current.set(cui,!!r.active||current.get(cui)===true);}
    if(rows.length<512)break;cursor=rows.at(-1)!.id;await salesYield();
  }
  const buckets={raw:empty(),consumer:empty(),linkedCompany:empty(),currentPortfolio:empty(),absent:empty(),inactive:empty(),identity:empty()},exceptions=new Map<string,RevenueException>();
  const add=(bucket:RevenueBucket,r:Fact)=>{bucket.knownCents+=r.cents??0;bucket.missingValues+=r.missing;bucket.sourceRows+=r.rows;if(!Number.isSafeInteger(bucket.knownCents))fail(503,'Totalul depășește precizia permisă.');};
  for(let i=0;i<facts.rows.length;i++){
    const r=facts.rows[i];add(buckets.raw,r);
    const category=r.category==='consumer'?'consumer':r.category==='identity'?'identity':current.get(r.company_id!)===true?'currentPortfolio':current.has(r.company_id!)?'inactive':'absent';
    add(buckets[category],r);if(r.category==='company')add(buckets.linkedCompany,r);
    if(category==='absent'||category==='inactive'||category==='identity'){
      const key=category==='identity'?'identity:'+r.identity_id:'company:'+r.company_id;
      const item=exceptions.get(key)||{key,category,companyId:category==='identity'?null:r.company_id,clientCode:category==='identity'?r.client_code:'',reason:category==='identity'?r.reason:category==='inactive'?'Only inactive current CRM points':'No current CRM point',...empty()};
      add(item,r);exceptions.set(key,item);
    }
    if(i%128===0)await salesYield();
  }
  if(version!==await clientPortfolioVersion()||generation!==fileGeneration(directory))fail(params.has('revision')?409:503,'Portofoliul sau sursa s-au actualizat. Reîncearcă.');
  const explanation='Reconciliere națională, în bani întregi. Sursă = consumatori + firme asociate + identități neasociate; firme asociate = portofoliu activ actual + firme inactive + firme absente. Istoricul tuturor vânzătorilor, nu vânzări personale ale responsabilului actual. PL ambiguu nu este alocat forțat. Sumele cunoscute exclud valorile lipsă, raportate separat. Absența unei luni importate nu înseamnă zero vânzări.';
  const portfolioRevision=version===null?null:sha256(version);
  const revision=paginationRevision(params,[generation,version,user.id,user.role,user.managerScope,input.month,bucharestToday(now),facts.source,[...current]]);
  const rows=[...exceptions.values()],result={revision,state:'ready' as const,scope:'national' as const,month:input.month,window:facts.window,source:facts.source,portfolioRevision,explanation,buckets,total:rows.length,page:input.page,hasMore:(input.page+1)*100<rows.length,exceptions:rows.slice(input.page*100,(input.page+1)*100)};
  if(params.get('format')==='csv'){
    const cell=(s:string|number|null|undefined)=>'"'+(typeof s==='number'?String(s):String(s??'').replace(/^[=+@-]/,"'$&")).replaceAll('"','""')+'"';
    const lines:(string|number|null|undefined)[][]=[['Definition',explanation],['Period',facts.window.from,facts.window.to,facts.window.imported?'imported':'not imported'],['Source revision',facts.source.revision],['Reference',facts.source.reference],['Portfolio revision',portfolioRevision],['Source coverage',JSON.stringify(facts.source.coverage)],['Bucket','Known cents','Missing values','Source rows'],...Object.entries(buckets).map(([k,v])=>[k,v.knownCents,v.missingValues,v.sourceRows]),[],['Exception key','Category','Company','Raw client code','Reason','Known cents','Missing values','Source rows'],...rows.map(r=>[r.key,r.category,r.companyId,r.clientCode,r.reason,r.knownCents,r.missingValues,r.sourceRows])];
    return new Response('\ufeff'+lines.map(row=>row.map(cell).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="reconciliation-${input.month}.csv"`,'Cache-Control':'no-store'}});
  }
  return response(result);
}
