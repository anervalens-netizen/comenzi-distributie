# Asynchronous SQL adapter foundation

This is a migration foundation, not an enabled PostgreSQL application runtime.
`runtime-node.ts`, HTTP routes, import workers and their SQLite stores keep their
existing behavior. No environment variable selects the new adapter implicitly.

## Implemented boundary

`lib/sql-database.ts` defines an asynchronous reader/writer contract. Each
application statement supplies explicit SQLite and PostgreSQL text. Values are
bound separately. Identifiers are validated. Reads start with SELECT; writes
start with INSERT, UPDATE or DELETE. WITH is excluded because it can end in a
read and SQLite would otherwise report the previous statement's change count.
Transaction commands, scripts and implicit SQL translation are outside this contract. Schema migration uses a
separate operator-controlled path.

`lib/sql-postgres.ts` owns its connection pool. One dedicated client holds each
transaction. Every writer acquires the same database-local transaction advisory
lock before the first authority read. The lock covers all schemas in this
application database, including account/session revocation and import writes.
An import cannot opt into a different lock key. Write transactions use READ
COMMITTED so a waiting importer observes a revocation committed while it waited.
Read callbacks use a read-only, repeatable-read transaction.

Authority is checked before the callback and again after its writes finish.
The final check covers expiration during asynchronous work. A caught SQL failure
still aborts the transaction. Pending statements finish before commit. Escaped
transaction handles cannot issue later SQL. A transaction's async context is
active only until its commit/rollback and client release finish. A detached
callback can start a fresh transaction after that lifetime ends; it cannot reuse
the closed transaction handle. Acquire failures also end this lifetime.

PostgreSQL nesting is deliberately unsupported across **all** adapter instances
in an active transaction, including a second pool or DSN alias. Reuse the supplied
client for related work. The initial application topology is one database with
separate schemas; cross-database nested work is outside this contract. This
conservative boundary does not guess database identity from hostnames or require
extra runtime privileges. SQLite still rejects nesting for the same main file.

Connection acquisition, lock waiting, statements and idle transactions have
bounded timeouts. `idleTransactionTimeoutMs` has its own 60,000 ms default and
1–300,000 ms bounds. It is independent of the per-statement timeout (15,000 ms
default). Awaited application work is allowed within that idle budget; callers
should complete parsing and external I/O before acquiring the writer lock where
possible. A checked-out connection error is observed and retires the
client. Rollback failure also retires it. Lost commit confirmation throws
`CommitOutcomeUnknownError`: the caller must reconcile its durable operation
identity before deciding whether to retry. The adapter never retries a write.
An explicit ROLLBACK completion or a server ERROR at COMMIT with SQLSTATE 23502,
23503, 23505, 23514, 23P01, 40001 or 40P01 is a definite rejection. It preserves
the original error and reuses the client only after successful cleanup. Other
responses, FATALs, connection failures and SQLSTATE 40003 remain unknown outcomes.

`lib/sql-sqlite.ts` supplies the same asynchronous boundary around a dedicated
SQLite connection. It retains `BEGIN IMMEDIATE`. Connections sharing the same
main database serialize in-process before entering synchronous SQLite calls, so
an awaited writer cannot deadlock its event loop against another local writer.
SQLite's cross-process busy behavior remains native. The caller owns the SQLite
file topology and journal configuration; this adapter does not change them.
Cross-file crash atomicity still needs an explicit compatible journal topology
and recovery proof before migration or publication is enabled.

`lib/import-write-authorization-async.ts` ports the current captured manager
predicate: exact user, role, active flag, password-change requirement, profile
revision, manager scope, session token and expiry. Application authority and the
destination ledger must be in the same database transaction. This helper is not
yet connected to existing HTTP or background import execution.

## Data and ownership decisions

The proposed target is one database dedicated to this application, with distinct
schemas and schema owners for its existing business modules. That permits one
atomic transaction across application authority and an import ledger. It does
not combine this application's ownership with other applications. Production
schema DDL and ACLs still require explicit review and complete catalog evidence.

The fixture uses separate NOLOGIN schema owners and a runtime LOGIN role with
only USAGE and table SELECT/INSERT/UPDATE/DELETE permissions. It verifies that
neither owner can update the other module and that the runtime cannot create
schemas or objects in public. The runtime can intentionally access both modules
because one authorized import must update them atomically.

No global PostgreSQL type parser is changed. PostgreSQL BIGINT results remain
lossless strings; SQLite integer results use bigint. `safeSqlInteger` performs
an explicit checked conversion for fields whose application contract is a safe
JavaScript integer. Monetary integer units, NULL, dates, JSON, binary data and
ordering need field-specific mappings when each production query is ported.
The synthetic contract checks exact negative cents, a value above 2^53 and
explicit binary ordering. It does not prove every existing report's semantics.

## Tests

Run the SQLite and transport fault contracts without a PostgreSQL server:

```sh
npm run test:sql-adapter
```

The shared fixture checks authorized/idempotent import, all current manager
predicate revocations, exact session binding, expiry during await, rollback
across authority and ledger schemas, caught SQL errors, escaped handles, nested
transactions, both import/revocation orders and writer cleanup. Fault injection
checks the actual adapter's client lifecycle, lock ordering, readonly mode,
connection/rollback failures and ambiguous commit behavior. Transport mocks do
not count as PostgreSQL engine qualification.

For the real PostgreSQL contract, the operator must create a new empty disposable
database with a name beginning `comenzi_adapter_fixture_` and set its comment to
exactly `comenzi async adapter isolated fixture v1`. The operator must isolate
the server, bound CPU/memory/storage and ensure no production mounts or endpoints
are present. This script does not launch or select a database server.

Supply the exact database name and a bootstrap URL as `COMENZI_PG_TEST_DATABASE`
and `COMENZI_PG_TEST_URL`, then run:

```sh
npm run test:sql-adapter:postgres
```

The fixture refuses a missing explicit URL, a different database name, a missing
owner marker, a standby or existing application relations. It creates only
uniquely named synthetic schemas and roles, tests through the restricted runtime
role, closes its pools and removes its own schemas/roles. The output records the
actual server version, case IDs and cleanup result. Credentials are never printed.
The fixture does not read a live SQLite snapshot. Actual PostgreSQL qualification
must use the intended target build, not merely a matching major version label.

## Remaining runtime port and release gates

All existing production authority writers remain on SQLite. In particular,
`app/api/[...path]/route.ts` owns session creation/expiry cleanup, logout,
password/profile changes, account reset/activation and manager-agent assignments.
`lib/server.ts` extends sessions. `lib/runtime-node.ts` owns initialization,
revision triggers, D1 batches and the current request write context. Import
authorization currently enters `lib/import-write-authorization.ts`; the stock,
sales, history, activation and manager-analysis paths must be ported together
with their authority readers and revokers before any runtime selector is added.

The following are still required:

- Port every production authority revoker and writer through this same boundary;
  retain exact CAS predicates, `changes()` behavior and assignment/revision rules.
- Port request-wide authority, portfolio revisions and restricted/global manager
  scope. The initial helper covers captured manager import authority only.
- Convert all direct synchronous database consumers to awaited flows. There is
  no Promise disguised as a synchronous `DatabaseSync` result.
- Port each auxiliary schema, trigger, custom SQL function, ATTACH-dependent
  operation and source-generation/publication contract explicitly.
- Prove counts, typed data, constraints, ownership/ACLs, idempotency, HTTP behavior,
  ordering, exports, history and activation report pairs on the actual target.
- Complete full-scope backup/restore, bounded load and concurrency qualification,
  writer fencing, cutover/recovery rehearsal and the post-write rollback boundary.

Passing this foundation's tests does not satisfy those release gates. Existing
runtime authorization and publication paths must not be switched piecemeal while
some revokers bypass the PostgreSQL writer lock.
