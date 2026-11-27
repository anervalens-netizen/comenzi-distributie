# Async order draft repository: prepared application slice

This slice ports authorized single-order reads and draft create/copy/save/delete
to the explicit async SQL adapter. It does not select a runtime backend or change
an HTTP route. PostgreSQL execution remains a separate qualification gate.

## Modules and boundary

- `lib/order-draft-repository-async.ts` owns business reads and mutations.
- `lib/order-write-authority-async.ts` composes the request authority check with
  the adapter's writer transaction. It never opens a nested transaction.
- `tools/order-draft-contract.mjs` is a reusable fictional contract for SQLite
  and PostgreSQL. The caller owns the isolated database, both adapters and DDL.
- `tools/test-order-draft-sqlite.mjs` bundles the actual modules, creates private
  temporary SQLite files, runs the contract and removes its files in `finally`.

The repository receives `(database, applicationSchema, seed, clock)`. `seed`
contains products and warehouse names from the same application release. The
constructor takes a private copy. Runtime private resources are not committed
with this preparation. Catalog overrides and EAN mappings always come from
`settings` in the transaction being used for the operation.

The prepared methods are:

| Method | Input authority | Behavior |
| --- | --- | --- |
| `read(identity, id)` | Exact session identity | Read one non-deleted order. Agents see their own orders. Managers retain national read visibility. |
| `create(actor, body)` | Captured request actor | Create an empty draft or copy the selected historical order. Return `{order, created}`. |
| `save(actor, id, body)` | Captured request actor | Validate the current catalog, quantities, serials and customer membership; perform an exact revision CAS or return the unchanged order. |
| `remove(actor, id, body)` | Captured request actor | Soft-delete after the exact revision CAS, then clean only the serials belonging to that order in the same transaction. |

`AuthorityRepository.captureRequestActor()` supplies the write snapshot. HTTP
integration must capture it at the existing boundary before reading an
asynchronous request body. The HTTP layer still owns origin, content-type,
maximum JSON size, operation-user and response-message handling. Internal
`AccountWriteError` status/code pairs are not a new public response contract.

## Transaction and authority rules

Every mutator owns one `database.write()`. All user/session checks, scope
generation reads, manager assignments, target agent reads, catalog/settings,
customer membership, order CAS and serial cleanup use its supplied transaction.
There is no synchronous runtime/database fallback and no second connection.

The adapter obtains its writer lock before invoking authority callbacks. The
injected clock is read after that acquisition. Each operation checks:

- The exact user and session, current activity and expiration.
- The captured actor profile revision, role and warehouse.
- The captured manager scope and password-change requirement for managers.
- The captured portfolio scope generation, including assignment revocations.
- The actual agent access for the operation. National manager reads do not grant
  national manager writes.

The complete captured authority is checked again before commit. Draft mutations
do not intentionally change their own account authority, unlike password or
logout operations. A session that expires during an awaited operation aborts the
whole write. Every revoker and business writer must use the shared adapter lock;
the slice is not safe to activate alongside unported PostgreSQL writers which
bypass that lock. A PostgreSQL commit with an unknown outcome must be reconciled
by operation identity; it must not be replayed blindly.

## Preserved behavior

### Create and copy

Kinds, number prefixes, UTC date and the existing 36-character identifier
grammar are preserved. An agent always targets their own account. A manager must
select an active agent in their write scope. The insertion also checks the exact
target warehouse in SQL. Missing target warehouses refuse without a partial row.

An already-existing authorized UUID returns that order. This retains the current
early retry behavior even when an otherwise valid request supplies another kind
or target. The target selection is still authorized first. A number collision
with a different UUID returns a conflict and cannot substitute another order.
A deleted UUID is never reused.

Copy requires the same agent and kind. It can use a finalized source. It keeps
the historical line snapshots, customer, notes and total, then starts a fresh
draft/revision. SIM and combined copies clear serials; combined pieces are the
sum of accessory and stand quantities. Copy does not silently apply today's
catalog or stock to historical source lines. Save performs catalog validation.

### Save and no-op

Line order is retained. Product metadata and prices come from the current seed
plus overrides, including EAN mappings and the existing product-version hash.
Unknown/deleted products, duplicate lines and invalid integer quantities refuse
before writing. The existing limits of 600 lines per group and 1,000 serials are
retained. SIM serials remain strings, are stripped of whitespace and are checked
for length and duplicates. Notes retain trimming and the 2,000-character limit.

The combined order total still sums accessories only; stand quantities count
toward pieces. The current draft route permits customers for SIM and stand-client
orders and rejects customers/serials on accessory, stand and combined drafts.
This slice does not alter that existing rule or infer a new finalize rule.

Customer access retains the selected order's warehouse. Missing or JSON-null
`warehouseIds` falls back to `warehouse_id`; an empty array grants no membership.
The contract runs the legacy SQLite JSON1 expression for array, object and scalar
forms. JSON string values are parsed again, as `json_each(json_extract(...))`
does; a bare warehouse string is malformed JSON and cannot grant access.
Migration qualification must still verify the real customer data and preserve
its text representation. This synthetic contract does not prove arbitrary
noncanonical JSON, duplicate object keys or a live snapshot's contents.

No-op detection normalizes only the absent/non-combined `standItems` value for
comparison. It performs no UPDATE. The raw stored payload, order revision,
`order_list_revision` and manager approval therefore remain unchanged. A real
change increments the order revision once. Existing approvals keep their old
order revision; this slice does not approve, consume or rewrite them.

### Delete

Agents can delete their own drafts. A manager can soft-delete a scoped finalized
order, matching the current route. The stored payload retains unrelated fields
and receives `deletedAt`, `deletedBy` and `previousStatus`; the authoritative row
status becomes `deleted`. JSON is serialized by the same application projection
on both adapters. Original JSON whitespace is not a business guarantee.

Serial cleanup runs only after the precise UPDATE reports one affected row.
This replaces the legacy connection-local `changes()`/settings proof-key with
the successful CAS branch inside the transaction. A stale CAS, SQL failure or
expired post-check leaves both order and serials unchanged. Other orders'
serials, approval history and export references are retained.

## Qualification and schema dependencies

Run the SQLite synthetic contract with the repository's installed dependencies:

```sh
node tools/test-order-draft-sqlite.mjs
```

The shared contract uses two actual adapters against one isolated database. It
covers successful operations and validation errors, national reads versus scoped
writes, historical copies, UUID/number retries, no-op approval preservation,
exact CAS cleanup, fault rollback, queued expiration and caller input mutation.
Each of nine revocations is tested before and after queued create/copy/save/delete
using the real writer lock. The reverse order must preserve the completed draft
operation and block a subsequent request with the stale authority.

The SQLite runner first installs the previously qualified synthetic authority
fixture, then the business fixture. For PostgreSQL integration, install the real
two-phase authority schema builder, copy/seed its metadata before activating its
triggers, and use that schema with this contract. Do not recreate a second
authority schema from the synthetic helper. The business fixture covers the
columns and side effects needed here, derived from `0000_rare_hardball.sql`,
`0010_order_list_revision.sql` and `0013_order_limit_approvals.sql`. It is not the
production DDL migrator and has no production ownership/ACL grants.

Before activation, qualification must establish all of these:

1. Actual PostgreSQL execution of this complete contract against the integrated
   transport and real authority DDL, with exact case/result receipts.
2. Production business schema ownership, ACLs, foreign keys, checks, indexes and
   row-level order-list revision triggers. A no-op must leave the token unchanged.
3. A consistent source snapshot and complete table/sequence/data parity. The
   historical `0001_happy_vertigo.sql` defines `order_payload_archive` triggers,
   while the Node bootstrap does not load that migration. Their live presence
   has not been established in this slice. Inspect the consistent source schema
   and port any existing archive side effect before changing the backend.
4. Migration of every other writer/revoker to the same PostgreSQL lock and
   authority contract before selecting PostgreSQL in a production process.
5. HTTP wiring and real route-level qualification, including error responses and
   offline operation ownership. None of these callsites is changed by this slice.

## Deliberately separate work

Order list/pagination/revision cursor semantics, finalize, limit approvals,
stock/sales checks, export and mail publication, imports, other business domains,
the production DDL/data migrator and recovery/backup are not ported here. No claim
of whole-application PostgreSQL readiness follows from this prepared slice.
