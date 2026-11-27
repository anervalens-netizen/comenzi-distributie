# Asynchronous order finalization and approval component

## Status

This is an isolated source component. It does not change the runtime database
selector, HTTP routes, production data, or export storage. Its synthetic contract
runs on real SQLite with two connections and is reusable by the PostgreSQL
qualification driver. PostgreSQL execution of these business cases is still
required. Existing SQLite routes remain the active implementation.

The component preserves the current finalization rules and the current unlimited
weekly limit representation. There is no transition from finalized back to draft.
The existing copy operation creates a separate draft.

## Files and boundaries

| File                                         | Responsibility                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `lib/order-finalization-repository-async.ts` | Prepare, bind a private export attempt, revalidate after the shared writer lock, and finalize atomically.   |
| `lib/order-limit-repository-async.ts`        | Policy read/write, saved-order limits, approval request, decision, individual view, and atomic consumption. |
| `lib/order-limit-source-async.ts`            | Explicit application and sales schema queries on the supplied transaction; source and mapping identities.   |
| `lib/order-finalization-state-async.ts`      | Stored order projection, catalog/client validation, exact raw values, and Bucharest week boundaries.        |
| `tools/order-finalization-contract.mjs`      | Shared synthetic business and failure contract.                                                             |
| `tools/test-order-finalization-sqlite.mjs`   | Isolated SQLite fixture, two connections, and exact fixture cleanup.                                        |

`OrderLimitOptions` receives explicit application/sales schemas, a private copy of
the seed catalog, configured pilot manager IDs, and an optional clock. There is no
environment or path fallback. SQL is written explicitly for each dialect; SQLite
SQL is not transformed into PostgreSQL SQL.

The application, authority, order, notification, and sales tables must be in one
PostgreSQL database with separately owned schemas and explicit grants. Every
business writer and authority revoker must use the same database writer gate.
The component never opens a second transaction from a transaction callback.

## Authorization and atomicity

The HTTP integration must capture `RequestActorSnapshot` before awaiting the
request body. Every public repository operation copies this snapshot. Reads
check the current session and authority before and after the operation. Mutations
use `withCapturedOrderWrite`: acquire the adapter's shared writer lock, check the
same session, profile, role, manager scope, warehouse and portfolio revision, run
all domain queries on that same transaction, and check authority again before
commit.

| Operation          | Additional domain checks inside the writer transaction                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set product floors | Current global manager, expected policy revision, exact previous raw setting.                                                                                         |
| Request approval   | Current agent and pilot assignment, same draft/revision/owner, current source generations and validity month, actual excess.                                          |
| Decide approval    | Current manager assignment and original recipient, pending status and revision, exact current draft and source generations.                                           |
| Finalize           | Current order access, unchanged draft payload/revision, exact catalog/client/settings raw values, current limits/approval, fresh weekly capacity, unique SIM serials. |

Approval creation and its notifications commit together. Decision changes and
notifications commit together. Order finalization, approval consumption, SIM
serial insertion, and order list revision triggers commit together. No permanent
`changes()` proof row is needed in the asynchronous transaction.

Policy and approval input hashes preserve their existing ordered JSON fields.
Persisted JSON text remains text. The component does not reserialize a raw
catalog, client, aliases, or settings value to decide whether it changed.
Consumed approval audit remains consumed. A soft-deleted or changed draft makes
an unconsumed approval appear superseded.

## Limits and sales semantics

The pure formulas in `order-limits.ts` are unchanged. Sales use the three closed
calendar months before the current Bucharest month, active import generations,
net quantities, and the current reporting location/alias rules. Missing or
ambiguous seller mapping, incomplete month coverage, duplicate product codes,
and net quantities below the floor retain their conservative existing behavior.
Current-month imports do not invalidate approval for the closed-month window.

The source reader replaces connection-specific custom functions with explicit
TypeScript normalization and dialect SQL. PostgreSQL site/item comparison uses
ASCII translation and trimming to preserve SQLite `UPPER(TRIM(...))`; location
matching retains the reporting normalizer. List parameters use JSON arrays, not
unbounded placeholder expansion. Mapping and source version queries stay on the
caller's transaction.

Actual sales-scale query plans and latency remain unqualified. The distinct
location lookup follows the existing resolver, but its PostgreSQL workload must
be measured on the qualified clone before deployment.

Weekly limit `0` is unlimited. The legacy integer marker `2147483647` is read as
unlimited without rewriting stored JSON. Invalid values block counted orders with
503; stands, SIM, and other uncounted cases retain their existing behavior.
Counted orders are accessories and combined orders with nonempty accessories.
Capacity is counted again after the shared writer lock, using the current
Bucharest Monday and DST rules. The exact raw `settings.app` value is compared
with preparation, so an administrator changing the weekly setting during export
cannot leave a stale limit in the final write.

Both `settings.catalog` and `settings['inventory-ean-v1']` are compared as exact
raw text after the export intent acknowledgement and again inside the writer.
An EAN edit invalidates the prepared catalog even when product limits are disabled
or the order is outside the configured pilot. The sales-location mapping version
is a separate input and does not replace this catalog check.

## Private export and uncertain commit contract

`OrderExportLifecycle` is an explicit integration dependency. A production
implementation is not included or installed by this component.

1. `begin(intent)` must durably acknowledge a pending record before staging.
2. Current actor and inputs are revalidated after that acknowledgement.
3. `stage(intent, order, catalog)` must create an immutable private object bound
   to this exact order, operation UUID, export key and order-content hash. It must
   not expose the object before the committed authorized order references it.
4. The database writer revalidates again, then commits the order and related
   domain writes atomically.
5. `settle` durably records the verified result of this attempt.

The intent contains no session token or token hash. A stand-client order has no
export object, but still records its database attempt through this lifecycle.
Existing finalized orders return idempotently before creating another attempt.

Stored order IDs retain the legacy 36-character hexadecimal/hyphen domain accepted
by draft creation, including historical non-UUID shapes. Existing case-insensitive
stored IDs remain accepted. The key still excludes slashes and dot segments, and
the new operation ID is an independent UUID. Qualification exercises the actual
create, save, and finalize sequence for legacy IDs and refuses unsafe path IDs
before any export intent is created.

| Outcome                                                   | Required behavior                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Confirmed rollback or a different successful finalization | Delete only this attempt's exact owned object, then settle its journal record.                |
| Unknown export staging acknowledgement                    | Preserve pending state and the exact possible object; return a reconciliation-required error. |
| `CommitOutcomeUnknownError`                               | Preserve pending state and the exact export. Do not retry automatically and do not delete it. |
| Journal begin/settle or cleanup acknowledgement failure   | Return explicit reconciliation-required state; retain the record for inspection.              |

`FinalizationReconciliationRequiredError` has status 503 and `retryUnsafe=true`.
Reconciliation must compare the actual order identity and committed export key
with the pending intent before choosing a disposition. The synthetic store in
the contract tests only this repository's protocol. It is not evidence of a
durable filesystem or object-store implementation.

## Verification

Run `node tools/test-order-finalization-sqlite.mjs` after the project's frozen
dependencies are available. It creates fresh fictional application, ledger and
sales files, opens two real SQLite connections, and removes only its own temporary
directory in `finally`.

The contract covers every order kind; idempotent retry; current catalog/client
validation; finite and unlimited weekly capacity; parallel finalizations; DST
boundaries; approval request, notification and decision rules; active closed
sales months; ambiguous aliases and duplicate product codes; source drift during
export; session, manager and profile revocation; notification/serial rollback;
post-write session expiry; and both possible database outcomes after lost COMMIT
acknowledgement. No fixture contains business data or actual identities.

The PostgreSQL driver must use the real authority and order builders, create the
remaining synthetic notification/sales fixture tables under exact owned schemas,
run the same case identities, and verify grants, errors, resource limits, and
cleanup. A successful TypeScript check or SQLite contract alone does not qualify
PostgreSQL execution.

The shared contract adds ten targeted cases to the original 69: two legacy
create/save/finalize sequences, existing uppercase stored-ID compatibility,
unsafe export path rejection, and six independently committed EAN changes across
the pre-stage and final-write boundaries under disabled, outside-pilot, and
evaluated limit gates. The EAN cases preserve unrelated private objects and prove
that the complete business state remains unchanged after refusal.

## Remaining integration gates

- Replace the temporary catalog snapshot helper with the shared catalog/customer
  repository after its independent contract and published revision are available.
- Port approval-list pagination and its scope/status ordering contract. This
  component provides only individual approval reads and mutations.
- Implement and qualify the durable export intent/object adapter, reconciliation,
  XLSX rendering/templates, download authorization, and retention.
- Wire HTTP status/message mapping, mail preparation, push delivery after commit,
  and the existing finalization response shape. Existing Romanian messages remain
  in the routes; domain error codes are not an HTTP replacement.
- Port the complete settings writer, including explicit invalid-weekly-limit
  repair, other application settings, and its raw compare-and-swap contract.
  This component reads and revalidates weekly settings; it does not replace that
  settings endpoint.
- Qualify notification/customer/catalog/sales schemas and every associated
  import/business writer under the same authority gate. Order DDL alone does not
  cover those schemas.
- Run the shared business cases on PostgreSQL, restored-data parity and workload
  measurements, then complete source review, CI, complete-database restore,
  deployment, and runtime verification gates before enabling the selector.
