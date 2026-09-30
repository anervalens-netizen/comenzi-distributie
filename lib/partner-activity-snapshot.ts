import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,renameSync,rmSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
import {partnerActivity,type PartnerActivity} from './partner-sales-health';
export const activityVersion='2';
export const normalizedCui=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^RO/,'');
export const bucharestToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function historyStamp(c:DatabaseSync) {
  const reference=String(c.prepare("SELECT value FROM history_meta WHERE key='current_reference'").get()?.value||'');
  const imports=c.prepare("SELECT id,sha256,period_start,period_end,row_count FROM history_imports WHERE state='active' ORDER BY period_start,id").all() as {id:number;sha256:string;period_start:string;period_end:string;row_count:number}[];
  let through='',complete=true;
  for(const row of imports){if(through&&Date.parse(row.period_start)-Date.parse(through)>86400000)complete=false;if(row.period_end>through)through=row.period_end;}
  return {reference,through,complete,signature:createHash('sha256').update(JSON.stringify([activityVersion,reference,imports])).digest('hex')};
}
export type ActivitySnapshotRow={id:string;cui:string;activity:PartnerActivity;billingYears:string[];recentCents:number;previousCents:number;missingValues:number;coverageComplete:boolean};
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
    const master=JSON.parse(String(c.prepare('SELECT master_json FROM history_references WHERE id=?').get(stamp.reference)?.master_json||'[]')) as {CIF?:string;PartnerCode?:string}[];
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
    const billing=new Map<string,{date:string;valueCents:number}[]>();
    for(const row of c.prepare(prefix+"SELECT partner_id,date,SUM(valueCents) valueCents FROM (SELECT partner_id,date,site_id,document_number,SUM(value_cents) valueCents FROM facts GROUP BY partner_id,date,site_id,document_number HAVING SUM(value_cents)>0 AND SUM(CASE WHEN quantity_micros>0 AND value_cents>0 THEN 1 ELSE 0 END)>0 AND SUM(value_cents IS NULL)=0) GROUP BY partner_id,date ORDER BY partner_id,date").iterate(stamp.reference)){
      const id=String(row.partner_id),days=billing.get(id)||[];
      days.push({date:String(row.date),valueCents:Number(row.valueCents)});billing.set(id,days);
    }
    const catalogById=new Map(partners.map(p=>[p.id,normalizedCui(p.cui||'')]));
    out=new DatabaseSync(temp);chmodSync(temp,0o600);
    out.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE activity(partner_id TEXT PRIMARY KEY,payload TEXT NOT NULL); BEGIN');
    const insert=out.prepare('INSERT INTO activity VALUES(?,?)');
    let count=0;
    for(const s of stats){
      if(!catalogById.has(s.partner_id))continue;
      const cui=catalogById.get(s.partner_id)!;
      const complete=stamp.complete&&!s.missing&&!unresolvedPartners.has(s.partner_id)&&![...(companyCodes.get(cui)||[])].some(code=>unresolvedCodes.has(code));
      const row:ActivitySnapshotRow={id:s.partner_id,cui,activity:partnerActivity(billing.get(s.partner_id)||[],stamp.through,today,complete),billingYears:[...new Set((billing.get(s.partner_id)||[]).filter(d=>d.date<=asOf).map(d=>d.date.slice(0,4)))].sort(),recentCents:s.recent,previousCents:s.previous,missingValues:s.missing,coverageComplete:complete};
      insert.run(row.id,JSON.stringify(row));count++;
    }
    const metadata={...stamp,version:activityVersion,builtAt:new Date().toISOString(),asOf,recentStart,previousStart,rows:count};
    out.prepare("INSERT INTO meta VALUES('snapshot',?)").run(JSON.stringify(metadata));out.exec('COMMIT');
    if(out.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Snapshot integrity failed');
    out.close();out=undefined;renameSync(temp,target);
    return metadata;
  } finally {out?.close();c.close();catalog.close();rmSync(temp,{force:true});}
}
/** Call only with current authorized partner IDs. Never cache access membership. */
export function readActivitySnapshot(partners:{id:string;cui:string}[],directory=process.env.MOBIUP_DATA_DIR||'./work/server-data',today=bucharestToday()) {
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
    return {state:'ready' as const,through:stamp.through,builtAt:meta.builtAt,asOf:meta.asOf,recentStart:meta.recentStart,previousStart:meta.previousStart,stale:lag>3,rows};
  }finally{c.close();snapshot.close();}
}
