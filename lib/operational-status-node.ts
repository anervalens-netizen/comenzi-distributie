import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function inspect<T>(path: string, read: (db: DatabaseSync) => T) {
  if (!existsSync(path)) return { state: 'missing' as const };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
    return { state: 'available' as const, ...read(db) };
  } catch {
    // Raw SQLite errors and source filenames can contain private paths/data.
    return { state: 'error' as const, errorCode: 'READ_FAILED' as const };
  } finally { db?.close(); }
}

const dateOnly = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : null;

/** A snapshot of persisted metadata only: no seeding, rebuild, job recovery or writes. */
export function operationalStatus(directory = resolve(process.env.MOBIUP_DATA_DIR || './work/server-data')) {
  return {
    observedAt: new Date().toISOString(),
    history: inspect(resolve(directory, 'client-history/client-sales-history.sqlite'), db => {
      const row = db.prepare("SELECT COUNT(*) imports,MAX(imported_at) imported_at,MIN(period_start) period_start,MAX(period_end) period_end FROM history_imports WHERE state='active'").get()!;
      return { activeImports: Number(row.imports), lastImportedAt: timestamp(row.imported_at), from: dateOnly(row.period_start), through: dateOnly(row.period_end) };
    }),
    portfolio: inspect(resolve(directory, 'mobiup.sqlite'), db => {
      const row = db.prepare('SELECT data_revision,scope_revision,(SELECT COUNT(*) FROM portfolio_dirty) pending,(SELECT version FROM portfolio_model_state WHERE id=1) version FROM portfolio_revision WHERE id=1').get();
      if (!row) throw new Error('Missing projection metadata');
      return { state: !row.version ? 'uninitialized' : Number(row.pending) ? 'stale' : 'current', dataRevision: Number(row.data_revision), scopeRevision: Number(row.scope_revision), pendingRows: Number(row.pending) };
    }),
    // The backup service owns offsite success; HTTP liveness cannot certify it.
    backup: { state: 'external' as const },
  };
}
