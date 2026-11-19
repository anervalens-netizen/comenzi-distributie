import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {FocusDocument} from './vodafone-focus';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
});
type Slip = {site: string; finalized: string; reference: string; serial: string; clientCode: string | null};

// Read order evidence in the reporting worker; the application connection and
// its session/scope checks stay on the request thread.
export function readFocusSlips(): Record<string, FocusDocument[]> {
  const app = new DatabaseSync(resolve(process.env.MOBIUP_DATA_DIR || './work/server-data', 'mobiup.sqlite'), {readOnly: true});
  try {
    // A slip proves the site only if the stored order warehouse still resolves
    // unambiguously to its agent. The finalized snapshot provides customer data.
    const rows = app.prepare(`SELECT UPPER(TRIM(u.site_code)) site,o.finalized_at finalized,
      o.number reference,s.value serial,JSON_EXTRACT(o.payload,'$.client.cui') clientCode
      FROM orders o JOIN users u ON u.id=o.user_id
      JOIN json_each(o.payload,'$.serials') s
      WHERE o.status='finalized' AND o.kind IN ('sim','stand_client','combined')
      AND o.finalized_at IS NOT NULL AND u.role='agent' AND u.warehouse_id=o.warehouse_id
      AND TRIM(u.site_code)<>'' AND s.type='text'
      AND NOT EXISTS(SELECT 1 FROM users conflict WHERE conflict.role='agent' AND conflict.id<>u.id
        AND UPPER(TRIM(conflict.site_code))=UPPER(TRIM(u.site_code)))
      ORDER BY s.value,o.finalized_at,o.number`).iterate() as Iterable<Slip>;
    const slips: Record<string, FocusDocument[]> = Object.create(null);
    for (const row of rows) {
      if (!/^\d{18,19}$/.test(row.serial)) continue;
      const timestamp = new Date(row.finalized);
      if (!Number.isFinite(timestamp.getTime())) continue;
      const serial = row.serial.slice(0, 18);
      (slips[serial] ??= []).push({
        site: row.site, tr: true, date: dateFormatter.format(timestamp), quantity: 1,
        source: 'slip', reference: row.reference, clientCode: row.clientCode || undefined,
      });
    }
    return slips;
  } finally {
    app.close();
  }
}
