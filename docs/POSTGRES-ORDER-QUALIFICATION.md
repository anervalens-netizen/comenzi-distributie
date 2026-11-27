# PostgreSQL order repository qualification

This prepares an isolated test. It does not select PostgreSQL for the running
application or migrate production records. A source/pure test pass is not an
executed PostgreSQL result.

`tools/test-order-repositories-postgres.mjs` requires an explicit fresh fixture
database, a separately installed database marker, an isolated Unix socket and an
actual PostgreSQL 19 primary. It refuses existing application relations or reused
generated roles/schemas. The external lab must pin the source and runtime,
enforce resource/network isolation, retain raw SQL logs and verify final cleanup.

The fixture executes the real authority create/copy/activate plan, preserving a
synthetic data generation of 11. It then executes the real order schema contract
and runs the repositories through two independent, restricted writer adapters.
The owner role cannot log in. Positive and negative authentication is checked for
the reader and writer. Runtime schema creation and generation deletion/insertion
remain forbidden. No production grants or constraints are relaxed for tests.

The draft contract has 146 cases. The list contract has 138 cases shared with
SQLite and two separately named target schema invariants. SQLite retains all 140
original cases, including the legacy missing/zero/unsafe generation behavior.
Those two invalid-metadata scenarios cannot be inserted through the intended
PostgreSQL writer: the target must return exact constraint/permission errors and
leave the current generation unchanged. The database generation domain is
1 through 9007199254740990. A final migration snapshot must validate that domain
before copy; this test does not authorize normalization or repair of source data.

The 21 original route comparisons are retained. Each comparison reads users,
sessions, assignments, orders and generation in one PostgreSQL snapshot, copies
the fictional records into a fresh in-memory SQLite fixture, and executes the
actual source route declarations there. This avoids translating legacy SQL or
using an independently invented expected response. Seventeen independent
PostgreSQL commits exercise the 15 interleaving scenarios, including three
consecutive changes that must exhaust the two permitted first-page retries.

The repository fixture adds only the four customer columns required by draft
tests. This is not qualification of the complete customer/catalog storage.
Finalization, approval-list routes, exports, notifications, sales/import paths,
backend selection, production data parity and complete application recovery
remain separate integration requirements. Cleanup removes only newly created,
previously absent fixture schemas/roles after closing both runtime adapters.
