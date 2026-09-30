# Per-customer sales history

This is a separate dataset from the application's existing per-TR sales reports.
It neither reads nor modifies `sales.sqlite`, the monthly uploader, or the sales UI.
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
3. Additional locations found in the master prevent an unsafe single-point
   assumption. Ambiguous/missing identities remain visible for reconciliation.
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
