# Distribution application

This public repository contains source code, reusable configuration examples and fictional test fixtures. Operational records, real customer/product data, credentials, private deployment configuration and production backups are maintained separately by the operator.

## Development and CI

Use the Node.js and package-manager versions specified by the CI workflow.

```sh
npm ci
npm run prepare:public
npm run check
```

Tests use isolated temporary data. Never point CI at a production database or import real account, customer or employee data. Run application-specific regression checks before publishing changes.

## Deployment

Configure actual hosts, filesystem paths and secrets privately. Files under deploy/ are templates, not an inventory of live machines. Preserve installed application identifiers and existing databases during upgrades. Operator deployment records and rollback procedures belong outside Git.

The standalone entry waits for the specific `HOST` address before starting the
HTTP server. `HOST` must be an IPv4 or IPv6 literal; it defaults to loopback and
rejects wildcard addresses. Only `EADDRNOTAVAIL` is retried, for at most
`MOBIUP_BIND_TIMEOUT_MS` (default 60000, maximum 300000). Timeout exits nonzero;
the service template uses `Restart=on-failure`, a delay and a start-rate limit.
`network-online.target` alone does not guarantee that an overlay address exists.
An address disappearing after the probe still fails the actual bind; no fallback
interface is used. A persistent failure can exhaust the systemd start limit and
requires operator diagnosis. Configure the bind address and matching proxy
upstream privately.

`GET /api/health` is unauthenticated process liveness only; it does not initialize
or query the database. `GET /api/admin/status` requires a global manager session
and returns read-only aggregate history import dates/coverage and portfolio
projection revisions/pending rows. Missing/error states are explicit; no source
filenames, paths, customers or raw errors are returned. Coverage bounds do not
prove that every intervening month was imported, and `current` refers only to the
portfolio projection's recorded dirty queue. Backup success remains the external
backup job's responsibility, not an HTTP health claim. Existing import screens
remain available for job details. Activation checks liveness plus anonymous
`/api/bootstrap` for database initialization; configure `MOBIUP_READY_URL` when
using a custom health URL, and size the activation wait for any longer bind wait.

Full recovery requires runtime, classified resources and product assets configured
through the existing `MOBIUP_RECOVERY_*` settings. The runtime includes
`bind-ready.mjs`. Backups preserve SQLite snapshots, history originals and a
checksummed recovery manifest. `deploy/restore.py` requires the archive checksum
sidecar, validates required resources against the compiled release and restores
only to a new isolated directory; it does not start services. Derived portfolio
and activity models are rebuildable and do not replace authoritative history.
Synthetic recovery tests are not evidence of a production restore or a real
reboot, and cannot establish production RPO/RTO.

Backend frame URLs use unique basenames derived from the Debug ID, so basename
fallback cannot confuse RSC and SSR entries. Runtime filenames stay unchanged.
Receiver uploads must also use those unique basenames for the private JS/map
pairs and verify their bytes; matching names and Debug IDs alone is insufficient.

Backend source maps remain private and use a release-bound Debug ID for each
server bundle. Full relative paths distinguish RSC and SSR bundles sharing a
basename. The runtime reports an ID only for an artifact in its matching
manifest; missing or mismatched evidence retains the original frame. Worker
maps retain their existing identity. This identifies artifacts; it does not
repair missing mappings in upstream transforms. Verify received frames before
activating a release, and preserve the private artifact and receiver receipt.

## Contributions

Read AGENTS.md. Use a GitHub noreply author address. Keep public issues and comments limited to generic code behavior; exclude private logs, screenshots, addresses and account information. Run the public-data guard before committing.

The resource files used by builds are generated and ignored by Git. `npm run prepare:public` creates synthetic CI inputs only and refuses to overwrite unclassified existing resources. Production builds must use a separately stored, explicitly classified private resource set; synthetic builds must never be activated in production. See tools/build-private.mjs.

## Standalone dependency boundary

`build:server` traces every emitted server chunk and worker with `@vercel/nft`
under both SSR and React Server Component conditions. It reconstructs the
standalone dependency directory from the installed source tree, preserving
nested package versions, instead of shipping Vinext's complete build-tool tree.
Unresolved trace warnings fail the build. `runtime-dependencies.json` records
entry points, copied files and package versions. The full check relocates the
artifact outside the checkout and consumes complete bootstrap, HTML and RSC
responses; this prevents missing dependencies from resolving through the source
checkout. Application and worker regression tests exercise the resulting build.

`shadcn` is a development dependency because its CSS is consumed during the
build. Vinext remains a runtime dependency: the standalone server imports its
production server. The stable framework is pinned to 1.1.0. Its Satori dependency
uses the compatible fflate 0.7.5 security backport through a scoped override,
avoiding the vulnerable ZIP64 parser without downgrading the framework. Source
audits therefore include Vinext's build dependency chain even though unreachable files are excluded from release artifacts.
The upstream braces advisory GHSA-vfj7-8cjw-p6xm has no patched version at the
time of this change. Do not use forced downgrades to hide this finding. Its
remaining source-tree use is build tooling processing repository-controlled
patterns, not request input. Keep build jobs isolated from production credentials;
verify each installed artifact's actual inventory independently of source audit.

Optional `MOBIUP_NAS_LATEST_ONLY=1` retains one NAS generation only after the
supported restore command successfully restores that generation to an isolated
local temporary directory. Restore failure preserves previous NAS generations.
The default fourteen-day retention remains available. Local backup space must
also accommodate the temporary restored generation. Install `backup.py` and
`restore.py` together so the retention gate uses the current restore contract.
Restore defaults to 8 GiB of uncompressed archive members and 100,000 entries.
For larger history sets, explicitly set `MOBIUP_RESTORE_MAX_BYTES` to a positive
integer byte limit in both the backup service and manual restore environment.
Size it against the full archive inventory and available temporary disk space;
checksum, path, resource, database and entry-count checks still apply.

## Manager access

The manager workspace separates operational activity (Sinteză), product sales
(Accesorii, including an additional-products view), and prepaid SIM sales and
activations (Prepay). Operational activity has one monthly selector; commercial
reports share direct multi-month selection and visible project toggles. The
customer portfolio report retains its explicitly monthly scope. Changing the
presentation does not change authorization or activation eligibility.

Agents reuse the same Accesorii and Prepay reports for their own portfolio.
Prepay sales remain available independently of activation access; only the
Activări subtab requires that permission. Their report controls select months,
while seller and project scope come from the authenticated account. Customer
reports retain a single month and do not expose manager reconciliation controls.

Product mappings are evaluated when reading sales and SIM 0 cohorts. Updating
only product mappings or their revision does not require rebuilding activation
facts. Report compatibility still requires identical structural rules, and
detail/export selection tokens include the complete current rules. Unmapped
products remain inspectable by source category and subcategory.

Activation partner summaries distinguish identified work points, personal sales
and activations whose point identity remains unresolved. Browse groups and
activation counts are not work-point counts. Personal sales remain in totals;
detail and export retain the same authenticated scope. A reported handset
category of `-` is explicit noncommissionable evidence, not a missing value.

All managers can view national activity, partners, orders, stock, inventory and sales, with region and agent filters. Regional assignments still govern account changes and operational writes. Managers change their own password from their profile; regional managers reset assigned agents' passwords under Team → Passwords and accounts (the default subtab). Regional managers cannot change other regions' accounts or manager assignments.

## Lucru mobil și offline

Datele consultate și ciornele se păstrează automat pe dispozitiv, fără activare manuală. Aplicația nu descarcă preventiv întregul portofoliu; fără conexiune sunt disponibile doar datele deja păstrate local. Fundalul hărții necesită conexiune.

Ciornele, modificările fișelor, vizitele și planurile sunt păstrate separat pentru fiecare cont în IndexedDB. „Salvat pe telefon” confirmă doar persistența locală. Operațiunile se sincronizează în ordine când aplicația este deschisă și conexiunea revine. Finalizarea și exportul necesită confirmarea serverului. Erorile de sesiune, permisiune sau revizie păstrează lucrul pentru verificare. Recuperarea este disponibilă în comanda, fișa partenerului sau planul afectat: compară versiunile și alege explicit modificările locale sau versiunea serverului. Operațiunile deja trimise își păstrează identitatea și conținutul la reîncercare; rezolvarea arhivează copia veche și creează o operațiune nouă numai după verificare. Comenzile șterse ori finalizate permit recuperarea într-o ciornă nouă, iar accesul retras nu permite retrimiterea.

Actualizările PWA nu reîncarcă automat editorul. Activarea unei versiuni noi este oferită după golirea cozii, iar resursele versiunilor anterioare rămân disponibile taburilor deschise.

Din fișa partenerului, agentul poate înregistra explicit o vizită fără să reintroducă firma sau agentul. Nota, pasul următor și data revenirii sunt opționale; o revenire datată reutilizează planul zilei. Apelurile, facturile, coordonatele GPS și opririle planificate nu creează automat vizite. O perioadă fără vizite înregistrate înseamnă lipsă de dovezi în aplicație, nu dovada că agentul nu a mers la client.

Fișa și lista disting pinul confirmat manual, poziția GPS, adresa completă, strada/adresa aproximativă, centrul localității și poziția necunoscută. Proveniența, precizia GPS disponibilă și data actualizării sunt afișate în context; pinii aproximativi nu sunt ETA sau dovadă de vizită. Confirmarea manuală este protejată de fluxul existent de geocodare.

Cardul compact „Necesită atenție” din Parteneri combină numai acțiuni existente: lucrul local al contului curent de pe dispozitivul curent, reveniri scadente, poziții de confirmat, semnale din raportul pe clienți, acoperirea sursei și excepțiile CRM autorizate. Momentul încărcării sursei este separat de data până la care există acoperire; weekendurile sau sărbătorile nu produc singure alerte.

Runtime-ul Node construiește un model derivat, regenerabil pentru portofoliu, cu revizii dedicate datelor și acoperirii utilizatorilor. Triggerele SQLite urmăresc și modificările făcute din alte conexiuni, fără funcții SQL private. Browse păstrează paginarea, totalurile și fațetele complete pentru selecție; harta agregă după nivelul de zoom și permite apropierea până la punctele individuale. Datele autoritative nu sunt rescrise pentru această optimizare.

## Customer sales imports

Settings → Imports includes a manager-only cumulative monthly customer-sales XLSX upload. Preview shows the inferred or declared month, totals and changed rows; applying replaces that month atomically and preserves all other months. Repeating the same active source is idempotent. Shorter coverage or removed/changed rows require explicit confirmation. Mixed-month reports are rejected. Original files and superseded source generations remain in the private data directory. Daily uploads use transaction rollback and append/supersede; scheduled verified backups provide disaster recovery without cloning the entire history database per upload.

The derived snapshot refreshes only the replaced month and recomputes activity from its daily aggregates. A transactional source revision tracks inserts, updates and deletes from every connection. Permission changes and WAL checkpoints do not invalidate derived data. Import receipts bind both the pre-import and committed revision; a later correction or concurrent replacement still forces a safe rebuild. Legacy history installs tracking on its next supported import and requires one full rebuild to establish the baseline. Before initial tracking installation or coverage repair, the importer holds the SQLite writer reservation and preserves a private SQLite recovery snapshot including committed WAL, an integrity check and a checksummed receipt under client-history/migration-backups. Missing, failed or unverifiable recovery stops before revision schema writes. A valid revision schema does not create another copy on ordinary previews or uploads. Keep these migration copies with the private data recovery records; they do not replace scheduled full recovery backups. Job results retain the exact fallback reason. It falls back to a full rebuild when historical import generations, catalog membership, prior identity allocations or snapshot compatibility change. Processing and derived activity refreshes run in an isolated, persisted background job; returning to Settings restores progress. The standalone host needs Python 3 (including SQLite and zoneinfo) and util-linux flock. The build packages both Python importer files and the worker. Cloudflare returns an explicit unavailable response for this host-only operation.

## Portfolio geography and route filters

County aliases use explicit Romanian county codes and labels (for example `RO-OT` / `Olt`, `RO-IS` / `Iași`, `RO-B` / `București`, `RO-SB` / `Sibiu`). List, map, report, export and cached portfolio filtering share this normalization. Unknown labels remain exact. CRM text, work-point identities, ownership and geographic fingerprints are retained. The derivative portfolio projection rebuilds when its format version changes.

Routes are comma-separated memberships. Filtering by `1` includes `1`, `1, 11` and `11, 1`, but excludes `11`. Facets expose trimmed unique tokens. Ordering and duplicate tokens do not affect membership; display, editing and import preserve the raw field. Old saved combination filters are cleared to all routes; select an individual route after upgrading. Old cached browse pages are recomputed from the available raw summary instead of retaining the earlier exact-string facets.

## Stock coverage and confirmation

The daily ERP stock file is a complete replacement of current stock, for both agent warehouses and the global depot. Present quantities replace previous values, zero stays zero, absent products are removed, and warehouses without mapped rows become empty. This includes stored warehouses whose agents are no longer active. There is no partial-import option in the daily upload. Source groups outside the application's agent roster may be left unassigned; their depot values still participate in the global depot and repeated values are never summed.

Preview lists additions, removals and quantity changes for every affected warehouse, including those emptied because they are absent from the file, and separately for the depot. Apply requires the exact file hash, stock/agent version, mappings and manager-bound full-replacement confirmation. Older clients submitting partial imports or an old confirmation must refresh. Invalid files, invalid mappings, conflicting depot values and stale/concurrent imports never write a partial replacement.

The stock CAS saves one bounded recovery copy of the prior state, including provenance and observation dates, atomically with the replacement. This is evidence for controlled recovery, not an automatic rollback over subsequent imports. Reusing a consumed preview fails the version check. Legacy partial stock is not retroactively certified as current.

## Revenue reconciliation

Managers can open the national reconciliation from the customer-sales report and export its complete exception list. It is independent of agent, county and search filters. Agents retain only their authorized portfolio/company history; national reconciliation and its export require manager access.

The bridge uses integer cents and exclusive partitions: raw source = consumers + linked legal companies + unresolved identities; linked companies = current active portfolio + inactive-only companies + companies absent from the current CRM. Negative returns and zero values remain in the bridge. Missing amounts are counted separately from known cents, and an unimported month is explicitly marked. Shared points contribute once per company; historical sellers are not attributed to today's portfolio owner. Ambiguous work points are not assigned by this report.

The derived activity format is version 8 and requires the supported activity-snapshot rebuild after upgrading. Existing source history is read-only. Version 7 projections are rejected as stale by new readers until rebuilt; previous readers can rebuild their own derivative format after rollback. Source revision, immutable identity reference, effective period, import coverage and live portfolio revision accompany the reconciliation/export. Current CRM membership is re-read even when immutable source totals are cached.

## Synthetic performance measurements

See [the LAB harness guide](tools/performance/README.md) for repeatable report,
bootstrap/search and inventory measurements. Artifacts are written only under
ignored `work/performance/`. The report cache keeps bounded compact chunks within
its existing budget; clients still receive independently mutable full results.

Health probes bypass process HTTP proxies. When a service uses EnvironmentFiles,
activation requires an explicit effective MOBIUP_HEALTH_URL or both
MOBIUP_HEALTH_HOST and MOBIUP_HEALTH_PORT; it does not guess values hidden by
systemctl's Environment property. Missing endpoint evidence fails before the
active release changes.

## Error reporting

Set `GLITCHTIP_DSN` in private runtime configuration. Browser builds use `VITE_GLITCHTIP_DSN` (Next.js: `NEXT_PUBLIC_GLITCHTIP_DSN`). Rebuild assets when the destination changes, and preserve the exact source release identifier.

New integrations retain stack locations, SDK version, component and release, while removing request payloads, user data, breadcrumbs and private exception messages. Synthetic acceptance events must carry `glitchtip.synthetic=true` and a unique `validation.run`; verify receipt at the destination. The operational collector excludes these test events from alerts. Validation must not crash the application or modify business data.

Private Node releases keep hidden browser and compiled backend maps under
`.private-source-maps/`, outside `dist/client` and `public`. The private build
records map support in `RELEASE.json`. Before activation, configure the existing
receiver gate with `MOBIUP_SOURCE_MAP_GATE`, `MOBIUP_SOURCE_MAP_PROJECT` and
`MOBIUP_PUBLIC_ORIGIN`; it must validate the exact manifest, upload once and verify
a received source frame. Retain the complete private release for recovery.
Backend maps are retained separately; receiver limitations for duplicate script
basenames must be evaluated before claiming backend symbolication coverage.

The same activation gate validates all four backend worker maps (including `.mjs` support). Framework/RSC maps remain private; duplicate index basenames and upstream transform warnings require separate proven resolution before claiming complete framework-frame coverage.

## Usage analytics

Managers: Echipă → Utilizare aplicație, with the existing national read scope and region/agent filters. Shows per-account logins, app openings, days with measured use, visible time and active estimated time, plus IP/browser audit detail and CSV summary. Tracking always belongs to the authenticated actor, including a manager acting for an agent. Successful password logins and explicit logout are server events; persistent authentication alone is not usage.

The native collector sends a bounded pulse every 30 seconds while visible and flushes on hiding/closing. Active time means visible with an interaction during the last 120 seconds; no typed text, document content, mouse coordinates or screen recordings are collected. Timer gaps over 45 seconds are discarded. Durations are estimates from acknowledged recent foreground intervals; overlapping tabs/devices are unioned per account/day in Europe/Bucharest. Network outages, old app versions, blocked collection and abrupt termination can leave gaps. No historical time is inferred from documents or session expiry.

Node stores analytics separately in MOBIUP_DATA_DIR/usage.sqlite (WAL). Retention is 90 days, pruned on next analytics activity. Include this file and committed WAL in private backup/recovery procedures; use a SQLite online backup, not a live file copy. IP uses only the trusted ingress-sanitized CF-Connecting-IP header; direct origin access must remain restricted. The report retains last 100 detail rows per selected account and period; narrow dates for older details. The disabled/read-only Cloudflare preview does not collect. MOBIUP_USAGE_DISABLED=1 disables storage/reporting; collector failures never block application operations. No new package, permission prompt, PWA identity change or forced reload is needed. Existing PWA update rules apply.

Historical sales identity aliases are explicit owner-maintained records in the private application settings key `sales-agent-aliases-v1`: a JSON array of `{userId, siteCode, warehouseName}`. Use them only after confirming continuity of the account/portfolio. They participate in report scopes and import preview revisions, retain the current account name, and preserve raw imported rows. Exact duplicate aliases are deduplicated, inactive accounts remain excluded, conflicting ownership fails closed, and invalid configuration returns an error. Account renaming alone does not automatically claim a historical location.

New partner registration activates the work location atomically with the agent record. Exact company/location/county/address matches reuse the existing point; ambiguous legacy points require explicit selection by the submitting agent. Retries of the same saved payload are idempotent. Managers receive informational push/inbox notifications, with independent read state per manager; reading a notification never changes the portfolio. Client lists and manager metrics contain completed registrations only; the former approval endpoint returns 410 without changing data. Legacy incomplete payloads remain stored and can be completed by their submitting agent through registration. Preparing the operational email remains separate from sending it.

Partner registration uses shared conservative Romanian address matching. Complete,
unambiguous points are reused; incomplete addresses, nearby numbers, county
conflicts and ambiguous legacy points require an explicit location choice. The
server repeats the decision for direct API submissions. CUI lookup prefilters in
SQLite and verifies normalized values in application code; it adds no startup index.
See [offline CRM location repair](tools/CRM_LOCATION_REPAIR.md) for backup-verified
county overrides and evidence-preserving aliases. Historical payloads remain immutable;
existing history screens do not combine activity across retired aliases.

## Activation ledger (development)

The separate activation database and offline XLSX importer are documented in
[Activation ledger foundation](tools/ACTIVATIONS.md). They preserve all source
movements, reconcile returns before proposing a TR site, and derive months only
from activation dates. Both agents and managers use Prepay, with Vânzări and
permission-gated Activări subtabs and monthly report selection. Reports show eligibility, without commission amounts. Configure
MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID and MOBIUP_ACTIVATIONS_PILOT_AGENT_ID privately.
Activation navigation and API access default to denied; Prepay sales remain available. Agents receive only their
unambiguously owned current site; managers can use the existing read filters.
No user names or account IDs belong in the public source.

Build the serial-free aggregate with `python3 tools/activation_report.py
--data-dir /private/dev-activations` after an import. Set MOBIUP_ACTIVATIONS_DIR
to that directory for the Node runtime. Reads never modify the source ledger,
and changed import generations make an old aggregate unavailable until rebuilt.
Derived facts also carry a semantic version, separate from the storage schema.
Before activating a runtime that requires a newer version, use the supported
staged activation job for each operator with an empty batch manifest and the
existing rules. It rebuilds stale facts and the matching report atomically,
preserving the previous generation and original sources. Repeated imports or
empty jobs cannot silently certify an older interpretation. Validate the new
generation and its aggregate differences before deployment; runtime reads
reject incompatible derived versions rather than rewriting source data.
The aggregate counts distinct TR activation identities, includes unresolved
attribution only in the national total, and never calculates commissions.
This development module does not deploy or initialize production storage.
