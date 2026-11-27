# Customer storage and asynchronous writer port

## Current scope

The native storage oracle is implemented. It uses synthetic rows and the exact
SQLite definitions and creation order of the customer dependency schema.
Application routes, runtime selection and deployed databases are unchanged.
The PostgreSQL customer schema and the asynchronous business writer are not
implemented or qualified by this oracle.

Run the oracle with:

```sh
node tools/test-customer-storage-sqlite.mjs
```

The runner emits a JSON receipt. It includes the Node and SQLite versions,
source hashes, ordered case identities, raw before/after rows, errors from
intentional failures and statement timestamp bounds. A failed case is recorded
before the runner returns nonzero. It never connects to an external database.

The fixture contains 29 explicit schema objects, including 13 customer triggers
and three partner profile triggers. It omits only implicit indexes with no SQL
definition. It verifies its recreated definitions and order against the fixture
before supplying a connection. Foreign keys are enabled and recursive triggers
are disabled, matching the application connection's relevant behavior.

The `users` table in this storage-only fixture is a minimal foreign-key parent.
It does not qualify account authorization. The later business writer contract
must use the complete authority schema and its dedicated transaction client.

## Effects that the port must preserve

| Area                  | Required behavior                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw customer data     | Preserve TEXT exactly on direct assignment. Only an original JSON mutation operation may change its representation.                                                                                                                                                       |
| Generations           | Every actual matching customer update advances data and CRM generations, including a no-op update. Profile writes advance only the data generation. No customer storage operation advances authority scope generation.                                                    |
| Dirty identities      | Retain both old and new customer identifiers after a rename. Keep deleted identifiers in the dirty queue.                                                                                                                                                                 |
| Activation membership | Use the first `warehouseIds` member, accept text array elements only, deduplicate, and require `active=1`. Missing and JSON null use the row warehouse. Other types and invalid JSON do not.                                                                              |
| County override       | Apply on insert and every update. Installing the override alone is not retroactive. Preserve nested update effects.                                                                                                                                                       |
| Alias repair          | Apply only when an UPDATE mentions `active`. Installing an alias or updating only `data` does not deactivate it. There is no installed alias insert repair.                                                                                                               |
| Profile address       | Compare the first address, city and county members with native SQL value semantics. Preserve numeric versus text distinctions, first duplicates and compound JSON lexemes. Clear all position fields and advance the profile revision when the native comparison changes. |
| Timestamps            | Validate the actual millisecond UTC timestamp against the write's time window. Resets within one SQL statement share a timestamp. Raw observed timestamps remain in the receipt.                                                                                          |
| Transactions          | A stale CAS changes nothing. Failed constraints and outer or nested rollback restore every derived table and generation.                                                                                                                                                  |
| Foreign keys          | Profile and alias references prevent deletion or rename of referenced customers. Coordinate and source checks remain effective.                                                                                                                                           |
| Consumer index        | Preserve the native JSON1/TEXT and ASCII GLOB predicate, including first duplicate members, inactive rows and lexemes of compound JSON.                                                                                                                                   |

The county repair is not one extra update in every case. With a strict JSON
array or scalar root, `json_set` cannot add an object member. The native insert
therefore fires three customer row events in total; a later update
fires two. The active instance of the update repair trigger is suppressed by
SQLite's recursive-trigger rule. A direct recursive PostgreSQL translation can
loop forever. Replacing the sequence with one generation increment is also
incorrect.

On an object with a changed county, an application update followed by county
repair can reset the partner profile twice. That advances the data generation
four times and the CRM generation twice. The oracle preserves these outcomes.

## Native edges and eligibility

Case receipts identify ordinary storage cases separately from native SQL/index
or eligibility edges. This distinction is explicit evidence for subsequent
gates. It is not a PostgreSQL pass or an automatic waiver.

SQLite's alias primary key has no `NOT NULL` declaration and permits multiple
NULL aliases. `INSERT OR REPLACE` does not fire its implicit delete trigger with
recursive triggers disabled. JSON5 is accepted by some native JSON functions
but fails strict `json_valid`. Escaped NUL can produce a SQLite text membership
that PostgreSQL TEXT cannot store. Excess JSON nesting can remain raw TEXT while
failing the JSON validity test. Each behavior has its own native case.

A future consistent migration snapshot must run the explicit JSON/TEXT and
column eligibility checks on every relevant row, including inactive rows. The
port must either preserve the recorded semantics or reject a specifically
identified unsupported row before activation. It must not silently parse with
JavaScript object semantics, rewrite as JSONB, discard duplicate members or
approximate numeric and compound-value comparisons.

## Next closed business flow

The first asynchronous repository will cover manager client editing and client
import preview/apply. It must acquire the application write gate before reading
authority, retain the actor and raw snapshot CAS checks, and perform every
business read and write on that same transaction client. Shared portfolio,
removed-row confirmation and final snapshot checks remain part of the import.
Trigger-induced changes must not be hidden by replacing those checks.

Partner registration is a separate integration gate. Its request update,
customer insertion or membership append, and confirmation comprise one atomic
three-operation flow. Notification publication happens after commit. A
composable customer primitive alone does not qualify that complete flow.
Initial seeding and offline repair utilities also require separate disposition.

The PostgreSQL builder, exact object grants, parser helpers and role boundaries
will be reviewed after the native oracle. Actual PostgreSQL qualification will
then cover the same storage effects, the closed writer's authorization and race
contract, and failures at the transaction boundary. No application selector is
enabled by these source files.
