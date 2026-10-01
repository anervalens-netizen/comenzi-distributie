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

## Billing-period filters

The partner list, map and activity overview share salesPeriod. Choices are an
explicit calendar year, the latest 90/365 days, last billing at least 365 days
ago, and unlinked/incomplete history. The default includes every catalog record.
The filter follows commercial billing, excluding zero-value movements and net
cancelled documents, using the same definition as cadence. Years are stored in
the derived snapshot (version 2); rebuild older snapshots before serving filters.

Period selection changes which partners are visible, not their current portfolio
assignment. Cadence and 30-day financial comparisons remain evaluated at source
coverage, as labeled; selecting an old year does not imply an as-of-year replay.
Unknown records are never called old merely because no linked sale was found.
Missing/stale-derived snapshots return an explicit error rather than an empty map.
No-filter browsing and geocoding remain independent of history availability.

Seller territory references may provide sellerProvenance to distinguish an owner
confirmation from customer-distribution inference. Geographic inference must use
independently known client counties, count distinct companies rather than lines,
and inspect changes across years and conflicting clients. Real evidence is private.


## Sales table

The activity page uses one paginated sortable table, initially descending by net
sales value across the full selected portfolio. Client and value appear first so
both fit on mobile; remaining columns scroll within the table. Period, county,
search and optional activity filters sit above it. The existing manager region
and agent controls scope the same table. Current shared owners are displayed;
unassigned counties remain visible to managers without an agent filter.

Snapshot version 4 retains point daily data and adds separate company activity
and daily tables. The client table groups authorized cards once per company and
uses complete company totals, including unresolved point rows. Selected-period sales include
returns and preserve missing amounts. Positive document groups are counted once
per company/date/site/number, excluding blank numbers, net cancellations and free
movements. This is labeled “Facturări”, not a verified count of application orders.
The latest positive billing date is scoped to the selected period too. Unlinked
records display a dash, never a false zero; partial associations are marked.
All sorting occurs before pagination, with unknown values last in both directions.
No national total is calculated by summing potentially shared/legacy aliases.

After deployment, rebuild the derived snapshot using the matching current builder;
source history, original seller attribution and existing TR reports stay intact.

## Sales-first partner sheet

Opening a partner expands its sales section immediately. Contact/location editing
and visits are closed disclosures; navigation and any saved phone remain reachable.
Internal catalog IDs are not presented as work-point codes.

The default date range spans all active historical imports. The period controls
can narrow the summary, document count, recent documents and products. Cadence
continues to use the whole history and is explicitly labeled separately.

The five most recent positive-net documents are grouped by partner identity,
date, site and document number, using only authorized linked facts and active
imports. Exact cancellations, standalone returns and unnamed movements are not
counted as bills; their amounts remain in net sales and raw transactions.
Each document expands to aggregated products/quantities/amounts and its original
seller(s). Product previews are bounded to 20 per document and explicitly flag
truncation. The sum of the visible documents is separate from period net sales.

Missing history stays unavailable/unlinked rather than zero. Partial coverage
is called out next to the total. These are source billing documents, not verified
application order IDs. No allocations, contacts, coordinates or visits are changed
by viewing the sheet.

## Current portfolio access and company history

Sales access is authorized by the existing portfolio route before historical data
is read. Original sellers do not filter accessible history. Every visible card
opens the full company history by default, identified by its normalized CUI and
unambiguous CRM aliases. This includes other work points and sales without a
point assignment. Exact point history remains an explicit optional filter; it is
the automatic fallback only when no company history can be identified. The response labels this scope as company, never as confirmed point
sales. Where both scopes exist the user can select point or whole company.

Company matching includes rows pending point reconciliation without changing
their allocation. Ambiguous aliases, generic consumers and name-only matches
are excluded. No source facts or point assignments are rewritten. The client table and its detail sheet now use the same company identity resolver.
The map and browse period filters include all authorized points of a company with
transactions in the selected period. This does not claim that every point sold;
exact point allocations remain separate. Year/recent filters include zero-value
movements; positive facturări counts retain their existing definition.

The partner header exposes a full-width position-update action for editable
partners. It opens the contact and position controls, scrolls directly to GPS
and moves keyboard focus to its button. Opening the shortcut does not request
geolocation or write data; GPS capture and the existing save confirmation remain
explicit. Sales still opens by default and contact editing starts collapsed.

## Monthly client report (snapshot version 5)

Navigation: **Vânzări → Pe clienți**, or **Echipă → Agenți → Vânzări pe
clienți**. This is a separate, lazy subtab in the existing sales screen. Its
independent month selection never fetches or supplements from the daily TR
upload. The manager's current region/agent selection follows the existing
national read policy; write authorization is unchanged.

`GET /api/sales/clients` accepts `month` (`YYYY-MM`), `filter`, `q`, `county`,
`sort`, `direction`, zero-based `page`, and existing manager scope parameters.
Pages contain 50 companies and at most 20 authorized point shortcuts per company;
remaining points stay accessible in the existing partner portfolio. Search/geography select companies through any
currently authorized point, retaining their full legal-company history.
Totals and chip counts apply before status filtering and pagination. Null
amounts sort last in both directions. Unlinked histories stay unknown.

Version 5 retains the version 4 tables and adds company identity quality plus
import-level coverage metadata. Rebuild with the same explicitly configured
`MOBIUP_DATA_DIR` and `node tools/build-partner-activity.mjs`. Older snapshots
return an explicit rebuild message in all readers. Raw source aggregation only
runs during that batch build; HTTP reads the derived daily company aggregates.
Source and application databases remain read-only during building. Current
portfolio membership is resolved afresh on every report request.

Each active import exposes its declared end, latest actual transaction date
across the **whole import**, and import timestamp. Its effective observation
end is the minimum of declared end, observed end, and today in Bucharest.
Declared coverage supplies the start and internal coverage claim; the last
observed date alone never proves export completeness. Gaps between effective
import intervals suspend affected absence/health conclusions. No transactions
within a declared interval is not independently verified proof of completeness.
A month beyond observation is **not imported**, with null financial KPIs and
an explicit latest-available-month action. Missing final days remain visible.

Full months compare preceding full calendar months. Partial months compare
through the same day number, clamped to each month's length. Previous/three-month
absence filters require covered equivalent windows and known associations and
amounts. These lists are exploratory absences up to the cutoff, never proven
churn. Documents are distinct positive-net company/date/site/number groups with
positive commercial quantity/value and no missing amounts. Blank document
numbers, free movements, returns alone and cancellations do not establish a
purchase; all known source amounts still contribute to net sales, including
returns and unnamed movements. These are not verified application orders.

Recent means the first **observed** positive documented billing day is within
60 calendar days ending at the selected cutoff (elapsed 0–59). A later billing
day establishes repeat; multiple bills on the first day do not. Without repeat,
less than 30 elapsed covered days means waiting; at least 30 means a review
signal, only with continuous coverage, known identity/amounts, and fresh source
coverage. Incomplete historical months cannot issue current overdue alerts.
Completed historical months show signals as of that month. Future bills and
future missing amounts do not influence those signals. Reactivation requires
an earlier actual purchase, at least 60 days between billing days and known
continuous coverage; it is a simple disclosed rule, not a risk score. It does
not require the regular-cadence baseline used by the older activity overview.

Visits are completed `partner_visits` records, grouped once by authorized
company, with the selected agent as actor when applicable. Their range is the
full selected Europe/Bucharest calendar month, independently of imported sales
coverage. Comparative visit ranges are labeled separately. Visits on unlinked
cards still count. Cards without a usable company identifier retain their visits
and have a separate unidentified-card count, rather than an invented unique-company
count. Zero records shows a caution; “Fără vizită înregistrată”
never claims a physical visit did not occur. Plans and GPS are not used.

The report is explicitly a **current portfolio** report, not personal historical
seller performance. Source-author mode is intentionally absent: current
ownership and shared site codes cannot safely establish that attribution.
Open a company or any authorized point to see its original sellers/documents in
the existing partner sheet. It starts at the selected reporting window and
retains the explicit company/point toggle. Monthly health explanations stay in
the report; the sheet does not show its separate whole-history cadence in this
entry path.

Synthetic checks: `npm run test:client-sales`, `npm run test:client-sales:browser`,
and `npm run test:client-sales:http` (the isolated QA server must be running).
All are included by `npm run check`; its API credentials now remain inside the
checkout's ignored `work/qa-credentials` directory.
