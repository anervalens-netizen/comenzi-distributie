import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { SqlSession, type AsyncSqlDatabase, type SqlAuthority, type SqlReader, type SqlWriter } from './sql-database';

// One event-loop writer must not synchronously wait on another writer whose
// awaited callback needs that SAME event loop to release the SQLite lock.
const queues = new Map<string, Promise<void>>();
const context = new AsyncLocalStorage<ReadonlySet<string>>();
const ownedConnections = new WeakSet<DatabaseSync>();
let memoryIdentity = 0;

export class SqliteDatabase implements AsyncSqlDatabase {
  private readonly key: string;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly connection: DatabaseSync) {
    if (ownedConnections.has(connection)) throw new Error('SQLite connection already belongs to an adapter');
    if (connection.isTransaction) throw new Error('SQLite adapter requires an idle dedicated connection');
    const main = connection.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
    if (!main) throw new Error('SQLite main database identity is missing');
    this.key = main.file ? String(main.file) : 'memory:' + ++memoryIdentity;
    ownedConnections.add(connection);
  }
  read<T>(action: (reader: SqlReader) => Promise<T>): Promise<T> { return this.transaction(false, action); }
  write<T>(action: (writer: SqlWriter) => Promise<T>, authority?: SqlAuthority): Promise<T> {
    return this.transaction(true, action, authority);
  }
  private async transaction<T>(writable: boolean, action: (session: SqlSession) => Promise<T>, authority?: SqlAuthority): Promise<T> {
    if (this.closed) throw new Error('SQLite database is closed');
    if (context.getStore()?.has(this.key)) throw new Error('Nested database transaction; use the supplied transaction client');
    const previous = queues.get(this.key) ?? Promise.resolve();
    let unlock!: () => void;
    const lock = new Promise<void>(resolve => { unlock = resolve; });
    queues.set(this.key, lock);
    await previous;
    return context.run(new Set([...(context.getStore() ?? []), this.key]), async () => {
      let session: SqlSession | undefined;
      let began = false;
      let priorQueryOnly: unknown;
      let queryOnlyChanged = false;
      const restoreQueryMode = () => {
        if (!queryOnlyChanged) return;
        this.connection.exec(priorQueryOnly ? 'PRAGMA query_only=ON' : 'PRAGMA query_only=OFF');
        queryOnlyChanged = false;
      };
      try {
        if (this.closed) throw new Error('SQLite database is closed');
        priorQueryOnly = this.connection.prepare('PRAGMA query_only').get()!.query_only;
        if (!writable) { this.connection.exec('PRAGMA query_only=ON'); queryOnlyChanged = true; }
        this.connection.exec(writable ? 'BEGIN IMMEDIATE' : 'BEGIN');
        began = true;
        session = new SqlSession('sqlite', writable, async (query, values) => {
          const statement = this.connection.prepare(query.sqlite);
          statement.setReadBigInts(true);
          const rows = statement.all(...values).map(row => ({ ...row }));
          const changes = query.kind === 'write'
            ? Number(this.connection.prepare('SELECT changes() AS n').get()!.n) : 0;
          return { rows, changes };
        });
        if (authority) await authority(session.reader());
        const result = await action(session);
        await session.endWrites();
        if (authority) await authority(session.reader());
        await session.finish();
        // Restore connection configuration before committing; a cleanup failure
        // must not turn a successful data commit into an apparent rollback.
        restoreQueryMode();
        this.connection.exec('COMMIT');
        began = false;
        return result;
      } catch (error) {
        session?.abort();
        const failures = [error];
        if (began && this.connection.isOpen && this.connection.isTransaction) {
          try { this.connection.exec('ROLLBACK'); } catch (rollbackError) { failures.push(rollbackError); }
        }
        try { restoreQueryMode(); } catch (modeError) { failures.push(modeError); }
        if (failures.length > 1 || !this.connection.isOpen) {
          this.closed = true;
          try { if (this.connection.isOpen) this.connection.close(); }
          catch (closeError) { failures.push(closeError); }
          throw new AggregateError(failures, 'SQLite cleanup failed; connection retired');
        }
        throw error;
      } finally {
        session?.abort();
        unlock();
        if (queues.get(this.key) === lock) queues.delete(this.key);
      }
    });
  }
  async close(): Promise<void> {
    if (context.getStore()?.has(this.key)) throw new Error('Cannot close a database from its active transaction');
    if (this.closing) return this.closing;
    const pending = queues.get(this.key);
    this.closed = true;
    this.closing = (async () => { if (pending) await pending; if (this.connection.isOpen) this.connection.close(); })();
    return this.closing;
  }
}
