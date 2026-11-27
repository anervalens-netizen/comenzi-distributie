# Customer storage and asynchronous writer port

## Current scope

The native storage oracle and the manager edit/client import repository are
implemented and qualified on synthetic SQLite fixtures. The native oracle uses
the exact SQLite definitions and creation order of the customer dependency
schema. Application routes, runtime selection and deployed databases are
unchanged. The PostgreSQL customer schema and actual PostgreSQL execution of
these new customer flows remain separate gates.

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

## Closed manager edit and import flow

`CustomerWriteRepository` covers manager client editing and client import
preview/apply. It acquires the application write gate before reading authority,
retains the actor and raw snapshot CAS checks, and performs every business read,
write and response read on the same transaction client. Shared portfolio,
removed-row confirmation and final snapshot checks remain part of the import.
The current request's actor and body are captured before any asynchronous wait.
The existing authority helper rechecks the session, role, profile and portfolio
scope before commit. Customer data generations do not replace authority scope.

Run the closed flow contract with:

```sh
node tools/test-customer-writes-sqlite.mjs
```

The contract has 69 cases and 54 original-code comparisons. It extracts the
original client edit branch and import function, executes them on an exact copy
of the synthetic SQLite fixture, and compares the resulting business values,
errors and all relevant stored rows. The legacy edit comparison projects the
client response; it does not run the original HTTP transport or `getUsers`.
The new response uses the separately qualified, composable user/count helper
and checks representative counts without opening a second transaction.

The contract includes an actual `SessionRepository.logout` racing a waiting
import, failures after mutation with rollback, whole-set and per-row CAS guards,
late expiry and request-body mutation while queued. Profile timestamp values
are retained in both raw observations and separately validated against their
own statement windows before semantic comparison. Failed cases retain their
completed case identities and raw oracle observations.

The import initially reads the ordered customer snapshot on its writer client
and uses the existing lexical JSON1 membership helper. It preserves first
duplicate members, SQL value types, raw fields and preview SHA property order.
This implementation still requires a representative volume/performance gate.
A later SQL/index optimization must retain these exact scope and ordering
semantics. Snapshot eligibility for the shared membership/count helpers remains
explicit; unsupported JSON values are not silently normalized.

If a county or alias trigger changes an imported row away from the expected
final set, the import rolls back. The edit method preserves the current route's
prepared response/version behavior, including the case where county repair
changes the stored raw data after the explicit UPDATE. That behavior is covered
by an original route comparison rather than silently changed during the port.

Partner registration is a separate integration gate. Its request update,
customer insertion or membership append, and confirmation comprise one atomic
three-operation flow. Notification publication happens after commit. A
composable customer primitive alone does not qualify that complete flow.
Initial seeding and offline repair utilities also require separate disposition.

The PostgreSQL builder, exact object grants, parser helpers and role boundaries
will be reviewed after the native oracle. Actual PostgreSQL qualification must
cover the same storage effects, the closed writer's authorization and race
contract, and failures at the transaction boundary. A nullable UNIQUE alias
column is one candidate for preserving SQLite's nullable primary-key behavior;
the native edge remains measured while that schema choice is evaluated.
No application selector is enabled by these source files.
