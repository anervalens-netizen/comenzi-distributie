import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {salesLocationKey, salesSiteKey} from './sales-location';
import {focusExcludedDocument, focusHistoryEvidence, focusLineKey, type FocusLine} from './commercial-focus-evidence';

export type FocusIdentity = {id: string; siteCode: string; warehouseName: string};
export type FocusSales = {
  lastDate: string | null; importedAt: string; quantities: Map<string, Map<string, number>>;
  excludedRows: number; unmatchedRows: number;
};
type Sale = FocusLine & {site: string};

const sellerKey = (site: string, warehouse: string) => JSON.stringify([salesSiteKey(site), salesLocationKey(warehouse)]);

export function readFocusSales(month: string, codes: readonly string[], identities: readonly FocusIdentity[],
  selected: ReadonlySet<string>, directory = process.env.MOBIUP_DATA_DIR || './work/server-data'): FocusSales | null {
  const path = resolve(directory, 'sales.sqlite');
  if (!existsSync(path)) return null;
  const owners = new Map<string, string | null>();
  for (const seller of identities) {
    if (!seller.siteCode || !seller.warehouseName) continue;
    const key = sellerKey(seller.siteCode, seller.warehouseName);
    const owner = owners.get(key);
    owners.set(key, owner === undefined || owner === seller.id ? seller.id : null);
  }
  const database = new DatabaseSync(path, {readOnly: true});
  try {
    database.exec('BEGIN');
    const source = database.prepare('SELECT import_id,imported_at FROM sales_months WHERE month=?').get(month) as {import_id: number; imported_at: string} | undefined;
    if (!source) return null;
    const lastDate = database.prepare('SELECT MAX(date) lastDate FROM sales_rows WHERE import_id=?').get(source.import_id)?.lastDate;
    const quantities = new Map<string, Map<string, number>>();
    const metadata = {lastDate: lastDate ? String(lastDate) : null, importedAt: source.imported_at, quantities};
    if (!selected.size || !codes.length) return {...metadata, excludedRows: 0, unmatchedRows: 0};
    const rows = database.prepare(`
      SELECT UPPER(TRIM(site_code)) site,location seller,UPPER(TRIM(item_code)) code,date,order_number document,
        CAST(ROUND(quantity*1000000) AS INTEGER) quantityMicros,price_cents priceCents,value_cents valueCents
      FROM sales_rows WHERE import_id=? AND UPPER(TRIM(item_code)) IN (SELECT value FROM json_each(?))
    `).all(source.import_id, JSON.stringify(codes)) as Sale[];
    const groups = new Map<string, {quantityMicros: number; code: string; ids: Map<string | null, number>}>();
    let excludedRows = 0, unmatchedRows = 0;
    for (const row of rows) {
      const id = owners.get(sellerKey(row.site, row.seller)) ?? null;
      if (focusExcludedDocument(row.document, '', '{}')) {
        if (id && selected.has(id)) excludedRows++;
        continue;
      }
      const key = focusLineKey(row);
      let group = groups.get(key);
      if (!group) groups.set(key, group = {quantityMicros: row.quantityMicros, code: row.code, ids: new Map()});
      group.ids.set(id, (group.ids.get(id) ?? 0) + 1);
    }
    const evidence = groups.size ? focusHistoryEvidence(directory, month, codes) : new Map();
    for (const [key, group] of groups) {
      const proof = evidence.get(key);
      for (const [id, count] of group.ids) {
        if (!id || !selected.has(id)) continue;
        const matched = group.ids.size === 1 && proof?.total === count ? proof : undefined;
        const excluded = matched?.excluded ?? 0;
        if (!matched) unmatchedRows += count;
        excludedRows += excluded;
        if (excluded === count) continue;
        let items = quantities.get(id);
        if (!items) quantities.set(id, items = new Map());
        const quantity = group.quantityMicros * (count - excluded) / 1_000_000;
        items.set(group.code, (items.get(group.code) ?? 0) + quantity);
      }
    }
    return {...metadata, excludedRows, unmatchedRows};
  } finally {
    database.close();
  }
}
