import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {historyFileGeneration} from './history-source-generation';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {FocusDocument} from './vodafone-focus';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
});
type Slip = {site: string; finalized: string; reference: string; serial: string; clientCode: string | null};

const revisionOps = ['insert','update','delete'];
function pinnedSlipRevision(database: DatabaseSync,path: string,before: string|null) {
  if (!before) return null;
  let stamp=before;
  try {
    const rows=database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN ('order_list_revision_insert','order_list_revision_update','order_list_revision_delete')").all();
    const certified=revisionOps.every(op=>{
      const name='order_list_revision_'+op;
      const trigger=rows.find(row=>row.name===name);
      return typeof trigger?.sql==='string' && trigger.sql.trim().replace(/\s+/g,' ')===
        'CREATE TRIGGER '+name+' AFTER '+op.toUpperCase()+' ON orders BEGIN UPDATE order_list_revision SET revision=revision+1 WHERE id=1; END';
    });
    if (certified) {
      const revision=database.prepare('SELECT revision FROM order_list_revision WHERE id=1').get()?.revision;
      if (typeof revision==='number' && Number.isSafeInteger(revision) && revision>=0) {
        const file=statSync(path,{bigint:true});
        const schema=database.prepare('PRAGMA schema_version').get()?.schema_version;
        const agents=database.prepare("SELECT id,site_code,warehouse_id FROM users WHERE role='agent' ORDER BY id").all();
        stamp=createHash('sha256').update(JSON.stringify([path,String(file.dev),String(file.ino),String(file.birthtimeNs),schema,revision,agents])).digest('hex');
      }
    }
  } catch {
    // Older schemas can still reuse results while the entire physical source is unchanged.
  }
  // A replacement or commit between path inspection and pinning is ambiguous.
  return before===historyFileGeneration(path) ? stamp : null;
}

export function focusSlipRevision(path: string): string|null {
  const before=historyFileGeneration(path);
  if (!before) return null;
  let database: DatabaseSync|undefined;
  try {
    database=new DatabaseSync(path,{readOnly:true,timeout:50});
    database.exec('BEGIN');
    return pinnedSlipRevision(database,path,before);
  } catch {
    return before===historyFileGeneration(path) ? before : null;
  } finally {
    database?.close();
  }
}

// Read order evidence in the reporting worker; the application connection and
// its session/scope checks stay on the request thread.
export function readFocusSlips(onRevision?: (revision:string|null)=>void): Record<string, FocusDocument[]> {
  const path=resolve(process.env.MOBIUP_DATA_DIR || './work/server-data','mobiup.sqlite');
  const before=onRevision ? historyFileGeneration(path) : null;
  const app=new DatabaseSync(path,{readOnly:true});
  try {
    if (onRevision) {
      app.exec('BEGIN');
      onRevision(pinnedSlipRevision(app,path,before));
    }
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
