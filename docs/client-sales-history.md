# Per-customer sales history

This is a separate dataset from the application's existing per-TR sales reports.
It neither reads nor modifies `sales.sqlite` or the monthly uploader. The existing
sales UI exposes it independently under Vânzări → Pe clienți; see
[monthly report semantics](partner-sales-activity.md#monthly-client-report-snapshot-version-5).
Never sum the two datasets: they describe overlapping sales at different grains.

## Schema and source contract

`tools/client_sales_history.py` uses Python's standard library and a dedicated
`client-sales-history.sqlite` file. Existing unrelated database schemas are refused.
Amounts use integer cents; quantities use integer millionths. The authoritative
source fields are `Pret` and `Valoare`; `PretFD` and `PriceWithVAT` are retained
only in the original row, never used for calculations.

- `history_imports`: immutable original SHA-256, declared reporting period,
  filename, import time, controls and active/superseded status.
- `history_rows`: one row per source sheet and row number, including returns,
  zero values, original TR/previous TR, client, document, product and raw fields.
- `history_identities`: source client/franchise pairs.
- `history_references`: immutable Partner and location-master snapshots plus
  allocation rule version.
- `history_allocations`: reference-versioned results and explicit reasons.
- `history_current`: active imports joined to the selected allocation version.

A repeated identical line is preserved. There is no source line ID proving that
identical lines are duplicates. A SHA-256 repeat is a no-op. Different files with
overlapping periods are rejected unless explicitly replaced. Replacement must
cover the complete previous period and acknowledge any missing/changed line
occurrences; old imports and originals remain available.

Blank price/value cells stay NULL, with a quality flag. Totals are totals of known
values; missing amounts are counted separately. Other malformed dates/numbers
abort the import atomically while preserving the archived workbook. No source
rows are silently filtered by TR, category, customer or franchise.

## Allocation

1. A franchise code identifies the point directly. A partial location master does
   not erase a supplied code. Missing address/Partner links are explicitly counted.
   Contradictory franchise/client or master identities require reconciliation.
2. Without a code, match the exact client/CUI (or an explicit master alias).
   Assign only an unambiguous Partner with a locality and address. Inactive historical records
   are included to avoid assigning old sales to the only location still active.
   Shared portfolio membership does not create extra points.
3. Additional locations found in the master or unassociated codes in the imported
   source prevent an unsafe single-point assumption. The complete source identity
   set is versioned with the reference; allocation does not depend on row order. Ambiguous/missing identities remain visible for reconciliation.
4. Generic consumer receipts retain a separate consumer classification.
5. Original seller attribution never changes when references or portfolios change.

Normalization preserves address punctuation and identifier zeroes. No fuzzy
matching by customer name, current TR, geographic proximity or revenue is used.

## Usage

Supply private input paths outside the public repository:

```sh
python3 tools/client_sales_history.py \
  --database "$HISTORY_DIR/client-sales-history.sqlite" \
  --partners "$PARTNER_SNAPSHOT" --locations "$LOCATION_MASTER_JSON" \
  --file "$ANNUAL_XLSX" --summary-json "$HISTORY_DIR/summary.json"
```

The partner snapshot is `{"partners":[{"id":"p1","active":1,"cui":"123",\
"city":"Example City","county":"Example County","address":"Example Road 1"}]}`.
The master JSON is an array using `Cod_Franciza, CIF, PartnerCode, Judet, Oras,
Street` columns from the source location master. Keep the complete snapshots.

Repeat `--file` for non-overlapping annual exports. A summary-only invocation
needs only `--database`. Use `--reconcile` with new reference inputs to create
another allocation version without rewriting transactions. A replacement requires
`--replace`; `--allow-regression` additionally acknowledges removed or changed
line occurrences.

Use `history_current` for per-client/point queries. Query `history_rows` with
the explicit import ID only for archived source audits; it includes superseded
imports. This module does not introduce an application page or public endpoint.

## Verification and recovery

Run `python3 tools/test_client_sales_history.py -v`.
Check row counts, integer amount/quantity totals per year and month, source hashes,
allocation coverage, missing amounts, SQLite integrity and foreign keys.
Keep an independent copy of the completed database and original XLSX files.
When copying a live database, use SQLite backup rather than copying only the main
file while WAL is active. Reimport from the retained sources is also supported.


## Additive integration with existing partners

Run `tools/client_catalog_plan.py` against explicit private application, history,
location-master and reviewed current-roster snapshots. Plan version 2 treats the
existing catalog as partial. Exact client identity plus matching complete address,
or a previously verified franchise alias, reuses the existing customer ID.
A company ID alone never proves that two work points are identical.

For an existing company, a new code without a sufficiently known address remains
in `pendingPoints`. Ownership conflicts are also retained for reconciliation;
they never create a guessed customer. New companies may have coded work points
or an explicitly marked company-only record. Neither implies verified geography.
Source transactions remain in the historical store in all these cases.

Verified code associations are stored in `historyFranchises` metadata. This lets
future reconciliation keep the association after an address correction. Existing
names, addresses, routes, active states and customer IDs remain unchanged. Inactive
records are retained and never silently reactivated. Legacy records sharing an
address are not deleted or merged automatically.

If enriching missing counties with `tools/client_catalog_geography.py`, also pass
`--snapshot` and `--roster` to recompute new-customer membership after inference.
Use only reviewed current territories, with all agents in a shared county included.
Original invoicing TR fields are immutable. An inferred county does not justify a
map coordinate; only geocoded points appear on the map.

Apply a reviewed plan using `tools/client_catalog_apply.py` with explicit
`--application`, `--plan`, `--snapshot` and a new private `--receipt-directory`.
The tool refuses unrelated DB filenames, stale catalogs and changed active rosters.
It verifies a SQLite recovery copy before entering one write transaction. It adds
new rows, updates only existing membership and verified code metadata, and verifies
that every other application table is unchanged. A repeated successful plan is a
no-op. The existing portfolio-replacing importer must not be used for this task.

Before activating the integrated catalog, rehearse with copies of the actual
application and history databases. Reconcile a fresh partner snapshot, confirm
unchanged transaction hashes/totals, rebuild the derived activity snapshot, and
release the matching period filters so historical-only clients remain manageable.
The two database updates are separate operations: retain recovery receipts for
each and do not advertise complete integration before both are verified.

The scheduled application backup includes the dedicated historical database and
checksum-verified originals. Restore validates both. The derived activity cache
is rebuilt after restore; it is not an authoritative source or a backup input.

### Monthly navigation and recorded-visit comparisons

The customer report defaults to the Bucharest reporting month, including the
previous month on calendar day one. Month and customer search remain visible;
geography, ordering and detailed source provenance expand on demand. KPI cards
open their customer lists. Search is debounced by 250 ms and stale requests are
ignored. The last-billing column and sort use the latest observed billing at or
before the report cutoff, including prior months.

Recorded-visit filters include customers with a visit in the previous calendar
month (or any of the previous three) and none recorded in the selected calendar
month. These use authorized points and the selected visit actor, independently
of billing imports. No recorded visit is not evidence of no physical visit.
