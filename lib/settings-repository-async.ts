import type { RequestActorSnapshot } from './authority-repository-async';
import { orderAgentAllowed, withCapturedOrderWrite } from './order-write-authority-async';
import { AccountWriteError, accountClock, captureSessionIdentity, requireSessionInTransaction,
  type AccountRecord, type SessionIdentity } from './session-repository-async';
import { sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader, type SqlWriter } from './sql-database';
import type { ManagerMailSettings, OperationalMailSettings, Order, Settings } from './types';
import { parseWeeklyLimit, persistWeeklyLimit } from './weekly-order-limit';

export type SettingsMailDefaults = Readonly<{ partnerTo: readonly string[]; partnerCc: readonly string[] }>;
export type AppSettingsSnapshot = { cfg: Settings; raw: string | null; stored: Record<string, unknown> };
export type RegionalSettingsSnapshot = { settings: OperationalMailSettings; mixed: boolean; agentIds: string[] };
type Body = Readonly<Record<string, unknown>>;
const emailFields = ['accessoriesEmail', 'standsEmail', 'simEmail'] as const;
const recipientFields = [['accessoriesCc', 4], ['standsCc', 4], ['simCc', 2], ['partnerTo', 2], ['partnerCc', 1]] as const;
const email = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function checkedSchema(value: string): string {
  if (typeof value !== 'string' || !/^"[a-z][a-z0-9_]{0,62}"$/.test(value)
    || sqlIdentifier(value.slice(1, -1)) !== value) throw new Error('Invalid quoted application schema');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid settings text');
  return value;
}
function defaultsCopy(defaults: SettingsMailDefaults): SettingsMailDefaults {
  return { partnerTo: [...defaults.partnerTo], partnerCc: [...defaults.partnerCc] };
}
function bodyCopy(input: Body): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountWriteError(400, 'invalid_settings_body');
  return structuredClone(input);
}
function textField(value: unknown, maximum = 254): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}
async function settingValue(tx: SqlReader, schema: string, key: string): Promise<string | null> {
  const binary = tx.dialect === 'postgresql' && key.includes('\u0000');
  const result = await tx.query(sqlQuery('read', `SELECT value FROM ${schema}.settings WHERE key=?`,
    `SELECT value FROM ${schema}.settings WHERE ${binary ? "convert_to(key,'UTF8')=$1::bytea" : 'key=$1'}`),
  [binary ? new TextEncoder().encode(key) : key]);
  if (result.rows.length > 1) throw new Error('Duplicate settings primary key');
  return result.rows.length ? text(result.rows[0].value) : null;
}

/** Caller authenticates in this SAME transaction. No helper opens another one. */
export async function readAppSettingsSnapshot(tx: SqlReader, quotedSchema: string,
  defaults: SettingsMailDefaults): Promise<AppSettingsSnapshot> {
  const schema = checkedSchema(quotedSchema), captured = defaultsCopy(defaults);
  const raw = await settingValue(tx, schema, 'app');
  // Keep JSON.parse, spreading and the `in` operation exactly as the existing
  // reader: invalid JSON/null/scalars fail; no stored value is silently repaired.
  const stored: Record<string, unknown> = raw === null ? {} : JSON.parse(raw);
  const cfg: Settings = { accessoriesEmail: '', standsEmail: '', simEmail: '', accessoriesCc: [], standsCc: [], simCc: [],
    partnerTo: [...captured.partnerTo], partnerCc: [...captured.partnerCc], ...stored,
    weeklyLimit: parseWeeklyLimit('weeklyLimit' in stored ? stored.weeklyLimit : 0) };
  return { cfg, raw, stored };
}
function operationalSettings(cfg: Settings): OperationalMailSettings {
  return { accessoriesEmail: cfg.accessoriesEmail, standsEmail: cfg.standsEmail, simEmail: cfg.simEmail,
    accessoriesCc: [...cfg.accessoriesCc], standsCc: [...cfg.standsCc], simCc: [...cfg.simCc],
    partnerTo: [...cfg.partnerTo], partnerCc: [...cfg.partnerCc] };
}
function withOperationalOverride(base: Settings, raw: string | null): Settings {
  if (!raw) return base;
  let value: Partial<OperationalMailSettings>;
  try { value = JSON.parse(raw); } catch { return base; }
  const next = { ...base };
  for (const key of emailFields) if (typeof value[key] === 'string') next[key] = value[key]!;
  for (const [key] of recipientFields) {
    if (Array.isArray(value[key]) && value[key]!.every(entry => typeof entry === 'string')) next[key] = [...value[key]!];
  }
  return next;
}
export async function readAgentSettingsSnapshot(tx: SqlReader, quotedSchema: string,
  defaults: SettingsMailDefaults, agentId: string): Promise<Settings> {
  const schema = checkedSchema(quotedSchema), captured = defaultsCopy(defaults), id = text(agentId);
  const { cfg } = await readAppSettingsSnapshot(tx, schema, captured);
  return withOperationalOverride(cfg, await settingValue(tx, schema, 'agent-mail:' + id));
}
export async function readRegionalSettingsSnapshot(tx: SqlReader, quotedSchema: string,
  defaults: SettingsMailDefaults, managerId: string): Promise<RegionalSettingsSnapshot> {
  const schema = checkedSchema(quotedSchema), captured = defaultsCopy(defaults), id = text(managerId);
  const binary = tx.dialect === 'postgresql' && id.includes('\u0000');
  const { cfg } = await readAppSettingsSnapshot(tx, schema, captured);
  const rows = await tx.query(sqlQuery('read',
    `SELECT a.id,s.value FROM ${schema}.manager_agents ma JOIN ${schema}.users a ON a.id=ma.agent_id AND a.role='agent' AND a.active=1 LEFT JOIN ${schema}.settings s ON s.key='agent-mail:'||a.id WHERE ma.manager_id=? ORDER BY a.id COLLATE BINARY`,
    `SELECT a.id,s.value FROM ${schema}.manager_agents ma JOIN ${schema}.users a ON a.id=ma.agent_id AND a.role='agent' AND a.active=1 LEFT JOIN ${schema}.settings s ON s.key='agent-mail:'||a.id WHERE ${binary ? "convert_to(ma.manager_id,'UTF8')=$1::bytea" : 'ma.manager_id=$1'} ORDER BY a.id COLLATE "C"`),
  [binary ? new TextEncoder().encode(id) : id]);
  const routes = rows.rows.map(row => operationalSettings(withOperationalOverride(cfg, row.value === null ? null : text(row.value))));
  const first = routes[0] || operationalSettings(cfg), signature = JSON.stringify(first);
  return { settings: first, mixed: routes.some(route => JSON.stringify(route) !== signature), agentIds: rows.rows.map(row => text(row.id)) };
}
export async function readManagerMailSettingsSnapshot(tx: SqlReader, quotedSchema: string,
  managerId: string): Promise<ManagerMailSettings> {
  const schema = checkedSchema(quotedSchema), id = text(managerId);
  const raw = await settingValue(tx, schema, 'manager-mail:' + id);
  const value: Partial<ManagerMailSettings> = raw === null ? {} : JSON.parse(raw);
  const accessories = typeof value.accessories === 'string' ? value.accessories : '';
  const stands = typeof value.stands === 'string' ? value.stands : '';
  const sim = typeof value.sim === 'string' ? value.sim : '';
  const partner = typeof value.partner === 'string' ? value.partner : accessories || stands || sim;
  return { accessories, stands, sim, partner };
}
export async function readOrderSettingsSnapshot(tx: SqlReader, quotedSchema: string,
  defaults: SettingsMailDefaults, order: Pick<Order, 'userId'>): Promise<Settings> {
  const schema = checkedSchema(quotedSchema), captured = defaultsCopy(defaults), id = text(order.userId);
  const binary = tx.dialect === 'postgresql' && id.includes('\u0000');
  const cfg = await readAgentSettingsSnapshot(tx, schema, captured, id);
  const rows = await tx.query(sqlQuery('read',
    `SELECT s.value FROM ${schema}.manager_agents ma JOIN ${schema}.users m ON m.id=ma.manager_id AND m.role='manager' AND m.active=1 LEFT JOIN ${schema}.settings s ON s.key='manager-mail:'||m.id WHERE ma.agent_id=? ORDER BY m.username COLLATE BINARY`,
    `SELECT s.value FROM ${schema}.manager_agents ma JOIN ${schema}.users m ON m.id=ma.manager_id AND m.role='manager' AND m.active=1 LEFT JOIN ${schema}.settings s ON s.key='manager-mail:'||m.id WHERE ${binary ? "convert_to(ma.agent_id,'UTF8')=$1::bytea" : 'ma.agent_id=$1'} ORDER BY m.username COLLATE "C"`),
  [binary ? new TextEncoder().encode(id) : id]);
  for (const row of rows.rows) {
    if (!row.value) continue;
    let value: Partial<ManagerMailSettings>;
    try { value = JSON.parse(text(row.value)); } catch { continue; }
    if (typeof value.accessories === 'string' && value.accessories) cfg.accessoriesCc = [...new Set([...cfg.accessoriesCc, value.accessories])];
    if (typeof value.stands === 'string' && value.stands) cfg.standsCc = [...new Set([...cfg.standsCc, value.stands])];
    if (typeof value.sim === 'string' && value.sim) cfg.simCc = [...new Set([...cfg.simCc, value.sim])];
  }
  return cfg;
}
function requireManager(user: AccountRecord, globalOnly = false): void {
  if (user.role !== 'manager' || globalOnly && user.managerScope !== 'global') throw new AccountWriteError(403, 'manager_scope_required');
}
function applyOperationalInput<T extends OperationalMailSettings>(cfg: T, body: Record<string, unknown>, optionalEmails: boolean): T {
  for (const key of emailFields) {
    if (optionalEmails && body[key] === undefined) continue;
    const value = textField(body[key]);
    if (value && !email.test(value)) throw new AccountWriteError(400, 'invalid_settings_email');
    cfg[key] = value;
  }
  for (const [key, limit] of recipientFields) {
    if (body[key] === undefined) continue;
    const entries = body[key];
    if (!Array.isArray(entries) || entries.length > limit) throw new AccountWriteError(400, 'invalid_recipient_count');
    const recipients: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.length > 254) throw new AccountWriteError(400, 'invalid_settings_email');
      const value = entry.trim();
      if (value && !email.test(value)) throw new AccountWriteError(400, 'invalid_settings_email');
      recipients.push(value);
    }
    cfg[key] = recipients;
  }
  if (!cfg.partnerTo.some(Boolean)) throw new AccountWriteError(400, 'partner_recipient_required');
  return cfg;
}
async function upsert(tx: SqlWriter, schema: string, key: string, value: string): Promise<void> {
  const result = await tx.query(sqlQuery('write',
    `INSERT INTO ${schema}.settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    `INSERT INTO ${schema}.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`), [key, value]);
  if (result.changes !== 1) throw new Error('Settings write did not persist exactly one row');
}

/** Prepared application operations only. HTTP and runtime selection are unchanged. */
export class SettingsRepository {
  private readonly schema: string;
  private readonly defaults: SettingsMailDefaults;
  constructor(private readonly database: AsyncSqlDatabase, private readonly applicationSchema: string,
    defaults: SettingsMailDefaults, private readonly clock: () => number = Date.now) {
    this.schema = sqlIdentifier(applicationSchema); this.defaults = defaultsCopy(defaults);
  }
  private read<T>(identity: SessionIdentity, action: (tx: SqlReader, user: AccountRecord) => Promise<T>): Promise<T> {
    const captured = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const { user } = await requireSessionInTransaction(tx, this.schema, captured, accountClock(this.clock));
      if (user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
      return action(tx, user);
    });
  }
  readAppSettings(identity: SessionIdentity): Promise<AppSettingsSnapshot> {
    return this.read(identity, tx => readAppSettingsSnapshot(tx, this.schema, this.defaults));
  }
  async settings(identity: SessionIdentity): Promise<Settings> { return (await this.readAppSettings(identity)).cfg; }
  settingsForAgent(identity: SessionIdentity, agentId: string): Promise<Settings> {
    const id = text(agentId);
    return this.read(identity, async (tx, user) => {
      if (!await orderAgentAllowed(tx, this.schema, user, id, true)) throw new AccountWriteError(403, 'agent_outside_scope');
      return readAgentSettingsSnapshot(tx, this.schema, this.defaults, id);
    });
  }
  regionalOperationalSettings(identity: SessionIdentity): Promise<RegionalSettingsSnapshot> {
    return this.read(identity, async (tx, user) => { requireManager(user); return readRegionalSettingsSnapshot(tx, this.schema, this.defaults, user.id); });
  }
  managerMailSettings(identity: SessionIdentity): Promise<ManagerMailSettings> {
    return this.read(identity, async (tx, user) => { requireManager(user); return readManagerMailSettingsSnapshot(tx, this.schema, user.id); });
  }
  settingsForOrder(identity: SessionIdentity, order: Pick<Order, 'userId'>): Promise<Settings> {
    const id = text(order.userId);
    return this.read(identity, async (tx, user) => {
      if (!await orderAgentAllowed(tx, this.schema, user, id, true)) throw new AccountWriteError(403, 'agent_outside_scope');
      return readOrderSettingsSnapshot(tx, this.schema, this.defaults, { userId: id });
    });
  }
  updateAppSettings(identity: RequestActorSnapshot, input: Body): Promise<{ settings: Settings }> {
    const body = bodyCopy(input);
    return withCapturedOrderWrite(this.database, this.applicationSchema, identity, async (tx, user) => {
      requireManager(user, true);
      const weeklyLimit = parseWeeklyLimit(body.weeklyLimit);
      if (weeklyLimit === null) throw new AccountWriteError(400, 'invalid_weekly_limit');
      const { cfg, raw, stored } = await readAppSettingsSnapshot(tx, this.schema, this.defaults);
      let encoded: string, resultSettings: Settings;
      if (cfg.weeklyLimit === null) {
        const keys = Object.keys(body);
        if (body.repairWeeklyLimit !== true || keys.length !== 2 || keys.some(key => key !== 'weeklyLimit' && key !== 'repairWeeklyLimit')) {
          throw new AccountWriteError(409, 'explicit_weekly_limit_repair_required');
        }
        encoded = JSON.stringify({ ...stored, weeklyLimit: persistWeeklyLimit(weeklyLimit) });
        resultSettings = { ...cfg, weeklyLimit };
      } else {
        if (body.repairWeeklyLimit !== undefined) throw new AccountWriteError(409, 'weekly_limit_already_repaired');
        cfg.weeklyLimit = weeklyLimit;
        applyOperationalInput(cfg, body, false);
        encoded = JSON.stringify({ ...stored, ...cfg, weeklyLimit: persistWeeklyLimit(weeklyLimit) }); resultSettings = cfg;
      }
      const result = raw === null
        ? await tx.query(sqlQuery('write', `INSERT INTO ${this.schema}.settings(key,value) VALUES('app',?) ON CONFLICT(key) DO NOTHING`,
          `INSERT INTO ${this.schema}.settings(key,value) VALUES('app',$1) ON CONFLICT(key) DO NOTHING`), [encoded])
        : await tx.query(sqlQuery('write', `UPDATE ${this.schema}.settings SET value=? WHERE key='app' AND value=?`,
          `UPDATE ${this.schema}.settings SET value=$1 WHERE key='app' AND value=$2`), [encoded, raw]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'settings_changed');
      return { settings: resultSettings };
    }, this.clock);
  }
  updateRegionalSettings(identity: RequestActorSnapshot, input: Body): Promise<{ regionalSettings: OperationalMailSettings; regionalSettingsMixed: false }> {
    const body = bodyCopy(input);
    return withCapturedOrderWrite(this.database, this.applicationSchema, identity, async (tx, user) => {
      requireManager(user);
      if (user.managerScope === 'global') throw new AccountWriteError(403, 'regional_manager_required');
      const regional = await readRegionalSettingsSnapshot(tx, this.schema, this.defaults, user.id);
      if (!regional.agentIds.length) throw new AccountWriteError(409, 'active_assigned_agents_required');
      const next = applyOperationalInput(operationalSettings({ ...regional.settings, weeklyLimit: null }), body, true);
      const stored = JSON.stringify(next);
      for (const id of regional.agentIds) await upsert(tx, this.schema, 'agent-mail:' + id, stored);
      return { regionalSettings: next, regionalSettingsMixed: false };
    }, this.clock);
  }
  updateManagerMailSettings(identity: RequestActorSnapshot, input: Body): Promise<{ managerMailSettings: ManagerMailSettings }> {
    const body = bodyCopy(input);
    return withCapturedOrderWrite(this.database, this.applicationSchema, identity, async (tx, user) => {
      requireManager(user);
      const next = await readManagerMailSettingsSnapshot(tx, this.schema, user.id);
      for (const key of ['accessories', 'stands', 'sim', 'partner'] as const) {
        const value = textField(body[key]);
        if (value && !email.test(value)) throw new AccountWriteError(400, 'invalid_settings_email');
        next[key] = value;
      }
      await upsert(tx, this.schema, 'manager-mail:' + user.id, JSON.stringify(next));
      return { managerMailSettings: next };
    }, this.clock);
  }
}
