# Prepared asynchronous catalog and customer reads

This slice prepares reads for the existing asynchronous SQL adapters. It does
not select PostgreSQL, change routes, start workers, or deploy the application.
The source includes the existing nullable weekly order limit behavior unchanged.

## Scope and call sites

| Existing read | Prepared implementation | Preserved behavior |
| --- | --- | --- |
| `lib/catalog.ts` `readCatalog` | `readCatalogSnapshot` | Exact settings text, override order/deletion, imported EAN matching, explicit empty EAN, product versions |
| Authenticated catalog and manager catalog GET | `CatalogCustomerRepository.readCatalog` | Session, active account, manager password requirement; optional manager-only check |
| Catalog photo GET | `readProductPhoto` | Exact key and content-hash prefix, filename grammar, bytes and response headers |
| Clients GET | `listCustomers` | Agent's own warehouse, national manager read access, assignment fallback, active rows, ID order, raw version hashes |
| Bootstrap warehouse list | `visibleWarehouses` | Seed order, national manager read access, agent warehouse, assignment fallback |

All four repository methods read the session, current account and business rows
in one adapter read transaction. Time is obtained after entering that snapshot.
They do not request a writer lock or grant new mutation authority. A concurrent
committed revocation affects the next read; the current read remains internally
consistent. HTTP session refresh and route wiring remain separate work.

`readCatalogSnapshot(tx, quotedSchema, seedProducts)` accepts the caller's
existing `SqlReader`, including a writer transaction. It never opens another
transaction or connection. It returns `{raw, mappingsRaw, state, products,
mappings}`. Finalization can bind the exact two raw settings values to its own
conditional write. The schema must be the result of `sqlIdentifier`, and the
seed is copied before the first await. Each repository owns a private seed copy.

## Customer membership and source eligibility

The legacy list predicate is:

```sql
EXISTS (
  SELECT 1
  FROM json_each(COALESCE(json_extract(data, '$.warehouseIds'),
                          json_array(warehouse_id)))
  WHERE value = ?
)
```

The warehouse parameter is a string. Numeric and boolean JSON values are not
converted into string memberships. Missing or JSON-null `warehouseIds` uses the
row's warehouse; an empty array does not. An embedded JSON string is parsed
twice, as with `json_extract` followed by `json_each`.

`customerWarehouseValues` preserves the first matching duplicate property,
escaped property names, nested compact JSON text, numeric lexemes and duplicate
nested keys. The original row text remains unchanged. The response continues to
use native `JSON.parse`, which selects the last duplicate object property. A
manager's version hashes the original row text, including whitespace. No JSONB
conversion or reserialization is used for membership or optimistic versions.

The implementation has an explicit eligibility limit. Native SQLite also
accepts JSON5 forms that this prepared implementation refuses. The contract
retains witnesses for non-ASCII whitespace, trailing commas, single quotes and
comments in an embedded membership document. Isolated Unicode surrogates in
decoded membership strings also differ between SQLite and JavaScript; they are
refused, not replaced. Valid surrogate pairs, escaped NUL membership values and
opaque nested surrogate escape lexemes have separate native oracle cases.

The **exact final-snapshot predicate** is the exported
`customerMembershipEligibility(data, warehouse_id).eligible`. The migrator must
run it on **every** customer row, including inactive rows, from the same
consistent snapshot used for the migration. All results must be true. A false
result blocks migration and records its reason and row identity privately. It
must not skip the row, rewrite JSON or substitute the fallback warehouse.
This slice implements the predicate but does not claim that the actual source
snapshot passes it.

The predicate invokes the same projection used by the repository. It requires
strict JSON in the source document and any decoded membership document; limits
container nesting to 1000; rejects malformed source Unicode and isolated
surrogates in decoded membership text. It preserves duplicate and escaped key
semantics. A simple `json_valid(data)` check is therefore insufficient. General
PostgreSQL TEXT eligibility, schema compatibility and other source invariants
remain separate migration gates. An unexpected implementation error is thrown,
not converted into an eligible result.

Only customer list membership is covered. `getUsers` and `clientCount` have a
different SQLite `CAST(value AS TEXT)` contract, including `1` versus `1.0` and
nested JSON lexemes. They are not ported here and must not reuse this projection
as a count implementation. Customer writes/imports, catalog/photo mutations,
reports and exports are also outside this slice.

For PostgreSQL, ID order uses `COLLATE "C"`; SQLite uses binary order. A NUL in a
photo-key or fallback warehouse request is compared through UTF-8 bytea only for
that parameter, preserving the accepted request without sending NUL as PostgreSQL
TEXT. Ordinary parameters retain normal indexed text comparisons.

## Verification

Run the synthetic contract with the repository's pinned dependencies:

```sh
node tools/test-catalog-customer-sqlite.mjs
```

The runner creates and removes only its exclusive temporary SQLite databases.
It does not import the production runtime. It extracts the original catalog,
warehouse and customer read declarations with Acorn and bundles those exact
declarations as independent legacy oracles. It records the native SQLite
version, case IDs, original-source comparisons and independent WAL commits.

The reusable contract exercises raw catalog text and EAN/version behavior,
photo bytes and grammar, customer type/duplicate/scope rules, all four read
methods under session/account/password revocation, clock timing, and five
independent commits while a read snapshot remains open. The JSON1 oracle reports
supported projection cases and explicit source-ineligibility witnesses as
different categories. A refusal witness is not a parity success claim.

PostgreSQL execution of this contract is a separate required qualification. The
customer fixture contains only the four business columns used by these reads;
the actual customer DDL still requires its own snapshot audit and qualified
builder. The repository scans active raw customer rows once and filters the
membership projection in JavaScript. Production transfer, memory and timing
have not been measured. Those capacity checks remain required before wiring.

The current route, runtime selector, existing synchronous implementation,
nullable weekly limit behavior, package files and CI remain unchanged.
