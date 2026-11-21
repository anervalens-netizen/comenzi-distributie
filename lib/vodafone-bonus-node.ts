import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {salesLocationKey,salesSiteKey} from './sales-location';
import {normalizedCui} from './partner-company-identity';
import type {DistributionRules} from './distribution-rules';
import {activationFactsVersion} from './activation-semantics';
import {firstVodafoneBonusMonth, vodafoneBonusPreview, type VodafoneBonusScreen, type VodafoneBonusReason, type VodafoneBonusReport, type VodafoneBonusScope, type VodafoneTopLocation} from './vodafone-bonus-types';
import {bonusDate,bonusMonth,bonusEvidenceIdentity,type VodafoneBonusEvidence} from './vodafone-bonus-evidence';
import {isVodafoneGenericPartner,vodafoneDocumentKind} from './vodafone-bonus-rules';
import {createReadProjectionCache} from './read-projection-cache';
import {createVodafoneDiskCache,type VodafoneDiskCache} from './vodafone-bonus-cache-node';
import {sim0Coverage,type Sim0MonthCoverage} from './vodafone-sim0-coverage';
import {vodafoneBonusLedger,type BonusActivation,type BonusLedgerInput} from './vodafone-bonus-ledger';

type DocFields = {date: string; site: string; number: string};
type Activation = {month: string; activation_date: string; distribution_date: string|null; company: string; serial: string; client_code: string; point_code: string; item_code: string; label: string; site: string; contradictory: number};
type Movement = {site: string; is_tr: number; movement_date: string; raw_json: string; quantity: number};
type MovementLink = DocFields & {tradeSite: string; realClient: boolean; fiscalKind: ReturnType<typeof fiscalKind>};
type HistoryLine = {
  date: string; document_number: string; site_id: string; tr: string; client_code: string; franchise_code: string; point_key: string|null;
  allocation_status: string; item_code: string; customer_name: string; quantity_micros: number; price_cents: number|null; value_cents: number|null;
  kind: ReturnType<typeof fiscalKind>;
};
type CommercialLine = {company: string; site_code: string; date: string; location: string; order_number: string; item_code: string; quantity: number; price_cents: number; value_cents: number};
type Point = BonusLedgerInput['portfolios'][number];
const ledgerCache=createVodafoneDiskCache<BonusLedgerInput>('ledger');
let cached: Snapshot<BonusLedgerInput> | undefined;
let cachedPreview: Snapshot<VodafoneBonusScreen> | undefined;
const previewDisk=createVodafoneDiskCache<VodafoneBonusScreen>('preview');
type Raw = Record<string,unknown>;
const s = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
const uniform = <T>(values: Iterable<T>): T|undefined => {
  const unique = new Set(values);
  if (unique.size === 1) return unique.values().next().value;
  return undefined;
};
const bucharestDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});
const knownVoucherCodes = ['V05EVDF','V06EVDF','V03EVDF'];
const rowKey = (date: string, number: string) => JSON.stringify([date,number]);
const docKey = (date: string, site: string, number: string) => JSON.stringify([date,site,number]);
const pointCode = (point: string|null) => point?.startsWith('franchise:') ? salesSiteKey(point.slice('franchise:'.length)) : '';
const serialHead = (serial: string) => /^\d{18,19}$/.test(serial) ? serial.slice(0,18) : '';

function documentLabels(value: Raw) {
  const labels = ['TipDocument','Tip Document','Tip Doc','TipDoc','TipTranzactie','Tip Tranzacție',
    'DocumentType','Document Type','DocumentKind','document_type','document_kind','Denumire Document','DocType'];
  return labels.filter(label=>Object.hasOwn(value,label)).map(label=>s(value[label]));
}
function fiscalKind(raw: Raw, number: string, partner: string, purpose: 'sale' | 'payment') {
  return vodafoneDocumentKind([number,...documentLabels(raw)],purpose,partner);
}
function activationsDirectory(root: string) {
  const pointer = resolve(root,'current');
  const entry = lstatSync(pointer,{throwIfNoEntry:false});
  if (!entry) return root;
  if (!entry.isSymbolicLink()) throw new Error('Invalid activation generation');
  const resolved = realpathSync(pointer);
  if (dirname(resolved) !== resolve(root,'generations')) throw new Error('Invalid activation generation path');
  return resolved;
}
function fingerprint(path: string) {
  const files = [path,path+'-wal'];
  return files.map(file => {
    const stat = statSync(file,{bigint:true,throwIfNoEntry:false});
    // Opening a WAL database for reading may create an empty sidecar without changing any rows.
    return !stat || (file!==path && stat.size===BigInt(0)) ? '-' : [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  }).join('|');
}
function hasTable(app: DatabaseSync, name: string) {
  return !!app.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
// Activity/session writes may alter this file. On such writes the logical digest still
// checks only the tables and columns that affect attribution.
const appRevisions=new Map<boolean,{stamp:string;digest:string}>();
function applicationIdentity(app: DatabaseSync, path: string, companyNames: boolean) {
  const stat=statSync(path,{bigint:true});
  const digest=createHash('sha256').update(stat.dev+':'+stat.ino);
  const triggers=new Set(app.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(row=>s(row.name)));
  const add=(sql: string)=>{
    for (const row of app.prepare(sql).iterate()) digest.update(JSON.stringify(row));
  };
  if (hasTable(app,'crm_directory_revision') && ['insert','update','delete'].every(op=>triggers.has('crm_directory_customers_'+op))) {
    add('SELECT revision FROM crm_directory_revision WHERE id=1');
  } else add('SELECT id,warehouse_id,active,data FROM customers ORDER BY id');
  if (hasTable(app,'order_list_revision') && ['insert','update','delete'].every(op=>triggers.has('order_list_revision_'+op))) {
    add('SELECT revision FROM order_list_revision WHERE id=1');
  } else add("SELECT id,number,user_id,warehouse_id,finalized_at,payload FROM orders WHERE kind IN ('sim','combined') AND status='finalized' ORDER BY id");
  // Those fields influence attribution. Session and activity changes do not.
  add("SELECT id,site_code,warehouse_id,active FROM users WHERE role='agent' ORDER BY id");
  if (hasTable(app,'crm_companies')) add(companyNames ? 'SELECT partner_id,partner_code,cif,name FROM crm_companies ORDER BY partner_id' : 'SELECT partner_id,partner_code,cif FROM crm_companies ORDER BY partner_id');
  if (hasTable(app,'crm_locations')) add('SELECT address_id,partner_id,franchise_code FROM crm_locations ORDER BY address_id');
  if (hasTable(app,'crm_customer_links')) add('SELECT customer_id,address_id FROM crm_customer_links ORDER BY customer_id,address_id');
  if (hasTable(app,'customer_identity_aliases')) add('SELECT alias_id,canonical_id FROM customer_identity_aliases ORDER BY alias_id');
  return digest.digest('hex');
}
function pinnedApplicationIdentity(app:DatabaseSync,appPath:string,stamp:string,withPayments:boolean) {
  // BEGIN is deferred. Pin the catalog before trusting a previously calculated digest.
  app.prepare('PRAGMA schema_version').get();
  const stable=fingerprint(appPath)===stamp;
  const memo=stable ? appRevisions.get(withPayments) : undefined;
  if (memo?.stamp===stamp) return memo.digest;
  const digest=applicationIdentity(app,appPath,!withPayments);
  if (stable) appRevisions.set(withPayments,{stamp,digest});
  return digest;
}
/** Same legal-entity names, alias, work-point and document inputs used by the worker. */
export function vodafoneSim0CatalogRevision(directory:string) {
  const path=resolve(directory,'mobiup.sqlite'),stamp=fingerprint(path);
  const app=new DatabaseSync(path,{readOnly:true,timeout:500});
  try {
    app.exec('PRAGMA query_only=ON; BEGIN');
    return pinnedApplicationIdentity(app,path,stamp,false);
  } finally {app.close();}
}
function keys(a: {date: string; site: string; number: string}[]) {
  return [...new Map(a.map(x => [docKey(x.date,x.site,x.number),x])).values()];
}

function historyInvoices(history: DatabaseSync, documents: DocFields[], purpose: 'sale' | 'payment') {
  // The date/site index is selective even for historical SIM issuance years before activation.
  const statement = history.prepare(`
    WITH wanted AS (SELECT value ->> '$.date' date,value ->> '$.site' site,value ->> '$.number' number FROM json_each(?))
    SELECT r.date,r.document_number,r.site_id,r.tr,i.client_code,i.franchise_code,a.point_key,a.status allocation_status,
      r.item_code,r.customer_name,r.quantity_micros,r.price_cents,r.value_cents,r.raw_json
    FROM wanted w CROSS JOIN history_rows r
      ON r.site_id=w.site AND r.date=w.date AND r.document_number=w.number
    JOIN history_imports b ON b.id=r.import_id AND b.state='active'
    JOIN history_identities i ON i.id=r.identity_id
    LEFT JOIN history_allocations a ON a.identity_id=r.identity_id
      AND a.reference_id=(SELECT value FROM history_meta WHERE key='current_reference')`);
  const result = new Map<string,HistoryLine[]>();
  type SourceLine = Omit<HistoryLine,'kind'> & {raw_json: string};
  for (const {raw_json,...fields} of statement.iterate(JSON.stringify(keys(documents))) as unknown as Iterable<SourceLine>) {
    const line: HistoryLine = {...fields,kind:fiscalKind(JSON.parse(raw_json),fields.document_number,fields.customer_name,purpose)};
    const key = docKey(line.date,line.site_id,line.document_number);
    const list = result.get(key);
    if (list) list.push(line);
    else result.set(key,[line]);
  }
  return result;
}

function identityIndex(app: DatabaseSync, history: DatabaseSync, observed: Activation[], targetPoints: ReadonlySet<string>) {
  const ownerByAlias = new Map<string,Set<string>>();
  const ownersByPoint = new Map<string,Set<string>>();
  const codesByCustomer = new Map<string,Set<string>>();
  const names = new Map<string,Point>();
  function add(map: Map<string,Set<string>>, key: string, value: string) {
    if (!key || !value) return;
    const values = map.get(key) || new Set<string>();
    values.add(value);
    map.set(key,values);
  }
  for (const row of hasTable(app,'crm_companies') ? app.prepare('SELECT cif,partner_code FROM crm_companies').iterate() : []) {
    const cui = normalizedCui(s(row.cif));
    const alias = normalizedCui(s(row.partner_code));
    add(ownerByAlias,cui,cui);
    add(ownerByAlias,alias,cui);
  }
  const knownCuis = new Map<string,string>();
  const legal = (value: string) => {
    const existing=knownCuis.get(value);
    if (existing!==undefined) return existing;
    const normalized=normalizedCui(value);
    const owned=ownerByAlias.get(normalized);
    const result=isVodafoneGenericPartner(normalized) ? '' : owned ? uniform(owned) ?? '' : normalized;
    knownCuis.set(value,result);
    return result;
  };
  const customers = new Map<string,{cui: string; active: boolean; partner: string; warehouseIds: string[]}>();
  for (const row of app.prepare('SELECT id,data,active,warehouse_id FROM customers').iterate()) {
    const data = JSON.parse(s(row.data)) as Raw;
    const cui = legal(s(data.cui));
    const warehouseIds=Array.isArray(data.warehouseIds) ? data.warehouseIds : [data.warehouseId||row.warehouse_id];
    customers.set(s(row.id),{cui,active:Number(row.active)===1,partner:s(data.name),warehouseIds:warehouseIds.map(s)});
    const codes = Array.isArray(data.historyFranchises) ? data.historyFranchises : [];
    for (const code of codes) {
      const franchise = salesSiteKey(s(code));
      add(codesByCustomer,s(row.id),franchise);
      add(ownersByPoint,franchise,cui);
    }
  }
  for (const row of ['crm_companies','crm_locations','crm_customer_links'].every(name=>hasTable(app,name)) ? app.prepare(`
    SELECT l.franchise_code,c.cif,lcl.customer_id
    FROM crm_locations l JOIN crm_companies c ON c.partner_id=l.partner_id
    LEFT JOIN crm_customer_links lcl ON lcl.address_id=l.address_id`).iterate() : []) {
    const code = salesSiteKey(s(row.franchise_code));
    const cui = legal(s(row.cif));
    add(ownersByPoint,code,cui);
    const customer = customers.get(s(row.customer_id));
    if (customer?.cui && customer.cui === cui) add(codesByCustomer,s(row.customer_id),code);
  }
  const single = new Map<string,Set<string>>();
  for (const row of history.prepare(`
    SELECT i.client_code,i.franchise_code,a.point_key,a.partner_ids_json,a.status FROM history_allocations a
    JOIN history_identities i ON i.id=a.identity_id
    WHERE a.reference_id=(SELECT value FROM history_meta WHERE key='current_reference')`).iterate()) {
    const cui = legal(s(row.client_code)), code = pointCode(s(row.point_key));
    const explicit = salesSiteKey(s(row.franchise_code));
    if (explicit) add(ownersByPoint,explicit,cui);
    if (!code || !cui || !['direct_code','single_partner'].includes(s(row.status))) continue;
    add(ownersByPoint,code,cui);
    if (!explicit && row.status === 'single_partner') add(single,cui,code);
    for (const id of JSON.parse(s(row.partner_ids_json) || '[]') as string[]) {
      if (customers.get(id)?.cui === cui) add(codesByCustomer,id,code);
    }
  }
  for (const row of observed) {
    if (!isVodafoneGenericPartner(row.client_code,row.label)) add(ownersByPoint,salesSiteKey(row.point_code),legal(row.client_code));
  }
  const aliases = new Map<string,string>();
  if (app.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_identity_aliases'").get()) {
    for (const row of app.prepare('SELECT alias_id,canonical_id FROM customer_identity_aliases').iterate()) aliases.set(s(row.alias_id),s(row.canonical_id));
  }
  const valid = (code: string,cui: string) => !!code && !!cui && uniform(ownersByPoint.get(code)||[])===cui;
  const fromCustomer = (id: string,cui: string) => {
    const canonical = aliases.get(id) ?? id;
    const code = uniform(codesByCustomer.get(canonical)||[]);
    return code && customers.get(canonical)?.cui === cui && valid(code,cui) ? code : '';
  };
  const fromHistory = (row: HistoryLine) => {
    const cui = legal(row.client_code), code = pointCode(row.point_key);
    return ['direct_code','single_partner'].includes(row.allocation_status) && valid(code,cui) ? code : '';
  };
  const fallback = (cui: string) => {
    const code = uniform(single.get(cui)||[]);
    return code && valid(code,cui) ? code : '';
  };
  const sites = new Map<string,Set<string>>();
  for (const row of app.prepare("SELECT warehouse_id,site_code FROM users WHERE role='agent' AND active=1 AND TRIM(site_code)<>''").iterate()) {
    add(sites,s(row.warehouse_id),salesSiteKey(s(row.site_code)));
  }
  if (targetPoints.size) for (const [customerId,customer] of customers) {
    if (!customer.active || isVodafoneGenericPartner(customer.partner)) continue;
    const code = fromCustomer(customerId,customer.cui);
    if (!code || !targetPoints.has(code)) continue;
    const scope = new Set(customer.warehouseIds.map(warehouse => uniform(sites.get(warehouse)||[])).filter((x):x is string=>!!x));
    if (!scope.size) continue;
    const existing = names.get(code);
    const labels=new Map(existing?.sites.map(entry=>[entry.site,entry.partner]));
    for (const site of scope) if (!labels.get(site)) labels.set(site,customer.partner);
    names.set(code,{pointCode:code,cui:customer.cui,sites:[...labels].map(([site,partner])=>({site,partner}))});
  }
  return {legal,valid,fromCustomer,fromHistory,fallback,portfolios:[...names.values()]};
}

type Identity = ReturnType<typeof identityIndex>;
function slipPoints(app: DatabaseSync, identities: Identity, activations: Activation[]) {
  const byHead = new Map<string,Set<string>>();
  for (const {serial} of activations) {
    const head = serialHead(serial);
    if (!head || serial.length!==19) continue;
    const values = byHead.get(head) || new Set<string>();
    values.add(serial);
    byHead.set(head,values);
  }
  const result = new Map<string,{site: string; cui: string; point: string; date: string; serial: string}[]>();
  for (const row of app.prepare(`
    SELECT s.value serial,u.site_code site,o.finalized_at finalized,o.number,
      json_extract(o.payload,'$.client.cui') client,json_extract(o.payload,'$.client.id') customer,
      json_extract(o.payload,'$.client.name') partner
    FROM orders o JOIN users u ON u.id=o.user_id AND u.warehouse_id=o.warehouse_id
    JOIN json_each(o.payload,'$.serials') s
    WHERE o.kind IN ('sim','combined') AND o.finalized_at IS NOT NULL AND o.status='finalized'
      AND u.role='agent' AND TRIM(u.site_code)<>'' AND s.type='text'
      AND NOT EXISTS(SELECT 1 FROM users other WHERE other.role='agent'
        AND other.id<>u.id AND UPPER(TRIM(other.site_code))=UPPER(TRIM(u.site_code)))`).iterate()) {
    const serial = s(row.serial), head = serialHead(serial);
    if (!head || isVodafoneGenericPartner(s(row.client),s(row.partner)) || vodafoneDocumentKind([s(row.number)],'sale',s(row.partner))==='excluded') continue;
    const cui = identities.legal(s(row.client)), point = identities.fromCustomer(s(row.customer),cui);
    if (!point) continue;
    const timestamp = new Date(s(row.finalized));
    if (!Number.isFinite(timestamp.getTime())) continue;
    const site = salesSiteKey(s(row.site)), date = bucharestDate.format(timestamp);
    const list = result.get(head) || [];
    list.push({serial,site,cui,point,date});
    result.set(head,list);
  }
  return (row: Activation, cui: string) => {
    const head = serialHead(row.serial);
    const valid = (result.get(head) || []).filter(slip =>
      slip.site===salesSiteKey(row.site) && slip.cui===cui && slip.date<=row.activation_date &&
      (slip.serial === row.serial || ((slip.serial.length===18 || row.serial.length===18) && (byHead.get(head)?.size ?? 0)<=1)));
    return new Set(valid.map(record=>record.point));
  };
}

function matchActivations(source: DatabaseSync, history: DatabaseSync, app: DatabaseSync, activations: Activation[], evidence: Map<string,'commercial'|'excluded'>, targetPoints: ReadonlySet<string>) {
  const movement = source.prepare(`
    SELECT w.key AS ordinal,m.site,m.is_tr,m.movement_date,m.raw_json,m.quantity
    FROM json_each(?) w CROSS JOIN activation_facts f
      ON f.provider='vodafone' AND f.company=w.value->>0 AND f.serial=w.value->>1
    JOIN activation_movements m ON m.id=json_extract(f.evidence_json,'$.remainingSaleIds[0]')
    WHERE json_array_length(f.evidence_json,'$.remainingSaleIds')=1`);
  const identity = identityIndex(app,history,activations,targetPoints);
  const slips = slipPoints(app,identity,activations);
  function resolveBatch(batch: Activation[]) {
    const links = new Map<Activation,MovementLink>();
    const wanted: DocFields[] = [];
    const requested=JSON.stringify(batch.map(row=>[row.company,row.serial]));
    for (const move of movement.iterate(requested) as unknown as Iterable<Movement & {ordinal:number}>) {
      const row=batch[move.ordinal];
      const raw = JSON.parse(move.raw_json) as Raw;
      const date = move.movement_date || '', site = s(raw.SiteId), number = s(raw.Nr);
      const partner=s(raw['Denumire Client']);
      const tradeSite=move.is_tr === 1 && move.quantity > 0 ? salesSiteKey(move.site) : '';
      const realClient=!isVodafoneGenericPartner(s(raw.CIF),partner);
      links.set(row,{date,site,number,tradeSite,realClient,fiscalKind:fiscalKind(raw,number,partner,'sale')});
      if (date && site && number && tradeSite && realClient) wanted.push({date,site,number});
    }
    const invoices = historyInvoices(history,wanted,'sale');
    return batch.map((row): BonusActivation => {
      const site = salesSiteKey(row.site), cui = identity.legal(row.client_code);
      const result: BonusActivation = {month:row.month,site,cui,partner:row.label,reason:'point-unknown',pointCode:null};
      const link = links.get(row);
      if (link?.realClient===false || isVodafoneGenericPartner(row.client_code,row.label)) {
        return {...result,reason:'excluded'};
      }
      const movementKind = link?.fiscalKind || 'unknown';
      const override = link ? evidence.get(bonusEvidenceIdentity('activation',row.company,link.date,link.site,link.number)) : undefined;
      if (override==='excluded' || movementKind==='excluded') return {...result,reason:'excluded'};
      if (row.contradictory) return {...result,reason:'conflict'};
      if (!cui) return {...result,reason:'client-missing'};
      if (!site || !link || link.tradeSite !== site) {
        return {...result,reason:'unmatched'};
      }
      const matched = invoices.get(docKey(link.date,link.site,link.number)) || [];
      const onArticle=matched.filter(line=>line.item_code===row.item_code && line.quantity_micros>0);
      const generic=(line: HistoryLine)=>isVodafoneGenericPartner(line.client_code,line.customer_name) || line.allocation_status==='consumer';
      if (onArticle.length && onArticle.every(line=>generic(line)||line.kind==='excluded')) return {...result,reason:'excluded'};
      const inDocument = onArticle.filter(line=>identity.legal(line.client_code)===cui);
      const historyKinds = inDocument.map(line=>line.kind);
      if (historyKinds.includes('excluded') ||
          inDocument.some(line=>isVodafoneGenericPartner(line.client_code,line.customer_name))) return {...result,reason:'excluded'};
      const candidates = slips(row,cui);
      const direct = salesSiteKey(row.point_code);
      if (direct && !identity.valid(direct,cui)) return {...result,reason:'conflict'};
      if (direct) candidates.add(direct);
      const fifoDocumentPoint = uniform(inDocument.map(identity.fromHistory));
      if (fifoDocumentPoint) candidates.add(fifoDocumentPoint);
      if (candidates.size>1 || (inDocument.some(line=>!!line.franchise_code && !identity.fromHistory(line)))) {
        return {...result,reason:'conflict'};
      }
      const point = uniform(candidates) || identity.fallback(cui);
      if (!point) return result;
      const commercial = override==='commercial' || movementKind==='commercial' || historyKinds.includes('commercial');
      return {...result,pointCode:point,reason:commercial?'commercial':'document-unknown'};
    });
  }
  // Invoice lines and their evidence are needed only while attributing the current batch.
  const activation: BonusActivation[]=[];
  for (let start=0;start<activations.length;start+=2048) {
    activation.push(...resolveBatch(activations.slice(start,start+2048)));
  }
  return {activation,identity};
}

function rowSignature(code: string, units: number, price: number|null, value: number|null) {
  return JSON.stringify([code,units,price,value]);
}
function equalDocument(lines: HistoryLine[], sale: CommercialLine[]) {
  if (lines.length !== sale.length) return false;
  const content = new Map<string,number>();
  for (const line of lines) {
    const key = rowSignature(line.item_code,line.quantity_micros,line.price_cents,line.value_cents);
    content.set(key,(content.get(key)||0)+1);
  }
  for (const line of sale) {
    const key = rowSignature(line.item_code,Math.round(line.quantity*1_000_000),line.price_cents,line.value_cents);
    const count = content.get(key) || 0;
    if (!count) return false;
    content.set(key,count-1);
  }
  return true;
}

function paymentDocuments(history: DatabaseSync, sales: DatabaseSync, identity: Identity, giftCodes: string[], today: string, evidence: Map<string,'commercial'|'excluded'>) {
  const firstDay = firstVodafoneBonusMonth+'-01';
  const wanted = history.prepare(`
    SELECT DISTINCT r.date,r.site_id AS site,r.document_number AS number
    FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active'
    WHERE r.date BETWEEN ? AND ? AND r.price_cents=0
      AND r.item_code IN(SELECT value FROM json_each(?))`).all(firstDay,today,JSON.stringify(giftCodes)) as DocFields[];
  const invoiceRows = historyInvoices(history,wanted,'payment');
  const lookup: [string,string][]=[];
  for (const [key,lines] of invoiceRows) {
    if (lines.some(line=>line.kind==='excluded' || line.allocation_status==='consumer' || isVodafoneGenericPartner(line.client_code,line.customer_name))) {
      invoiceRows.delete(key);
    } else lookup.push([lines[0].date,lines[0].document_number]);
  }
  const byIdentity = new Map<string,Map<string,CommercialLine[]>>();
  for (const line of sales.prepare(`
    SELECT r.company,r.site_code,r.date,r.location,r.order_number,r.item_code,r.quantity,r.price_cents,r.value_cents
    FROM sales_months m JOIN sales_rows r ON r.import_id=m.import_id
    WHERE m.month BETWEEN ? AND ? AND r.date BETWEEN ? AND ?
      AND (r.date,r.order_number) IN (SELECT value->>0,value->>1 FROM json_each(?))`).iterate(firstVodafoneBonusMonth,today.slice(0,7),firstDay,today,JSON.stringify(lookup)) as unknown as Iterable<CommercialLine>) {
    const key = rowKey(line.date,line.order_number);
    const bySite = byIdentity.get(key) || new Map<string,CommercialLine[]>();
    const identity = JSON.stringify([line.company,salesSiteKey(line.site_code)]);
    const rows = bySite.get(identity);
    if (rows) rows.push(line);
    else bySite.set(identity,[line]);
    byIdentity.set(key,bySite);
  }
  const gifts = new Set(giftCodes), documents: BonusLedgerInput['documents'] = [];
  for (const lines of invoiceRows.values()) {
    const first = lines[0], {date,site_id:siteId,document_number:number} = first;
    const loc = uniform(lines.map(line=>salesLocationKey(line.tr)));
    const candidates = [...(byIdentity.get(rowKey(date,number))?.values() || [])]
      .filter(rows=>loc && rows.every(line=>salesLocationKey(line.location)===loc && !!salesSiteKey(line.site_code)));
    const exact = candidates.filter(rows=>equalDocument(lines,rows));
    const match = exact.length===1 ? exact[0][0] : undefined;
    const sites = [...new Set(candidates.map(row=>salesSiteKey(row[0].site_code)))].sort();
    const override = match && evidence.get(bonusEvidenceIdentity('sales',match.company,date,siteId,number));
    if (override==='excluded') continue;
    const cui = uniform(lines.map(line=>identity.legal(line.client_code))) || '';
    const point = uniform(lines.map(identity.fromHistory)) || '';
    let reason: VodafoneBonusReason = override==='commercial'||lines.some(line=>line.kind==='commercial') ? 'commercial' : 'document-unknown';
    let quantity: number|null = lines.reduce((total,line)=>total+line.quantity_micros,0)/1_000_000;
    if (lines.some(line=>!gifts.has(line.item_code)||line.price_cents!==0||line.value_cents!==0)) {
      reason='mixed';
      quantity=null;
    } else if (lines.some(line=>line.quantity_micros<=0 || line.quantity_micros%1_000_000!==0)) {
      reason='return';
    } else if (!cui || !point) {
      reason='point-unknown';
    } else if (!match || !number || !siteId) {
      reason='unmatched';
    }
    documents.push({
      date,number,company:match?.company || '',siteId,sites:match ? [salesSiteKey(match.site_code)] : sites,
      pointCode:point||null,cui,partner:first.customer_name,reason,quantity,
    });
  }
  return documents;
}

const operatorWindowsWhere="operator='vodafone' AND status='complete' AND source_kind='operator' AND UPPER(TRIM(company)) IN ('VODAFONE','MOBIUP','MOBIUP DISTRIBUTION SRL')";
function monthCoverage(source: DatabaseSync, activations: Activation[], today: string, external: VodafoneBonusEvidence) {
  const finals = source.prepare(`SELECT source_at,period_start,period_end FROM activation_imports
    WHERE ${operatorWindowsWhere}`).all();
  const latestActivation = new Map<string,string>();
  for (const act of activations) {
    if ((latestActivation.get(act.month)||'') < act.activation_date) latestActivation.set(act.month,act.activation_date);
  }
  const dates = external.published.filter(item=>item.date<=today);
  const result: BonusLedgerInput['coverage'] = [];
  const cursor = new Date(firstVodafoneBonusMonth+'-01T00:00:00Z');
  while (cursor.toISOString().slice(0,7) <= today.slice(0,7)) {
    const month = cursor.toISOString().slice(0,7);
    cursor.setUTCMonth(cursor.getUTCMonth()+1);
    const next = cursor.toISOString().slice(0,10);
    const last = new Date(cursor.getTime()-86_400_000).toISOString().slice(0,10);
    const imports = finals.filter(file=>bonusDate(s(file.period_start)) && bonusDate(s(file.period_end)) && s(file.period_start)<=month+'-01' && s(file.period_end)>=last && bonusDate(s(file.source_at)) && s(file.source_at)>=next && s(file.source_at)<=today);
    const publishedOn = dates.find(row=>row.month===month)?.date || imports.map(r=>s(r.source_at)).sort()[0] || null;
    result.push({month,sourceThrough:publishedOn ? last : latestActivation.get(month) || null,publishedOn});
  }
  return result;
}

export type VodafoneBonusRead = {
  preview?: boolean;
  directory?: string;
  activationDirectory?: string;
  today: string;
  rules: DistributionRules;
  evidence: VodafoneBonusEvidence;
  scope: VodafoneBonusScope;
  month: string | null;
  targets: readonly VodafoneTopLocation[];
};
type BonusSources = {app: DatabaseSync; history: DatabaseSync; source: DatabaseSync; report: DatabaseSync; sales?: DatabaseSync};
type Snapshot<T> = {key: string; value: T};
type BonusSourceInput = Pick<VodafoneBonusRead,'directory' | 'activationDirectory' | 'today' | 'rules' | 'evidence'>;

function readSnapshot<T>(
  input: BonusSourceInput, selection: readonly unknown[], withPayments: boolean,
  read: (openSources: ()=>BonusSources, key: string)=>T,
  previous?: Snapshot<T>,
  disk?: VodafoneDiskCache<T>,
): Snapshot<T> {
  const directory = resolve(input.directory || process.env.MOBIUP_DATA_DIR || './work/server-data');
  const base = resolve(input.activationDirectory || process.env.MOBIUP_ACTIVATIONS_DIR || directory);
  const generation = activationsDirectory(base);
  const appPath=resolve(directory,'mobiup.sqlite');
  const paths=[resolve(directory,'client-history/client-sales-history.sqlite'),resolve(generation,'activations.sqlite'),
    resolve(generation,'activation-report.sqlite')];
  if (withPayments) paths.push(resolve(directory,'sales.sqlite'));
  const before=paths.map(fingerprint);
  const databases: DatabaseSync[] = [];
  try {
    const open = (path: string) => {
      const database = new DatabaseSync(path,{readOnly:true,timeout:500});
      databases.push(database);
      database.exec('PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY; BEGIN');
      return database;
    };
    const initialApp=fingerprint(appPath);
    const app=open(appPath);
    const appIdentity=pinnedApplicationIdentity(app,appPath,initialApp,withPayments);
    const key=createHash('sha256').update(JSON.stringify([appIdentity,before,generation,input.today,input.rules,input.evidence,selection])).digest('hex');
    function verifySources() {
      if (generation!==activationsDirectory(base) || paths.some((path,i)=>fingerprint(path)!==before[i]) ||
          (fingerprint(appPath)!==initialApp && appIdentity!==applicationIdentity(open(appPath),appPath,!withPayments))) {
        throw new Error('Vodafone report source updated during read');
      }
    }
    if (previous?.key===key) {verifySources();return previous;}
    const restored=disk?.load(directory,key);
    if (restored!==undefined) {verifySources();return {key,value:restored};}
    function openSources():BonusSources {
      const [history,source,report,sales]=paths.map(open);
      const meta = Object.fromEntries(report.prepare('SELECT key,value FROM report_meta').all().map(row=>[row.key,row.value]));
      const sourceMeta = Object.fromEntries(source.prepare("SELECT key,value FROM activation_meta WHERE key IN ('schema_version','facts_version','generation')").all().map(row=>[row.key,row.value]));
      const sourceImports = source.prepare("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").all()
        .map(row=>[row.sha256,row.operator,row.row_count,row.parser_version]);
      if (meta.version!=='4' || meta.factsVersion!==sourceMeta.facts_version || !['2',activationFactsVersion].includes(s(sourceMeta.facts_version)) ||
          sourceMeta.schema_version!=='3' || meta.sourceGeneration!==sourceMeta.generation || meta.sourceImports!==JSON.stringify(sourceImports)) {
        throw new Error('Stale or unsupported Vodafone activation projection');
      }
      return {app,history,source,report,sales};
    }
    const release=disk?.acquire?.(directory);
    try {
      // The prewarm service may have published after our first disk lookup.
      const concurrent=release && disk?.load(directory,key);
      if(concurrent!==undefined){verifySources();return {key,value:concurrent};}
      const value=read(openSources,key);
      verifySources();
      disk?.save(directory,key,value);
      return {key,value};
    } finally {release?.();}
  } finally {
    for (const database of databases.reverse()) database.close();
  }
}

function readSim0Details(report: DatabaseSync,input: BonusSourceInput,fromMonth: string,toMonth: string) {
  const zero = Object.keys(input.rules.products).filter(code=>input.rules.products[code]==='vodafone_0');
  if (!zero.length) throw new Error('No Vodafone SIM 0 products configured');
  return report.prepare(`SELECT month,activation_date,distribution_date,company,serial,client_code,point_code,item_code,label,site,contradictory
    FROM details WHERE provider='vodafone' AND is_tr=1 AND item_type<>'TELSIM'
    AND month BETWEEN ? AND ? AND activation_date BETWEEN ? AND ?
    AND item_code IN (SELECT value FROM json_each(?))`)
    .all(fromMonth,toMonth,fromMonth+'-01',input.today,JSON.stringify(zero)) as unknown as Activation[];
}

function fiscalEvidence(input: BonusSourceInput) {
  return new Map(input.evidence.documents.map(row=>[bonusEvidenceIdentity(row.source,row.company,row.date,row.site,row.number),row.kind]));
}

export function readVodafoneBonus(input: VodafoneBonusRead): VodafoneBonusScreen {
  if (!input.preview) return readFullVodafoneBonus(input);
  // A certified screen also survives a restart. New activations or settlement documents must
  // rebuild the complete ledger before its monthly balances can be displayed.
  cachedPreview=readSnapshot(input,[input.targets,input.month,input.scope],true,
    ()=>vodafoneBonusPreview(readFullVodafoneBonus(input)),cachedPreview,previewDisk);
  return cachedPreview.value;
}

function readLedger(input:VodafoneBonusRead,previous:Snapshot<BonusLedgerInput>|undefined,disk:VodafoneDiskCache<BonusLedgerInput>) {
  return readSnapshot(input,[input.targets],true,(openSources,revision)=>{
    const {app,history,source,report,sales}=openSources();
    const activations=readSim0Details(report,input,firstVodafoneBonusMonth,input.today.slice(0,7));
    const evidence=fiscalEvidence(input);
    const {activation,identity}=matchActivations(source,history,app,activations,evidence,new Set(input.targets.map(row=>row.pointCode)));
    const sim5=Object.keys(input.rules.products).filter(code=>input.rules.products[code]==='vodafone_5');
    const documents=paymentDocuments(history,sales!,identity,[...new Set([...sim5,...knownVoucherCodes])],input.today,evidence);
    const coverage=monthCoverage(source,activations,input.today,input.evidence);
    return {activation,documents,coverage,targets:input.targets,portfolios:identity.portfolios,revision};
  },previous,disk);
}

/** Warm the shared pre-scope ledger. Maintenance must fail if its private cache could not be persisted. */
export function warmVodafoneBonusLedger(input:VodafoneBonusRead) {
  let status='current';
  readLedger(input,undefined,{load:ledgerCache.load,acquire:ledgerCache.acquire,save:(directory,key,value)=>{
    if (!ledgerCache.save(directory,key,value)) throw new Error('Cannot persist private Vodafone ledger cache');
    status='rebuilt';
    return true;
  }});
  return status;
}

// A report which completed between two polls must remain available. Recheck the
// immutable source generation before every cache hit, including after a role/scope change.
const scopedReports=createReadProjectionCache(24*1024*1024,4);
function readFullVodafoneBonus(input: VodafoneBonusRead): VodafoneBonusReport {
  cached=readLedger(input,cached,ledgerCache);
  const snapshot=cached.value;
  const revision=createHash('sha256').update(JSON.stringify([snapshot.revision,input.scope])).digest('hex');
  const selection=JSON.stringify([input.scope,input.month]);
  const ready=scopedReports.get<VodafoneBonusReport>(selection,revision);
  if(ready)return ready;
  const report=vodafoneBonusLedger({...snapshot,revision},input.scope,input.month);
  scopedReports.put(selection,revision,report);
  return report;
}

/** Activation analytics is independent of the reward campaign's opening month and payment sources. */
type Sim0SourceRows = {activation:BonusActivation[];companies:Map<string,string>;revision:string;
  coverage:Sim0MonthCoverage[]};
export function projectVodafoneSim0Rows<T>(input:BonusSourceInput,fromMonth:string,toMonth:string,scope:VodafoneBonusScope,
  project:(source:Sim0SourceRows)=>T, previous?:Snapshot<T>,disk?:VodafoneDiskCache<T>) {
  if (!bonusMonth(fromMonth) || !bonusMonth(toMonth) || fromMonth>toMonth || toMonth>input.today.slice(0,7)) throw new Error('Invalid activation period');
  return readSnapshot(input,[fromMonth,toMonth,scope],false,(openSources,revision)=>{
    const {app,history,source,report}=openSources();
    const details=readSim0Details(report,input,fromMonth,toMonth);
    const {activation}=matchActivations(source,history,app,details,fiscalEvidence(input),new Set());
    const companies=new Map<string,string>();
    if (hasTable(app,'crm_companies')) for (const row of app.prepare('SELECT cif,name FROM crm_companies ORDER BY partner_id').iterate()) {
      const cui=normalizedCui(s(row.cif)), name=s(row.name);
      if (cui && name && !isVodafoneGenericPartner(cui,name) && !companies.has(cui)) companies.set(cui,name);
    }
    const windows=source.prepare(`SELECT period_start,period_end FROM activation_imports WHERE ${operatorWindowsWhere}
      AND period_start<=? AND period_end>=?`).all(input.today,fromMonth+'-01').map(r=>({start:s(r.period_start),end:s(r.period_end)}));
    const observed=new Map<string,string>(),sites=scope===null?null:new Set(scope);
    for (const row of details) if ((!sites || sites.has(salesSiteKey(row.site))) && row.activation_date>(observed.get(row.month)||'')) {
      observed.set(row.month,row.activation_date);
    }
    const coverage=sim0Coverage(fromMonth,toMonth,input.today,windows,observed);
    return project({activation,revision,coverage,companies});
  },previous,disk);
}

export function readVodafoneSim0ActivationRows(input:BonusSourceInput,fromMonth:string,toMonth:string) {
  return projectVodafoneSim0Rows(input,fromMonth,toMonth,null,source=>source).value;
}
