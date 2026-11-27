# Prepared asynchronous order list reads

This slice implements `OrderListRepository.listOrders` and `listOrdersPage` on the
explicit asynchronous SQL adapter. It does not activate a backend selector, change
an HTTP route, finalize an order, grant an approval or publish an export. The draft
writer and its authority checks remain separate and unchanged.

## Scope and result

The constructor receives the database adapter, application schema and an injected
epoch-millisecond clock. Each method receives a `SessionIdentity`. The repository
checks the current session and active user inside its read snapshot. A manager
that must change a password gets the existing 428 requirement. Agents keep their
own order scope. All managers, including assigned managers, retain national read
scope; this grants no additional write authority.

`listOrders` returns compact orders. `listOrdersPage` returns `orders`, the existing
`orderPage` fields, and `weekKey` computed from the same attempt clock as its weekly
statistics. The future route integration can use this `weekKey` instead of taking
a separate wall-clock sample after the query. `OrderListChangedError` carries
status 409 and `currentRevision`; the HTTP layer still needs to map its existing
localized response. No route currently calls this repository.

The copied parameter set cannot be changed while a read is queued. Calendar ranges
use the existing `bucharestDayStartUtc` helper and Europe/Bucharest calendar days.
Drafts remain visible regardless of age. A finalized timestamp falls back to its
created timestamp only when SQL NULL, matching `COALESCE`. Timestamps remain text
for legacy filtering/cursors; they are not silently reparsed as instants.

## Snapshot and concurrent writes

Each page attempt uses one adapter read transaction for session, manager/agent
filters, the list revision, count, rows and statistics. It then closes that
snapshot and reads the revision in a second transaction. A second read in the
same PostgreSQL `REPEATABLE READ` snapshot could not detect a concurrent commit.

An unbound first page retries at most twice after a changed revision. A page
bound to a cursor or a nonempty expected revision immediately returns 409. Three
unstable first-page attempts also return 409. No application read is replayed as
a write. As with the original API, a commit after the final revision observation
is possible; the returned page is still internally coherent and carries its
revision for the next request.

Every INSERT/UPDATE/DELETE on the eventual production orders table must retain
the order-list revision trigger contract. Import/publication writers must use it
as well. A schema without that contract is not qualified by these read tests.
The existing zero/missing singleton fallback remains `"1"`; out-of-range BIGINT
values are refused rather than converted with loss of precision.

## Preserved filtering and ordering

- Limits preserve the current default, clamp and safe-integer rules.
- Manager filters include inactive agents, validate an active assigned manager,
  and preserve `__unassigned`: assignment to a global or inactive manager alone
  does not count as an active region assignment.
- `orders` excludes SIM and client-stand orders; `sim` includes both.
- Counts apply the row filters and search before the cursor. Statistics apply
  only authenticated scope, manager/agent filters and kind. Status, range, search
  and cursor do not narrow the statistics.
- Search remains JavaScript NFD, combining-mark removal and Romanian lowercasing
  across number, historical agent/warehouse names and client name/CUI.
- Page SQL order is `created_at DESC, id DESC`, with PostgreSQL `COLLATE "C"`
  and SQLite binary collation. The search branch retains its original JavaScript
  string cursor comparisons. The difference between UTF-8 SQL order and UTF-16
  JavaScript comparisons is explicitly covered; this slice does not redefine it.
- The existing cursor JSON shape and length checks are retained. No new timestamp,
  identifier or canonical-base64 restriction is introduced.

One deliberate stabilization was approved: the unpaged legacy list now also uses
`id DESC` when created timestamps tie. Its prior tie order was unspecified. This
aligns it with the already explicit page order.

SQLite keeps the original JSON1 compact projection. PostgreSQL has an explicit
JSONB expression removing the same large fields and computing the same item
count. Parsed JSON values and ordered rows are the comparison contract, not JSON
object key byte order. Historical malformed/non-object payloads and duplicate
keys still require a migration-data disposition; these fixtures do not certify
arbitrary invalid stored JSON.

## Verification and remaining work

`tools/order-list-contract.mjs` is reusable by a caller-owned PostgreSQL fixture.
It covers compact payloads, scope, filters, diacritics, pagination, cursor edge
values, statistics, DST/week transitions, session guards and concurrent changes.
The SQLite runner uses the actual adapter and an independent worker connection
to the same temporary WAL file. That writer commits while the reader snapshot is
still open, so count/row/statistic coherence and the fresh revision read are
tested separately. Cases that only queue a writer do not substitute for that test.

The SQLite runner also transpiles the original TypeScript with the installed
esbuild and extracts route/helper declarations with the installed Acorn parser,
without importing the live runtime. It runs their real SQL and
search/page logic against the same synthetic data, with a fixed clock. The oracle
does not rewrite query text or replace expected results with the new implementation.

The original published SQLite contract passed **132 cases**, including **21 original-route
oracle comparisons** and **15 independent-writer interleavings**. The latter hold
the reader snapshot open until the other connection has committed; they verify
both snapshot coherence and rejection/retry from the separate revision read.
Strict TypeScript checking passes. Verification receipts are recorded in the
change handoff. PostgreSQL execution and
HTTP integration are not claimed by local/SQLite tests. The full port still needs
the production business schema/privileges and revision triggers, PostgreSQL
qualification of this exact contract, all remaining business writers, finalization,
limits/approvals, exports, import/report publication, full database generation
consistency and migration/recovery gates. The backend selector remains off.

## NUL cursor compatibility

The existing cursor grammar accepts NUL in either the timestamp or order ID.
PostgreSQL cannot bind such a value as `text`. The prepared repository therefore
uses a UTF-8 `bytea` comparison only for a cursor field containing NUL. Its bound
value is a byte array; ordinary cursor fields retain the indexed text predicate.
This preserves SQLite binary ordering without rejecting a previously valid
cursor. Search continues to apply its existing JavaScript string comparison and
does not send cursor strings to SQL.

The original 132 contract cases and 21 original-route comparisons remain intact.
Eight additional cases cover timestamp/ID/both/neither containing NUL, with and
without search. They check the actual repository's parameter construction and
native SQLite results. A synthetic PostgreSQL-dialect guard within the SQLite
suite proves no NUL reaches a text parameter; it does not prove PostgreSQL
execution. The same contract must also run through the real PostgreSQL adapter.
