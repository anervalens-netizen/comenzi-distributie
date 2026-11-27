import { canViewActivations } from './activation-access';
import { customerWarehouseCountKeys } from './customer-membership-json';
import { AccountWriteError, accountClock, accountRecord, captureSessionIdentity,
  requireSessionInTransaction, type AccountRecord, type SessionIdentity } from './session-repository-async';
import { safeSqlInteger, sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader } from './sql-database';
import type { User, Warehouse } from './types';

function checkedSchema(value: string): string {
  if (typeof value !== 'string' || !/^"[a-z][a-z0-9_]{0,62}"$/.test(value)
    || sqlIdentifier(value.slice(1, -1)) !== value) throw new Error('Invalid quoted application schema');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid user/customer text');
  return value;
}

/**
 * Caller-owned coherent snapshot, usable inside an existing writer transaction.
 * The caller authenticates the viewer in this SAME transaction. This helper
 * preserves the existing read scope; it grants no mutation authority.
 */
export async function readUsersWithClientCounts(tx: SqlReader, quotedSchema: string,
  viewer: AccountRecord, warehouses: readonly Warehouse[]): Promise<User[]> {
  const schema = checkedSchema(quotedSchema), actor = Object.freeze({ ...viewer }), seed = structuredClone(warehouses);
  const filter = actor.role === 'manager' ? ''
    : ` WHERE u.id=? OR EXISTS (SELECT 1 FROM ${schema}.manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=u.id)`;
  const pgFilter = actor.role === 'manager' ? ''
    : ` WHERE u.id=$1 OR EXISTS (SELECT 1 FROM ${schema}.manager_agents ma WHERE ma.manager_id=$2 AND ma.agent_id=u.id)`;
  const users = await tx.query(sqlQuery('read',
    `SELECT u.* FROM ${schema}.users u${filter} ORDER BY u.role COLLATE BINARY DESC,u.name COLLATE BINARY`,
    `SELECT u.* FROM ${schema}.users u${pgFilter} ORDER BY u.role COLLATE "C" DESC,u.name COLLATE "C"`),
  actor.role === 'manager' ? [] : [actor.id, actor.id]);
  const assignments = await tx.query(sqlQuery('read',
    `SELECT manager_id,agent_id FROM ${schema}.manager_agents ORDER BY manager_id COLLATE BINARY,agent_id COLLATE BINARY`,
    `SELECT manager_id,agent_id FROM ${schema}.manager_agents ORDER BY manager_id COLLATE "C",agent_id COLLATE "C"`));
  const customers = await tx.query(sqlQuery('read',
    `SELECT id,warehouse_id,data FROM ${schema}.customers WHERE active=1`,
    `SELECT id,warehouse_id,data FROM ${schema}.customers WHERE active=1`));
  const counts = new Map<string, number>();
  for (const row of customers.rows) {
    const keys = new Set(customerWarehouseCountKeys(text(row.data), row.warehouse_id === null ? null : text(row.warehouse_id)));
    // Each primary-key customer contributes once per CAST key. NULL never joins
    // a user warehouse, including another NULL; an empty string still does.
    for (const key of keys) if (key !== null) {
      const next = (counts.get(key) ?? 0) + 1;
      safeSqlInteger(next); counts.set(key, next);
    }
  }
  return users.rows.map(row => {
    const user = accountRecord(row);
    const base: User = { canViewActivations: canViewActivations({ id: user.id, role: user.role, active: Number(user.active) }),
      id: user.id, username: user.username, name: user.name, role: user.role as User['role'], managerScope: user.managerScope,
      warehouseId: user.warehouseId, warehouseName: user.warehouseName || seed.find(w => w.id === user.warehouseId)?.name || null,
      siteCode: user.siteCode, profileVersion: String(user.profileVersion), mustChangePassword: user.mustChangePassword,
      active: Number(user.active), clientCount: user.warehouseId === null ? 0 : counts.get(user.warehouseId) ?? 0 };
    if (user.role !== 'manager') return base;
    return { ...base, managedAgentIds: assignments.rows.filter(item => item.manager_id === user.id).map(item => text(item.agent_id)) };
  });
}

/** Prepared reads only; HTTP, mutators and backend selection remain separate. */
export class UserReadRepository {
  private readonly schema: string;
  private readonly warehouses: readonly Warehouse[];
  constructor(private readonly database: AsyncSqlDatabase, applicationSchema: string,
    warehouses: readonly Warehouse[], private readonly clock: () => number = Date.now) {
    this.schema = sqlIdentifier(applicationSchema); this.warehouses = structuredClone(warehouses);
  }
  getUsers(identity: SessionIdentity, managerOnly = false): Promise<User[]> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const { user } = await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock));
      if (user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
      if (managerOnly && user.role !== 'manager') throw new AccountWriteError(403, 'manager_required');
      return readUsersWithClientCounts(tx, this.schema, user, this.warehouses);
    });
  }
}
