import type { ImportAuthorization } from './import-write-authorization';
import { sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader, type SqlWriter } from './sql-database';

export class ImportAuthorizationChangedError extends Error {
  readonly status = 401;
  constructor() {
    super('Sesiunea sau drepturile managerului s-au schimbat. Autentifică-te din nou.');
    this.name = 'ImportAuthorizationChangedError';
  }
}

/** This scope is explicit: both app authority and the target ledger use one DB. */
export function managerImportAuthority(applicationSchema: string, auth: ImportAuthorization,
  clock: () => number = Date.now): (reader: SqlReader) => Promise<void> {
  const schema = sqlIdentifier(applicationSchema);
  const tables = ' FROM ' + schema + '.users u JOIN ' + schema + '.sessions s ON s.user_id=u.id ';
  const query = sqlQuery('read',
    'SELECT 1 AS valid' + tables
      + "WHERE u.id=? AND u.role='manager' AND u.active=1 AND u.must_change_password=0 "
      + 'AND u.profile_revision=? AND u.manager_scope=? AND s.token_hash=? AND s.expires_at>?',
    'SELECT 1 AS valid' + tables
      + "WHERE u.id=$1 AND u.role='manager' AND u.active=1 AND u.must_change_password=0 "
      + 'AND u.profile_revision=$2 AND u.manager_scope=$3 AND s.token_hash=$4 AND s.expires_at>$5');
  const captured = Object.freeze({ ...auth });
  return async reader => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(captured.profileVersion)
      || captured.profileVersion < 1) throw new Error('Invalid captured authorization clock or revision');
    const result = await reader.query(query, [captured.userId, captured.profileVersion,
      captured.managerScope, captured.tokenHash, now]);
    if (result.rows.length !== 1) throw new ImportAuthorizationChangedError();
  };
}

/**
 * Authorization, target writes, final expiry check and commit share one writer
 * transaction. Every PostgreSQL revocation must use database.write() as well.
 * No HTTP runtime is switched to this path until all its writers are ported.
 */
export function withCapturedAsyncImportAuthorization<T>(
  database: AsyncSqlDatabase, applicationSchema: string, auth: ImportAuthorization,
  write: (transaction: SqlWriter, check: () => Promise<void>) => Promise<T>,
  clock: () => number = Date.now,
): Promise<T> {
  const authority = managerImportAuthority(applicationSchema, auth, clock);
  return database.write(transaction => write(transaction, () => authority(transaction)), authority);
}
