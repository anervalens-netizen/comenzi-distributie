import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,existsSync,renameSync,rmSync,chmodSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {activityVersion,activitySourceImports,bucharestToday,historyStamp,type ActivitySnapshotRow} from './partner-activity-snapshot';
import {partnerActivity} from './partner-sales-health';
import {normalizedCui,type CompanyAlias} from './partner-company-identity';
import {historyCompanyLinks,type CompanyLinks} from './partner-company-links';
import {buildDetailLinks} from './partner-detail-snapshot';
import {historyFileGeneration} from './history-source-generation';
import {derivedOutputTarget} from './derived-output-target';

type SourceRow={
  identity_id:number;
  client_code:string;
  date:string;
  site_id:string;
  document_number:string;
  value_cents:number|null;
  quantity_micros:number;
};
type Day={
  sum:number;
  known:number;
  missing:number;
  docs:Map<string,{sum:number;known:number;missing:number;positive:boolean;number:string}>;
};
type MonthRow={valueCents:number|null;missing:number;documents:number;lastBilling:string|null};

const batch=<T>(items:T[],size=400)=>Array.from({length:Math.ceil(items.length/size)},(_,i)=>items.slice(i*size,(i+1)*size));
const monthEnd=(month:string)=>{
  const [year,number]=month.split('-').map(Number);
  if(!/^\d{4}-\d{2}$/.test(month)||!year||number<1||number>12)throw new Error('Lună invalidă pentru centralizare.');
  return new Date(Date.UTC(year,number,0)).toISOString().slice(0,10);
};
const addDay=(map:Map<string,Day>,key:string,row:SourceRow)=>{
  let day=map.get(key);
  if(!day){day={sum:0,known:0,missing:0,docs:new Map()};map.set(key,day);}
  if(row.value_cents===null)day.missing++;else{day.sum+=Number(row.value_cents);day.known++;}
  const docKey=row.site_id+'\u0000'+row.document_number;
  let doc=day.docs.get(docKey);
  if(!doc){doc={sum:0,known:0,missing:0,positive:false,number:row.document_number};day.docs.set(docKey,doc);}
  if(row.value_cents===null)doc.missing++;else{doc.sum+=Number(row.value_cents);doc.known++;}
  if(row.quantity_micros>0&&row.value_cents!==null&&row.value_cents>0)doc.positive=true;
};
const finishDay=(day:Day,date:string,blankDocumentCanBill:boolean):MonthRow=>{
  let documents=0,billing=false;
  for(const doc of day.docs.values()){
    if(doc.known&&doc.sum>0&&doc.positive&&doc.missing===0){
      const numbered=Boolean(doc.number.trim());
      if(blankDocumentCanBill||numbered)billing=true;
      if(numbered)documents++;
    }
  }
  return {valueCents:day.known?day.sum:null,missing:day.missing,documents,lastBilling:billing?date:null};
};
function idLinks(s:DatabaseSync,table:string,column:string,ids:number[]){
  const result=new Map<number,string[]>();
  for(const values of batch(ids)){
    if(!values.length)continue;
    const sql=`SELECT ${column} key,identity_id FROM ${table} WHERE identity_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`;
    for(const row of s.prepare(sql).all(JSON.stringify(values))){
      const id=Number(row.identity_id),items=result.get(id)||[];
      items.push(String(row.key));result.set(id,items);
    }
  }
  return result;
}
function allocationStatus(c:DatabaseSync,reference:string,ids:number[]){
  const result=new Map<number,string>();
  for(const values of batch(ids)){
    if(!values.length)continue;
    for(const row of c.prepare("SELECT identity_id,status FROM history_allocations WHERE reference_id=? AND identity_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))").all(reference,JSON.stringify(values))){
      result.set(Number(row.identity_id),String(row.status));
    }
  }
  return result;
}
function allocationSemantics(c:DatabaseSync,reference:string){
  const result=new Map<number,string>();
  for(const row of c.prepare('SELECT identity_id,status,point_key,partner_ids_json,candidates_json,reason FROM history_allocations WHERE reference_id=? ORDER BY identity_id').all(reference)){
    const canonical=(value:unknown)=>{
      const text=typeof value==='string'?value:'[]';
      try{return JSON.stringify((JSON.parse(text) as unknown[]).map(item=>String(item)).sort());}
      catch{return text;}
    };
    result.set(Number(row.identity_id),JSON.stringify([String(row.status),String(row.point_key||''),canonical(row.partner_ids_json),canonical(row.candidates_json),String(row.reason||'')]));
  }
  return result;
}
function unresolvedIndex(index:CompanyLinks){
  return new Map(index.unresolved.map(row=>[row.identityId,JSON.stringify([row.companies,row.reason])]));
}
function compatibleReferenceChange(c:DatabaseSync,oldReference:string,newReference:string){
  const oldAlloc=allocationSemantics(c,oldReference),freshAlloc=allocationSemantics(c,newReference);
  for(const [id,value] of oldAlloc)if(freshAlloc.get(id)!==value)return null;
  const oldIndex=historyCompanyLinks(c,oldReference),freshIndex=historyCompanyLinks(c,newReference);
  const oldUnresolved=unresolvedIndex(oldIndex),freshUnresolved=unresolvedIndex(freshIndex);
  for(const id of oldAlloc.keys()){
    if((oldIndex.links[String(id)]||null)!==(freshIndex.links[String(id)]||null))return null;
    if((oldUnresolved.get(id)||null)!==(freshUnresolved.get(id)||null))return null;
  }
  return freshIndex;
}
function replaceReferenceTables(source:DatabaseSync,out:DatabaseSync,reference:string,index:CompanyLinks){
  out.exec(`DROP TABLE company_identity_links; DROP TABLE company_code_aliases; DROP TABLE company_detail_identity;
    DROP TABLE point_identity_links; DROP TABLE point_unresolved_codes; DROP TABLE point_unresolved_candidates;
    DROP TABLE company_identity; DROP TABLE company_unresolved;`);
  buildDetailLinks(source,out,reference,index);
  out.exec('CREATE TABLE company_identity(company_id TEXT PRIMARY KEY,complete INTEGER NOT NULL)');
  const identity=out.prepare('INSERT INTO company_identity VALUES(?,?)');
  for(const key of index.known)identity.run(key,Number(!index.incomplete.has(key)));
  out.exec('CREATE TABLE company_unresolved(identity_id INTEGER PRIMARY KEY,companies_json TEXT NOT NULL,reason TEXT NOT NULL)');
  const unresolved=out.prepare('INSERT INTO company_unresolved VALUES(?,?,?)');
  for(const row of index.unresolved)unresolved.run(row.identityId,JSON.stringify(row.companies),row.reason);
}
function unresolvedReasons(s:DatabaseSync,ids:number[]){
  const result=new Map<number,string>();
  for(const values of batch(ids)){
    if(!values.length)continue;
    for(const row of s.prepare("SELECT identity_id,reason FROM company_unresolved WHERE identity_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))").all(JSON.stringify(values))){
      result.set(Number(row.identity_id),String(row.reason));
    }
  }
  return result;
}
function sourceCoverage(c:DatabaseSync,start:string,end:string){
  const hasImportedAt=c.prepare('PRAGMA table_info(history_imports)').all().some(row=>row.name==='imported_at');
  return c.prepare(`SELECT b.period_start start,b.period_end declaredEnd,CASE WHEN b.row_count=0 THEN b.period_end ELSE MAX(r.date) END observedEnd,${hasImportedAt?'b.imported_at':'NULL'} importedAt FROM history_imports b LEFT JOIN history_rows r ON r.import_id=b.id WHERE b.state='active' AND b.period_start>=? AND b.period_end<=? GROUP BY b.id ORDER BY b.period_start`).all(start,end);
}
function sameImportsOutsideMonth(previous:unknown,current:ReturnType<typeof activitySourceImports>,start:string,end:string){
  if(!Array.isArray(previous))return false;
  // A source spanning multiple months is indivisible. Its replacement requires
  // a full rebuild even when its displayed coverage/totals happen to match.
  const outside=(rows:typeof current)=>rows.filter(row=>!(String(row.period_start)>=start&&String(row.period_end)<=end));
  return JSON.stringify(outside(previous))===JSON.stringify(outside(current));
}
function recomputeActivity(
  out:DatabaseSync,
  partners:Map<string,string>,
  stamp:ReturnType<typeof historyStamp>,
  today:string,
  asOf:string,
  recentStart:string,
  previousStart:string,
  master:CompanyAlias[],
){
  const unresolvedPartners=new Set<string>();
  for(const row of out.prepare('SELECT DISTINCT partner_id FROM point_unresolved_candidates').all())unresolvedPartners.add(String(row.partner_id));
  const unresolvedCodes=new Set<string>();
  for(const row of out.prepare('SELECT DISTINCT code FROM point_unresolved_codes').all())unresolvedCodes.add(String(row.code));
  // Match point completeness to full-build master aliases, including ambiguous
  // codes excluded by the separate legal-company identity index.
  const aliases=new Map<string,Set<string>>();
  for(const cui of partners.values())if(cui&&!aliases.has(cui))aliases.set(cui,new Set([cui]));
  for(const row of master){
    const key=normalizedCui(String(row.CIF||''));
    if(row.PartnerCode)aliases.get(key)?.add(normalizedCui(String(row.PartnerCode)));
  }

  out.exec('DELETE FROM activity');
  const insert=out.prepare('INSERT INTO activity VALUES(?,?)');
  let current='',days:{date:string;valueCents:number|null;missing:number;lastBilling:string|null}[]=[],count=0;
  const flush=()=>{
    if(!current||!days.length)return;
    if(!partners.has(current))return;
    const cui=partners.get(current)!;
    let missing=0,recent=0,previous=0;
    const billing:{date:string;valueCents:number}[]=[];
    const years=new Set<string>();
    for(const day of days){
      missing+=day.missing;
      if(day.date>=recentStart&&day.date<=asOf)recent+=Number(day.valueCents||0);
      if(day.date>=previousStart&&day.date<recentStart)previous+=Number(day.valueCents||0);
      if(day.lastBilling&&day.date<=asOf){billing.push({date:day.date,valueCents:1});years.add(day.date.slice(0,4));}
    }
    const codes=aliases.get(cui)||new Set<string>();
    const complete=stamp.complete&&!missing&&!unresolvedPartners.has(current)&&![...codes].some(code=>unresolvedCodes.has(code));
    const row:ActivitySnapshotRow={id:current,cui,activity:partnerActivity(billing,stamp.through,today,complete),billingYears:[...years].sort(),recentCents:recent,previousCents:previous,missingValues:missing,coverageComplete:complete};
    insert.run(current,JSON.stringify(row));count++;
  };
  for(const row of out.prepare('SELECT partner_id,date,value_cents,missing_values,last_billing FROM daily ORDER BY partner_id,date').iterate()){
    const id=String(row.partner_id);
    if(current&&id!==current){flush();days=[];}
    current=id;
    days.push({date:String(row.date),valueCents:row.value_cents===null?null:Number(row.value_cents),missing:Number(row.missing_values),lastBilling:row.last_billing===null?null:String(row.last_billing)});
  }
  flush();

  out.exec('DELETE FROM company_activity');
  const companyInsert=out.prepare('INSERT INTO company_activity VALUES(?,?)');
  const stats=new Map<string,{missing:number;recent:number;previous:number;years:Set<string>;movementYears:Set<string>;last:string;billing:{date:string;valueCents:number}[]}>();
  for(const row of out.prepare('SELECT company_id,date,value_cents,missing_values,last_billing FROM company_daily ORDER BY company_id,date').iterate()){
    const key=String(row.company_id),date=String(row.date);
    const stat=stats.get(key)||{missing:0,recent:0,previous:0,years:new Set<string>(),movementYears:new Set<string>(),last:'',billing:[]};
    stat.missing+=Number(row.missing_values);
    if(date<=asOf){stat.movementYears.add(date.slice(0,4));if(date>stat.last)stat.last=date;}
    if(date>=recentStart&&date<=asOf)stat.recent+=Number(row.value_cents||0);
    if(date>=previousStart&&date<recentStart)stat.previous+=Number(row.value_cents||0);
    if(row.last_billing&&date<=asOf){stat.billing.push({date,valueCents:1});stat.years.add(date.slice(0,4));}
    stats.set(key,stat);
  }
  for(const identity of out.prepare('SELECT company_id,complete FROM company_identity ORDER BY company_id').iterate()){
    const key=String(identity.company_id),stat=stats.get(key)||{missing:0,recent:0,previous:0,years:new Set<string>(),movementYears:new Set<string>(),last:'',billing:[]};
    const complete=stamp.complete&&!stat.missing&&Boolean(identity.complete);
    const row:ActivitySnapshotRow={id:key,cui:key,scope:'company',movementYears:[...stat.movementYears].sort(),lastMovement:stat.last,activity:partnerActivity(stat.billing,stamp.through,today,complete),billingYears:[...stat.years].sort(),recentCents:stat.recent,previousCents:stat.previous,missingValues:stat.missing,coverageComplete:complete};
    companyInsert.run(key,JSON.stringify(row));
  }
  return count;
}

/**
 * Fast path for cumulative imports that replace one month without changing the
 * immutable identity/allocation reference. The existing derived snapshot owns
 * all prior months, so only the replaced month's narrow facts are read from the
 * multi-year history. Activity payloads are then recomputed from the narrow
 * derived daily tables, not from raw history.
 *
 * Compatible reference extensions that add only new identities are handled in
 * place. Returns null when prior allocation semantics, older-month coverage or
 * the snapshot schema changed; caller must then run the full rebuild.
 */
export function refreshActivitySnapshotMonth(directory:string,month:string,today=bucharestToday(),previousSourceDigest?:string,previousLogicalDigest?:string,sourceLogicalDigest?:string,onFallback?:(reason:string)=>void){
  const fallback=(reason:string)=>{onFallback?.(reason);return null;};
  const root=resolve(directory),history=resolve(root,'client-history','client-sales-history.sqlite'),catalogPath=resolve(root,'mobiup.sqlite');
  const output=derivedOutputTarget(resolve(root,'client-history','partner-activity.sqlite'),[history,catalogPath,resolve(root,'sales.sqlite')]);
  const {target}=output;
  if(!existsSync(history)||!existsSync(target))return fallback('source_or_snapshot_missing');
  const start=month+'-01',end=monthEnd(month),sourceGeneration=historyFileGeneration(history),snapshotGeneration=historyFileGeneration(target),catalogGeneration=historyFileGeneration(catalogPath);
  if(!sourceGeneration||!snapshotGeneration||!catalogGeneration)return fallback('physical_generation_unavailable');

  const source=new DatabaseSync(history,{readOnly:true});
  const read=new DatabaseSync(target,{readOnly:true});
  let temp='',out:DatabaseSync|undefined,catalog:DatabaseSync|undefined;
  try{
    source.exec('BEGIN');read.exec('BEGIN');
    const stamp=historyStamp(source);
    if(!stamp.reference||!stamp.through)return fallback('active_history_missing');
    const required=['meta','activity','daily','company_activity','company_daily','revenue_daily','company_identity','company_unresolved','company_identity_links','company_code_aliases','company_detail_identity','point_identity_links','point_unresolved_codes','point_unresolved_candidates'];
    const available=new Set(read.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name)));
    if(required.some(table=>!available.has(table)))return fallback('snapshot_tables_missing');
    const previous=JSON.parse(String(read.prepare("SELECT value FROM meta WHERE key='snapshot'").get()?.value||'null'));
    if(!previous||previous.version!==activityVersion||!read.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='revenue_daily'").get())return fallback('snapshot_version_changed');
    // Only the importer can attest to the exact source generation it replaced.
    // Import IDs/hashes alone cannot detect older in-place numeric corrections.
    if(stamp.sourceLogicalRevision){
      if(!previous.sourceLogicalRevision)return fallback('logical_revision_baseline_missing');
      if(previous.sourceLogicalRevision!==stamp.sourceLogicalRevision){
        if(createHash('sha256').update(String(previous.sourceLogicalRevision)).digest('hex')!==previousLogicalDigest)return fallback('unattested_logical_change');
        if(createHash('sha256').update(stamp.sourceLogicalRevision).digest('hex')!==sourceLogicalDigest)return fallback('source_changed_after_import');
      }
    }else{
      if(previous.sourceLogicalRevision)return fallback('logical_revision_coverage_missing');
      if(previous.sourceGeneration!==sourceGeneration&&(!previous.sourceGeneration||createHash('sha256').update(String(previous.sourceGeneration)).digest('hex')!==previousSourceDigest))return fallback('unattested_source_change');
    }
    const sourceImports=activitySourceImports(source);
    if(!sameImportsOutsideMonth(previous.sourceImports,sourceImports,start,end))return fallback('historical_imports_changed');
    if(!Array.isArray(previous.coverage))return fallback('coverage_missing');
    const coverage=[...previous.coverage.filter((row:{start:string;declaredEnd:string})=>!(row.start>=start&&row.declaredEnd<=end)),...sourceCoverage(source,start,end)].sort((a,b)=>a.start.localeCompare(b.start));
    const changedReference=previous.reference!==stamp.reference;
    const freshIndex=changedReference?compatibleReferenceChange(source,String(previous.reference||''),stamp.reference):null;
    if(changedReference&&!freshIndex)return fallback('prior_allocation_changed');
    if(changedReference){
      // A newly allocated identity can already have historical unresolved facts.
      // Those older partitions cannot be fixed by replacing the requested month.
      const oldAlloc=allocationSemantics(source,String(previous.reference)),newAlloc=allocationSemantics(source,stamp.reference);
      const added=[...newAlloc.keys()].filter(id=>!oldAlloc.has(id));
      for(const values of batch(added))if(read.prepare('SELECT 1 FROM revenue_daily WHERE identity_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) AND (date<? OR date>?) LIMIT 1').get(JSON.stringify(values),start,end))return fallback('new_identity_has_older_facts');
    }
    if(sourceGeneration!==historyFileGeneration(history)||snapshotGeneration!==historyFileGeneration(target))return fallback('source_or_snapshot_race');
    read.close();

    temp=target+'.incremental-'+randomUUID();
    copyFileSync(target,temp);chmodSync(temp,0o600);
    out=new DatabaseSync(temp);
    catalog=new DatabaseSync(catalogPath,{readOnly:true});
    out.exec('BEGIN IMMEDIATE');catalog.exec('BEGIN');

    const currentMeta=JSON.parse(String(out.prepare("SELECT value FROM meta WHERE key='snapshot'").get()?.value||'null'));
    if(!currentMeta||currentMeta.version!==activityVersion||currentMeta.reference!==previous.reference)return fallback('snapshot_copy_changed');
    if(changedReference)replaceReferenceTables(source,out,stamp.reference,freshIndex!);

    const catalogPartners=catalog.prepare("SELECT id,json_extract(data,'$.cui') cui FROM customers").all();
    const canonical=(rows:typeof catalogPartners)=>JSON.stringify(rows.map(row=>[String(row.id),row.cui]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
    if(!Array.isArray(previous.catalogPartners)||canonical(previous.catalogPartners)!==canonical(catalogPartners))return fallback('catalog_membership_changed');
    const partners=new Map<string,string>();
    for(const row of catalogPartners)partners.set(String(row.id),normalizedCui(String(row.cui||'')));
    const master=JSON.parse(String(source.prepare('SELECT master_json FROM history_references WHERE id=?').get(stamp.reference)?.master_json||'[]'));

    const sourceRows=source.prepare(`SELECT r.identity_id,i.client_code,r.date,r.site_id,r.document_number,r.value_cents,r.quantity_micros
      FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active'
      JOIN history_identities i ON i.id=r.identity_id
      WHERE r.date>=? AND r.date<=? ORDER BY r.date,r.identity_id,r.site_id,r.document_number`).all(start,end) as SourceRow[];
    const ids=[...new Set(sourceRows.map(row=>Number(row.identity_id)))];
    const points=idLinks(out,'point_identity_links','partner_id',ids);
    const companies=idLinks(out,'company_identity_links','company_id',ids);
    const statuses=allocationStatus(source,stamp.reference,ids);
    const reasons=unresolvedReasons(out,ids);

    const pointDays=new Map<string,Day>(),companyDays=new Map<string,Day>();
    const revenue=new Map<string,{identity:number;client:string;date:string;sum:number;known:number;missing:number;rows:number}>();
    for(const row of sourceRows){
      const id=Number(row.identity_id);
      for(const partner of points.get(id)||[])addDay(pointDays,partner+'\u0001'+row.date,row);
      for(const company of companies.get(id)||[])addDay(companyDays,company+'\u0001'+row.date,row);
      const key=id+'\u0001'+row.date,item=revenue.get(key)||{identity:id,client:String(row.client_code||''),date:row.date,sum:0,known:0,missing:0,rows:0};
      item.rows++;if(row.value_cents===null)item.missing++;else{item.sum+=Number(row.value_cents);item.known++;}
      revenue.set(key,item);
    }

    out.prepare('DELETE FROM daily WHERE date>=? AND date<=?').run(start,end);
    out.prepare('DELETE FROM company_daily WHERE date>=? AND date<=?').run(start,end);
    out.prepare('DELETE FROM revenue_daily WHERE date>=? AND date<=?').run(start,end);
    const dayInsert=out.prepare('INSERT INTO daily VALUES(?,?,?,?,?,?)');
    for(const [key,day] of pointDays){
      const split=key.lastIndexOf('\u0001'),partner=key.slice(0,split),date=key.slice(split+1),value=finishDay(day,date,true);
      if(partners.has(partner))dayInsert.run(partner,date,value.valueCents,value.missing,value.documents,value.lastBilling);
    }
    const companyInsert=out.prepare('INSERT INTO company_daily VALUES(?,?,?,?,?,?)');
    for(const [key,day] of companyDays){
      const split=key.lastIndexOf('\u0001'),company=key.slice(0,split),date=key.slice(split+1),value=finishDay(day,date,false);
      companyInsert.run(company,date,value.valueCents,value.missing,value.documents,value.lastBilling);
    }
    const revenueInsert=out.prepare('INSERT INTO revenue_daily VALUES(?,?,?,?,?,?,?,?,?)');
    for(const item of revenue.values()){
      const company=(companies.get(item.identity)||[])[0]||null,status=statuses.get(item.identity),category=status==='consumer'?'consumer':company?'company':'identity';
      revenueInsert.run(item.date,item.identity,category,company,item.client,category==='identity'?reasons.get(item.identity)||'No reliable company association':'',item.known?item.sum:null,item.missing,item.rows);
    }

    const asOf=today<stamp.through?today:stamp.through;
    const recentStart=new Date(Date.parse(asOf)-29*86400000).toISOString().slice(0,10);
    const previousStart=new Date(Date.parse(asOf)-59*86400000).toISOString().slice(0,10);
    const rows=recomputeActivity(out,partners,stamp,today,asOf,recentStart,previousStart,master);

    const metadata={...stamp,sourceImports,catalogPartners,sourceGeneration,version:activityVersion,builtAt:new Date().toISOString(),asOf,recentStart,previousStart,rows,companies:Number(out.prepare('SELECT COUNT(*) n FROM company_identity').get()?.n||0),unresolvedCompanyIdentities:Number(out.prepare('SELECT COUNT(*) n FROM company_unresolved').get()?.n||0),coverage};
    out.prepare("INSERT INTO meta VALUES('snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(metadata));
    out.exec('COMMIT');
    if(out.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Snapshot integrity failed');
    catalog.exec('ROLLBACK');source.exec('ROLLBACK');
    out.close();out=undefined;catalog.close();catalog=undefined;source.close();
    if(catalogGeneration!==historyFileGeneration(catalogPath)){
      // Sessions, orders and visits share this database. Unrelated writes must
      // not turn every busy current-month import into a full history rebuild.
      // Re-pin only the catalog membership used by the full activity builder.
      const currentCatalogGeneration=historyFileGeneration(catalogPath);
      const liveCatalog=new DatabaseSync(catalogPath,{readOnly:true});
      try{
        liveCatalog.exec('BEGIN');
        const livePartners=liveCatalog.prepare("SELECT id,json_extract(data,'$.cui') cui FROM customers").all();
        if(canonical(livePartners)!==canonical(catalogPartners)||!currentCatalogGeneration||currentCatalogGeneration!==historyFileGeneration(catalogPath))return fallback('catalog_changed_during_refresh');
      }finally{liveCatalog.close();}
    }
    if(sourceGeneration!==historyFileGeneration(history)||snapshotGeneration!==historyFileGeneration(target)){rmSync(temp,{force:true});return fallback('source_or_snapshot_race');}
    output.check();
    renameSync(temp,target);temp='';
    return {...metadata,mode:'incremental' as const,month,rawRows:sourceRows.length};
  }finally{
    try{read.close();}catch{}
    try{out?.close();}catch{}
    try{catalog?.close();}catch{}
    try{source.close();}catch{}
    if(temp)rmSync(temp,{force:true});
  }
}
