import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,renameSync,rmSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
import {partnerActivity,type PartnerActivity} from './partner-sales-health';
import {normalizedCui,companyIdentityIndex,type CompanyAlias} from './partner-company-identity';
export {normalizedCui} from './partner-company-identity';
export const activityVersion='4';
export const bucharestToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function historyStamp(c:DatabaseSync) {
  const reference=String(c.prepare("SELECT value FROM history_meta WHERE key='current_reference'").get()?.value||'');
  const imports=c.prepare("SELECT id,sha256,period_start,period_end,row_count FROM history_imports WHERE state='active' ORDER BY period_start,id").all() as {id:number;sha256:string;period_start:string;period_end:string;row_count:number}[];
  let through='',complete=true;
  for(const row of imports){if(through&&Date.parse(row.period_start)-Date.parse(through)>86400000)complete=false;if(row.period_end>through)through=row.period_end;}
  return {reference,through,start:imports[0]?.period_start||'',complete,signature:createHash('sha256').update(JSON.stringify([activityVersion,reference,imports])).digest('hex')};
}
export type ActivitySnapshotRow={id:string;cui:string;activity:PartnerActivity;billingYears:string[];recentCents:number;previousCents:number;missingValues:number;coverageComplete:boolean;scope?:'point'|'company';movementYears?:string[];lastMovement?:string};
export type PartnerPeriodMetrics={valueCents:number|null;documents:number;lastBilling:string|null;missingValues:number};
export function activityRange(period:string,start:string,asOf:string){
 if(period.startsWith('year:'))return {from:period.slice(5)+'-01-01',to:[period.slice(5)+'-12-31',asOf].sort()[0]};
 const days=period==='recent90'?90:period==='recent365'?365:0;
 return {from:days?new Date(Date.parse(asOf)-(days-1)*86400000).toISOString().slice(0,10):start,to:asOf};
}
export type ActivitySnapshot=ReturnType<typeof readActivitySnapshot>;
/** Batch rebuild outside the HTTP process. Source history and application DBs are read-only. */
export function buildActivitySnapshot(directory:string,today=bucharestToday()) {
  const history=resolve(directory,'client-history','client-sales-history.sqlite'),target=resolve(directory,'client-history','partner-activity.sqlite');
  const temp=target+'.tmp-'+randomUUID(),c=new DatabaseSync(history,{readOnly:true}),catalog=new DatabaseSync(resolve(directory,'mobiup.sqlite'),{readOnly:true});
  let out:DatabaseSync|undefined;
  try {
    c.exec('BEGIN');catalog.exec('BEGIN');
    const stamp=historyStamp(c);
    if(!stamp.reference||!stamp.through)throw new Error('No active history');
    const partners=catalog.prepare("SELECT id,json_extract(data,'$.cui') cui FROM customers").all() as {id:string;cui:string|null}[];
    const companyCodes=new Map<string,Set<string>>();
    for(const p of partners){const key=normalizedCui(p.cui||'');if(key&&!companyCodes.has(key))companyCodes.set(key,new Set([key]));}
    const master=JSON.parse(String(c.prepare('SELECT master_json FROM history_references WHERE id=?').get(stamp.reference)?.master_json||'[]')) as CompanyAlias[];
    for(const row of master){const key=normalizedCui(String(row.CIF||''));if(row.PartnerCode)companyCodes.get(key)?.add(normalizedCui(String(row.PartnerCode)));}
    const unresolvedCodes=new Set<string>(),unresolvedPartners=new Set<string>();
    for(const row of c.prepare("SELECT i.client_code,a.candidates_json FROM history_allocations a JOIN history_identities i ON i.id=a.identity_id WHERE a.reference_id=? AND (a.status='reconcile' OR (a.status IN ('direct_code','single_partner') AND json_array_length(a.partner_ids_json)=0))").all(stamp.reference)){
      unresolvedCodes.add(normalizedCui(String(row.client_code)));
      for(const id of JSON.parse(String(row.candidates_json)))if(typeof id==='string')unresolvedPartners.add(id);
    }
    // DISTINCT prevents duplicate membership entries from multiplying source facts.
    const prefix="WITH links AS (SELECT DISTINCT a.identity_id,p.value partner_id FROM history_allocations a,json_each(a.partner_ids_json) p WHERE a.reference_id=? AND a.status IN ('direct_code','single_partner')), facts AS (SELECT l.partner_id,r.* FROM links l JOIN history_rows r ON r.identity_id=l.identity_id JOIN history_imports b ON b.id=r.import_id AND b.state='active') ";
    const asOf=today<stamp.through?today:stamp.through;
    const recentStart=new Date(Date.parse(asOf)-29*86400000).toISOString().slice(0,10),previousStart=new Date(Date.parse(asOf)-59*86400000).toISOString().slice(0,10);
    const stats=c.prepare(prefix+"SELECT partner_id,SUM(value_cents IS NULL) missing,SUM(CASE WHEN date>=? AND date<=? THEN COALESCE(value_cents,0) ELSE 0 END) recent,SUM(CASE WHEN date>=? AND date<? THEN COALESCE(value_cents,0) ELSE 0 END) previous FROM facts GROUP BY partner_id").all(stamp.reference,recentStart,asOf,previousStart,recentStart) as {partner_id:string;missing:number;recent:number;previous:number}[];
    const billing=new Map<string,{date:string;valueCents:number;documents:number}[]>();
    for(const row of c.prepare(prefix+"SELECT partner_id,date,SUM(valueCents) valueCents,SUM(CASE WHEN TRIM(document_number)<>'' THEN 1 ELSE 0 END) documents FROM (SELECT partner_id,date,site_id,document_number,SUM(value_cents) valueCents FROM facts GROUP BY partner_id,date,site_id,document_number HAVING SUM(value_cents)>0 AND SUM(CASE WHEN quantity_micros>0 AND value_cents>0 THEN 1 ELSE 0 END)>0 AND SUM(value_cents IS NULL)=0) GROUP BY partner_id,date ORDER BY partner_id,date").iterate(stamp.reference)){
      const id=String(row.partner_id),days=billing.get(id)||[];
      days.push({date:String(row.date),valueCents:Number(row.valueCents),documents:Number(row.documents)});billing.set(id,days);
    }
    const catalogById=new Map(partners.map(p=>[p.id,normalizedCui(p.cui||'')]));
    out=new DatabaseSync(temp);chmodSync(temp,0o600);
    out.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE activity(partner_id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE daily(partner_id TEXT NOT NULL,date TEXT NOT NULL,value_cents INTEGER,missing_values INTEGER NOT NULL,documents INTEGER NOT NULL,last_billing TEXT,PRIMARY KEY(partner_id,date)); BEGIN');
    const dailyInsert=out.prepare('INSERT INTO daily VALUES(?,?,?,?,?,?)');
    const billingByDate=new Map([...billing].map(([id,days])=>[id,new Map(days.map(day=>[day.date,day]))]));
    for(const row of c.prepare(prefix+"SELECT partner_id,date,SUM(value_cents) value_cents,SUM(value_cents IS NULL) missing_values FROM facts GROUP BY partner_id,date").iterate(stamp.reference)){
      const id=String(row.partner_id),date=String(row.date),day=billingByDate.get(id)?.get(date);
      if(catalogById.has(id))dailyInsert.run(id,date,row.value_cents,row.missing_values,day?.documents||0,day?date:null);
    }
    const insert=out.prepare('INSERT INTO activity VALUES(?,?)');
    let count=0;
    for(const s of stats){
      if(!catalogById.has(s.partner_id))continue;
      const cui=catalogById.get(s.partner_id)!;
      const complete=stamp.complete&&!s.missing&&!unresolvedPartners.has(s.partner_id)&&![...(companyCodes.get(cui)||[])].some(code=>unresolvedCodes.has(code));
      const row:ActivitySnapshotRow={id:s.partner_id,cui,activity:partnerActivity(billing.get(s.partner_id)||[],stamp.through,today,complete),billingYears:[...new Set((billing.get(s.partner_id)||[]).filter(d=>d.date<=asOf).map(d=>d.date.slice(0,4)))].sort(),recentCents:s.recent,previousCents:s.previous,missingValues:s.missing,coverageComplete:complete};
      insert.run(row.id,JSON.stringify(row));count++;
    }
    // Company totals are stored once per legal entity, separate from point facts.
    // The table groups authorized cards before displaying these totals.
    const companyIndex=companyIdentityIndex(master,new Set(partners.map(p=>normalizedCui(p.cui||''))));
    const companyByCode=new Map<string,string>();
    for(const [key,codes] of companyIndex.codesByCompany)for(const code of codes)companyByCode.set(code,key);
    const companyLinks:Record<string,string>={};
    for(const row of c.prepare("SELECT i.id,i.client_code FROM history_identities i JOIN history_allocations a ON a.identity_id=i.id WHERE a.reference_id=? AND a.status<>'consumer'").iterate(stamp.reference)){
      const company=companyByCode.get(normalizedCui(String(row.client_code)));
      if(company)companyLinks[String(row.id)]=company;
    }
    const companyPrefix="WITH links AS (SELECT CAST(key AS INTEGER) identity_id,value company_id FROM json_each(?)), facts AS (SELECT l.company_id,r.* FROM links l JOIN history_rows r ON r.identity_id=l.identity_id JOIN history_imports b ON b.id=r.import_id AND b.state='active') ";
    const linkJson=JSON.stringify(companyLinks);
    out.exec('CREATE TABLE company_activity(company_id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE company_daily(company_id TEXT NOT NULL,date TEXT NOT NULL,value_cents INTEGER,missing_values INTEGER NOT NULL,documents INTEGER NOT NULL,last_billing TEXT,PRIMARY KEY(company_id,date));');
    const companyBilling=new Map<string,{date:string;valueCents:number;documents:number}[]>();
    for(const row of c.prepare(companyPrefix+"SELECT company_id,date,SUM(valueCents) valueCents,COUNT(*) documents FROM (SELECT company_id,date,site_id,document_number,SUM(value_cents) valueCents FROM facts WHERE TRIM(document_number)<>'' GROUP BY company_id,date,site_id,document_number HAVING SUM(value_cents)>0 AND SUM(CASE WHEN quantity_micros>0 AND value_cents>0 THEN 1 ELSE 0 END)>0 AND SUM(value_cents IS NULL)=0) GROUP BY company_id,date ORDER BY company_id,date").iterate(linkJson)){
      const key=String(row.company_id),days=companyBilling.get(key)||[];
      days.push({date:String(row.date),valueCents:Number(row.valueCents),documents:Number(row.documents)});companyBilling.set(key,days);
    }
    const companyByDate=new Map([...companyBilling].map(([key,days])=>[key,new Map(days.map(day=>[day.date,day]))]));
    const companyStats=new Map<string,{missing:number;recent:number;previous:number;years:Set<string>;last:string}>();
    const companyDailyInsert=out.prepare('INSERT INTO company_daily VALUES(?,?,?,?,?,?)');
    for(const row of c.prepare(companyPrefix+"SELECT company_id,date,SUM(value_cents) cents,SUM(value_cents IS NULL) missing FROM facts GROUP BY company_id,date").iterate(linkJson)){
      const key=String(row.company_id),date=String(row.date),bill=companyByDate.get(key)?.get(date);
      companyDailyInsert.run(key,date,row.cents,row.missing,bill?.documents||0,bill?date:null);
      const stat=companyStats.get(key)||{missing:0,recent:0,previous:0,years:new Set<string>(),last:''};
      stat.missing+=Number(row.missing);
      if(date<=asOf){stat.years.add(date.slice(0,4));if(date>stat.last)stat.last=date;}
      if(date>=recentStart&&date<=asOf)stat.recent+=Number(row.cents||0);
      if(date>=previousStart&&date<recentStart)stat.previous+=Number(row.cents||0);
      companyStats.set(key,stat);
    }
    const companyInsert=out.prepare('INSERT INTO company_activity VALUES(?,?)');
    for(const [key,stat] of companyStats){
      const days=companyBilling.get(key)||[],complete=stamp.complete&&!stat.missing&&!companyIndex.ambiguousCompanies.has(key);
      const row:ActivitySnapshotRow={id:key,cui:key,scope:'company',movementYears:[...stat.years].sort(),lastMovement:stat.last,activity:partnerActivity(days,stamp.through,today,complete),billingYears:[...new Set(days.filter(d=>d.date<=asOf).map(d=>d.date.slice(0,4)))].sort(),recentCents:stat.recent,previousCents:stat.previous,missingValues:stat.missing,coverageComplete:complete};
      companyInsert.run(key,JSON.stringify(row));
    }
    const metadata={...stamp,version:activityVersion,builtAt:new Date().toISOString(),asOf,recentStart,previousStart,rows:count,companies:companyStats.size};
    out.prepare("INSERT INTO meta VALUES('snapshot',?)").run(JSON.stringify(metadata));out.exec('COMMIT');
    if(out.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Snapshot integrity failed');
    out.close();out=undefined;renameSync(temp,target);
    return metadata;
  } finally {out?.close();c.close();catalog.close();rmSync(temp,{force:true});}
}
/** Call only with current authorized partner IDs. Never cache access membership. */
export function readActivitySnapshot(partners:{id:string;cui:string}[],directory=process.env.MOBIUP_DATA_DIR||'./work/server-data',today=bucharestToday(),options?:{period:string;scope?:'company'|'point'}) {
  const base=resolve(directory,'client-history'),history=resolve(base,'client-sales-history.sqlite'),path=resolve(base,'partner-activity.sqlite');
  if(!existsSync(history)||!existsSync(path))return {state:'unavailable' as const,message:'Centralizarea activității nu este încă pregătită.'};
  const c=new DatabaseSync(history,{readOnly:true}),snapshot=new DatabaseSync(path,{readOnly:true});
  try{
    c.exec('BEGIN');snapshot.exec('BEGIN');
    const stamp=historyStamp(c),meta=JSON.parse(String(snapshot.prepare("SELECT value FROM meta WHERE key='snapshot'").get()?.value||'null')) as {signature:string;version:string;builtAt:string;asOf:string;recentStart:string;previousStart:string}|null;
    if(!meta||meta.version!==activityVersion||meta.signature!==stamp.signature||meta.asOf!==(today<stamp.through?today:stamp.through))return {state:'unavailable' as const,message:'Istoricul a fost actualizat; centralizarea activității trebuie recalculată.'};
    const allowed=new Map(partners.map(p=>[p.id,normalizedCui(p.cui)]));
    const rows=new Map<string,ActivitySnapshotRow>();
    const lag=Math.max(0,Math.floor((Date.parse(today)-Date.parse(stamp.through))/86400000));
    for(const record of snapshot.prepare("SELECT payload FROM activity WHERE partner_id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...allowed.keys()]))){
      const row=JSON.parse(String(record.payload)) as ActivitySnapshotRow;
      if(row.cui!==allowed.get(row.id))continue;
      if(lag>3&&!row.activity.stale)row.activity.reason+=' Datele sunt întârziate; alerta curentă este suspendată.';
      row.activity.stale=lag>3;row.activity.sourceLagDays=lag;row.activity.alertEligible=row.activity.alertEligible&&lag<=3;
      rows.set(row.id,row);
    }
    const metrics=new Map<string,PartnerPeriodMetrics>(),range=activityRange(options?.period||'',stamp.start,meta.asOf);
    if(options){
      for(const row of snapshot.prepare('SELECT partner_id,SUM(value_cents) valueCents,SUM(documents) documents,MAX(last_billing) lastBilling,SUM(missing_values) missingValues FROM daily WHERE partner_id IN (SELECT value FROM json_each(?)) AND date>=? AND date<=? GROUP BY partner_id').all(JSON.stringify([...rows.keys()]),range.from,range.to)){
        metrics.set(String(row.partner_id),{valueCents:row.valueCents===null?null:Number(row.valueCents),documents:Number(row.documents),lastBilling:row.lastBilling===null?null:String(row.lastBilling),missingValues:Number(row.missingValues)});
      }
      for(const id of rows.keys())if(!metrics.has(id))metrics.set(id,{valueCents:0,documents:0,lastBilling:null,missingValues:0});
    }
    if(options?.scope==='company'){
      const keys=[...new Set(allowed.values())];
      const companyRows=new Map<string,ActivitySnapshotRow>();
      for(const record of snapshot.prepare('SELECT company_id,payload FROM company_activity WHERE company_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(keys))){
        const row=JSON.parse(String(record.payload)) as ActivitySnapshotRow;
        if(lag>3&&!row.activity.stale)row.activity.reason+=' Datele sunt întârziate; alerta curentă este suspendată.';
        row.activity.stale=lag>3;row.activity.sourceLagDays=lag;row.activity.alertEligible=row.activity.alertEligible&&lag<=3;
        companyRows.set(String(record.company_id),row);
      }
      const companyMetrics=new Map<string,PartnerPeriodMetrics>();
      for(const row of snapshot.prepare('SELECT company_id,SUM(value_cents) valueCents,SUM(documents) documents,MAX(last_billing) lastBilling,SUM(missing_values) missingValues FROM company_daily WHERE company_id IN (SELECT value FROM json_each(?)) AND date>=? AND date<=? GROUP BY company_id').all(JSON.stringify(keys),range.from,range.to)){
        companyMetrics.set(String(row.company_id),{valueCents:row.valueCents===null?null:Number(row.valueCents),documents:Number(row.documents),lastBilling:row.lastBilling===null?null:String(row.lastBilling),missingValues:Number(row.missingValues)});
      }
      for(const [id,key] of allowed){
        const company=companyRows.get(key);
        if(company){rows.set(id,{...company,id});metrics.set(id,companyMetrics.get(key)||{valueCents:0,documents:0,lastBilling:null,missingValues:0});}
      }
    }
    return {state:'ready' as const,range,metrics,through:stamp.through,builtAt:meta.builtAt,asOf:meta.asOf,recentStart:meta.recentStart,previousStart:meta.previousStart,stale:lag>3,rows};
  }finally{c.close();snapshot.close();}
}
