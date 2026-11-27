# PostgreSQL migration preparation

This tooling prepares complete, versioned evidence for the application database
migration. It does not change the running application, rewrite its SQL, create a
PostgreSQL database or perform cutover. All input and output paths must be supplied
by the operator. Do not commit generated manifests, schemas or data fingerprints:
they describe a private installation.

## Scope and behavior that must be preserved

The migration covers eight principal databases and two derived databases. The
activation report databases count as part of the principal migration scope even
though their contents are generated from ledgers: they are published together and
the application requires the compatible pair.

| Key | Relative location | Main consumers and conversion requirements |
|---|---|---|
| `application` | `mobiup.sqlite` | `runtime-node.ts`, operational mutations, sessions, orders, stock, manager chat and billing. Preserve the authorization check and mutation in one serialized transaction, revision triggers, account revocation, order approvals and exact money units. |
| `sales` | `sales.sqlite` | `sales-store.ts`, `import-engine-sales.ts`, sales reports and order limits. Preserve import idempotency, monthly active import selection, revisions, integer cents, location normalization and transactional authorization. |
| `usage` | `usage.sqlite` | `usage-store-node.ts`. Preserve session identity, pulse sequence monotonicity, visit closure and atomic throttling. |
| `history` | `client-history/client-sales-history.sqlite` | `client-history-import-node.ts`, `historical-sales.ts`, client reports and reconciliation. Preserve source imports, logical epoch/revision, incremental allocation and historical coverage. |
| `vodafone_ledger` | selected activation generation / `activations.sqlite` | Activation importer, `activation-store-node.ts`, provider-specific reports. Preserve complete-import identity, canonical facts and generation publication. |
| `vodafone_report` | same generation / `activation-report.sqlite` | `activation-distribution-node.ts`, partner pages, summary/detail/export. Preserve source generation/import-set agreement, filters, limits and ordering. |
| `digi_ledger` | selected Digi generation / `activations.sqlite` | Separate provider ledger. Preserve provider authorization and source chronology; do not merge it implicitly with another provider. |
| `digi_report` | same Digi generation / `activation-report.sqlite` | Separate provider report pair and the combined authorized view. Preserve publication and selected-month semantics. |
| `partner_activity` | `client-history/partner-activity.sqlite` | `partner-activity-snapshot.ts` and incremental activity. Reference copy only: rebuild and validate against history and catalog revisions after conversion. |
| `vodafone_focus` | selected activation generation / `vodafone-focus-evidence.sqlite` | `vodafone-focus-evidence-node.ts`. Reference copy only: rebuild and validate against its source generation and rules. |

The activation root may be configured separately from the application data root.
The tool supports the application's published `current -> generations/<id>` layout.
It refuses ambiguous or unsupported legacy layouts instead of choosing a file by
modification time. An absent derived database is recorded as
`missing_rebuild_required`; an absent principal database is an error.

## Why a driver replacement is insufficient

`runtime-node.ts` provides an asynchronous D1-shaped interface on top of synchronous
`DatabaseSync`. Other modules use synchronous connections directly. The database
contract includes SQLite writer locking, process-local SQL functions, `ATTACH`,
SQLite trigger bodies, placeholder syntax, JSON/date functions and file identities.

`BEGIN IMMEDIATE` currently serializes authorization and publication with account
revocation. PostgreSQL's default transaction behavior is different. A replacement
must use an explicit row/advisory-lock or equivalent serialization protocol and
prove the same revocation races. Merely changing it to `BEGIN` is not sufficient.

The main Drizzle schema does not describe all auxiliary databases. Actual catalogs,
inline DDL and importer schemas must be reconciled. Integer booleans and integer
currency must retain the application's SQL semantics. SQLite's permissive typing,
nullable primary keys, generated columns, sequences and trigger-driven revision
counts require explicit rules. The inventory reports candidate types but never
executes a guessed DDL translation.

The portable publication model must retain logical generation identities.
Filesystem inode/WAL stamps cannot be copied into a PostgreSQL cache key. Report
readers need one pinned publication and a compatible source/report pair for the
whole request, including pagination and exports.

The durable import queue/journal is a separate database dependency. Migrating
application SQLite data does not migrate that service, and changing its server
version does not convert the application data.

## Commands

These are operator templates. Substitute explicit local private paths and the
exact source revision. No command has a production data-directory default.

Run the synthetic regression suite:

```sh
cd tools/sqlite-migration
python3 -W error::ResourceWarning -m unittest -v test_sqlite_migration.py
```

Read catalogs and bounded publication metadata, without scanning business tables:

```sh
python3 tools/sqlite-migration/sqlite_migration.py inventory \
  --data-root /private/application-data \
  --activation-root /private/activation-data \
  --source-revision FULL_SOURCE_COMMIT \
  --output /private/migration-evidence/catalog.json
```

Copy the complete scope into a new temporary directory:

```sh
python3 tools/sqlite-migration/sqlite_migration.py snapshot \
  --data-root /private/application-data \
  --activation-root /private/activation-data \
  --source-revision FULL_SOURCE_COMMIT \
  --output-dir /private/local-scratch/migration-copy \
  --max-bytes EXPLICIT_BYTE_BUDGET \
  --deadline-seconds 1800
```

The default `quiescent` mode samples every source's `data_version` before any read
snapshot is pinned, then checks every connection after all copied read transactions
are released. Any intervening commit refuses publication. The operator should
first fence all writers for a final cutover capture; the tool does not stop them.
In a busy preparation session, `--consistency per-database` can produce individually
consistent copies, but its manifest explicitly reports
`cross_database_consistency_verified=false`. Do not use that mode as a final
cross-database consistency certificate.

Both modes acquire the same shared activation-publication locks as `deploy/backup.py`,
without creating a missing lock. They pin each generation once, validate the actual
copied ledger/report pair's `sourceGeneration` and complete `sourceImports`, and
reject generation/path replacement. A busy exclusive publication lock fails
immediately. Holding these shared locks delays cooperating import publication until
the bounded capture finishes; schedule the operation accordingly.

The tool uses SQLite's backup API, seals each destination without an external WAL,
checks structure and foreign keys, records schema/sequence evidence and computes
file checksums. It does not copy source spreadsheets, exports, runtime files or
private configuration. Keep the established full recovery backup for those assets.
This migration copy is not a replacement for that backup.

Generate deterministic whole-table reference fingerprints from the sealed copy:

```sh
python3 tools/sqlite-migration/sqlite_migration.py fingerprint \
  --snapshot-dir /private/local-scratch/migration-copy \
  --output /private/migration-evidence/rows.json \
  --deadline-seconds 1800
```

Row encoding distinguishes NULL, signed integer, IEEE-754 double, UTF-8 text and
bytes. Each value has an eight-byte big-endian length prefix. Row SHA-256 values
are externally sorted and hashed with their newline delimiters. This retains
duplicates and ignores physical row order. Memory, open merge files and cell size
are bounded. Values are never written to fingerprint output. The exporter verifies
snapshot checksums before and after reading.

Fingerprints prove the stated data comparison only after a target exporter uses
the same explicit type/column contract. They do not establish application query
parity, report ordering, collation, access control, transaction behavior or an
implemented PostgreSQL reader. Those remain separate tests.

## Storage, privacy and failure behavior

- SQLite inputs and scratch must be on local filesystems. Network filesystems are
  rejected before opening database inputs.
- The complete projected snapshot must fit the explicit byte budget and preserve
  at least 40 GiB free by default. Run within the operator's CPU/memory/I/O-limited
  durable job, one large copy at a time.
- New results publish atomically without replacing an existing file/directory.
  A failed capture removes only its own temporary directory. Existing evidence
  and source files remain intact.
- Snapshot directories are private and database/evidence files use mode 0600.
  Catalogs contain schema/default/sequence information and must remain private.
- Interrupted process termination can leave a private temporary directory.
  The owning durable job must reconcile it and clean it after verifying no process
  still uses it. The tool deliberately performs no broad age-based deletion.
- Remove the temporary databases and fingerprint scratch after target validation;
  retain compact evidence with a defined purpose and expiry. Never commit them.

## Remaining implementation and qualification

1. Capture complete catalogs and reference data; review every unsupported schema
   feature. Choose explicit PostgreSQL database/schema boundaries that preserve
   cross-module atomicity without merging unrelated applications.
2. Implement an asynchronous database interface and port the operational
   authorization/write-transaction boundary. Port direct synchronous consumers
   rather than masking asynchronous results behind a synchronous API.
3. Port all auxiliary DDL, revision triggers, UDFs, importer idempotency and source
   generation publication. Preserve legacy SQLite behavior until the complete
   PostgreSQL path is selected by an explicit runtime configuration.
4. Load an isolated target and compare counts, typed row fingerprints, sequences,
   constraints and all declared publication metadata. Rebuild both derived models.
5. Run the existing authorization/revocation, password race, order-limit, import,
   sales-generation, activation, activity, report and export tests against both
   engines. Add target-specific concurrency and recovery checks where contracts
   differ. Include scoped HTTP behavior and representative performance.
6. Rehearse writer fencing, final capture, connection switch, restart, new backup,
   recovery and the boundary after which target writes prevent lossless rollback.

Every output retains `production_cutover_ready=false`. This preparation is a
concrete input to qualification, not an approval or a claim that the application
already supports PostgreSQL.

## Contract references

- [SQLite data_version](https://www.sqlite.org/pragma.html#pragma_data_version): compare observations from the same connection.
- [SQLite Online Backup API](https://www.sqlite.org/c3ref/backup_finish.html): destination transaction and incremental backup behavior.
- [SQLite isolation](https://www.sqlite.org/isolation.html): read snapshots and writer serialization.
