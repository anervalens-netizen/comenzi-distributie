import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {monthEnd} from './client-sales-store';
import {salesYield} from './client-sales-cooperative';
import {productGroup, type DistributionRules} from './distribution-rules';
import {historyFileGeneration} from './history-source-generation';
import type {AiSource,AiSourceRow} from './manager-ai-query';
import {normalizedCui} from './partner-company-identity';
import {partnerScope} from './partner-portfolio';
import {db,fail} from './server';
import {salesSiteKey} from './sales-location';
import type {User} from './types';
import {isVodafoneGenericPartner,vodafoneDocumentKind} from './vodafone-bonus-rules';

const label = 'Istoric comercial pe clienți · documente și vânzări Vodafone la punct';
const sourceLimit = 'Numai pozițiile Vodafone legate de o franciză confirmată. Codul de gestiune din istoric este ERP SiteId. Importul nu certifică tipul fiscal sau emitentul. Grupele de document folosesc franciza, data, ERP SiteId și numărul. Documentele de acordare a bonusurilor sunt în registrul dedicat.';
const visiblePointIds = "EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w JOIN json_each(?) scope ON scope.value=w.value)";

type PointCard = {
  id:string; cui:string|null; name:string|null; inScope:number;
  historyCode:string|null; crmCode:string|null; franchiseCodes:string|null;
};
export type BillingPoint = {cui:string; name:string; franchises:Set<string>};
type BillingRow = {
  date:string; erpSite:string; document:string; seller:string; sku:string; product:string;
  quantity:number; value:number|null; owner:string; cui:string; sourceFranchise:string; pointKey:string;sourcePartner:string;
};
type BillingDocument = {
  month:string;date:string;erpSite:string;document:string;seller:string|null;
  franchise:string;partner:string;units:number;valueLei:number;lines:number;missingValueLines:number;positiveCharge:boolean;
};
type SalesImport = {id:number; sha256:string; from:string; to:string};

function available(periods:readonly SalesImport[], from:string, to:string) {
  const periodsWithin = periods.map(p=>({from:p.from<from?from:p.from,to:p.to>to?to:p.to}));
  const coverage = periodsWithin.map(r=>r.from+'–'+r.to);
  const day = (stamp:string) => Date.parse(stamp+'T00:00:00Z')/86_400_000;
  let next=day(from);
  for (const period of periodsWithin) {
    if (day(period.from)>next) break;
    next=Math.max(next,day(period.to)+1);
  }
  return {coverage,complete:next>day(to),through:periodsWithin.at(-1)?.to||null};
}

export function selectManagerAiBillingPoints(cards:readonly PointCard[]):Map<string,BillingPoint> {
  const owners = new Map<string,string|null>();
  const visible = new Map<string,BillingPoint>();
  for (const card of cards) {
    const cui=normalizedCui(card.cui||'');
    const known:unknown=JSON.parse(card.franchiseCodes||'[]');
    const values=[card.historyCode,card.crmCode,...(Array.isArray(known)?known:[])];
    const franchises=new Set<string>();
    for (const value of values) {
      if (typeof value!=='string'||!value.trim()) continue;
      const code=salesSiteKey(value);
      const previous=owners.get(code);
      owners.set(code,previous===undefined||previous===card.id?card.id:null);
      franchises.add(code);
    }
    if(card.inScope===1&&cui&&!isVodafoneGenericPartner(cui,card.name||'')&&franchises.size)visible.set(card.id,{cui,name:card.name||'',franchises});
  }
  // Verify global point uniqueness before projecting the authorized intersection.
  for (const [id,point] of visible) {
    for (const code of point.franchises) if (owners.get(code)!==id) point.franchises.delete(code);
    if (!point.franchises.size) visible.delete(id);
  }
  return visible;
}

export async function managerAiBillingPoints(user:User,warehouses:string[]|undefined) {
  const scope=partnerScope(user);
  const selected=warehouses? `(${scope.sql}) AND ${visiblePointIds}` : scope.sql;
  const rows=await db().prepare(`SELECT c.id,json_extract(c.data,'$.cui') cui,json_extract(c.data,'$.name') name,
      json_extract(c.data,'$.historyCatalog.franchiseCode') historyCode,
      json_extract(c.data,'$.crm.franchiseCode') crmCode,
      json_extract(c.data,'$.historyFranchises') franchiseCodes,
      CASE WHEN ${selected} THEN 1 ELSE 0 END inScope
      FROM customers c WHERE c.active=1 ORDER BY c.id`)
    .bind(...scope.args,...(warehouses?[JSON.stringify(warehouses)]:[])).all<PointCard>();
  return selectManagerAiBillingPoints(rows.results);
}

export async function readManagerAiBilling(
  month:string,
  dataset:'salesByPoint'|'billingDocuments',
  points:Map<string,BillingPoint>,
  rules:DistributionRules|null,
  directory=process.env.MOBIUP_DATA_DIR||'./work/server-data',
  options?:{allProducts:true;maxRows:number},
):Promise<AiSource> {
  const unavailable = (note:string):AiSource => ({rows:[],coverage:[{source:label,month,available:false,note}]});
  if (!rules && !options) return unavailable('Catalogul Vodafone nu este configurat.');
  const path=resolve(directory,'client-history','client-sales-history.sqlite');
  if (!existsSync(path)) return unavailable('Istoricul comercial nu este importat.');
  const generation=historyFileGeneration(path);
  if (!generation) return unavailable('Istoricul comercial nu este disponibil.');
  const connection=new DatabaseSync(path,{readOnly:true});
  try {
    connection.exec('BEGIN');
    const from=month+'-01', to=monthEnd(month);
    const reference=String(connection.prepare("SELECT value FROM history_meta WHERE key='current_reference'").get()?.value||'');
    const active=connection.prepare(`SELECT id,sha256,period_start "from",period_end "to" FROM history_imports
      WHERE state='active' AND period_start<=? AND period_end>=? ORDER BY period_start,id`).all(to,from) as unknown as SalesImport[];
    if (!reference||!active.length) return unavailable('Luna nu are acoperire declarată în istoricul activ.');
    if (active.some((row,i)=>i>0&&row.from<=active[i-1].to)) fail(409,'Importurile active au perioade suprapuse. Verifică istoricul comercial.');
    const covered=available(active,from,to);
    const revision=createHash('sha256').update(JSON.stringify([reference,active,generation,rules?.revision])).digest('hex');
    const skus=rules?Object.keys(rules.products).filter(sku=>productGroup(rules,sku).startsWith('vodafone_')):[];
    const rows:AiSourceRow[]=[];
    if (points.size&&(options||skus.length)) {
      const productFilter=options?'':'AND r.item_code IN (SELECT value FROM json_each(?))';
      const records=connection.prepare(`SELECT r.date,r.site_id erpSite,r.document_number document,r.tr seller,
        r.item_code sku,r.item_name product,r.customer_name sourcePartner,
        r.quantity_micros quantity,r.value_cents value,
        json_extract(a.partner_ids_json,'$[0]') owner,i.client_code cui,i.franchise_code sourceFranchise,a.point_key pointKey
        FROM history_rows r
        JOIN history_imports h ON h.id=r.import_id AND h.state='active' AND r.date BETWEEN h.period_start AND h.period_end
        JOIN history_allocations a ON a.identity_id=r.identity_id AND a.reference_id=?
        JOIN history_identities i ON i.id=r.identity_id
        WHERE r.date BETWEEN ? AND ? ${productFilter}
        AND a.status='direct_code' AND json_array_length(a.partner_ids_json)=1
        ORDER BY r.date,r.import_id,r.sheet,r.source_row`).iterate(reference,from,to,...(options?[]:[JSON.stringify(skus)]));
      const documents=new Map<string,BillingDocument>();
      let evaluated=0;
      try {
        for (const record of records) {
          if (++evaluated%256===0) await salesYield();
          const row=record as BillingRow;
          const point=points.get(row.owner);
          const franchise=salesSiteKey(row.sourceFranchise);
          if (!point||point.cui!==normalizedCui(row.cui)||!point.franchises.has(franchise)||row.pointKey!=='franchise:'+franchise||
            isVodafoneGenericPartner(row.cui,row.sourcePartner)||vodafoneDocumentKind([row.document],'sale',row.sourcePartner)==='excluded') continue;
          const units=row.quantity/1e6;
          if (dataset==='salesByPoint') {
            if (options&&rows.length>=options.maxRows) fail(413,'Istoricul pe punct depășește limita. Restrânge perioada sau portofoliul.');
            rows.push({month,date:row.date,franchise,partner:point.name,seller:row.seller,erpSite:row.erpSite,document:row.document,
              sku:row.sku,product:row.product,units,valueLei:row.value===null?null:row.value/100,lines:1,
              missingValueLines:row.value===null?1:0});
          } else if (row.document.trim()) {
            const document=row.document.trim();
            const key=JSON.stringify([row.date,franchise,row.erpSite,document]);
            let account=documents.get(key);
            if (!account) {
              account={month,date:row.date,erpSite:row.erpSite,document,seller:row.seller,franchise,partner:point.name,
                units:0,valueLei:0,lines:0,missingValueLines:0,positiveCharge:false};
              documents.set(key,account);
            }
            if (account.seller!==row.seller) account.seller=null;
            account.units+=units;
            account.lines++;
            if (row.value===null) account.missingValueLines++;
            else {
              account.valueLei+=row.value;
              if (units>0&&row.value>0) account.positiveCharge=true;
            }
          }
        }
      } finally {records.return?.();}
      for (const account of documents.values()) {
        const {positiveCharge,valueLei,missingValueLines,...fields}=account;
        const status = missingValueLines ? 'valoare necunoscută' : valueLei<0 ? 'retur/corecție' :
          valueLei>0&&positiveCharge ? 'pozitiv net' : valueLei===0 ? 'la zero' : 'în verificare';
        rows.push({...fields,status,documentGroups:1,missingValueLines,
          valueLei:missingValueLines?null:valueLei/100});
      }
    }
    if (generation!==historyFileGeneration(path)) fail(409,'Istoricul comercial s-a modificat. Reîncarcă raportul.');
    const note=[options?sourceLimit.replace('Numai pozițiile Vodafone','Pozițiile de produs'):sourceLimit,`Acoperire declarată ${covered.coverage.join(', ')}.`,covered.complete?'':'Luna are acoperire parțială.'].filter(Boolean).join(' ');
    return {rows,coverage:[{source:options?'Istoric comercial · poziții pe punct':label,month,available:true,through:covered.through,revision,note}]};
  } finally {connection.close();}
}
