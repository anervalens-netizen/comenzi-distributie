import { safeSqlInteger, sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader,
  type SqlRow, type SqlWriter } from './sql-database';

export const ASYNC_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 900_000;

export class AccountWriteError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 428 | 429, readonly code: string) {
    super(code);
    this.name = 'AccountWriteError';
  }
}
export type SessionIdentity = Readonly<{ userId: string; tokenHash: string }>;
export type AccountRecord = Readonly<{
  id: string; username: string; name: string; role: string; managerScope: 'global' | 'assigned';
  warehouseId: string | null; warehouseName: string | null; siteCode: string;
  active: boolean; mustChangePassword: boolean; profileVersion: number;
}>;
/** Private server-side input to password verification/CAS; never serialize to HTTP. */
export type CredentialSnapshot = Readonly<{
  id: string; username: string; passwordHash: string; profileVersion: number;
}>;
export type LiveSession = Readonly<{ user: AccountRecord; expiresAt: number }>;

export function accountClock(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid account clock');
  return now;
}
export function accountRevision(value: unknown): number {
  const revision = safeSqlInteger(value);
  if (revision < 1 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid account revision');
  return revision;
}
function flag(value: unknown): boolean {
  const number = safeSqlInteger(value);
  if (number !== 0 && number !== 1) throw new Error('Invalid account flag');
  return number === 1;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid account text');
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
export function accountRecord(row: SqlRow): AccountRecord {
  if (row.role === 'manager' && row.manager_scope !== 'assigned' && row.manager_scope !== 'global') {
    throw new Error('Invalid manager scope');
  }
  return Object.freeze({ id: text(row.id), username: text(row.username), name: text(row.name),
    role: text(row.role), managerScope: row.role === 'manager' && row.manager_scope === 'global' ? 'global' : 'assigned',
    warehouseId: nullableText(row.warehouse_id), warehouseName: nullableText(row.warehouse_name), siteCode: text(row.site_code),
    active: flag(row.active), mustChangePassword: row.role === 'manager' && flag(row.must_change_password),
    profileVersion: accountRevision(row.profile_revision) });
}
function credentials(row: SqlRow): CredentialSnapshot {
  return Object.freeze({ id: text(row.id), username: text(row.username), passwordHash: text(row.password_hash),
    profileVersion: accountRevision(row.profile_revision) });
}
export function captureSessionIdentity(identity: SessionIdentity): SessionIdentity {
  if (!identity.userId || !identity.tokenHash || typeof identity.userId !== 'string' || typeof identity.tokenHash !== 'string') {
    throw new AccountWriteError(401, 'session_changed');
  }
  return Object.freeze({ userId: identity.userId, tokenHash: identity.tokenHash });
}
function sessionExpiry(now: number): number {
  const expires = now + ASYNC_SESSION_TTL_MS;
  if (!Number.isSafeInteger(expires)) throw new Error('Session expiry exceeds the number contract');
  return expires;
}
export function preparedPasswordHash(value: string): string {
  // Password policy, derivation and verification belong to the caller before
  // acquiring the writer lock. The repository accepts no plaintext password.
  if (typeof value !== 'string' || !value || value.length > 1024) throw new AccountWriteError(400, 'invalid_prepared_password');
  return value;
}
export async function sessionInTransaction(reader: SqlReader, schema: string, tokenHash: string,
  now: number, userId?: string): Promise<LiveSession | null> {
  const from = ' FROM ' + schema + '.sessions s JOIN ' + schema + '.users u ON u.id=s.user_id ';
  const result = await reader.query(sqlQuery('read',
    'SELECT u.*,s.expires_at AS session_expires_at' + from + 'WHERE s.token_hash=? AND s.expires_at>? AND u.active=1',
    'SELECT u.*,s.expires_at AS session_expires_at' + from + 'WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.active=1'), [tokenHash, now]);
  if (result.rows.length !== 1 || userId !== undefined && result.rows[0].id !== userId) return null;
  return Object.freeze({ user: accountRecord(result.rows[0]), expiresAt: safeSqlInteger(result.rows[0].session_expires_at) });
}
export async function requireSessionInTransaction(reader: SqlReader, schema: string,
  identity: SessionIdentity, now: number): Promise<LiveSession> {
  const session = await sessionInTransaction(reader, schema, identity.tokenHash, now, identity.userId);
  if (!session) throw new AccountWriteError(401, 'session_changed');
  return session;
}

/** Prepared repository only. No singleton, runtime selection, timers or live I/O. */
export class SessionRepository {
  protected readonly schema: string;
  constructor(protected readonly database: AsyncSqlDatabase, applicationSchema: string,
    protected readonly clock: () => number = Date.now) { this.schema = sqlIdentifier(applicationSchema); }

  readSession(tokenHash: string): Promise<LiveSession | null> {
    return this.database.read(tx => sessionInTransaction(tx, this.schema, tokenHash, accountClock(this.clock)));
  }

  /** Return the user and refreshed expiry from the same writer snapshot. */
  refreshSession(tokenHash: string): Promise<LiveSession | null> {
    return this.database.write(async tx => {
      const now = accountClock(this.clock), session = await sessionInTransaction(tx, this.schema, tokenHash, now);
      if (!session) return null;
      const expiresAt = sessionExpiry(now);
      const result = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + '.sessions SET expires_at=? WHERE token_hash=? AND user_id=? AND expires_at>?',
        'UPDATE ' + this.schema + '.sessions SET expires_at=$1 WHERE token_hash=$2 AND user_id=$3 AND expires_at>$4'),
      [expiresAt, tokenHash, session.user.id, now]);
      if (result.changes !== 1) throw new AccountWriteError(401, 'session_changed');
      return Object.freeze({ user: session.user, expiresAt });
    });
  }

  logout(identity: SessionIdentity): Promise<void> {
    const actor = captureSessionIdentity(identity);
    return this.database.write(async tx => {
      await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock));
      const result = await tx.query(sqlQuery('write',
        'DELETE FROM ' + this.schema + '.sessions WHERE token_hash=? AND user_id=?',
        'DELETE FROM ' + this.schema + '.sessions WHERE token_hash=$1 AND user_id=$2'), [actor.tokenHash, actor.userId]);
      if (result.changes !== 1) throw new AccountWriteError(401, 'session_changed');
      // An import-style post-check would wrongly undo this intentional revocation.
    });
  }

  reserveLoginAttempt(username: string, ipHash: string): Promise<{ allowed: boolean; ipAttempts: number; accountAttempts: number | null }> {
    if (!username || username.length > 80 || username !== username.trim().toLowerCase() || !ipHash || ipHash.length > 128) {
      throw new AccountWriteError(400, 'invalid_login_identity');
    }
    return this.database.write(async tx => {
      const now = accountClock(this.clock), resetAt = now + LOGIN_WINDOW_MS;
      if (!Number.isSafeInteger(resetAt)) throw new Error('Login window exceeds the number contract');
      await tx.query(sqlQuery('write',
        'DELETE FROM ' + this.schema + '.login_attempts WHERE key IN (SELECT key FROM ' + this.schema + '.login_attempts WHERE reset_at<? LIMIT 100)',
        'DELETE FROM ' + this.schema + '.login_attempts WHERE key IN (SELECT key FROM ' + this.schema + '.login_attempts WHERE reset_at<$1 LIMIT 100)'), [now]);
      const ip = await tx.query(sqlQuery('write',
        'INSERT INTO ' + this.schema + '.login_attempts(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.reset_at<? THEN 1 ELSE login_attempts.attempts+1 END,reset_at=CASE WHEN login_attempts.reset_at<? THEN excluded.reset_at ELSE login_attempts.reset_at END WHERE login_attempts.reset_at<? OR login_attempts.attempts<80 RETURNING attempts',
        'INSERT INTO ' + this.schema + '.login_attempts(key,attempts,reset_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.reset_at<$3 THEN 1 ELSE login_attempts.attempts+1 END,reset_at=CASE WHEN login_attempts.reset_at<$4 THEN excluded.reset_at ELSE login_attempts.reset_at END WHERE login_attempts.reset_at<$5 OR login_attempts.attempts<80 RETURNING attempts'),
      ['ip:' + ipHash, resetAt, now, now, now]);
      if (ip.changes === 0) return { allowed: false, ipAttempts: 80, accountAttempts: null };
      if (ip.changes !== 1 || ip.rows.length !== 1) throw new Error('Unexpected IP reservation result');
      const account = await tx.query(sqlQuery('write',
        'INSERT INTO ' + this.schema + '.login_attempts(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.reset_at<? THEN 1 ELSE login_attempts.attempts+1 END,reset_at=CASE WHEN login_attempts.reset_at<? THEN excluded.reset_at ELSE login_attempts.reset_at END RETURNING attempts',
        'INSERT INTO ' + this.schema + '.login_attempts(key,attempts,reset_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.reset_at<$3 THEN 1 ELSE login_attempts.attempts+1 END,reset_at=CASE WHEN login_attempts.reset_at<$4 THEN excluded.reset_at ELSE login_attempts.reset_at END RETURNING attempts'),
      ['account:' + username, resetAt, now, now]);
      if (account.changes !== 1 || account.rows.length !== 1) throw new Error('Unexpected account reservation result');
      const accountAttempts = safeSqlInteger(account.rows[0].attempts);
      return { allowed: accountAttempts <= 10, ipAttempts: safeSqlInteger(ip.rows[0].attempts), accountAttempts };
    });
  }

  loginCredential(username: string): Promise<CredentialSnapshot | null> {
    return this.database.read(async tx => {
      const result = await tx.query(sqlQuery('read',
        'SELECT id,username,password_hash,profile_revision FROM ' + this.schema + '.users WHERE username=? AND active=1',
        'SELECT id,username,password_hash,profile_revision FROM ' + this.schema + '.users WHERE username=$1 AND active=1'), [username]);
      return result.rows.length === 1 ? credentials(result.rows[0]) : null;
    });
  }

  createLoginSession(verified: CredentialSnapshot, tokenHash: string): Promise<LiveSession> {
    const expected = Object.freeze({ ...verified, profileVersion: accountRevision(verified.profileVersion) });
    if (!tokenHash || tokenHash.length > 256) throw new AccountWriteError(400, 'invalid_session_token');
    return this.database.write(async tx => {
      const now = accountClock(this.clock), expiresAt = sessionExpiry(now);
      const result = await tx.query(sqlQuery('write',
        'INSERT INTO ' + this.schema + '.sessions(token_hash,user_id,expires_at) SELECT ?,id,? FROM ' + this.schema + '.users WHERE id=? AND active=1 AND username=? AND password_hash=? AND profile_revision=?',
        'INSERT INTO ' + this.schema + '.sessions(token_hash,user_id,expires_at) SELECT $1,id,$2 FROM ' + this.schema + '.users WHERE id=$3 AND active=1 AND username=$4 AND password_hash=$5 AND profile_revision=$6'),
      [tokenHash, expiresAt, expected.id, expected.username, expected.passwordHash, expected.profileVersion]);
      if (result.changes !== 1) throw new AccountWriteError(401, 'login_credentials_changed');
      // Cleanup belongs only to this successful CAS, never to a stale login.
      await tx.query(sqlQuery('write', 'DELETE FROM ' + this.schema + '.login_attempts WHERE key=?',
        'DELETE FROM ' + this.schema + '.login_attempts WHERE key=$1'), ['account:' + expected.username]);
      await tx.query(sqlQuery('write', 'DELETE FROM ' + this.schema + '.sessions WHERE expires_at<?',
        'DELETE FROM ' + this.schema + '.sessions WHERE expires_at<$1'), [now]);
      return requireSessionInTransaction(tx, this.schema, { userId: expected.id, tokenHash }, now);
    });
  }

  /** The verifier (including the missing-user fallback) runs outside both locks. */
  async authenticate(input: Readonly<{ username: string; ipHash: string;
    verify: (encodedHash: string | null) => Promise<boolean>; issueTokenHash: () => string }>): Promise<LiveSession> {
    const { username, ipHash, verify, issueTokenHash } = input;
    const reservation = await this.reserveLoginAttempt(username, ipHash);
    if (!reservation.allowed) throw new AccountWriteError(429, 'login_rate_limited');
    const expected = await this.loginCredential(username);
    const verified = await verify(expected?.passwordHash ?? null);
    if (!expected || !verified) throw new AccountWriteError(401, 'invalid_credentials');
    return this.createLoginSession(expected, issueTokenHash());
  }

  ownPasswordCredential(identity: SessionIdentity): Promise<CredentialSnapshot> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const session = await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock));
      if (session.user.role !== 'manager') throw new AccountWriteError(403, 'manager_required');
      const result = await tx.query(sqlQuery('read',
        'SELECT id,username,password_hash,profile_revision FROM ' + this.schema + '.users WHERE id=?',
        'SELECT id,username,password_hash,profile_revision FROM ' + this.schema + '.users WHERE id=$1'), [actor.userId]);
      return credentials(result.rows[0]);
    });
  }

  changeOwnPassword(identity: SessionIdentity, verified: CredentialSnapshot, newPasswordHash: string): Promise<void> {
    const actor = captureSessionIdentity(identity), expected = Object.freeze({ ...verified });
    const passwordHash = preparedPasswordHash(newPasswordHash), revision = accountRevision(expected.profileVersion);
    if (expected.id !== actor.userId) throw new AccountWriteError(403, 'own_account_required');
    return this.database.write(async tx => {
      const currentManagerSession = async () => {
        try {
          const session = await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock));
          if (session.user.role !== 'manager') throw new AccountWriteError(409, 'account_changed');
        } catch (error) {
          // The route already authenticated before password verification. A
          // concurrent reset/revocation is the existing failed-CAS 409 result.
          if (error instanceof AccountWriteError && error.status === 401) throw new AccountWriteError(409, 'account_changed');
          throw error;
        }
      };
      await currentManagerSession();
      const result = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".users SET password_hash=?,must_change_password=0,profile_revision=profile_revision+1 WHERE id=? AND active=1 AND role='manager' AND password_hash=? AND profile_revision=?",
        'UPDATE ' + this.schema + ".users SET password_hash=$1,must_change_password=0,profile_revision=profile_revision+1 WHERE id=$2 AND active=1 AND role='manager' AND password_hash=$3 AND profile_revision=$4"),
      [passwordHash, actor.userId, expected.passwordHash, revision]);
      if (result.changes !== 1) throw new AccountWriteError(409, 'account_changed');
      await this.deleteOtherSessions(tx, actor.userId, actor.tokenHash);
      await currentManagerSession();
      // Do not compare the old profile/password after intentionally changing it.
    });
  }

  protected async deleteOtherSessions(tx: SqlWriter, userId: string, retainedTokenHash?: string): Promise<void> {
    if (retainedTokenHash === undefined) {
      await tx.query(sqlQuery('write', 'DELETE FROM ' + this.schema + '.sessions WHERE user_id=?',
        'DELETE FROM ' + this.schema + '.sessions WHERE user_id=$1'), [userId]);
    } else {
      await tx.query(sqlQuery('write', 'DELETE FROM ' + this.schema + '.sessions WHERE user_id=? AND token_hash<>?',
        'DELETE FROM ' + this.schema + '.sessions WHERE user_id=$1 AND token_hash<>$2'), [userId, retainedTokenHash]);
    }
  }
}
