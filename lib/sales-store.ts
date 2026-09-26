import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, unlinkSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SalesAggregate, SalesCardsSim, SalesDaily, SalesMonthly, SalesProduct, SalesRow, SalesSegment, SalesSegments, SalesSite, SalesView } from './sales-types';
import { createSalesProductClassifier, type SalesCatalogEntry } from './sales-classification';
import seed from '../resources/seed.json';

const dataDirectory = resolve(process.env.MOBIUP_DATA_DIR || './work/server-data');
export const salesDatabasePath = resolve(dataDirectory, 'sales.sqlite');
export const salesOriginalsDirectory = resolve(dataDirectory, 'sales-imports');
let connection: DatabaseSync | undefined;

function database() {
  if (connection) return connection;
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  connection = new DatabaseSync(salesDatabasePath);
  connection.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS sales_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sales_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, file_hash TEXT NOT NULL,
      filename TEXT NOT NULL, imported_at TEXT NOT NULL, imported_by TEXT NOT NULL,
      row_count INTEGER NOT NULL, original_path TEXT NOT NULL, revision INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_imports_month ON sales_imports(month, id DESC);
    CREATE TABLE IF NOT EXISTS sales_months (
      month TEXT PRIMARY KEY, import_id INTEGER NOT NULL REFERENCES sales_imports(id),
      imported_at TEXT NOT NULL, filename TEXT NOT NULL, file_hash TEXT NOT NULL, revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_rows (
      import_id INTEGER NOT NULL REFERENCES sales_imports(id), row_number INTEGER NOT NULL,
      date TEXT NOT NULL, month TEXT NOT NULL, site_code TEXT NOT NULL, item_code TEXT NOT NULL,
      item_name TEXT NOT NULL, quantity REAL NOT NULL, brand TEXT NOT NULL, price_cents INTEGER NOT NULL,
      value_cents INTEGER NOT NULL, location TEXT NOT NULL, company TEXT NOT NULL, asm TEXT NOT NULL,
      regional TEXT NOT NULL, order_number TEXT NOT NULL, category TEXT NOT NULL, sub_category TEXT NOT NULL,
      agent TEXT NOT NULL, PRIMARY KEY(import_id, row_number)
    );
    CREATE INDEX IF NOT EXISTS idx_sales_rows_month ON sales_rows(month);
    CREATE INDEX IF NOT EXISTS idx_sales_rows_month_site ON sales_rows(month, site_code);
    INSERT OR IGNORE INTO sales_meta(key,value) VALUES ('revision','0');
  `);
  return connection;
}

const aggregate = (row: Record<string, unknown>): SalesAggregate => ({ rows: Number(row.rows || 0), quantity: Number(row.quantity || 0), value: Number(row.value_cents || 0) / 100 });
const currency = (value: number) => Math.round((value + (value >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
const safeText = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const sqlFilter = (siteCodes?: string | string[]) => {
  if (Array.isArray(siteCodes)) { const values=siteCodes.map(value=>value.trim()).filter(Boolean); return values.length?{sql:` AND UPPER(TRIM(site_code)) IN (${values.map(()=> 'UPPER(TRIM(?))').join(',')})`,args:values}:{sql:' AND 0',args:[] as string[]}; }
  return siteCodes?.trim()?{sql:' AND UPPER(TRIM(site_code))=UPPER(TRIM(?))',args:[siteCodes.trim()]}:{sql:'',args:[] as string[]};
};
const seedSalesCatalog = seed.products.map(product => ({ code: product.code, name: product.name, category: product.category, kind: product.kind }));

type SalesProductClassifier = ReturnType<typeof createSalesProductClassifier>;
function classify(row: Record<string, unknown>, classifySalesProduct: SalesProductClassifier) {
  const itemCode = safeText(row.itemCode ?? row.item_code); const itemName = safeText(row.itemName ?? row.item_name);
  const result = classifySalesProduct({ itemCode, itemName, quantity: Number(row.quantity || 0), valueCents: Number(row.valueCents ?? row.value_cents ?? 0), category: safeText(row.category), subCategory: safeText(row.subCategory ?? row.sub_category) });
  const descriptor = `${itemCode} ${itemName}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  // Some legacy source rows call phone bundles "Cartele"; retain the classifier but apply the explicit bundle rule.
  const bucket = result.bucket === 'main-card' && /PACHET/.test(descriptor) && /(?:TELEFON|SIM|NOKIA|SAMSUNG|MAXCOM|TCL|ALCATEL|XIAOMI|HONOR|MOTOROLA|HUAWEI|OPPO|REALME|ZTE)/.test(descriptor) ? 'phone' : result.bucket;
  const segment = bucket === 'phone' ? 'phones' : bucket === 'accessory' ? 'accessories' : bucket === 'ambiguous' ? 'unclassified' : 'cardsSim';
  const subsegment = bucket === 'value-card-voucher' ? 'vouchers' : bucket === 'main-card' ? (/\bSIM\b|^SIM/.test(descriptor) ? 'sim' : 'cards') : undefined;
  return { segment, subsegment, classification: result } as { segment: 'accessories' | 'cardsSim' | 'phones' | 'unclassified'; subsegment?: 'cards' | 'sim' | 'vouchers'; classification: ReturnType<SalesProductClassifier> };
}
function emptySegments(): SalesSegments {
  const empty = (): SalesSegment => ({ summary: { rows: 0, quantity: 0, value: 0 }, products: [] });
  const cardsSim: SalesCardsSim = { ...empty(), subsegments: { cards: { rows: 0, quantity: 0, value: 0 }, sim: { rows: 0, quantity: 0, value: 0 }, vouchers: { rows: 0, quantity: 0, value: 0 }, valueVouchers: { rows: 0, quantity: 0, value: 0 } } };
  return { accessories: empty(), cardsSim, phones: empty(), unclassified: empty() };
}

export function salesRevision() { return Number(database().prepare("SELECT value FROM sales_meta WHERE key='revision'").get()?.value || 0); }

export function salesMonths(siteCode?: string | string[]) {
  const filter = sqlFilter(siteCode);
  return database().prepare(`SELECT month, imported_at AS importedAt, filename, file_hash AS fileHash, revision, (SELECT COUNT(*) FROM sales_rows r WHERE r.import_id=m.import_id${filter.sql.replaceAll('site_code', 'r.site_code')}) AS rowCount FROM sales_months m ORDER BY month DESC`).all(...filter.args) as Record<string, unknown>[];
}

export function currentSalesImport(month: string) {
  return database().prepare('SELECT m.*,i.imported_by AS imported_by FROM sales_months m JOIN sales_imports i ON i.id=m.import_id WHERE m.month=?').get(month) as Record<string, unknown> | undefined;
}

export function latestSalesImport() {
  return database().prepare('SELECT month,filename,imported_at AS importedAt,row_count AS rows FROM sales_imports ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
}

export function latestSalesMonth() {
  return database().prepare('SELECT month FROM sales_months ORDER BY month DESC LIMIT 1').get()?.month as string | undefined;
}

export function salesLastDate(month: string) {
  return database().prepare('SELECT MAX(date) lastDate FROM sales_rows WHERE month=?').get(month)?.lastDate as string | undefined;
}

export function salesCoverage(month: string) {
  const summary=database().prepare('SELECT COUNT(*) rowCount, MIN(date) firstDate, MAX(date) lastDate FROM sales_rows WHERE month=?').get(month) as Record<string,unknown>;
  const siteCodes=(database().prepare("SELECT DISTINCT UPPER(TRIM(site_code)) siteCode FROM sales_rows WHERE month=? AND TRIM(site_code)<>'' ORDER BY siteCode").all(month) as Record<string,unknown>[]).map(row=>String(row.siteCode));
  return {rowCount:Number(summary.rowCount||0),firstDate:safeText(summary.firstDate)||null,lastDate:safeText(summary.lastDate)||null,siteCodes};
}

export function getSalesView(month: string, siteCode?: string | string[], fromMonth = month, toMonth = month, catalog: readonly SalesCatalogEntry[] = seedSalesCatalog): SalesView {
  const classifySalesProduct = createSalesProductClassifier(catalog);
  const current = currentSalesImport(month);
  const revision = salesRevision();
  const filter = sqlFilter(siteCode);
  const months = salesMonths(siteCode).map(item => ({ month: String(item.month), importedAt: String(item.importedAt), filename: String(item.filename), fileHash: String(item.fileHash), revision: Number(item.revision), rowCount: Number(item.rowCount || 0) }));
  const monthlyRows = database().prepare(`SELECT r.month, r.item_code itemCode, r.item_name itemName, r.category, r.sub_category subCategory, COUNT(*) rows, COALESCE(SUM(r.quantity),0) quantity, COALESCE(SUM(r.value_cents),0) value_cents FROM sales_rows r JOIN sales_months m ON m.import_id=r.import_id AND m.month=r.month WHERE r.month>=? AND r.month<=?${filter.sql.replaceAll('site_code', 'r.site_code')} GROUP BY r.month, r.item_code, r.item_name, r.category, r.sub_category ORDER BY r.month`).all(fromMonth, toMonth, ...filter.args) as Record<string, unknown>[];
  const monthlyMap = new Map<string, SalesMonthly>();
  for (const row of monthlyRows) {
    const key = safeText(row.month); const point = monthlyMap.get(key) || { month: key, rows: 0, quantity: 0, value: 0, segments: { accessories: { rows: 0, quantity: 0, value: 0 }, cardsSim: { rows: 0, quantity: 0, value: 0 }, phones: { rows: 0, quantity: 0, value: 0 }, unclassified: { rows: 0, quantity: 0, value: 0 } } };
    const part = aggregate(row); point.rows += part.rows; point.quantity += part.quantity; point.value = currency(point.value + part.value);
    const segment = classify(row, classifySalesProduct).segment;
    point.segments[segment].rows += part.rows; point.segments[segment].quantity += part.quantity; point.segments[segment].value = currency(point.segments[segment].value + part.value);
    monthlyMap.set(key, point);
  }
  const monthly = [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const blankSegments = emptySegments();
  if (!current) return { month, importedAt: null, filename: null, fileHash: null, revision, summary: { rows: 0, quantity: 0, value: 0 }, sites: [], daily: [], products: [], months, segments: blankSegments, monthly };
  const db = database();
  const args: (string | number)[] = [Number(current.import_id), ...filter.args];
  const summary = aggregate(db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(quantity),0) quantity, COALESCE(SUM(value_cents),0) value_cents FROM sales_rows WHERE import_id=?${filter.sql}`).get(...args) as Record<string, unknown>);
  const sites = db.prepare(`SELECT MIN(site_code) siteCode, MIN(location) location, MIN(agent) agent, COUNT(*) rows, COALESCE(SUM(quantity),0) quantity, COALESCE(SUM(value_cents),0) value_cents FROM sales_rows WHERE import_id=?${filter.sql} GROUP BY UPPER(TRIM(site_code)) ORDER BY value_cents DESC, siteCode`).all(...args).map(row => ({ ...aggregate(row as Record<string, unknown>), siteCode: safeText((row as Record<string, unknown>).siteCode), location: safeText((row as Record<string, unknown>).location), agent: safeText((row as Record<string, unknown>).agent) })) as SalesSite[];
  const daily = db.prepare(`SELECT date, COUNT(*) rows, COALESCE(SUM(quantity),0) quantity, COALESCE(SUM(value_cents),0) value_cents FROM sales_rows WHERE import_id=?${filter.sql} GROUP BY date ORDER BY date`).all(...args).map(row => ({ ...aggregate(row as Record<string, unknown>), date: String((row as Record<string, unknown>).date) })) as SalesDaily[];
  const productRows = db.prepare(`SELECT item_code itemCode, item_name itemName, brand, category, sub_category subCategory, COUNT(*) rows, COALESCE(SUM(quantity),0) quantity, COALESCE(SUM(value_cents),0) value_cents FROM sales_rows WHERE import_id=?${filter.sql} GROUP BY item_code, item_name, brand, category, sub_category ORDER BY value_cents DESC, item_code`).all(...args) as Record<string, unknown>[];
  const products = productRows.map(row => { const bucket = classify(row, classifySalesProduct); return { ...aggregate(row), itemCode: safeText(row.itemCode), itemName: safeText(row.itemName), brand: safeText(row.brand), category: safeText(row.category), subCategory: safeText(row.subCategory), segment: bucket.segment, ...(bucket.subsegment ? { subsegment: bucket.subsegment } : {}) }; }) as SalesProduct[];
  const segments = emptySegments();
  for (const row of productRows) {
    const bucket = classify(row, classifySalesProduct);
    const product = { ...aggregate(row), itemCode: safeText(row.itemCode), itemName: safeText(row.itemName), brand: safeText(row.brand), category: safeText(row.category), subCategory: safeText(row.subCategory), segment: bucket.segment, ...(bucket.subsegment ? { subsegment: bucket.subsegment } : {}) } as SalesProduct;
    const segment = bucket.segment;
    segments[segment].products.push(product);
    segments[segment].summary.rows += product.rows; segments[segment].summary.quantity += product.quantity; segments[segment].summary.value = currency(segments[segment].summary.value + product.value);
    if (segment === 'cardsSim') { const subsegment = bucket.subsegment || 'cards'; const target = segments.cardsSim.subsegments[subsegment]; target.rows += product.rows; target.quantity += product.quantity; target.value = currency(target.value + product.value); if (subsegment === 'vouchers') { const valueVouchers = segments.cardsSim.subsegments.valueVouchers; valueVouchers.rows += product.rows; valueVouchers.quantity += product.quantity; valueVouchers.value = currency(valueVouchers.value + product.value); } }
  }
  return { month, importedAt: String(current.imported_at), filename: String(current.filename), fileHash: String(current.file_hash), revision: Number(current.revision), summary, sites, daily, products, months, segments, monthly };
}


export function getSalesViewSnapshot(month: string, siteCode?: string | string[], fromMonth = month, toMonth = month, catalog: readonly SalesCatalogEntry[] = seedSalesCatalog): SalesView {
  const db=database();
  db.exec('BEGIN;');
  try {
    const view=getSalesView(month,siteCode,fromMonth,toMonth,catalog);
    db.exec('COMMIT;');
    return view;
  } catch(error) {
    try { db.exec('ROLLBACK;'); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** Writes an immutable copy of the source before it can become a durable audit record. */
export async function saveSalesOriginal(fileHash: string, filename: string, bytes: Uint8Array) {
  await mkdir(salesOriginalsDirectory, { recursive: true, mode: 0o700 });
  const extension = /\.xlsx$/i.test(filename) ? '.xlsx' : '.xls';
  const relative = `sales-imports/${fileHash}${extension}`;
  const path = resolve(salesOriginalsDirectory, `${fileHash}${extension}`);
  if (existsSync(path)) return relative;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, path); } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort cleanup */ }
    if (existsSync(path)) return relative;
    throw error;
  }
  return relative;
}

export function importSalesRows(args: { rows: SalesRow[]; month: string; fileHash: string; filename: string; importedBy: string; originalPath: string; expectedRevision: number; expectedMappingHash: string; currentMappingHash: string; historicalAcknowledged: boolean; regressionAcknowledged?: boolean; }) {
  const db = database();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const revision = salesRevision();
    const existing = db.prepare('SELECT m.month,m.imported_at AS importedAt,m.revision,i.imported_by AS importedBy FROM sales_months m JOIN sales_imports i ON i.id=m.import_id WHERE m.month=? AND m.file_hash=?').get(args.month, args.fileHash) as Record<string, unknown> | undefined;
    if (existing) {
      db.exec('COMMIT;');
      return { ok: true, idempotent: true, month: args.month, importedAt: String(existing.importedAt), importedBy: String(existing.importedBy), revision: Number(existing.revision), rows: args.rows.length, fileHash: args.fileHash };
    }
    if (revision !== args.expectedRevision) throw new Error('STALE_REVISION');
    if (args.expectedMappingHash !== args.currentMappingHash) throw new Error('STALE_MAPPING');
    const historical = latestSalesMonth();
    if (historical && args.month < historical && !args.historicalAcknowledged) throw new Error('HISTORICAL_ACK');
    const existingCoverage=salesCoverage(args.month);
    const incomingFirstDate=args.rows.reduce((earliest,row)=>row.date<earliest?row.date:earliest,args.rows[0].date);
    const incomingLastDate=args.rows.reduce((latest,row)=>row.date>latest?row.date:latest,args.rows[0].date);
    const incomingSites=new Set(args.rows.map(row=>row.siteCode.trim().toUpperCase()).filter(Boolean));
    const coverageReduced=existingCoverage.rowCount>0&&(args.rows.length<existingCoverage.rowCount||!!existingCoverage.firstDate&&incomingFirstDate>existingCoverage.firstDate||!!existingCoverage.lastDate&&incomingLastDate<existingCoverage.lastDate||existingCoverage.siteCodes.some(site=>!incomingSites.has(site)));
    if(coverageReduced&&!args.regressionAcknowledged)throw new Error('REGRESSION_ACK');
    const nextRevision = revision + 1;
    const importedAt = new Date().toISOString();
    const insert = db.prepare('INSERT INTO sales_imports(month,file_hash,filename,imported_at,imported_by,row_count,original_path,revision) VALUES(?,?,?,?,?,?,?,?)');
    insert.run(args.month, args.fileHash, args.filename, importedAt, args.importedBy, args.rows.length, args.originalPath, nextRevision);
    const importId = Number(db.prepare('SELECT last_insert_rowid() id').get()?.id);
    db.prepare('DELETE FROM sales_rows WHERE month=?').run(args.month);
    const add = db.prepare('INSERT INTO sales_rows(import_id,row_number,date,month,site_code,item_code,item_name,quantity,brand,price_cents,value_cents,location,company,asm,regional,order_number,category,sub_category,agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of args.rows) add.run(importId, row.rowNumber, row.date, row.month, row.siteCode, row.itemCode, row.itemName, row.quantity, row.brand, row.priceCents, row.valueCents, row.location, row.company, row.asm, row.regional, row.orderNumber, row.category, row.subCategory, row.agent);
    db.prepare('INSERT INTO sales_months(month,import_id,imported_at,filename,file_hash,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET import_id=excluded.import_id,imported_at=excluded.imported_at,filename=excluded.filename,file_hash=excluded.file_hash,revision=excluded.revision').run(args.month, importId, importedAt, args.filename, args.fileHash, nextRevision);
    db.prepare("UPDATE sales_meta SET value=? WHERE key='revision'").run(String(nextRevision));
    db.exec('COMMIT;');
    return { ok: true, month: args.month, importedAt, revision: nextRevision, rows: args.rows.length, fileHash: args.fileHash };
  } catch (error) { try { db.exec('ROLLBACK;'); } catch { /* already rolled back */ } throw error; }
}

export function salesAudit(month?: string) {
  const query = month ? 'SELECT * FROM sales_imports WHERE month=? ORDER BY id DESC' : 'SELECT * FROM sales_imports ORDER BY id DESC';
  return (month ? database().prepare(query).all(month) : database().prepare(query).all()) as Record<string, unknown>[];
}
