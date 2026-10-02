# Client sales snapshot and reporting

`MOBIUP_DATA_DIR=/explicit/data/directory node tools/build-partner-activity.mjs`
rebuilds the derived `client-history/partner-activity.sqlite` outside HTTP requests.
Schema **7** requires rebuilding **every older snapshot**, including schema 6. The builder opens
history and application databases read-only, checks the temporary derived database
and atomically replaces the snapshot. No authoritative database migration is needed.
The source CLI and private server build bundle the helpers through normal imports;
there is no extra worker asset or runtime dependency.

Company identities come from the historical reference and source identity universe,
independent of today's cards. Adding a card with an existing historical CUI therefore
works without rebuilding. Changing, merging or splitting current CUIs changes the
report grouping immediately; historical allocations are never reassigned by a card
edit. Any raw history generation change, including row amounts, identities, allocations,
import/reference content, WAL writes or atomic replacement, requires a new derived snapshot. A genuinely
unknown CUI is explicitly unlinked, with unknown amounts rather than zero sales.

Client codes, master aliases, reference cards and franchise ownership are considered
together. Several points inside one firm, including rows without a franchise code,
can safely contribute to company totals. Evidence for different firms is disputed:
the identity contributes to neither firm's reliable sums or document counts, and all
identified candidate firms become incomplete. Undisputed amounts remain visible as
partial; known positive bills still count, but new/repeat/absence/health conclusions
are suspended for incomplete firms. Positive bills and document totals are lower
bounds when attribution is incomplete.
The detail reader and both activity readers use the same attribution rule.
`company_unresolved` retains every unresolved non-consumer identity with its candidate
companies and reason, including identities with no resolvable company. Snapshot
metadata counts **identities**, not raw rows or documents. Raw source rows are never
changed or deleted. The UI's unknown/partial count describes current visible firms,
so it is not the same count as unresolved source identities.

Net amounts include returns, cancellations and zero movements. A positive billing
document is grouped once by company, date, site and document number across aliases
and points. Blank numbers, return-only, net-zero/cancelled and missing-value documents
do not count as positive bills. National totals count each firm once, independently
of overlapping portfolios. Search and geography select through any authorized point
and retain company amounts; totals precede status filters and pagination. Unknown
sort values remain last in either direction.

The Node HTTP reader yields between bounded batches during cold calculation, current
portfolio reads, copies and sorting. A process-local LRU holds at most four billing
reports within a 64 MiB estimated allocation budget, plus at most 24 MiB of decoded
current card summaries. Identical in-flight billing calculations coalesce; failures
are removed and at most four different calculations can run concurrently. File
identity, nanosecond timestamps (including WAL), schema, calendar day, selected month
and displayed card identity fields fence billing cache reuse. Import/reference
signatures and the snapshot's `sourceGeneration` are validated on calculation.
The raw generation is captured before opening SQLite, checked after pinning the read
transaction and checked again before returning or admitting cached results. Replacement during calculation/copy returns
an unavailable response rather than a stale result.

Cached records never escape directly to callers. Visits and visit flags are never
cached with billing. Current scoped IDs are selected on every request using the
existing portfolio SQL, and trigger-maintained data/scope revisions fence concurrent
changes. Decoded cards reuse that existing revision mechanism. No per-request raw
history scan or external cache service is introduced. A missing billing month reads
only available comparison months and skips historical health.

Future months are rejected against the current **calendar** month in Bucharest.
On day one, the default can still be the previous reporting month; selecting the
current month remains valid. Recorded visits use calendar month/DST boundaries,
current authorized points and the selected actor, exclude future timestamps and
never include plans. Current visits remain available beyond the imported billing
cutoff. No recorded visit is not evidence of physical absence.

Focused synthetic checks (no shared full-gate ports):

```sh
node tools/test-source-guards.mjs
node tools/test-client-sales.mjs
node tools/test-client-sales-remediation.mjs
node tools/test-client-sales-performance.mjs
node tools/test-partner-activity.mjs
node tools/test-partner-sales-store.mjs
node tools/test-partner-sales-health.mjs
```

The performance harness uses roughly 20,000 synthetic firms and 140,000 company-day
facts, an ephemeral loopback HTTP listener, and four simultaneous cold/warm queries.
It checks equivalence, single-flight behavior, a bounded cache and repeated light
HTTP completions during reporting. Printed timings are measurements, not portable
latency guarantees or evidence of production acceptance.

The source fingerprint is computed in bounded UTF-8 byte chunks for HTTP cold reads and shared between concurrent months for the same filesystem generation. It remains identical to the batch fingerprint. Warm reports must demonstrate cache admission in tests, including wide synthetic company labels.

The schema 7 snapshot also contains indexed company and point identity lookups for
cold detail reads. Code rollout and derived rebuild are separate steps: prepare the
matching code release, rebuild with that release's builder, verify its output, then
promote it through the deployment's supported procedure. Older or stale snapshots
remain explicitly unavailable until rebuilt; no raw schema migration is required.

For a direct rebuild, use the command above. For staged output, first create a
private staging directory on the destination filesystem, then run:

```sh
MOBIUP_DATA_DIR=/explicit/authoritative/data node tools/build-partner-activity.mjs --output /explicit/staging/partner-activity.sqlite
```

The API also accepts this output path as the third `buildActivitySnapshot` argument.
The source directory must identify the **same authoritative source database** used
by the serving reader. Staging changes only the output location; it must not use a
copied raw database or a symlink wrapper to claim a distinct source generation.
Physical source provenance is shared across symlink aliases, including a symlinked
root directory. A copied/replaced raw database requires its own derived rebuild;
do not edit `sourceGeneration` metadata to bypass validation.

Only the verified derived output is promoted to `client-history/partner-activity.sqlite`;
preserve the deployment's private recovery procedure and authoritative data. Destination
parents must exist. The builder resolves their physical paths before any output write,
rejects source aliases (including hardlinks and final symlinks), writes to the captured
canonical staging location and checks the destination again immediately before rename.
Coordinate source writes and checkpointing with the rebuild: any physical generation
change conservatively invalidates the result. Application filesystem directories must
remain under the operator's control during build and promotion.
The HTTP adapter uses cooperative source validation and rechecks the current authorized
card after yielding.
