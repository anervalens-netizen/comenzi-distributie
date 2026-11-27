/** Explicit asynchronous SQL contract. SQL is ported per dialect, never rewritten. */
export type SqlDialect = 'sqlite' | 'postgresql';
export type SqlValue = null | string | number | bigint | Uint8Array;
export type SqlRow = Record<string, unknown>;
export type SqlQuery = Readonly<{ kind: 'read' | 'write'; sqlite: string; postgresql: string }>;
export type SqlResult<Row extends SqlRow = SqlRow> = { rows: Row[]; changes: number };
export interface SqlReader {
  readonly dialect: SqlDialect;
  query<Row extends SqlRow = SqlRow>(query: SqlQuery, values?: readonly SqlValue[]): Promise<SqlResult<Row>>;
}
export type SqlWriter = SqlReader;
export type SqlAuthority = (reader: SqlReader) => Promise<void>;
export interface AsyncSqlDatabase {
  read<T>(action: (reader: SqlReader) => Promise<T>): Promise<T>;
  write<T>(action: (writer: SqlWriter) => Promise<T>, authority?: SqlAuthority): Promise<T>;
  close(): Promise<void>;
}

/** Restricted application statements; migrations and transaction control are separate. */
export function sqlQuery(kind: SqlQuery['kind'], sqlite: string, postgresql: string): SqlQuery {
  if (kind !== 'read' && kind !== 'write') throw new Error('Unsupported application SQL statement kind');
  const allowed = kind === 'read' ? /^SELECT\b/i : /^(INSERT|UPDATE|DELETE)\b/i;
  for (const sql of [sqlite, postgresql]) {
    // Parameters carry arbitrary text. Deliberately exclude scripts, transaction
    // commands and semicolons from this first bounded application contract.
    // WITH can end in a SELECT; it cannot promise a write/change-count contract.
    if (!allowed.test(sql.trimStart()) || sql.includes(';')) throw new Error('Unsupported application SQL statement');
  }
  return Object.freeze({ kind, sqlite, postgresql });
}

export function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid SQL schema identifier');
  return '"' + value + '"';
}

export function sqlValues(values: readonly SqlValue[]): SqlValue[] {
  return values.map(value => {
    if (value === null || typeof value === 'string' || typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    if (value instanceof Uint8Array) return new Uint8Array(value);
    throw new Error('Unsupported or lossy SQL parameter');
  });
}

/** Explicit conversion for fields whose application contract is a safe integer. */
export function safeSqlInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' || typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    const integer = BigInt(value);
    if (integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(integer);
  }
  throw new Error('SQL integer is outside the application number contract');
}

/** Internal lifecycle guard, shared by both adapters. A caught SQL failure still aborts. */
export class SqlSession implements SqlWriter {
  private open = true;
  private writesOpen: boolean;
  private failure: unknown;
  private failed = false;
  private pending = new Set<Promise<unknown>>();
  constructor(readonly dialect: SqlDialect, writable: boolean,
    private readonly execute: (query: SqlQuery, values: SqlValue[]) => Promise<SqlResult>) {
    this.writesOpen = writable;
  }
  query<Row extends SqlRow = SqlRow>(query: SqlQuery, values: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
    if (!this.open || query.kind === 'write' && !this.writesOpen) return Promise.reject(new Error('SQL transaction is closed or read-only'));
    let task: Promise<SqlResult<Row>>;
    try {
      const captured = sqlQuery(query.kind, query.sqlite, query.postgresql);
      const parameters = sqlValues(values);
      // Start the operation now, inside the transaction boundary. A deferred
      // microtask must never enqueue SQL after a callback has already failed.
      task = this.execute(captured, parameters) as Promise<SqlResult<Row>>;
    } catch (error) {
      this.failed = true; this.failure ??= error;
      return Promise.reject(error);
    }
    this.pending.add(task);
    // Observe failures even when a caller forgets to await or catches them.
    void task.then(() => { this.pending.delete(task); }, error => {
      this.failed = true; this.failure ??= error; this.pending.delete(task);
    });
    return task;
  }
  reader(): SqlReader {
    return { dialect: this.dialect, query: <Row extends SqlRow = SqlRow>(query: SqlQuery, values?: readonly SqlValue[]) => {
      if (query.kind !== 'read') return Promise.reject(new Error('Authority and read callbacks cannot write'));
      return this.query<Row>(query, values);
    } };
  }
  async endWrites(): Promise<void> {
    this.writesOpen = false;
    await Promise.allSettled(this.pending);
    if (this.failed) throw this.failure;
  }
  async finish(): Promise<void> {
    this.open = false;
    await this.endWrites();
  }
  abort(): void { this.open = false; this.writesOpen = false; }
}
