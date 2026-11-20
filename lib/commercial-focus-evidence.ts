import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {salesLocationKey, salesSiteKey} from './sales-location';
import {isVodafoneGenericPartner, vodafoneDocumentKind} from './vodafone-bonus-rules';

export type FocusLine = {
  date: string; seller: string; document: string; code: string; quantityMicros: number;
  priceCents: number | null; valueCents: number | null;
};
const labelKeys = new Set(['TIPDOC', 'TIPDOCUMENT', 'TIPTRANZACTIE', 'DOCUMENTTYPE', 'DOCUMENTKIND', 'DENUMIREDOCUMENT', 'DOCTYPE']);

export const focusLineKey = (line: FocusLine) =>
  JSON.stringify([line.date, salesLocationKey(line.seller), line.document.trim(), salesSiteKey(line.code),
    line.quantityMicros, line.priceCents, line.valueCents]);

export function focusExcludedDocument(document: string, partner: string, raw: string) {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const labels = Object.entries(payload).flatMap(([key, value]) =>
    typeof value === 'string' && labelKeys.has(salesLocationKey(key).replaceAll(' ', '')) ? [value] : []);
  return vodafoneDocumentKind([document, ...labels], 'sale', partner) === 'excluded';
}

export function focusHistoryEvidence(directory: string, month: string, codes: readonly string[]) {
  const history = resolve(directory, 'client-history', 'client-sales-history.sqlite');
  const counts = new Map<string, {total: number; excluded: number}>();
  if (!existsSync(history)) return counts;
  const database = new DatabaseSync(history, {readOnly: true});
  try {
    const rows = database.prepare(`
      SELECT r.date,r.tr seller,r.document_number document,r.item_code code,r.quantity_micros quantityMicros,
        r.price_cents priceCents,r.value_cents valueCents,r.customer_name partner,r.raw_json raw,t.client_code client
      FROM history_rows r JOIN history_imports i ON i.id=r.import_id AND i.state='active'
        JOIN history_identities t ON t.id=r.identity_id
      WHERE r.date BETWEEN ? AND ? AND r.item_code IN (SELECT value FROM json_each(?))
    `).iterate(month + '-01', month + '-31', JSON.stringify(codes)) as unknown as
      Iterable<FocusLine & {partner: string; client: string; raw: string}>;
    for (const row of rows) {
      if (!row.document.trim() || !row.seller.trim()) continue;
      const key = focusLineKey(row);
      const count = counts.get(key) ?? {total: 0, excluded: 0};
      count.total++;
      if (isVodafoneGenericPartner(row.client,row.partner) || focusExcludedDocument(row.document,row.partner,row.raw)) count.excluded++;
      counts.set(key,count);
    }
    return counts;
  } finally {
    database.close();
  }
}
