# Client sales snapshot and reporting

`MOBIUP_DATA_DIR=/explicit/data/directory node tools/build-partner-activity.mjs`
rebuilds the derived `client-history/partner-activity.sqlite` outside HTTP requests.
Schema **6** requires a rebuild after upgrading from schema 5. The builder opens
history and application databases read-only, checks the temporary derived database
and atomically replaces the snapshot. No authoritative database migration is needed.
The source CLI and private server build bundle the helpers through normal imports;
there is no extra worker asset or runtime dependency.

Company identities come from the historical reference and source identity universe,
independent of today's cards. Adding a card with an existing historical CUI therefore
works without rebuilding. Changing, merging or splitting current CUIs changes the
report grouping immediately; historical allocations are never reassigned by a card
edit. Changed import/reference content requires a new derived snapshot. A genuinely
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
reports within a 48 MiB estimated allocation budget, plus at most 24 MiB of decoded
current card summaries. Identical in-flight billing calculations coalesce; failures
are removed and at most four different calculations can run concurrently. File
identity, nanosecond timestamps (including WAL), schema, calendar day, selected month
and displayed card identity fields fence billing cache reuse. Import/reference
signatures are validated on calculation. Replacement during calculation/copy returns
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
