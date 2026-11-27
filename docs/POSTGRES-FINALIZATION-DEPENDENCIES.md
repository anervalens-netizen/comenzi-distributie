# PostgreSQL finalization dependencies

This is source preparation for the asynchronous finalization repository. It
does not select PostgreSQL in the application, migrate a business database,
implement the production export store, or authorize production activation.

The existing finalization contract has 79 ordered cases. Its SQLite result
remains byte-identical after using the complete sales table shape and the real
notification recipient foreign key. Four additional input cases compare the
shared customer membership helper against SQLite JSON1 and retain the shared
catalog helper's exact raw values. PostgreSQL execution of this source is a
separate gate; a successful build is not evidence that its SQL executed.

## Component boundaries

| Component | Plan in this change | Runtime authority |
| --- | --- | --- |
| Authority, settings and orders | Reuse the existing explicit builders | Existing restricted application roles |
| Notifications | All ten original columns, recipient foreign key, three indexes | Reader: SELECT. Writer: SELECT, INSERT, UPDATE, DELETE |
| Sales | Four tables, all nineteen sales row columns, six indexes, original import sequence high-water | Application roles: SELECT. Separate importer: SELECT, INSERT, UPDATE, DELETE; sequence USAGE |
| Customers | Four-column test fixture only | Application roles: SELECT only |
| Export publication | Existing lifecycle interface and synthetic store | No production implementation in this change |

Sales has a separate non-login owner and importer role. The builder does not
create roles or grant the importer access to application authority tables.
The final application importer must acquire the same application writer lock
and revalidate authority on its dedicated transaction connection. That caller
and its narrow authority access are not implemented or qualified here. Giving
the importer an application writer membership would bypass the separation and
is not an integration shortcut.

The notification and sales plans are pure values. The caller must use a new,
explicitly owned schema/table set and one transaction: create, copy a validated
snapshot, activate, then commit. These plans do not use `IF NOT EXISTS`, repair
existing objects, seed production rows, or make activation an idempotent
runtime initializer. Re-running sales activation against an existing sequence
is not supported.

## Preserved values and source eligibility

Raw catalog, EAN mappings, customer data and settings stay text. The
finalization repository delegates catalog reading to `readCatalogSnapshot`
on the supplied transaction, then retains its original public projection:
`raw`, `mappingsRaw`, `products`. It still compares both raw catalog inputs
before export staging and under the writer lock.

Customer membership uses `customerWarehouseValues` on the original raw JSON.
SQLite JSON1 uses the first duplicate object key and can expose nested JSON
with its original numeric lexeme. Parsing the object first loses both details.
The new tests reproduce an allow case, a deny case and a nested `1.0` membership
against the original SQLite predicate. This preserves the existing rule; it
does not accept otherwise unsupported JSON5 or surrogate inputs.

Sales keeps historical ASM and regional columns as independent raw source
fields. Text uses C collation; the indexed site key uses ASCII `translate`
and space-only trimming, matching the original SQLite expression. Timestamps
remain text. Integer fields have the safe integer range used by the JavaScript
contract. Quantity remains double precision and cannot be NaN.

A complete copy must validate its actual source snapshot before these stricter
target types are used. Required checks include safe integer range, non-null
primary keys, valid target text without NUL, foreign keys, raw JSON eligibility
and all generation rows. The component tests do not establish eligibility of
live business rows and do not silently normalize or repair them.

Sales import IDs use the exact `sqlite_sequence` value from that same consistent
snapshot. `MAX(id)` alone is insufficient after deletion of the highest import.
Activation refuses a copied ID above the captured sequence. A zero sequence
starts at one; a nonzero sequence advances beyond that captured high-water.
The fixture copies ID 7 with high-water 41 and requires the next ID to be 42.

## Permission checks

Activation checks explicit table and column ACL entries by principal,
privilege type and grant option. Reader entries can only grant SELECT. Writer
table entries can only grant SELECT, INSERT, UPDATE and DELETE; writer column
entries can only grant SELECT, INSERT and UPDATE. Non-owner REFERENCES,
TRUNCATE, TRIGGER, MAINTAIN and grant options are refused. Effective privilege
checks remain in place so inherited authority cannot evade direct ACL checks.

Sales schema access is USAGE only for non-owners. The import sequence grants
only USAGE to the importer, never SELECT, UPDATE or a grant option. Application
roles cannot advance or reset it. Independent negative cases inject writer
column REFERENCES, writer table MAINTAIN and importer sequence SELECT, require
the exact refusal, roll back, and recheck the clean ACL after each case.

These new guards do not change the separately qualified authority or order
builders. Extra-grant rejection in those builders has its own source review and
qualification gate. Previously executed component receipts must retain their
original source identity and scope.

## Verification entry points

```sh
node tools/test-order-finalization-sqlite.mjs
node tools/test-finalization-shared-inputs.mjs
node tools/test-postgres-finalization-dependencies.mjs
```

The first command runs the original 79 cases. The second runs four input cases,
including three actual SQLite JSON1 oracles. The third runs four pure builder
guards and does not connect to PostgreSQL.

The separate `tools/test-order-finalization-postgres.mjs` driver requires an
explicit disposable database, a private Unix socket URL, PostgreSQL 19, a
dedicated database marker and no pre-existing user relations. It verifies all
random schema and role names are absent before the first creation. It never
falls back to an ambient `DATABASE_URL` or production configuration.

The planned PostgreSQL groups are 28 dependency cases, four shared input
cases, all 79 original finalization cases and five integration cases: 116 in
total. The actual ordered case IDs must match the frozen source and the
original SQLite receipt, not merely the count. Deliberate negative SQL is
bounded by exact code, message and count: 21 permission/constraint errors and
three failed password authentications. Unexpected errors still fail the run.

All repositories in that driver use the restricted application writer role.
Separate, explicitly named privileged fixture adapters seed and reset synthetic
inputs and simulate independent administrative/import commits. They use the
same transaction adapter and writer lock, but are not production importers.
The receipt exposes this distinction. It also records that the customer
triggers and production export store are unqualified.

The external lab must supply the reviewed image, process isolation, total
resource budget, private socket, durable execution identity, strict raw log
classification, exact cleanup and production continuity proof. The driver
alone is not a production migration runner. No database execution is implied
by this document.

## Remaining activation gates

Customer writes still depend on thirteen direct customer triggers, three
indirect partner profile triggers, related tables and the activation view.
County repair, aliases, coordinate invalidation, raw JSON behavior and exact
portfolio/directory generation increments need original SQLite oracles and
an explicit PostgreSQL preservation contract. A four-column SELECT fixture
does not replace that work.

Further gates include the real sales importer and revocation access on the
same lock, a durable export lifecycle with recovery for unknown commit/staging
outcomes, actual source data eligibility and copy parity, and integration of
all business writers before the runtime database selector changes. No
finalized-to-draft reopen transition is introduced; the existing copy flow
creates a new draft.
