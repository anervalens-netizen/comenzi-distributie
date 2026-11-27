# Prepared asynchronous user list and customer counts

This source slice prepares `getUsers` and its `clientCount` projection. It does
not connect HTTP routes, change backend selection, execute PostgreSQL or enable
a second business-data store. The existing nullable weekly limit is unchanged.

## Read contract

`UserReadRepository.getUsers(identity, managerOnly = false)` reads the session,
current account, visible users, manager assignments and active customers in one
adapter read transaction. Time is read after entering the snapshot. A manager
keeps the existing national read scope, including inactive users. A nonmanager
keeps the existing self-or-assignment filter. `managerOnly` is an explicit
additional check for a caller whose current endpoint requires a manager.

The read preserves the existing `userView` fields: active state, manager scope,
profile version as text, manager-only password flag, warehouse label fallback,
site code, activation-pilot permission and manager assignment IDs. Credential
and session fields are not returned. Activation permission uses the existing
policy function and configuration. Account rows must also satisfy the already
separate authority-schema eligibility constraints.

Users remain ordered by role descending and then name, with SQLite binary and
PostgreSQL `C` collation. Equal role/name ties remain unspecified, as in the
existing query; no hidden ID tie-breaker was added. Manager assignment IDs retain
binary order. Inactive assigned agents remain visible in that list.

`readUsersWithClientCounts(tx, quotedSchema, viewer, warehouses)` is composable
inside an existing read or writer transaction. It opens no nested transaction.
Its internal caller must authenticate `viewer` in that same transaction. The
helper copies the supplied viewer and warehouse seed before its first await.
It grants no write authority. A concurrent committed role change, revocation,
assignment change or customer update is visible on the next read; the current
response does not mix snapshots.

Existing call sites include bootstrap and the responses after manager/account,
customer and import mutations. They still call the synchronous function. Wiring
must preserve their existing endpoint permission and write-authorization guards
and must choose the appropriate caller-owned transaction or post-commit read.
No mutator is modified by this slice.

## Exact count keys and bounded eligibility

The current `selectUsersWithClientCounts` CTE casts each `json_each` value to
SQLite TEXT, deduplicates `(customer primary key, warehouse key)`, then counts
each warehouse. That differs from the customer-list predicate, which compares a
bound string without TEXT-column affinity.

`customerWarehouseCountKeys` retains the original JSON token text. Supported
keys preserve these rules:

- String values remain exact, including empty strings and escaped NUL.
- Boolean values become `"1"` or `"0"`.
- Integer tokens in the signed 64-bit range become exact decimal strings using
  `BigInt`. Integers above JavaScript's safe-number range retain every digit.
- Nested object/array values are already SQLite TEXT; their compact JSON,
  number lexemes, escaped keys and duplicate keys are preserved.
- Missing or JSON-null `warehouseIds` uses the row warehouse; an empty array
  stays empty. Embedded JSON strings are parsed twice.
- NULL keys never join a user warehouse. Other duplicate keys count only once
  for each primary-key customer, even when numeric and text aliases coincide.
  A JSON payload's `id` does not replace the row's primary key.

SQLite REAL formatting is **not** approximated. `1.0`, `1e0`, negative real zero,
fractions, exponent forms, integer overflow and infinities remain an explicit
eligibility limit when they occur as the scalar `json_each` value. For example,
native SQLite distinguishes the cast keys `"1"` and `"1.0"`. The native contract
retains acceptance/refusal witnesses for these forms; a refusal witness is not
claimed as PostgreSQL parity. Numbers inside nested JSON text remain supported
because their lexical representation is retained, not numerically formatted.
Integer tokens longer than 19 digits are refused before `BigInt` conversion.

The final consistent migration snapshot must pass both exported predicates on
**every customer row, including inactive rows**:

```ts
customerMembershipEligibility(data, warehouse_id).eligible
  && customerCountMembershipEligibility(data, warehouse_id).eligible
```

Any false result blocks migration, with the reason and row identity retained
privately. It must not normalize data, silently skip a customer or substitute a
fallback. These predicates do not replace PostgreSQL TEXT, authority-schema or
other business-data eligibility gates. Future customer write/import paths must
preserve the supported contract before the backend can be enabled. This source
slice does not claim that the actual production snapshot is eligible.

## Verification and remaining gates

```sh
node tools/test-user-client-counts-sqlite.mjs
node tools/test-catalog-customer-sqlite.mjs
```

The new runner creates exclusive synthetic SQLite databases, extracts the
original CTE, `getUsers` and `userView` declarations with Acorn, and compares
complete responses against those original functions. The oracle reads all its
tables in one dedicated read-only SQLite transaction, executing the original
CTE unchanged without widening the application adapter's SQL allowlist.
Native SQLite `CAST` probes separately record
supported keys, unsupported REAL witnesses and shared eligibility refusals.

The reusable repository contract covers permissions, flags, counts, duplicate
and lexical memberships, ordering, metadata shape, clock timing and read-only
behavior. Independent worker connections commit while reads remain open to
exercise role, session, profile, warehouse, assignment and customer changes.
The observed portfolio revision remains the same within each open snapshot.
The existing catalog/customer suite must still pass after the shared lexical
helper extension.

PostgreSQL execution with the actual authority/customer DDL remains a separate
required qualification. The SQLite fixture supplies only the customer columns
used by these reads. All active raw customer rows are scanned once per user
list, then grouped in JavaScript. Production transfer, memory and latency have
not been measured; this capacity gate remains open. Reports and other consumers
of the old CTE are separate ports and must not be reported as wired by this
change.
