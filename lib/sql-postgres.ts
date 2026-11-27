import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolConfig, type PoolClient, type QueryConfig } from 'pg';
import { SqlSession, type AsyncSqlDatabase, type SqlAuthority, type SqlReader, type SqlWriter, type SqlValue } from './sql-database';

// Advisory locks are database-local. Every application writer uses this pair;
// a caller cannot select a separate lock for revocation or a different ledger.
export const APPLICATION_WRITE_LOCK = Object.freeze([1129270605, 1] as const);
const context = new AsyncLocalStorage<{ active: boolean }>();
// These ErrorResponses explicitly reject COMMIT. Connection errors, FATALs and
// SQLSTATE 40003 (statement completion unknown) remain ambiguous outcomes.
const commitRejectionCodes = new Set(['23502', '23503', '23505', '23514', '23P01', '40001', '40P01']);
function confirmedCommitRejection(error: unknown): boolean {
  return error instanceof Error && 'severity' in error && error.severity === 'ERROR'
    && 'code' in error && typeof error.code === 'string' && commitRejectionCodes.has(error.code);
}
// pg 8 supports queryMode at runtime; its separately published types omit it.
// Keep the extension explicit and preserve the typed query result overload.
const extended = (text: string, values: SqlValue[] = []): QueryConfig & { queryMode: 'extended' } =>
  ({ text, values, queryMode: 'extended' });
export interface PostgresOptions {
  connectionString: string;
  expectedDatabase: string;
  onIdleConnectionError: (error: Error) => void;
  maxConnections?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
}
export class CommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('Database commit outcome is unknown; reconcile the operation identity before retrying', { cause });
    this.name = 'CommitOutcomeUnknownError';
  }
}

/** The pool is internal; application callers cannot bypass the transaction boundary. */
export class PostgresDatabase implements AsyncSqlDatabase {
  private readonly pool: Pool;
  private readonly expectedDatabase: string;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;
  constructor(options: PostgresOptions) {
    if (!options.connectionString || !options.expectedDatabase || typeof options.onIdleConnectionError !== 'function') {
      throw new Error('Explicit PostgreSQL connection, database identity and error observer are required');
    }
    const endpoint = new URL(options.connectionString);
    if (!['postgres:', 'postgresql:'].includes(endpoint.protocol)) throw new Error('Explicit PostgreSQL URL required');
    this.expectedDatabase = options.expectedDatabase;
    const max = options.maxConnections ?? 4;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 15000;
    this.idleTransactionTimeoutMs = options.idleTransactionTimeoutMs ?? 60000;
    if (![max, this.lockTimeoutMs, this.statementTimeoutMs, this.idleTransactionTimeoutMs].every(Number.isSafeInteger)
      || max < 2 || max > 16 || this.lockTimeoutMs < 1 || this.lockTimeoutMs > 30000
      || this.statementTimeoutMs < this.lockTimeoutMs || this.statementTimeoutMs > 60000
      || this.idleTransactionTimeoutMs < 1 || this.idleTransactionTimeoutMs > 300000) {
      throw new Error('Invalid bounded PostgreSQL pool or timeout configuration');
    }
    const configuration: PoolConfig = {
      connectionString: options.connectionString, application_name: 'comenzi-async-adapter',
      max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true,
    };
    this.pool = new Pool(configuration);
    this.pool.on('error', options.onIdleConnectionError);
  }
  read<T>(action: (reader: SqlReader) => Promise<T>): Promise<T> {
    return this.transaction(false, action);
  }
  write<T>(action: (writer: SqlWriter) => Promise<T>, authority?: SqlAuthority): Promise<T> {
    return this.transaction(true, action, authority);
  }
  private async transaction<T>(writable: boolean, action: (session: SqlSession) => Promise<T>, authority?: SqlAuthority): Promise<T> {
    if (this.closed) throw new Error('PostgreSQL database is closed');
    // This single-database application does not support nested PG transactions,
    // including a second pool/DSN alias. Related work must use the passed client.
    if (context.getStore()?.active) throw new Error('Nested database transaction; use the supplied transaction client');
    const lifetime = { active: true };
    return context.run(lifetime, async () => {
      const client: PoolClient = await this.pool.connect();
      let began = false, commitAttempted = false, commitRejected = false, committed = false, destroy = false;
      let session: SqlSession | undefined;
      let connectionFailure: Error | undefined;
      // The pool removes its idle error listener while a client is checked out.
      // Observe errors during an awaited callback as well as query rejections.
      const onConnectionError = (error: Error) => {
        connectionFailure ??= error;
        destroy = true;
        session?.abort();
      };
      client.on('error', onConnectionError);
      try {
        const identity = await client.query<{ database: string }>(extended('SELECT current_database() AS database'));
        if (identity.rows[0]?.database !== this.expectedDatabase) throw new Error('PostgreSQL database identity differs');
        // READ COMMITTED is deliberate: the authority read AFTER a blocked lock
        // must see a revocation that committed while that lock was being acquired.
        await client.query(writable ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
          : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        began = true;
        await client.query(extended(
          "SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true), set_config('idle_in_transaction_session_timeout',$3,true), set_config('search_path','pg_catalog',true)",
          [String(this.lockTimeoutMs), String(this.statementTimeoutMs), String(this.idleTransactionTimeoutMs)]));
        if (writable) await client.query(extended('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [...APPLICATION_WRITE_LOCK]));
        session = new SqlSession('postgresql', writable, async (query, values) => {
          if (connectionFailure) throw connectionFailure;
          const parameters = values.map((value: SqlValue) => value instanceof Uint8Array ? Buffer.from(value) : value);
          const result = await client.query(extended(query.postgresql, parameters));
          return { rows: result.rows, changes: query.kind === 'write' ? result.rowCount ?? 0 : 0 };
        });
        if (authority) await authority(session.reader());
        const result = await action(session);
        if (connectionFailure) throw connectionFailure;
        await session.endWrites();
        // Expiration can advance without any competing database writer.
        if (authority) await authority(session.reader());
        await session.finish();
        if (connectionFailure) throw connectionFailure;
        commitAttempted = true;
        const completion = await client.query('COMMIT');
        if (completion.command === 'ROLLBACK') {
          commitRejected = true;
          throw new Error('PostgreSQL rolled back instead of committing');
        }
        if (completion.command !== 'COMMIT') throw new Error('PostgreSQL did not confirm COMMIT');
        committed = true;
        return result;
      } catch (error) {
        session?.abort();
        if (commitAttempted && !committed && !commitRejected && !confirmedCommitRejection(error)) {
          destroy = true;
          throw new CommitOutcomeUnknownError(error);
        }
        if (began && !connectionFailure) {
          try { await client.query('ROLLBACK'); } catch { destroy = true; }
        } else {
          destroy = true;
        }
        throw error;
      } finally {
        session?.abort();
        // release reattaches the pool's idle listener before ours is removed.
        try { client.release(destroy); }
        finally { client.removeListener('error', onConnectionError); }
      }
    }).finally(() => {
      // Child async resources retain their inherited object, not its activity.
      // Include acquire failure and release failure in this lifetime boundary.
      lifetime.active = false;
    });
  }
  async close(): Promise<void> {
    if (context.getStore()?.active) throw new Error('Cannot close a database from its active transaction');
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.pool.end();
    return this.closing;
  }
}
