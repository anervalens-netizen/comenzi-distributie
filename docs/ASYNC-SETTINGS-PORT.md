# Prepared asynchronous settings operations

This slice prepares the existing settings readers and the three settings writes.
It does not select PostgreSQL, change HTTP routes, send mail, start workers or
change runtime/deployment configuration. The existing SQL adapters and authority
schema are reused. Runtime integration, real PostgreSQL qualification and the
whole-application migration remain separate gates.

## Scope and call sites

| Existing source operation | Prepared interface |
| --- | --- |
| `readAppSettings` / `settings` | `SettingsRepository.readAppSettings` / `settings` |
| `settingsForAgent` | `settingsForAgent` and `readAgentSettingsSnapshot` |
| `regionalOperationalSettings` | `regionalOperationalSettings` and `readRegionalSettingsSnapshot` |
| `managerMailSettings` | `managerMailSettings` and `readManagerMailSettingsSnapshot` |
| `settingsForOrder` | `settingsForOrder` and `readOrderSettingsSnapshot` |
| `PUT admin/settings` | `updateAppSettings` |
| `PUT admin/regional-settings` | `updateRegionalSettings` |
| `PUT admin/manager-mail` | `updateManagerMailSettings` |

`readAppSettingsSnapshot(tx, quotedSchema, mailDefaults)` returns the current
`cfg`, exact `raw` text or `null`, and parsed `stored` value. All five exported
snapshot helpers use only the supplied transaction. Their caller authenticates
and authorizes the operation in that same transaction. They do not acquire
another connection or open a nested transaction. This supports order
finalization and other composed operations without splitting their snapshot.

The public repository authenticates reads. Agents can read their own operational
routing; managers retain the existing national order-read scope. Regional and
manager-mail entry points require a manager. They use the current account and
current assignments. No mutation authority follows from national read scope.
Mail defaults are injected and copied, never loaded from production resources.
The repository returns settings; it performs no email or other network action.

Requested routing IDs may contain NUL even when stored PostgreSQL identifiers
cannot. The setting-key lookup and both assignment lookups bind such requested
IDs as UTF-8 bytes and compare with `convert_to(column,'UTF8')`. This preserves
the original missing-ID fallback without passing NUL in a PostgreSQL TEXT
parameter. Ordinary IDs keep their existing text predicates and index access.
The permission checks and the accepted request grammar remain unchanged.

## Preserved values and failures

- Stored `2147483647` means unlimited and is returned as `0`. Saving `0` persists
  the same sentinel. The existing parser is reused, including its acceptance of
  that sentinel in submitted input. Integer limits `0..7` remain valid.
- An invalid stored weekly limit is returned as `null`. It is never silently
  converted to unlimited. Repair requires exactly `weeklyLimit` and
  `repairWeeklyLimit: true`. Repair changes only the persisted limit and keeps
  unrelated stored properties, including malformed unrelated mail fields.
- Repair against an already valid configuration fails with conflict. A normal
  save cannot repair an invalid limit. The absent setting uses insert-on-conflict
  refusal; an existing setting uses its exact raw string in the UPDATE predicate.
- Normal saves retain unknown stored properties. Submitted unknown properties
  do not become new settings. Existing JSON parsing, property order and spread
  semantics remain visible in the persisted string. Stored invalid JSON or
  incompatible scalar/null shapes fail rather than being rewritten.
- Recipient arrays retain order, blanks and duplicates. Existing length and
  email validation remains unchanged. At least one nonempty partner recipient
  is required for a normal/global or regional update. Global omitted email
  fields become empty; regional omitted fields remain unchanged.
- Regional reads include only assigned active agents, ordered by binary agent
  ID (`COLLATE C` on PostgreSQL). The first route and exact JSON signatures
  determine the value and mixed flag. A regional write updates precisely that
  set atomically. Global accounts cannot use that regional write endpoint.
- Manager-mail writes replace the four existing fields for the actor's own
  account. Missing submitted fields become empty. Reading the legacy partner
  fallback, including an explicitly empty partner, remains unchanged.
- Order routing appends only active managers' nonempty accessories/stands/SIM
  recipients, in binary username order, with the same `Set` deduplication.
  Partner routing is not changed by those manager fields. Invalid override JSON
  follows the original skip/failure behavior; no new repair policy is inferred.

## Authority, transactions and concurrency

Each mutator receives the existing `RequestActorSnapshot`, copied before its
first asynchronous boundary. The existing `withCapturedOrderWrite` helper is
reused as a request-authority transaction primitive; the settings callback then
requires its own manager/global/regional scope. The helper name does not grant
order-specific or broader settings permissions.

The writer lock covers the current session, profile and portfolio generation,
scope lookup, settings read, comparison and all writes. Time is read after the
lock is acquired. The existing full captured-authority check also runs before
commit, so expiry while an asynchronous callback is waiting causes rollback.
Settings do not intentionally mutate the actor's profile or session, so this
complete final check is appropriate. Every revoker and business writer must use
the shared adapter lock before a PostgreSQL selector can be enabled.

Raw comparisons remain in SQL even under the shared writer lock. The exact
statement's row count controls success. No `changes()` translation, proof-key
settings row, second connection or automatic retry is introduced. A failed
regional member write rolls back all earlier member writes. Unknown-commit
handling remains the unchanged adapter contract.

Reads use one coherent transaction for settings, accounts and assignments.
An independent committed write cannot mix old defaults with new routing in the
same result. The wrappers do not extend that snapshot over separate HTTP
operations. Historical source eligibility for PostgreSQL text, schema, roles
and generations remains a migration gate; no stored value is normalized during
this preparation.

## Qualification and remaining integration

`tools/test-settings-sqlite.mjs` builds only the prepared modules. It extracts
the original reader declarations and three original admin branches using Acorn
after TypeScript transformation. It does not import the production server or
runtime. Each legacy oracle receives a coherent snapshot copied to a new
in-memory SQLite database. Tests compare both responses/failures and exact
persisted settings text. All examples are fictional.

`tools/settings-contract.mjs` is reusable by a PostgreSQL fixture with two
dedicated restricted adapters, the real authority/settings schema, the same
legacy oracles and an independent commit callback. The contract covers malformed
values, unknown properties, recipient ordering, explicit repair, stale CAS,
revocations in both orders, queued writers, input capture, expiry, partial-write
failure and snapshot reads across independently acknowledged WAL commits.
The NUL routing cases first check the original SQLite fallback, then a
PostgreSQL-dialect parameter proxy rejects every NUL TEXT parameter and checks
the explicit byte predicate. It delegates execution to SQLite; this parameter
regression is not a PostgreSQL execution claim.
SQLite execution alone does not establish PostgreSQL or deployed parity.

The current HTTP wrappers remain unchanged. Bootstrap, order mail/export and
finalization must be wired to the composed helpers in the complete runtime port.
Catalog/photo mutation and customer imports are separate slices. Customer writes
also require their full trigger/projection/identity dependencies; this settings
work is not evidence that those mutations are portable. The integrated candidate
still needs normal review/CI, the application qualification and the approved
migration checks before runtime activation.
