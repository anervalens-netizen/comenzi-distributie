# Synthetic performance LAB

These tools create their own temporary SQLite databases and remove them on exit.
They never accept a production URL, credentials or an existing data directory.
Use the repository's supported Node version and installed dependencies. All
fixtures are fictional. Generated artifacts belong only in ignored
`work/performance/`; do not commit local measurements or copy business data here.

Run benchmarks **sequentially**, with builds/tests stopped, on the same machine
and runtime. Other host workloads must be reported; these tools do not stop them.
For a controlled comparison, run the baseline and candidate at least twice in
alternating order. Pin hardware/CPU allocation externally if an SLA decision is
needed. Timing assertions are not hardware-independent quality gates.

```sh
# Source comparison without checkout/reset or another worktree. Supply a local SHA.
LAB_SOURCE_REF=<baseline-sha> LAB_LABEL=before node tools/bench-reports.mjs
LAB_LABEL=after node tools/bench-reports.mjs
node tools/compare-performance.mjs work/performance/reports-before.json work/performance/reports-after.json

LAB_SOURCE_REF=<baseline-sha> LAB_LABEL=before node tools/bench-portfolio.mjs
LAB_LABEL=after node tools/bench-portfolio.mjs
LAB_LINES=100 LAB_LABEL=small node tools/bench-inventory.mjs
LAB_LABEL=inventory node tools/bench-inventory.mjs
npm run build:server
LAB_LABEL=http node tools/bench-http.mjs
```

The optional `LAB_SOURCE_REF` loads **library source** from a local Git commit
into the report fixture bundle. Fixture/infrastructure code remains the current
harness. It does not read another checkout or change Git state. The artifact
records the source override; compare only compatible source schemas. The HTTP
harness instead runs the current standalone build, which must be rebuilt from
synthetic resources for each candidate. It binds loopback on a dynamically
allocated port and creates ephemeral synthetic sessions, without password login.
No outgoing business writes or notifications are exercised.

`LAB_COMPANIES` (default 35581) controls added synthetic companies; 67 semantic
fixture points remain alongside them. Seven dated source rows per added company
cover current and comparative months. The original small fixture retains shared
companies, unlinked identities, returns, zero and missing amounts. CRM includes
an unused notes field to expose the cost of reading whole cards in reconciliation.
The artifact records exact source counts. `LAB_SAMPLES` defaults to 30. Single
cold/invalidated reads are explicitly single observations. p50/p95 use nearest
rank and are **absent** for N < 30. Four-reader waves and individual correlated
request samples are distinguished; a four-request wave is never called p95.

The separate portfolio harness measures the activity report on the same source
scale, with its calendar fixed to the fixture date. It is distinct from the
monthly client-sales report and is not changed by the cache optimization.

Report cases measure dirty-projection cold reads, warm portfolio membership,
direct report-cache delivery, national and agent reports, four readers,
equivalent diacritic/case/county searches,
reconciliation with live CRM membership, invalidation and source rebuild. Source
rebuild is fixture setup, not included in read latency. Cold means application
caches/projections as stated; OS filesystem caches are not dropped. SQL timings
cover the application adapter only; history aggregation is included in total
latency but not those SQL phase counters. Existing report/read-model counters are
snapshotted; the direct delivery case records cache hit/build deltas and has no
application-database query work. It therefore distinguishes the baseline's
oversized-report rebuild/copy path from the candidate's bounded compact decode
without adding production counters. No runtime telemetry service or new
production counters are added. Synthetic national and reconciliation semantic
digests make A/B business-output equality machine-checkable without storing rows.
Only run-local snapshot time, source-generation revision and portfolio revision
are normalized in those digests; their presence and format are asserted and the
freshness/invalidation behavior remains covered separately.

The inventory test measures 100 distinct scan IDs at 1000 lines by default
(`LAB_LINES=100` provides a smaller synthetic comparison), lost-response
replays, 30 two-writer CAS races and complete finalization. It verifies receipt
order, legitimate repeat counts, changed-payload rejection, loser retry with the
same ID, hidden uncounted rows and reopened database/module replay. All 999 other
rows are set through the real handler before finalization. Receipts stay private;
clients still receive the full inventory. Existing `test-r2-inventory.mjs` also
covers truncated legacy histories and the browser queue's durable IDs.

HTTP cases include initial document, first database/bootstrap access, role-specific
bootstrap with 10000 orders and portfolio search. This intentionally measures the
current bootstrap cost; changing loading/pagination is outside this work. HTTP
latency includes body transfer/read on loopback. It does not measure browser
rendering, downloaded/executed chunks, mobile networking or physical scanner focus.

Payload sizes are UTF-8 JSON/text plus offline gzip/Brotli estimates, **not** actual
proxy compression or network traffic. Compression is outside request timing;
inventory serialization and client JSON parsing are measured separately. Memory
snapshots and CPU use describe the harness process (the HTTP server child is
excluded). Its event-loop monitor also spans setup and offline compression. These
and host load are diagnostic context, not server peak-heap or GC attribution. Small reports retain the existing decoded cache/copy path; reports that exceed
its budget use compact serialized chunks in the same cache. Compaction has a
cold-build cost, so compare cold and warm paths separately. The codec's bounded
string accounting is a retention
budget, not a claimed measurement of the process heap. Concurrent unfiltered
national hits extend the existing single-flight behavior to share one compact
decode, then deep-copy before request-specific visit/flag decoration. A solitary
reader owns its fresh decode; filtered searches keep their selective decode. No
decoded report is retained as a second cache.

## Performance safeguards and conditional inventory disposition

`test-performance-lab.mjs` tests percentile eligibility, byte accounting, codec
round-trip equality and independent mutable results. The scaled
`test-client-sales-performance.mjs` requires single-flight cold reads and warm
cache reuse at 35581 added companies, under the unchanged 64 MiB report budget.
Other report tests enforce access, live visits, source replacement, imports,
deletions and company identity changes. Timing remains diagnostic except for the
existing cooperative responsiveness guard.

Inventory disposition: **`validated_no_change` for the full-response protocol**
at the synthetic 1000-line/100-scan workload. Serialization and JSON parsing are
a small fraction of handler latency, and compressed responses do not justify the
complexity of a delta/resync migration in this LAB. The permanent benchmark keeps
this decision reviewable at larger workloads. Exact measurements and host context
belong in ignored artifacts/private run records. Mobile rendering, physical
scanner focus and slow-network acceptance remain unmeasured here; this disposition
is not a mobile SLA. No delta protocol, virtualization or receipt change is made.
