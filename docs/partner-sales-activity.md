# Partner sales and activity

This module is independent of the existing seller/category sales module.
The transaction store is `client-history/client-sales-history.sqlite` under
the configured application data directory. Web requests open it read-only.

## Business views

The partner sheet shows source coverage, period totals, monthly movements,
products, original sellers and paginated transaction lines. Invoice history is
not the same metric as orders created/finalized in the application.

The activity overview supports both operational audiences:
- Agents: their current shared portfolio, regular buyers, overdue regular buyers,
  inactive buyers, reactivated buyers, recent first billing, occasional buyers
  and incomplete histories. Show the reason, last commercial billing date,
  normal cadence and recent sales alongside existing visit/contact actions.
- Managers: the same definitions nationally, with current territory/team filters,
  historical seller filters and a drill-down to each work point. A current agent
  assignment does not rewrite who made an old sale.

The partner list opens the activity overview, with current manager/agent scope,
county/search filters, category counts, 50-row pages and partner-sheet drill-down.
A batch command, explicitly configured with MOBIUP_DATA_DIR, builds the derived
partner-activity.sqlite file: node tools/build-partner-activity.mjs. It reads both
source databases read-only and atomically replaces only this disposable derived
file. Run it after imports/reconciliation and before enabling the overview.
The source reference/import signature fences old snapshots; access membership
is always resolved from the current app database at request time. Old source
coverage suppresses current follow-up alerts. Rebuild if future-dated imports
advance the evaluation date. Snapshot files contain private data and stay
outside this repository.

Counts represent current catalog records and overlapping activity categories,
not unique legal companies. No national monetary total is produced by summing
records or overlapping portfolios. Unlinked records remain explicitly unknown.

## Activity definitions

The observation unit is a work point. Never collapse different work points
solely because they share a company tax identifier.

Cadence uses **distinct commercial billing days**, not line counts, product
counts, zero-value SIM movements or a claimed order count. Export document
numbers are grouped by work point identity scope, date, source site and number
to remove net cancellations before dates are aggregated. This is not a promise
that the export contains a globally unique invoice identifier.

Current configurable starter rules (not empirical targets):
- At least six billing days spanning at least 28 days.
- Up to the latest 12 billing days, within 365 days of the last billing.
- Normal cadence: median days between events. Regularity: median absolute
  deviation no more than half the median, median no more than 90 days.
- Overdue: pause greater than max(14 days, 1.5 times cadence + MAD).
- Inactive after formerly regular billing: pause greater than
  max(60 days, 3 times cadence, overdue threshold).
- Recent first observed billing: within 60 days; this is not company creation.
- Reactivated: recent billing after a gap beyond the inactivity threshold,
  with a regular prior baseline.
- Possible seasonality: similar narrow month patterns in the two prior calendar
  years and a current month outside that pattern. It is a hint, not certainty.

Inactivity is evaluated at the latest covered source date, never by silently
extending an old import to today's date. Alerts are suspended when source data
is more than three days late, relevant associations/values/period coverage are
incomplete, or a seasonal pattern calls for review.

The displayed financial sum is the sum of known source value cents including
negative lines; missing amounts remain unknown. Quantities remain in integer
millionths in storage. Gross positive billing, zero-value activity and returns
must not be conflated. A free delivery or return alone does not reactivate a
commercial buyer. Source transactions are never deleted as apparent duplicates.

The overview compares 30 days through the evaluation date with the preceding
30 days, exposes possible seasonality, and sorts follow-up by elapsed cadence,
then previous-period billed value. It never labels historic volume as proven
lost revenue. Financial values remain partial when source associations or
amounts are incomplete.

## Geography and catalog

`tools/client_catalog_plan.py` creates an additive, private plan from current
customers, all active history identities and a location reference.
`tools/client_catalog_geography.py` enriches missing counties from explicit
seller territories or counties named in the source seller label.

A known address/county wins over inference. Inferred counties carry provenance,
seller evidence and candidate counties; they are commercial allocations, not
verified street addresses or map coordinates. Multiple counties, conflicting
sellers and unknown seller territories stay explicit. County-wide shared
portfolios may overlap. Unknown geography must not erase a company or its sales.

A partial existing catalog cannot prove that a previously unseen explicit
franchise code is an existing street address, even with only one old address
for that company. Preserve the distinct coded identity until corroborated.

Company-only entries are separate from identified coded work points. An unknown
association must display as unknown/incomplete rather than zero actual sales.
Catalog plans are not applied by these read-only planning commands.

## Integrity and access

Partner sales routes first authorize the existing partner using the application's
current portfolio scope. Managers use the established national read scope.
SQL uses parameter binding. Historical agent values remain unchanged.

Shared portfolio membership is many-to-many. A manager's national total must
aggregate source transaction identities exactly once, never sum overlapping
agent portfolio subtotals. Agent-specific portfolios may legitimately overlap.

## Validation

Run the history, catalog plan/geography, partner sales health and read-only
store tests, plus typecheck, lint and the application acceptance tests.
Fixtures must be synthetic. Real plans, maps and customer data remain private.
