# Prepared PostgreSQL account schema

`lib/postgres-authority-schema.ts` builds SQL for six existing application tables:
`users`, `sessions`, `login_attempts`, `manager_agents`, `settings` and
`portfolio_revision`. It opens no connection, provisions no role, reads no
environment variable and changes no application route or database selector.

This is one part of the asynchronous PostgreSQL conversion. It does not migrate
orders, history, other SQLite databases, derived models or the remaining writers.
The current application continues to use SQLite until a complete conversion is
qualified and selected through its normal deployment workflow.

## Source contracts

The column and foreign-key contracts come from
`drizzle/0000_rare_hardball.sql`, `db/schema.ts` and the incremental additions in
`lib/runtime-node.ts`. The authority generation comes from
`drizzle/0009_portfolio_read_model.sql` and `lib/request-authority.ts`.
`drizzle/0010_order_list_revision.sql` belongs to orders and is outside this slice.

The builder preserves these distinctions:

| Contract | PostgreSQL representation |
| --- | --- |
| Account, session and assignment IDs | Text with `COLLATE "C"`; no identifier generation or case folding |
| Username uniqueness | Exact text uniqueness, including the difference between upper and lower case |
| Active SiteCode uniqueness | `TRANSLATE(TRIM(site_code),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') COLLATE "C"`, only for active agents with a nonblank code |
| Account flags | Integer `0` or `1`; they remain numeric for the existing SQL predicates |
| Session expiry and rate-limit reset | Integer epoch milliseconds in `bigint`, not timestamps or seconds |
| Profile and portfolio revisions | Positive `bigint` values within the JavaScript exact-integer contract |
| Session and assignment foreign keys | Immediate `NO ACTION`; no implicit deletion of accounts, sessions or assignments |
| Metadata | Both `data_revision` and `scope_revision`, with the exact singleton `id=1` |

PostgreSQL must reject source values outside this target contract. The migration
must inventory and validate them before copying; it must not clip numbers,
rewrite codes, invent manager scope, drop rows or silently repair invalid flags.
The integer checks are deliberate validation of the new repository contract,
not a claim that historical SQLite constraints already enforced these ranges.
PostgreSQL text also requires valid database-encoding text without NUL characters.

## Two phases in one transaction

The caller provides explicit schema, owner, reader and writer names. The schema
must be new. Identifiers are restricted to the same bounded ASCII contract as
the SQL adapter; system schemas and role aliases are refused. There is no
`IF NOT EXISTS`, destructive reset or automatic adoption of existing objects.

1. Begin an explicit migration transaction with a separately authorized DDL
   client. Apply `createStatements`. This creates the six tables, constraints,
   indexes and narrowly scoped grants. The first statement sets a transaction-local
   `pg_catalog` search path so existing names cannot shadow built-in types or functions.
2. Copy the validated original account rows and the **original**
   `portfolio_revision` row. Preserve session token hashes, password verifiers,
   expiry values and revision values privately. This builder has no seed data.
3. Apply `activateStatements`. It requires the metadata singleton, installs the
   six scope triggers and checks final and effective privileges. Complete the
   independent data comparison before committing or publishing a runtime.
4. Commit only when every migration check succeeds. Any error requires rollback
   of the entire transaction. Do not commit between the two phases.

Installing the triggers after the copy prevents the copy itself from incrementing
authority generations. A new synthetic test database must explicitly insert its
own `(1, data_revision, scope_revision)` row. A migration of an existing application
must use its captured row instead. It must not run the first-table assignment
initializer merely because a migrated assignment table happens to be empty.

No trigger changes `users.profile_revision`. Account mutators already increment
that value explicitly. Adding another increment would break their CAS contract.
The six scope triggers match the existing event semantics:

| Event | Scope effect |
| --- | --- |
| Every user INSERT or DELETE | Increment once per affected row |
| User UPDATE mentioning `warehouse_id`, `active`, `role` or `manager_scope` | Increment once per affected row, even if the assigned value is unchanged |
| Every assignment INSERT, UPDATE or DELETE | Increment once per affected row |
| Profile-only, username or password update | No automatic scope increment; explicit profile revision remains authoritative |
| Statement affecting zero rows | No increment |

Scope changes occur in the same transaction as the corresponding business row.
The function uses invoker rights, a fixed `pg_catalog` search path and a fully
qualified metadata table. A missing metadata row aborts a scoped write. Reaching
the safe revision bound aborts the write instead of producing a lossy token.
Customer-directory and derived portfolio triggers are outside this account slice.

## Roles and privileges

The caller must provision three distinct roles separately. The owner must be
`NOLOGIN`. None may be superuser, create databases or roles, replicate, or bypass
RLS. The reader and owner must not inherit other roles. The writer may inherit
the declared reader only. Transitive membership is checked, including membership
that would allow a later `SET ROLE`; a global data-writer role is refused.
The reverse graph is checked too: an additional non-superuser must not be able
to assume an authority role. The only exceptions are the actual authenticated
DDL session/effective principal and the writer's permitted reader membership.
Database superusers remain inherently trusted; these grants cannot restrict them.

The reader is an internal application role. It can read password verifiers and
session hashes and must never be handed to an analytical agent or a client.
It receives table SELECT and schema USAGE. The writer receives the same reads
and INSERT/UPDATE/DELETE on the five account/settings tables. For metadata it
can update only the two revision columns. It cannot delete the singleton,
truncate tables, create schema objects, add triggers or grant references.

The builder does not grant database connection privileges or role memberships,
and it does not remove unrelated permissions from existing roles. Its preflight
refuses incompatible role capabilities. The operator remains responsible for
the database connection boundary and for using dedicated application roles.

New-object ACLs can come from the DDL client's default privileges. Changing an
object's owner does not remove those grants. The activation gate therefore
checks namespace, table, column and function ACLs and refuses any grantee outside
the three declared roles. It also verifies effective reader/writer privileges.
A rejected default grant is rolled back with the entire new schema; it is not
silently revoked from unrelated objects or existing default-privilege settings.

## Verification interface

`node tools/test-postgres-authority-schema.mjs` checks only the pure builder's
input boundary, role separation, immutability and non-destructive plan. Its
receipt explicitly reports that PostgreSQL was not executed.

The exported `runPostgresAuthoritySchemaContract(api, options)` requires a caller
with an already attested disposable PostgreSQL client, three existing fixture
roles, a fourth foreign fixture role, a fresh schema name and
`isolatedMutation: true`. It does not accept an environment DSN, start a server,
create roles or perform broad cleanup. The caller owns those resources and must
remove the exact objects it created. The base schema name must leave room within
the identifier bound for the `_acl_probe` suffix.

The real database contract exercises unchanged-value UPDATE events, explicit
profile increments, COPY/activation ordering, complete rollback, constraint and
foreign-key failures, ASCII and non-ASCII code behavior, effective read/write
permissions, missing metadata, a foreign default grant and inherited global
write authority. Its temporary default-ACL and membership probes are always
rolled back. SQL errors expected by these negative cases must be counted by
the enclosing database harness; arbitrary additional errors remain failures.

After this schema contract, the caller can reuse the resulting schema for the
separate account/session repository contract. It must create that contract's
isolated import-ledger schema itself. The existing SQLite fixture remains useful
as the reference; successful pure or SQLite tests do not certify PostgreSQL,
HTTP integration, import publication or production behavior.
