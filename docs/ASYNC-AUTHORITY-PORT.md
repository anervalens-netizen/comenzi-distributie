# Prepared asynchronous account and session repository

This slice supplies explicit SQLite and PostgreSQL statements for account,
session and assignment changes. It is preparation code. The HTTP application
continues to use the existing SQLite runtime. No database selector, deployment,
schema migration, package script or production route is changed by this slice.

## Transaction boundary

`SessionRepository(database, applicationSchema, clock)` handles authentication
and registered-device sessions. `AuthorityRepository` extends it with manager
and agent administration. Each public mutator opens `database.write()` once.
Its authority queries, target CAS, assignment changes and cleanup use that same
transaction client. Helpers do not open nested transactions.

The adapter's application writer lock must cover **every participating writer**,
including imports, administrative scripts and initializers. A direct connection
that skips this protocol is outside this proof. This repository must not be
selected in production until the remaining writers and schema migrations are
ported and qualified together.

Inputs are server-side values. The repository expects normalized account fields,
trusted warehouse catalog IDs, hashed session tokens and password hashes already
derived by the existing password implementation. It never accepts or verifies a
plaintext password inside a writer transaction. Credential snapshots contain
private verifiers and must never be serialized to HTTP or logs.

The injected clock returns safe integer epoch milliseconds. Mutators sample it
after acquiring the writer lock. Administrative and own-password changes also
check that the retained actor session is still valid after asynchronous cleanup.
That final check does **not** compare the intentionally replaced profile version,
password or portfolio generation. Expiry during cleanup rolls the whole change
back. Logout intentionally removes the exact actor session and has no such
post-check.

An own-password change whose session/role is revoked during password preparation
returns the existing failed-CAS conflict (409), as does an administrative reset
winning over that change. Initial authentication of an invalid device remains
401. Logout now also rechecks the exact unexpired session after waiting for the
writer lock; a device that expires while queued is rejected rather than reported
as a fresh authenticated logout.

### Two different actor contracts

The current route wrapper excludes `auth/*` from `captureRequestAuthority`.
The new interfaces preserve that distinction:

| Operation | Input authority | Transaction precondition |
| --- | --- | --- |
| Session read and refresh | Hashed device token | Exact live token, active user and current expiry |
| Logout | `SessionIdentity` | Token belongs to the supplied active user and is unexpired |
| Own manager password | `SessionIdentity` plus verified credential snapshot | Current manager/session plus target hash and profile CAS |
| Manager or agent administration | `RequestActorSnapshot` | Exact actor profile, role, warehouse, manager scope, password-change flag, session and portfolio scope generation; then current manager/agent access |

`captureRequestActor()` prepares the administrative snapshot. The existing
request checks for origin, operation-user identity and route permissions still
belong at the HTTP boundary. There is no new role or scope assignment endpoint.

Using the import helper's captured-authority **post-check** for these account
mutations would be incorrect. A successful own password change increments the
actor revision, and logout deletes the actor session. Either operation would
fail its own old authority test. Import transactions retain their existing
captured pre/post checks; this slice does not alter that helper.

## Authentication and session behavior

`authenticate()` deliberately has two writer transactions separated by password
verification:

1. `reserveLoginAttempt()` deletes at most 100 expired attempt keys, reserves the
   IP allowance, then increments the account counter only if the IP reservation
   succeeded. IP allowance is 80 attempts and account allowance is 10 attempts
   per existing 15-minute window. A rejected login still commits its counters.
2. `loginCredential()` reads the active account outside the write lock. The
   caller-provided verifier always runs, including a `null` input for an absent
   user so the existing constant-cost fallback can be used.
3. After verification, the caller creates a random device token and passes its
   hash. `createLoginSession()` takes a new writer lock, samples a fresh clock and
   checks the captured ID, username, password hash and profile version. A reset
   during password verification therefore wins over the stale login.
4. Only an exact successful insert clears the account counter and expired
   sessions. The IP counter remains. A failed CAS performs no cleanup.

The session lifetime remains 365 days with sliding renewal. `refreshSession()`
returns the current user and new expiry from one writer snapshot. Expired or
inactive sessions return `null`; a refresh cannot resurrect them. Cookie
encoding, clearing and response headers remain the caller's responsibility.
The caller also retains usage login/logout events; this repository does not
send messages or write telemetry.

Compared with the old batch, a stale login no longer deletes unrelated expired
sessions. That deliberate tightening follows the rule that cleanup depends on
the exact successful CAS. A successful login keeps the existing expiry cleanup
predicate, `expires_at < now`, while authentication requires `expires_at > now`.

## Administrative behavior

All target snapshots are copied before waiting for a lock. The writer reads the
current target again and checks its version and role/scope. Each UPDATE retains
an explicit target CAS. Cleanup runs only when that exact statement reports
`changes === 1`; the repository does not issue `SELECT changes()` or temporary
proof keys in `settings`.

| Method | Authorization and change | Session / counter result |
| --- | --- | --- |
| `changeOwnPassword` | Current manager, verified old hash and revision; clears `must_change_password`, increments revision | Keeps current device, removes other devices; attempt keys unchanged |
| `createManager` | Global manager; creates assigned manager; all selected agents must be active | No existing session or counter cleanup |
| `updateManager` | Global manager; only the owner may edit a global manager; increments revision and replaces assigned agent set | Profile/assignment-only edit keeps sessions; username/password edit clears old and new account keys and all target devices, retaining current device when editing self |
| `updateAgentCredentials` | Global manager or currently assigned manager; target revision CAS | Removes all target devices and the old username's attempt key |
| `resetAgentPassword` | Same current agent access; target revision CAS | Removes all target devices and the current username's attempt key |
| `updateAgentProfile` | Current agent access; changing site code requires global scope; target revision CAS | Keeps sessions and warehouse ID; increments revision |
| `toggleAgentActive` | Current agent access; activation checks active site-code uniqueness; target revision CAS | Removes target devices on either transition |
| `createAgent` | Global manager and warehouse from the trusted server catalog | Creates active agent with revision 1; no implicit manager assignment |

The current agent credential-update route clears only the **old** username's
attempt key. That detail is preserved and tested. Manager updates clear both
names. Name-only edits do not gain credential-reset behavior.

SQLite's built-in `UPPER()` folds ASCII letters only. The explicit PostgreSQL
site-code query uses `TRANSLATE()` and `COLLATE "C"` to preserve that contract.
The synthetic PostgreSQL fixture uses the matching unique index. The actual
PostgreSQL schema migration must preserve this same expression; a locale-aware
`UPPER()` index would be a different rule for non-ASCII values.

## Revocation map

| Changed authority | Prepared writer / source | Effect on an in-flight captured import |
| --- | --- | --- |
| Logout | `logout` | Exact session disappears |
| Expiry | Clock checks, session expiry and successful-login cleanup | Captured session no longer satisfies expiry |
| Active state | `toggleAgentActive`; manager state has no arbitrary HTTP mutator today | Current active predicate fails for a revoked importing manager |
| Role | No arbitrary role HTTP mutator today; any future administrative writer must use the shared lock | Current manager role predicate fails |
| `must_change_password` | Own/admin credential changes clear it; no arbitrary HTTP setter today | Requiring a new password invalidates captured import authority |
| `manager_scope` | Explicit seed initializer only; no generic scope API | Captured manager scope differs |
| `profile_revision` | Every prepared profile/credential/assignment update | Captured profile differs |
| `manager_agents` | `updateManager`, atomically with target revision increment | Captured manager revision differs; scope-generation triggers also reject stale administrative snapshots |

Synthetic tests for manager active/role/password-required/scope changes use
explicit fixture SQL through `database.write()`. They do not imply a new HTTP
capability. The tests exercise real repository calls for logout, profile and
assignment revocation.

### Explicit startup preparation

`initializeSeedManagerScope()` ports only the existing fixed seed-manager
promotion. It changes `id='manager'` with `role='manager'` to global and is
idempotent. It does not increase the profile revision, matching current startup;
the scope predicate itself invalidates captured imports.

`initializeAssignmentsForNewTable()` ports the old first-table creation fill:
active assigned managers receive active agents. The schema migrator must call it
**only when it created `manager_agents` for the first time**, before application
writers start, and record that migration durably. The repository checks that the
table is empty. Emptiness alone is not proof of first creation and must not be
used as the activation condition. This method is not a repair or normal account
administration endpoint. DDL and durable migration-version ownership remain
outside this slice.

## Synthetic contract and validation

Run the local SQLite contract with installed dependencies:

```sh
node tools/test-authority-session-sqlite.mjs
```

It uses two dedicated SQLite connections, temporary application and import
ledger files, the adapter writer queue, and representative scope-generation
triggers. Both connections are closed and temporary files are removed. It starts
no HTTP server, worker, schedule, Docker container or external database.

`authorityFixtureStatements()` and `runAuthoritySessionContract()` are exported
for the separately owned PostgreSQL harness. That caller must create isolated
application/ledger schemas, execute the matching fixture DDL, provide two
adapters with the same writer-lock identity, and own cleanup. No PostgreSQL DSN
is accepted by the SQLite test. A SQLite pass is not PostgreSQL qualification.

The contract covers both serialization orders for each revocation class,
expired sessions waiting for the lock, expiry during cleanup, stale actor and
target snapshots, exact session-user binding, scope denial, failed CAS without
cleanup, full rollback after cleanup/assignment failure, preserved own-device
sessions, login throttling, resets during verification, and site-code behavior.
It checks row values and negative effects, not only successful command counts.

## Runtime integration still required

These callsites have been inspected but remain **unwired**:

| Existing code | Prepared replacement / remaining responsibility |
| --- | --- |
| `lib/server.ts` `currentUser`, `refreshSession` | Session read/refresh; retain `userView`, reporting profile and caller checks |
| `route.ts` `auth/login` | `authenticate`; preserve password policy/fallback, random token, cookie and usage event |
| `route.ts` `auth/logout` | `logout`; preserve response cookie and usage event |
| `route.ts` `auth/password` | Prepare/verify password outside lock, then `changeOwnPassword` |
| `route.ts` manager POST/PUT | Capture request actor, prepare target/hash, call create/update; retain response assembly |
| `route.ts` agent PUT and create/reset/toggle POST | Corresponding repository method; retain existing body normalization and trusted warehouse catalog |
| `runtime-node.ts` fixed seed normalization and first assignment table fill | Explicit reviewed schema-migration calls with durable first-creation evidence |

The HTTP integration must map `AccountWriteError.status/code` to the existing
application error/translation mechanism. Until then, passing this error directly
to the old generic handler would return a generic server error. Full account
schema conversion, authority triggers, other writers, import publication, route
wiring, password HTTP races and real PostgreSQL parity remain separate gates.
This slice alone does not make a production PostgreSQL switch ready.
