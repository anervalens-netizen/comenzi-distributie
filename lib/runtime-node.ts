import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import initialSchema from '@/drizzle/0000_rare_hardball.sql?raw';
import partnerPortfolioSchema from '@/drizzle/0006_partner_portfolio.sql?raw';

import partnerDayPlansSchema from '@/drizzle/0007_partner_day_plans.sql?raw';
import partnerMapIndex from '@/drizzle/0008_partner_map_index.sql?raw';

export const runtimeKind = 'node';
const dataDirectory = resolve(process.env.MOBIUP_DATA_DIR || './work/server-data');
let connection: DatabaseSync | undefined;
function sqlite() {
  if (connection) return connection;
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const candidate = new DatabaseSync(resolve(dataDirectory, 'mobiup.sqlite'));
  try {
    candidate.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (!candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()) {
      candidate.exec('BEGIN IMMEDIATE;');
      try { candidate.exec(initialSchema); candidate.exec('COMMIT;'); }
      catch (error) { candidate.exec('ROLLBACK;'); throw error; }
    }
    const userColumns=candidate.prepare('PRAGMA table_info(users)').all().map(row=>row.name);
    if(!userColumns.includes('warehouse_name'))candidate.exec('ALTER TABLE users ADD COLUMN warehouse_name TEXT');
    if(!userColumns.includes('site_code'))candidate.exec("ALTER TABLE users ADD COLUMN site_code TEXT NOT NULL DEFAULT ''");
    if(!userColumns.includes('manager_scope'))candidate.exec("ALTER TABLE users ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'assigned'");
    if(!userColumns.includes('profile_revision'))candidate.exec("ALTER TABLE users ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 1");
    candidate.exec("UPDATE users SET manager_scope='global' WHERE id='manager' AND role='manager'");
    const hasManagerAgents=!!candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='manager_agents'").get();
    candidate.exec("CREATE TABLE IF NOT EXISTS manager_agents (manager_id TEXT NOT NULL REFERENCES users(id), agent_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(manager_id,agent_id)); CREATE INDEX IF NOT EXISTS idx_manager_agents_agent ON manager_agents(agent_id);");
    if(!hasManagerAgents)candidate.exec("INSERT OR IGNORE INTO manager_agents(manager_id,agent_id) SELECT m.id,a.id FROM users m CROSS JOIN users a WHERE m.role='manager' AND m.manager_scope='assigned' AND m.active=1 AND a.role='agent' AND a.active=1");
    const duplicateSite=candidate.prepare("SELECT UPPER(TRIM(site_code)) siteCode,COUNT(*) count FROM users WHERE role='agent' AND active=1 AND TRIM(site_code)<>'' GROUP BY UPPER(TRIM(site_code)) HAVING COUNT(*)>1 LIMIT 1").get();
    if(duplicateSite)throw new Error(`Duplicate active SiteCode ${String(duplicateSite.siteCode)}; resolve data before startup.`);
    candidate.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_active_site_code_unique ON users(UPPER(TRIM(site_code))) WHERE role='agent' AND active=1 AND TRIM(site_code)<>''");
    candidate.exec("CREATE TABLE IF NOT EXISTS partner_requests (id TEXT PRIMARY KEY NOT NULL,agent_id TEXT NOT NULL REFERENCES users(id),warehouse_id TEXT NOT NULL,cui_key TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,confirmed_at TEXT,confirmed_by TEXT REFERENCES users(id),customer_id TEXT,revision INTEGER NOT NULL DEFAULT 1); CREATE INDEX IF NOT EXISTS idx_partner_requests_agent_created ON partner_requests(agent_id,created_at); CREATE INDEX IF NOT EXISTS idx_partner_requests_status_created ON partner_requests(status,created_at); CREATE INDEX IF NOT EXISTS idx_partner_requests_cui ON partner_requests(cui_key);");
    candidate.exec("CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);");
    candidate.exec(partnerPortfolioSchema);
    candidate.exec(partnerDayPlansSchema);
    candidate.exec(partnerMapIndex);
    connection=candidate;
    return candidate;
  } catch(error) {
    try { candidate.close(); } catch {}
    throw error;
  }
}
class Statement {
  constructor(readonly sql: string, readonly parameters: SQLInputValue[] = []) {}
  bind(...parameters: SQLInputValue[]) { return new Statement(this.sql, parameters); }
  execute() {
    const db = sqlite();
    const results = db.prepare(this.sql).all(...this.parameters);
    const changes = db.prepare('SELECT changes() AS changes').get()!.changes;
    return { success: true, results, meta: { changes: Number(changes) } };
  }
  async all<T = Record<string, unknown>>() { return this.execute() as { success: boolean; results: T[]; meta: { changes: number } }; }
  async first<T = Record<string, unknown>>(column?: string) {
    const row = sqlite().prepare(this.sql).get(...this.parameters);
    return (row ? (column ? row[column] : row) : null) as T | null;
  }
  async run() { return this.execute(); }
}
const database = {
  prepare: (sql: string) => new Statement(sql),
  async batch(statements: Statement[]) {
    const db = sqlite();
    db.exec('BEGIN IMMEDIATE;');
    try { const result = statements.map(statement => statement.execute()); db.exec('COMMIT;'); return result; }
    catch (error) { db.exec('ROLLBACK;'); throw error; }
  },
};
const excelMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function objectPath(key: string) {
  const root = resolve(dataDirectory, 'files');
  const result = resolve(root, key);
  if (!result.startsWith(root + sep) || key.includes('\\')) throw new Error('Invalid export key');
  return result;
}
const files = {
  async get(key: string) {
    try {
      const bytes = await readFile(objectPath(key));
      return { size: bytes.byteLength, body: new Response(bytes).body!, httpMetadata: { contentType: excelMime },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', excelMime) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  },
  async put(key: string, value: Uint8Array | ArrayBuffer) {
    const path = objectPath(key), temporary = path + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, new Uint8Array(value), { mode: 0o600 });
    await rename(temporary, path);
  },
  async delete(key: string) { await rm(objectPath(key), { force: true }); },
};
// The application uses only prepare/batch and get/put/delete from these bindings.
export const env = { DB: database as unknown as D1Database, FILES: files as unknown as R2Bucket };
