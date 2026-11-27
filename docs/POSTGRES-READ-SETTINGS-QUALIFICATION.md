# PostgreSQL qualification: catalog, customer reads, users and settings

This is an isolated synthetic qualification of the existing asynchronous
repositories. It does not select PostgreSQL at runtime, deploy an application,
import production rows, start workers, or send messages.

## Exact scope

The candidate combines the published catalog/customer reads, user/client-count
reads and SettingsRepository with the real authority schema builder. Repository
implementation files remain unchanged. The existing contract defaults and case
identities remain intact.

| Group | PostgreSQL contract cases | Original source oracle calls |
| --- | ---: | ---: |
| Catalog, photos, customer and warehouse reads | 82 | 16 |
| Users and client counts | 42 | 6 |
| Settings reads and mutations | 154 | 108, including 61 write oracles |
| Integration boundaries | 8 | — |
| Total | 286 | 130 |

The existing native SQLite JSON1 membership suite has 41 cases. The native
CAST suite has 63 cases. They are reported separately. They are not 104 extra
PostgreSQL cases and they do not establish that all historical source values
are eligible for migration. Membership retains seven measured ineligibility
witnesses and two strict-source eligibility checks. The CAST suite retains 44
matching cases, 16 explicit unsupported REAL-cast witnesses, and three shared
refusals. All existing assertions remain present.

## Schema and privilege boundary

The runner applies the actual `postgresAuthoritySchema` create/copy/activate
plan in one transaction. This provides users, sessions, assignments, settings,
login attempts and portfolio metadata with the intended role separation and
scope triggers. Settings keys and values remain `TEXT COLLATE "C"`; they are
never parsed into JSONB or reserialized by the storage layer.

The separate customer **read fixture** has the four observed columns:

| Column | PostgreSQL fixture type | Nullability and default |
| --- | --- | --- |
| id | TEXT COLLATE "C" | Primary key, not null |
| warehouse_id | TEXT COLLATE "C" | Not null |
| data | TEXT COLLATE "C" | Not null, original JSON text |
| active | INTEGER | Not null, default 1 |

The primary key and warehouse lookup index exist. The legacy JSON1 expression
index, 13 customer triggers and their dependent projections are deliberately
absent. This fixture is not a production customer schema builder. It does not
qualify customer imports, mutation semantics, indirect trigger effects, or scan
performance at production volume. Those remain separate migration gates.

Both application roles have SELECT only on customers. The actual repository
calls use the restricted writer login because Settings mutations require the
authority builder's intended DML privileges. Its read transactions are
`REPEATABLE READ READ ONLY`; `current_user`, `session_user`, `role=none` and
non-superuser status are recorded and checked. Three direct INSERT/UPDATE/DELETE
attempts must fail with PostgreSQL `42501`. The reader and writer each require
a successful login and an exact wrong-password `28P01` rejection.

Fixture reset, seeding and independent customer mutations use the explicitly
identified bootstrap adapter on the owned disposable database. One existing
composability case deliberately changes a customer and then calls
`readUsersWithClientCounts` in the **same supplied transaction**. That case uses
the fixture bootstrap identity, with `SET ROLE` absent (`role=none`), writable
READ COMMITTED and superuser status recorded. It is not reported as an
application-role or SELECT-only mutation test. The helper and its result
assertions are unchanged.

## Original source and concurrency evidence

The oracle helper extracts exact declarations and route branches from the
candidate source through TypeScript transformation and an AST parser. It does
not import the application runtime. Each oracle captures all needed PostgreSQL
tables in one adapter read snapshot and copies that synthetic snapshot into a
fresh in-memory SQLite database. The unmodified legacy SQL and JavaScript run
there. Each result is compared with the asynchronous repository result. Raw
setting bytes, unknown properties, unlimited-limit sentinel, invalid-limit
repair, exact recipient order and CAS branches retain their original assertions.

Independent snapshot changes use a worker thread that imports the actual
PostgresDatabase adapter, takes its actual advisory write lock, commits, closes
the adapter, and only then acknowledges completion. The writer has a separate
async context; the adapter's nested-transaction prohibition is not bypassed or
weakened. There are five catalog, eight user and three Settings independent
commits. Existing queued-writer tests continue to use the second real adapter.

The Settings test proxy decodes a BYTEA value only when forwarding to SQLite.
It preserves the same Uint8Array for actual PostgreSQL. This corrects a fixture
transport defect and keeps every NUL-input case and predicate assertion intact.
The pure regression covers all three affected predicates, normal text, refusal
of NUL TEXT parameters and refusal of a mismatched binary predicate.

## Commands and proof requirements

Source-only checks:

```sh
node tools/test-read-settings-fixture.mjs
node tools/test-catalog-customer-sqlite.mjs
node tools/test-user-client-counts-sqlite.mjs
node tools/test-settings-sqlite.mjs
node tools/test-read-settings-oracles-sqlite.mjs
```

The last command reruns the same 278 case identities through the new coherent
oracle helper. It does not add business cases. The standalone original runners
remain available and unchanged.

Actual PostgreSQL execution requires an externally isolated, fresh database
whose name starts with `comenzi_read_settings_fixture_` and whose exact marker
is `comenzi async read settings isolated fixture v1`. Both
`COMENZI_PG_TEST_DATABASE` and `COMENZI_PG_TEST_URL` must be explicit. The URL must
select the isolated Unix socket. No ambient credential or database fallback is
accepted. The operations harness provides the pinned engine, resource limits,
private network, original-source/dependency hashes, exact case manifest, raw
diagnostics and verified cleanup.

```sh
node tools/test-read-settings-postgres.mjs
```

A successful command alone is insufficient: the external receipt must verify
all 286 case identities, the 130 source oracle calls, 16 independent commits,
native eligibility-case identities, exact role/column observations, the five
expected PostgreSQL negative events, no unexpected database errors, unchanged
protected services, and complete cleanup. Failed attempt evidence remains
distinct. No real PostgreSQL result is claimed by this source document.

Before any runtime switch, the final consistent production snapshot still must
pass the lexical JSON membership/CAST eligibility rules and a bounded
production-volume scan test. Customer writers and dependent projections need
their complete port and separate qualification. This read/settings proof does
not close those gates.
