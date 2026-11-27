import { safeSqlInteger, sqlQuery, type SqlReader, type SqlWriter } from './sql-database';
import { AccountWriteError, SessionRepository, accountClock, accountRecord, accountRevision,
  captureSessionIdentity, preparedPasswordHash, requireSessionInTransaction,
  type AccountRecord, type SessionIdentity } from './session-repository-async';

/** Mirrors captureRequestAuthority for admin routes; auth routes do not use it. */
export type RequestActorSnapshot = SessionIdentity & Readonly<{
  profileVersion: number; role: string; warehouseId: string | null;
  managerScope: 'assigned' | 'global'; mustChangePassword: boolean; scopeRevision: number;
}>;
type ManagerInput = Readonly<{ username: string; name: string; agentIds: readonly string[] }>;
type ManagerCreate = ManagerInput & Readonly<{ id: string; passwordHash: string }>;
type ManagerUpdate = ManagerInput & Readonly<{ target: AccountRecord; passwordHash?: string }>;
type AgentProfile = Readonly<{ name: string; warehouseName: string; siteCode: string }>;

function normalized(value: string, maximum: number, optional = false): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > maximum || !optional && !value) {
    throw new AccountWriteError(400, 'invalid_account_input');
  }
  return value;
}
function username(value: string): string {
  if (!/^[a-z0-9._-]{3,80}$/.test(value)) throw new AccountWriteError(400, 'invalid_username');
  return value;
}
function assignments(values: readonly string[]): readonly string[] {
  const result = [...new Set(values.map(id => normalized(id, 256)))];
  if (result.length > 100) throw new AccountWriteError(400, 'too_many_assignments');
  return Object.freeze(result);
}
function capturedActor(actor: RequestActorSnapshot): RequestActorSnapshot {
  captureSessionIdentity(actor);
  accountRevision(actor.profileVersion);
  accountRevision(actor.scopeRevision);
  return Object.freeze({ ...actor });
}
function capturedTarget(target: AccountRecord, role: 'manager' | 'agent'): AccountRecord {
  accountRevision(target.profileVersion);
  if (!target.id || target.role !== role) throw new AccountWriteError(400, 'invalid_target');
  return Object.freeze({ ...target });
}

/** Every public mutator owns one writer lock. Helpers use the supplied tx only. */
export class AuthorityRepository extends SessionRepository {
  readAccount(id: string): Promise<AccountRecord | null> {
    return this.database.read(async tx => {
      const result = await tx.query(sqlQuery('read', 'SELECT * FROM ' + this.schema + '.users WHERE id=?',
        'SELECT * FROM ' + this.schema + '.users WHERE id=$1'), [id]);
      return result.rows.length === 1 ? accountRecord(result.rows[0]) : null;
    });
  }

  captureRequestActor(identity: SessionIdentity): Promise<RequestActorSnapshot> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const { user } = await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock));
      if (user.role === 'manager' && user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
      return Object.freeze({ ...actor, profileVersion: user.profileVersion, role: user.role,
        warehouseId: user.warehouseId, managerScope: user.managerScope, mustChangePassword: user.mustChangePassword,
        scopeRevision: await this.scopeRevision(tx) });
    });
  }

  private async scopeRevision(tx: SqlReader): Promise<number> {
    const result = await tx.query(sqlQuery('read', 'SELECT scope_revision FROM ' + this.schema + '.portfolio_revision WHERE id=1',
      'SELECT scope_revision FROM ' + this.schema + '.portfolio_revision WHERE id=1'));
    if (result.rows.length !== 1) throw new Error('Missing portfolio authority generation');
    return accountRevision(result.rows[0].scope_revision);
  }

  private async requireActor(tx: SqlReader, actor: RequestActorSnapshot, globalOnly: boolean,
    agentId?: string): Promise<AccountRecord> {
    let user: AccountRecord;
    try { user = (await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock))).user; }
    catch (error) {
      if (error instanceof AccountWriteError && error.status === 401) throw new AccountWriteError(409, 'request_authority_changed');
      throw error;
    }
    if (user.profileVersion !== actor.profileVersion || user.role !== actor.role || user.warehouseId !== actor.warehouseId
      || user.role === 'manager' && (user.managerScope !== actor.managerScope || user.mustChangePassword !== actor.mustChangePassword)
      || await this.scopeRevision(tx) !== actor.scopeRevision) throw new AccountWriteError(409, 'request_authority_changed');
    if (user.role !== 'manager' || globalOnly && user.managerScope !== 'global') throw new AccountWriteError(403, 'manager_scope_required');
    if (user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
    if (agentId !== undefined && user.managerScope !== 'global') {
      const assignment = await tx.query(sqlQuery('read',
        'SELECT 1 AS allowed FROM ' + this.schema + '.manager_agents WHERE manager_id=? AND agent_id=?',
        'SELECT 1 AS allowed FROM ' + this.schema + '.manager_agents WHERE manager_id=$1 AND agent_id=$2'), [user.id, agentId]);
      if (assignment.rows.length !== 1) throw new AccountWriteError(403, 'agent_outside_scope');
    }
    return user;
  }

  private async requireTarget(tx: SqlReader, expected: AccountRecord): Promise<AccountRecord> {
    const result = await tx.query(sqlQuery('read', 'SELECT * FROM ' + this.schema + '.users WHERE id=? AND role=?',
      'SELECT * FROM ' + this.schema + '.users WHERE id=$1 AND role=$2'), [expected.id, expected.role]);
    if (result.rows.length !== 1) throw new AccountWriteError(404, 'account_not_found');
    const target = accountRecord(result.rows[0]);
    if (target.profileVersion !== expected.profileVersion || target.managerScope !== expected.managerScope) {
      throw new AccountWriteError(409, 'account_changed');
    }
    return target;
  }

  private async finalActorSession(tx: SqlReader, actor: SessionIdentity): Promise<void> {
    // A PG callback can yield during assignment/cleanup queries. Recheck expiry
    // before commit, but not the profile/generation intentionally changed here.
    try { await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock)); }
    catch (error) {
      if (error instanceof AccountWriteError && error.status === 401) throw new AccountWriteError(409, 'request_authority_changed');
      throw error;
    }
  }

  private async availableUsername(tx: SqlReader, value: string, exceptId: string): Promise<void> {
    const result = await tx.query(sqlQuery('read', 'SELECT id FROM ' + this.schema + '.users WHERE username=? AND id<>?',
      'SELECT id FROM ' + this.schema + '.users WHERE username=$1 AND id<>$2'), [value, exceptId]);
    if (result.rows.length) throw new AccountWriteError(409, 'username_in_use');
  }

  private async requireActiveAgents(tx: SqlReader, agentIds: readonly string[]): Promise<void> {
    if (!agentIds.length) return;
    const result = await tx.query(sqlQuery('read', "SELECT id FROM " + this.schema + ".users WHERE role='agent' AND active=1",
      "SELECT id FROM " + this.schema + ".users WHERE role='agent' AND active=1"));
    const allowed = new Set(result.rows.map(row => row.id));
    if (agentIds.some(id => !allowed.has(id))) throw new AccountWriteError(400, 'agent_not_active');
  }

  private async putAssignments(tx: SqlWriter, managerId: string, agentIds: readonly string[]): Promise<void> {
    await tx.query(sqlQuery('write', 'DELETE FROM ' + this.schema + '.manager_agents WHERE manager_id=?',
      'DELETE FROM ' + this.schema + '.manager_agents WHERE manager_id=$1'), [managerId]);
    for (const agentId of agentIds) {
      const result = await tx.query(sqlQuery('write', 'INSERT INTO ' + this.schema + '.manager_agents(manager_id,agent_id) VALUES(?,?)',
        'INSERT INTO ' + this.schema + '.manager_agents(manager_id,agent_id) VALUES($1,$2)'), [managerId, agentId]);
      if (result.changes !== 1) throw new Error('Assignment insert did not persist');
    }
  }

  private async clearAccountAttempts(tx: SqlWriter, names: readonly string[]): Promise<void> {
    for (const name of new Set(names)) await tx.query(sqlQuery('write', 'DELETE FROM ' + this.schema + '.login_attempts WHERE key=?',
      'DELETE FROM ' + this.schema + '.login_attempts WHERE key=$1'), ['account:' + name]);
  }

  createManager(identity: RequestActorSnapshot, input: ManagerCreate): Promise<void> {
    const actor = capturedActor(identity), id = normalized(input.id, 256), name = normalized(input.name, 100);
    const login = username(input.username), passwordHash = preparedPasswordHash(input.passwordHash), agentIds = assignments(input.agentIds);
    return this.database.write(async tx => {
      await this.requireActor(tx, actor, true);
      await this.availableUsername(tx, login, id);
      await this.requireActiveAgents(tx, agentIds);
      const result = await tx.query(sqlQuery('write',
        'INSERT INTO ' + this.schema + ".users(id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,'manager','assigned',NULL,?,0,1,1)",
        'INSERT INTO ' + this.schema + ".users(id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,active,profile_revision) VALUES($1,$2,$3,'manager','assigned',NULL,$4,0,1,1)"),
      [id, login, name, passwordHash]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      await this.putAssignments(tx, id, agentIds);
      await this.finalActorSession(tx, actor);
    });
  }

  updateManager(identity: RequestActorSnapshot, input: ManagerUpdate): Promise<void> {
    const actor = capturedActor(identity), expected = capturedTarget(input.target, 'manager');
    const login = username(input.username), name = normalized(input.name, 100);
    const passwordHash = input.passwordHash === undefined ? undefined : preparedPasswordHash(input.passwordHash);
    const agentIds = expected.managerScope === 'global' ? [] : assignments(input.agentIds);
    return this.database.write(async tx => {
      await this.requireActor(tx, actor, true);
      const current = await this.requireTarget(tx, expected);
      if (current.managerScope === 'global' && current.id !== actor.userId) throw new AccountWriteError(403, 'own_global_account_required');
      await this.availableUsername(tx, login, current.id);
      await this.requireActiveAgents(tx, agentIds);
      const result = passwordHash === undefined
        ? await tx.query(sqlQuery('write',
          'UPDATE ' + this.schema + ".users SET username=?,name=?,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=? AND role='manager' AND manager_scope=?",
          'UPDATE ' + this.schema + ".users SET username=$1,name=$2,profile_revision=profile_revision+1 WHERE id=$3 AND profile_revision=$4 AND role='manager' AND manager_scope=$5"),
        [login, name, current.id, expected.profileVersion, expected.managerScope])
        : await tx.query(sqlQuery('write',
          'UPDATE ' + this.schema + ".users SET username=?,name=?,password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=? AND role='manager' AND manager_scope=?",
          'UPDATE ' + this.schema + ".users SET username=$1,name=$2,password_hash=$3,must_change_password=0,profile_revision=profile_revision+1 WHERE id=$4 AND profile_revision=$5 AND role='manager' AND manager_scope=$6"),
        [login, name, passwordHash, current.id, expected.profileVersion, expected.managerScope]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      // A successful statement's exact row count replaces the legacy settings proof-key.
      if (current.managerScope === 'assigned') await this.putAssignments(tx, current.id, agentIds);
      if (passwordHash !== undefined || login !== current.username) {
        await this.clearAccountAttempts(tx, [current.username, login]);
        await this.deleteOtherSessions(tx, current.id, current.id === actor.userId ? actor.tokenHash : undefined);
      }
      await this.finalActorSession(tx, actor);
    });
  }

  updateAgentCredentials(identity: RequestActorSnapshot, target: AccountRecord, loginName: string,
    newPasswordHash: string): Promise<void> {
    const actor = capturedActor(identity), expected = capturedTarget(target, 'agent');
    const login = username(loginName), passwordHash = preparedPasswordHash(newPasswordHash);
    return this.database.write(async tx => {
      await this.requireActor(tx, actor, false, expected.id);
      const current = await this.requireTarget(tx, expected);
      await this.availableUsername(tx, login, current.id);
      const result = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".users SET username=?,password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=? AND role='agent'",
        'UPDATE ' + this.schema + ".users SET username=$1,password_hash=$2,must_change_password=0,profile_revision=profile_revision+1 WHERE id=$3 AND profile_revision=$4 AND role='agent'"),
      [login, passwordHash, current.id, expected.profileVersion]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      // Preserve the current route's old-username-only counter cleanup.
      await this.clearAccountAttempts(tx, [current.username]);
      await this.deleteOtherSessions(tx, current.id);
      await this.finalActorSession(tx, actor);
    });
  }

  resetAgentPassword(identity: RequestActorSnapshot, target: AccountRecord, newPasswordHash: string): Promise<void> {
    const actor = capturedActor(identity), expected = capturedTarget(target, 'agent'), passwordHash = preparedPasswordHash(newPasswordHash);
    if (expected.id === actor.userId) throw new AccountWriteError(400, 'own_password_route_required');
    return this.database.write(async tx => {
      await this.requireActor(tx, actor, false, expected.id);
      const current = await this.requireTarget(tx, expected);
      const result = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".users SET password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=? AND role='agent'",
        'UPDATE ' + this.schema + ".users SET password_hash=$1,must_change_password=0,profile_revision=profile_revision+1 WHERE id=$2 AND profile_revision=$3 AND role='agent'"),
      [passwordHash, current.id, expected.profileVersion]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      await this.clearAccountAttempts(tx, [current.username]);
      await this.deleteOtherSessions(tx, current.id);
      await this.finalActorSession(tx, actor);
    });
  }

  private async requireUniqueSite(tx: SqlReader, id: string, site: string): Promise<void> {
    if (!site.trim()) return;
    // SQLite's built-in UPPER folds ASCII only; explicit PG TRANSLATE preserves
    // that behavior for existing non-ASCII site codes, independently of locale.
    const result = await tx.query(sqlQuery('read',
      'SELECT id FROM ' + this.schema + ".users WHERE role='agent' AND active=1 AND id<>? AND UPPER(TRIM(site_code))=UPPER(TRIM(?)) LIMIT 1",
      'SELECT id FROM ' + this.schema + ".users WHERE role='agent' AND active=1 AND id<>$1 AND TRANSLATE(TRIM(site_code),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') COLLATE \"C\"=TRANSLATE(TRIM($2::text),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') COLLATE \"C\" LIMIT 1"), [id, site]);
    if (result.rows.length) throw new AccountWriteError(409, 'site_code_in_use');
  }

  updateAgentProfile(identity: RequestActorSnapshot, target: AccountRecord, input: AgentProfile): Promise<void> {
    const actor = capturedActor(identity), expected = capturedTarget(target, 'agent');
    const name = normalized(input.name, 100), warehouseName = normalized(input.warehouseName, 200), siteCode = normalized(input.siteCode, 80, true);
    return this.database.write(async tx => {
      const currentActor = await this.requireActor(tx, actor, false, expected.id), current = await this.requireTarget(tx, expected);
      if (currentActor.managerScope !== 'global' && siteCode !== current.siteCode) throw new AccountWriteError(403, 'site_code_requires_global_manager');
      await this.requireUniqueSite(tx, current.id, siteCode);
      const result = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".users SET name=?,warehouse_name=?,site_code=?,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=? AND role='agent'",
        'UPDATE ' + this.schema + ".users SET name=$1,warehouse_name=$2,site_code=$3,profile_revision=profile_revision+1 WHERE id=$4 AND profile_revision=$5 AND role='agent'"),
      [name, warehouseName, siteCode, current.id, expected.profileVersion]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      await this.finalActorSession(tx, actor);
      // Profile-only changes intentionally preserve device sessions.
    });
  }

  toggleAgentActive(identity: RequestActorSnapshot, target: AccountRecord): Promise<void> {
    const actor = capturedActor(identity), expected = capturedTarget(target, 'agent');
    if (expected.id === actor.userId) throw new AccountWriteError(400, 'cannot_toggle_self');
    return this.database.write(async tx => {
      await this.requireActor(tx, actor, false, expected.id);
      const current = await this.requireTarget(tx, expected);
      if (!current.active) await this.requireUniqueSite(tx, current.id, current.siteCode);
      const result = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".users SET active=1-active,profile_revision=profile_revision+1 WHERE id=? AND profile_revision=? AND role='agent' AND active=?",
        'UPDATE ' + this.schema + ".users SET active=1-active,profile_revision=profile_revision+1 WHERE id=$1 AND profile_revision=$2 AND role='agent' AND active=$3"),
      [current.id, expected.profileVersion, Number(current.active)]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      await this.deleteOtherSessions(tx, current.id);
      await this.finalActorSession(tx, actor);
    });
  }

  createAgent(identity: RequestActorSnapshot, input: Readonly<{ id: string; username: string; name: string;
    warehouseId: string; passwordHash: string }>, allowedWarehouseIds: readonly string[]): Promise<void> {
    const actor = capturedActor(identity), id = normalized(input.id, 256), login = username(input.username), name = normalized(input.name, 100);
    const warehouseId = normalized(input.warehouseId, 256), passwordHash = preparedPasswordHash(input.passwordHash);
    // This allowlist comes from the existing server-side catalog, never the HTTP body.
    if (!allowedWarehouseIds.includes(warehouseId)) throw new AccountWriteError(400, 'invalid_warehouse');
    return this.database.write(async tx => {
      await this.requireActor(tx, actor, true);
      await this.availableUsername(tx, login, id);
      const result = await tx.query(sqlQuery('write',
        'INSERT INTO ' + this.schema + ".users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,'agent',?,?,0,1,1)",
        'INSERT INTO ' + this.schema + ".users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,profile_revision) VALUES($1,$2,$3,'agent',$4,$5,0,1,1)"),
      [id, login, name, warehouseId, passwordHash]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      await this.finalActorSession(tx, actor);
    });
  }

  /** Explicit startup migration only. No generic role/scope mutation API. */
  initializeSeedManagerScope(): Promise<number> {
    return this.database.write(async tx => {
      accountClock(this.clock);
      const result = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".users SET manager_scope='global' WHERE id='manager' AND role='manager' AND manager_scope IS NOT 'global'",
        'UPDATE ' + this.schema + ".users SET manager_scope='global' WHERE id='manager' AND role='manager' AND manager_scope IS DISTINCT FROM 'global'"));
      return result.changes;
    });
  }

  /** Invoke ONLY inside the one-time migration that creates manager_agents.
   * Table creation/migration versioning remains outside this repository. */
  initializeAssignmentsForNewTable(): Promise<number> {
    return this.database.write(async tx => {
      accountClock(this.clock);
      const existing = await tx.query(sqlQuery('read', 'SELECT COUNT(*) AS n FROM ' + this.schema + '.manager_agents',
        'SELECT COUNT(*) AS n FROM ' + this.schema + '.manager_agents'));
      if (safeSqlInteger(existing.rows[0].n) !== 0) throw new Error('Assignment initializer requires a newly created empty table');
      const result = await tx.query(sqlQuery('write',
        'INSERT INTO ' + this.schema + '.manager_agents(manager_id,agent_id) SELECT m.id,a.id FROM ' + this.schema + '.users m CROSS JOIN ' + this.schema + ".users a WHERE m.role='manager' AND m.manager_scope='assigned' AND m.active=1 AND a.role='agent' AND a.active=1 ON CONFLICT(manager_id,agent_id) DO NOTHING",
        'INSERT INTO ' + this.schema + '.manager_agents(manager_id,agent_id) SELECT m.id,a.id FROM ' + this.schema + '.users m CROSS JOIN ' + this.schema + ".users a WHERE m.role='manager' AND m.manager_scope='assigned' AND m.active=1 AND a.role='agent' AND a.active=1 ON CONFLICT(manager_id,agent_id) DO NOTHING"));
      return result.changes;
    });
  }
}
