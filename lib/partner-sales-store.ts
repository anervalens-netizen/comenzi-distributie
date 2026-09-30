import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { partnerActivity } from './partner-sales-health';
export class PartnerSalesInputError extends Error {}
export type PartnerSalesResult = ReturnType<typeof readPartnerSales>;
function isoDate(value: string) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new PartnerSalesInputError('Perioada este invalidă.');
  const time=Date.parse(value+'T00:00:00Z');
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)throw new PartnerSalesInputError('Perioada este invalidă.');
  return value;
}
const cuiKey=(value: string)=>value.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^RO/,'');
export function readPartnerSales(partnerId: string, cui: string, params: URLSearchParams, directory=process.env.MOBIUP_DATA_DIR||'./work/server-data') {
  const path=resolve(directory,'client-history','client-sales-history.sqlite');
  if(!existsSync(path))return {state:'unavailable' as const,message:'Istoricul pe parteneri nu este încă disponibil.'};
  const c=new DatabaseSync(path,{readOnly:true});
  c.function('history_cui_key',{deterministic:true},value=>cuiKey(String(value||'')));
  try {
    c.exec('BEGIN');
    const reference=c.prepare("SELECT value FROM history_meta WHERE key='current_reference'").get()?.value;
    const periods=c.prepare("SELECT period_start,period_end FROM history_imports WHERE state='active' ORDER BY period_start").all() as {period_start:string;period_end:string}[];
    if(!reference||!periods.length)return {state:'unavailable' as const,message:'Istoricul nu are încă un import activ.'};
    const through=periods.reduce((end,p)=>p.period_end>end?p.period_end:end,'');
    let coverageComplete=true,covered=periods[0].period_end;
    for(const p of periods.slice(1)){
      if(Date.parse(p.period_start)-Date.parse(covered)>86_400_000)coverageComplete=false;
      if(p.period_end>covered)covered=p.period_end;
    }
    const identityRows=c.prepare("SELECT a.identity_id FROM history_allocations a WHERE reference_id=? AND status IN ('direct_code','single_partner') AND EXISTS(SELECT 1 FROM json_each(a.partner_ids_json) p WHERE p.value=?)").all(String(reference),partnerId);
    const companyKey=cuiKey(cui);
    const companyCodes=new Set<string>();
    const referenceRow=c.prepare('SELECT master_json FROM history_references WHERE id=?').get(String(reference));
    const master=JSON.parse(String(referenceRow?.master_json||'[]')) as {CIF?:string;PartnerCode?:string}[];
    // A company alias must identify exactly one legal entity. Never join by name,
    // old seller, county, or an ambiguous CRM code.
    const owners=new Map<string,Set<string>>();
    for(const row of master){
      const code=cuiKey(String(row.PartnerCode||'')),owner=cuiKey(String(row.CIF||''));
      if(!code||!owner)continue;
      const values=owners.get(code)||new Set<string>();values.add(owner);owners.set(code,values);
    }
    if(companyKey&&companyKey!=='CLIENTGEN'&&(!owners.has(companyKey)||(owners.get(companyKey)!.size===1&&owners.get(companyKey)!.has(companyKey))))companyCodes.add(companyKey);
    for(const [code,values] of owners)if(values.size===1&&values.has(companyKey))companyCodes.add(code);
    companyCodes.delete('CLIENTGEN');
    const companyIdentityComplete=![...owners.values()].some(values=>values.size>1&&values.has(companyKey));
    const companyRows=c.prepare("SELECT DISTINCT i.id identity_id FROM history_identities i JOIN history_allocations a ON a.identity_id=i.id WHERE a.reference_id=? AND a.status<>'consumer' AND history_cui_key(i.client_code) IN (SELECT value FROM json_each(?))").all(String(reference),JSON.stringify([...companyCodes]));
    const requestedScope=params.get('scope')||'auto';
    if(!['auto','point','company'].includes(requestedScope))throw new PartnerSalesInputError('Nivelul istoricului este invalid.');
    const scope=requestedScope==='company'||(requestedScope==='auto'&&!identityRows.length&&companyRows.length)?'company' as const:'point' as const;
    const selectedIdentities=scope==='company'?companyRows:identityRows;
    const identities=JSON.stringify(selectedIdentities.map(r=>r.identity_id));
    const unresolved=c.prepare("SELECT COUNT(*) n FROM history_allocations a JOIN history_identities i ON i.id=a.identity_id WHERE a.reference_id=? AND (a.status='reconcile' OR (a.status IN ('direct_code','single_partner') AND json_array_length(a.partner_ids_json)=0)) AND (history_cui_key(i.client_code) IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_each(a.candidates_json) p WHERE p.value=?))").get(String(reference),JSON.stringify([...companyCodes]),partnerId) as {n:number};
    if(!selectedIdentities.length)return {state:'unlinked' as const,through,message:'Istoricul nu este încă asociat sigur acestei fișe. Aceasta nu înseamnă că partenerul nu a cumpărat.'};
    const from=isoDate(params.get('from')||periods[0].period_start);
    const to=isoDate(params.get('to')||through);
    if(from>to)throw new PartnerSalesInputError('Începutul perioadei trebuie să fie înaintea sfârșitului.');
    const rawPage=params.get('page')||'0';
    if(!/^\d{1,5}$/.test(rawPage))throw new PartnerSalesInputError('Pagina este invalidă.');
    const page=Number(rawPage);
    const base=" FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active' WHERE r.identity_id IN (SELECT value FROM json_each(?))";
    const range=base+' AND r.date>=? AND r.date<=?';
    const args=[identities,from,to];
    const totals=c.prepare("SELECT COUNT(*) rows,MAX(r.date) lastMovement,SUM(r.value_cents) valueCents,SUM(r.quantity_micros) quantityMicros,SUM(r.value_cents IS NULL) missingValues,SUM(CASE WHEN r.value_cents<0 THEN r.value_cents ELSE 0 END) returnsCents"+range).get(...args) as {rows:number;lastMovement:string|null;valueCents:number|null;quantityMicros:number|null;missingValues:number|null;returnsCents:number|null};
    // A billing document is scoped to this partner, date, site and number.
    // Count positive net documents, excluding cancellations, returns-only and unnamed movements.
    const documentGroups="SELECT r.date date,r.site_id site,r.document_number document,SUM(r.value_cents) valueCents"+range+" AND TRIM(r.document_number)<>'' GROUP BY r.date,r.site_id,r.document_number HAVING SUM(r.value_cents)>0 AND SUM(CASE WHEN r.quantity_micros>0 AND r.value_cents>0 THEN 1 ELSE 0 END)>0 AND SUM(r.value_cents IS NULL)=0";
    const documents=c.prepare("SELECT COUNT(*) count,MAX(date) lastBilling FROM ("+documentGroups+")").get(...args) as {count:number;lastBilling:string|null};
    const latestDocuments=(c.prepare(documentGroups+" ORDER BY date DESC,site,document DESC LIMIT 5").all(...args) as {date:string;site:string;document:string;valueCents:number}[]).map(document=>{
      const documentRange=range+" AND r.date=? AND r.site_id=? AND r.document_number=?";
      const documentArgs=[...args,document.date,document.site,document.document];
      const items=c.prepare("SELECT r.item_code code,MAX(r.item_name) name,SUM(r.quantity_micros) quantityMicros,SUM(r.value_cents) valueCents"+documentRange+" GROUP BY r.item_code ORDER BY valueCents DESC,code LIMIT 21").all(...documentArgs) as {code:string;name:string;quantityMicros:number;valueCents:number|null}[];
      const originalSellers=c.prepare("SELECT DISTINCT r.tr seller"+documentRange+" ORDER BY r.tr").all(...documentArgs) as {seller:string}[];
      return {...document,products:items.slice(0,20),hasMoreProducts:items.length>20,sellers:originalSellers.map(s=>s.seller)};
    });
    const monthly=c.prepare("SELECT substr(date,1,7) month,COUNT(*) rows,SUM(r.value_cents) valueCents,SUM(r.quantity_micros) quantityMicros,SUM(r.value_cents IS NULL) missingValues"+range+" GROUP BY substr(date,1,7) ORDER BY month DESC").all(...args) as {month:string;rows:number;valueCents:number|null;quantityMicros:number;missingValues:number}[];
    const products=c.prepare("SELECT item_code code,MAX(item_name) name,SUM(r.quantity_micros) quantityMicros,SUM(r.value_cents) valueCents"+range+" GROUP BY item_code ORDER BY valueCents DESC LIMIT 20").all(...args) as {code:string;name:string;quantityMicros:number;valueCents:number|null}[];
    const sellers=c.prepare("SELECT tr seller,SUM(r.value_cents) valueCents,COUNT(*) rows"+range+" GROUP BY tr ORDER BY valueCents DESC").all(...args) as {seller:string;valueCents:number|null;rows:number}[];
    const missingHistory=c.prepare("SELECT COUNT(*) n"+base+" AND r.value_cents IS NULL").get(identities) as {n:number};
    // Document grouping removes exact net cancellations; dates aggregate billing frequency.
    // Raw repeated product lines remain facts; Nr is never presented as a verified order count.
    const billing=c.prepare("SELECT date,SUM(valueCents) valueCents FROM (SELECT date,site_id,document_number,SUM(r.value_cents) valueCents,SUM(r.value_cents IS NULL) missing"+base+" GROUP BY date,site_id,document_number HAVING SUM(r.value_cents)>0 AND SUM(CASE WHEN r.quantity_micros>0 AND r.value_cents>0 THEN 1 ELSE 0 END)>0 AND SUM(r.value_cents IS NULL)=0) GROUP BY date ORDER BY date").all(identities) as {date:string;valueCents:number}[];
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const activity=partnerActivity(billing,through,today,coverageComplete&&companyIdentityComplete&&(scope==='company'||!unresolved.n)&&!missingHistory.n);
    const transactions=c.prepare("SELECT date,document_number document,site_id site,item_code itemCode,item_name itemName,r.quantity_micros quantityMicros,r.value_cents valueCents,tr seller"+range+" ORDER BY date DESC,import_id DESC,source_row DESC LIMIT 51 OFFSET ?").all(...args,page*50) as {date:string;document:string;site:string;itemCode:string;itemName:string;quantityMicros:number;valueCents:number|null;seller:string}[];
    return {state:'ready' as const,through,from,to,scope,pointHistoryAvailable:identityRows.length>0,companyHistoryAvailable:companyRows.length>0,activity,coverageComplete:coverageComplete&&companyIdentityComplete&&(scope==='company'||!unresolved.n)&&!missingHistory.n,
      unresolvedCompanyIdentities:unresolved.n,totals,documents,latestDocuments,monthly,products,sellers,transactions:transactions.slice(0,50),page,hasMore:transactions.length>50};
  } finally {c.close();}
}
