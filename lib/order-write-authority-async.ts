import type { RequestActorSnapshot } from './authority-repository-async';
import { AccountWriteError, accountClock, accountRevision, captureSessionIdentity,
  requireSessionInTransaction, type AccountRecord } from './session-repository-async';
import { sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader,
  type SqlWriter } from './sql-database';

/** Internal request snapshot, captured before an asynchronous HTTP body read. */
function capture(actor: RequestActorSnapshot): RequestActorSnapshot {
  const identity = captureSessionIdentity(actor);
  accountRevision(actor.profileVersion);
  accountRevision(actor.scopeRevision);
  if (!['manager', 'agent'].includes(actor.role)
    || actor.warehouseId !== null && typeof actor.warehouseId !== 'string'
    || !['global', 'assigned'].includes(actor.managerScope)
    || typeof actor.mustChangePassword !== 'boolean') {
    throw new AccountWriteError(409, 'request_authority_changed');
  }
  return Object.freeze({ ...identity, profileVersion: actor.profileVersion, role: actor.role,
    warehouseId: actor.warehouseId, managerScope: actor.managerScope,
    mustChangePassword: actor.mustChangePassword, scopeRevision: actor.scopeRevision });
}

/** No second connection or transaction: every query uses the supplied reader. */
export async function requireOrderWriteActor(tx: SqlReader, quotedSchema: string,
  actor: RequestActorSnapshot, clock: () => number): Promise<AccountRecord> {
  let user: AccountRecord;
  try {
    user = (await requireSessionInTransaction(tx, quotedSchema, actor, accountClock(clock))).user;
  } catch (error) {
    if (error instanceof AccountWriteError && error.status === 401) {
      throw new AccountWriteError(409, 'request_authority_changed');
    }
    throw error;
  }
  const generations = await tx.query(sqlQuery('read',
    'SELECT scope_revision FROM ' + quotedSchema + '.portfolio_revision WHERE id=1',
    'SELECT scope_revision FROM ' + quotedSchema + '.portfolio_revision WHERE id=1'));
  if (generations.rows.length !== 1) throw new Error('Missing portfolio authority generation');
  if (user.profileVersion !== actor.profileVersion || user.role !== actor.role
    || user.warehouseId !== actor.warehouseId
    || user.role === 'manager' && (user.managerScope !== actor.managerScope
      || user.mustChangePassword !== actor.mustChangePassword)
    || accountRevision(generations.rows[0].scope_revision) !== actor.scopeRevision) {
    throw new AccountWriteError(409, 'request_authority_changed');
  }
  if (user.role !== 'agent' && user.role !== 'manager') throw new AccountWriteError(403, 'order_role_required');
  if (user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
  return user;
}

export async function orderAgentAllowed(tx: SqlReader, quotedSchema: string,
  user: AccountRecord, agentId: string, nationalRead = false): Promise<boolean> {
  if (user.role === 'agent') return user.id === agentId;
  if (user.role !== 'manager') return false;
  if (nationalRead || user.managerScope === 'global') return true;
  const result = await tx.query(sqlQuery('read',
    'SELECT 1 AS allowed FROM ' + quotedSchema + '.manager_agents WHERE manager_id=? AND agent_id=?',
    'SELECT 1 AS allowed FROM ' + quotedSchema + '.manager_agents WHERE manager_id=$1 AND agent_id=$2'),
  [user.id, agentId]);
  return result.rows.length === 1;
}

/**
 * Draft operations do not change account authority. Unlike password/logout
 * mutators, they therefore retain the complete captured pre/post check.
 * All revokers and business writers must use this adapter's shared writer lock.
 */
export function withCapturedOrderWrite<T>(database: AsyncSqlDatabase, applicationSchema: string,
  identity: RequestActorSnapshot, action: (tx: SqlWriter, actor: AccountRecord) => Promise<T>,
  clock: () => number = Date.now): Promise<T> {
  const schema = sqlIdentifier(applicationSchema), actor = capture(identity);
  const authority = async (tx: SqlReader) => { await requireOrderWriteActor(tx, schema, actor, clock); };
  return database.write(async tx => action(tx, await requireOrderWriteActor(tx, schema, actor, clock)), authority);
}
