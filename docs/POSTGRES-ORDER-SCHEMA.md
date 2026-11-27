# Prepared PostgreSQL order schema

This is a pure schema plan. It does not open a connection, select a runtime
backend, copy live data, create a role or deploy the application. The order
draft and list repositories still require their own real PostgreSQL parity
tests and integration with the complete application.

## Scope and activation

`postgresOrderSchema` prepares four tables in the same schema as the authority
tables: `orders`, `serials`, `order_list_revision`, and `order_limit_approvals`.
The schema must already belong to the authority owner, with the six authority
tables and the configured reader/writer access. The complete role-separation
guard is reused from the versioned authority plan. A changed guard layout is a
refusal that requires review; it cannot silently skip the precondition.

The caller must use one explicit transaction:

1. Create the authority schema and the order tables.
2. Copy validated source rows, including the original portfolio and order-list
   generations. Copy dependent users before orders, and orders before serials
   and approvals. Do not start application writers.
3. Activate the authority and order plans, then commit the complete operation.

The plan does not use `CREATE ... IF NOT EXISTS`, replace existing objects, seed missing
metadata or delete an existing archive. A missing generation prevents
activation. The order trigger also refuses a later write when its singleton
generation is absent. A failed statement rolls back the enclosing transaction.

## Preserved storage behavior

| Source behavior | PostgreSQL plan |
| --- | --- |
| Order IDs, serials and order numbers | Text keys; exact values and leading zeros remain intact |
| Unique order number | Explicit `orders_number_unique` index |
| User, order and approval references | Foreign keys with `NO ACTION`; no cascade |
| Historical `source_order_id` | Nullable text; no new foreign key |
| Payload, manager IDs and violations | Text; no parse, JSONB rewrite or key reordering during copy |
| Created/finalized/decision timestamps and week keys | Text; no timezone conversion during copy |
| Text equality and indexed ordering | `COLLATE "C"` to preserve binary comparisons |
| Per-order and approval revision | Explicit application increment; no automatic row-revision trigger |
| List generation | One increment per affected order row for each INSERT, UPDATE or DELETE |
| Unchanged UPDATE | Still increments the list generation, matching the source trigger |
| Zero-row statement | No list-generation increment |
| Approval status | Existing pending/approved/rejected/consumed constraint |

The plan retains the user/date, user/date/ID, date/ID, weekly-order, serial-order
and approval scope/date/unique-input indexes. Revisions use bounded `bigint`,
from 1 through 9,007,199,254,740,990. This leaves the application an exact
JavaScript integer boundary and refuses an overflowing increment. Copy
eligibility must establish these bounds and nonnull primary keys; the plan
does not repair historical violations.

The three order triggers use a security-invoker function with a fixed
`pg_catalog` search path and fully qualified table names. An order mutation and
its generation update commit or roll back together. Serial and approval writes
do not independently change the list generation.

## Privileges

The existing owner, reader and writer roles remain separate. The reader can
select the four order tables. The writer can select, insert, update and delete
business rows, and can update only the `revision` column in
`order_list_revision`. It cannot create schema objects, truncate tables, delete
the generation singleton or modify its ID. The reader has no execution grant
on the generation function. The writer has no `TRIGGER` or `REFERENCES` grant.

Activation checks effective permissions and rejects foreign default table,
column or function grants. The authority role guard also rejects administrative
capabilities and privilege-changing role memberships. The reader is an internal
application role, not a public analytics account.

## Required source eligibility

This plan requires an explicit `payloadArchive: 'absent'` disposition. A
consistent source snapshot must independently confirm that an order payload
archive and its associated triggers are absent. If an archive is present,
preserve it and prepare a separate versioned mapping. Do not discard it or
substitute an empty table. The target precondition also refuses an existing
archive relation.

The full snapshot must validate table/column/trigger scope, keys, foreign keys,
nullability and integer ranges before copying. It must preserve every text
value. List projection uses PostgreSQL JSONB expressions after copying, so
malformed or nonobject payloads, duplicate JSON keys and other JSON1/JSONB
differences need a measured disposition before runtime activation. Storing the
original text does not by itself certify projection equivalence.

This plan does not supply customer/catalog storage, export-file publication,
finalization, reopen, approval decisions, weekly-limit behavior, import ledgers
or runtime wiring. Those operations retain their separate authority, atomicity
and consistency requirements.

## Verification

The pure builder contract checks identifier and role validation, explicit
archive disposition, immutable input capture and create/copy/activate
separation. It opens no database.

The reusable PostgreSQL contract requires an attested disposable database and
the real authority schema. It tests copied generations and lexical payloads,
three row triggers, explicit row revisions, multirow and zero-row behavior,
rollback, key/reference failures, approval history, restricted grants,
foreign default grants and missing generation failure. The caller owns exact
fixture cleanup. These tests are qualification code until a recorded execution
passes; their existence is not evidence that PostgreSQL behavior has passed.
