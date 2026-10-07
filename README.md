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

## Contributions

Read AGENTS.md. Use a GitHub noreply author address. Keep public issues and comments limited to generic code behavior; exclude private logs, screenshots, addresses and account information. Run the public-data guard before committing.

The resource files used by builds are generated and ignored by Git. `npm run prepare:public` creates synthetic CI inputs only and refuses to overwrite unclassified existing resources. Production builds must use a separately stored, explicitly classified private resource set; synthetic builds must never be activated in production. See tools/build-private.mjs.

## Manager access

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

The derived snapshot refreshes only the replaced month and recomputes activity from its daily aggregates. It falls back to a full rebuild when historical import generations, catalog membership, prior identity allocations or snapshot compatibility change. Processing and derived activity refreshes run in an isolated, persisted background job; returning to Settings restores progress. The standalone host needs Python 3 (including SQLite and zoneinfo) and util-linux flock. The build packages both Python importer files and the worker. Cloudflare returns an explicit unavailable response for this host-only operation.

## Portfolio geography and route filters

County aliases use explicit Romanian county codes and labels (for example `RO-OT` / `Olt`, `RO-IS` / `Iași`, `RO-B` / `București`, `RO-SB` / `Sibiu`). List, map, report, export and cached portfolio filtering share this normalization. Unknown labels remain exact. CRM text, work-point identities, ownership and geographic fingerprints are retained. The derivative portfolio projection rebuilds when its format version changes.

Routes are comma-separated memberships. Filtering by `1` includes `1`, `1, 11` and `11, 1`, but excludes `11`. Facets expose trimmed unique tokens. Ordering and duplicate tokens do not affect membership; display, editing and import preserve the raw field. Old saved combination filters are cleared to all routes; select an individual route after upgrading. Old cached browse pages are recomputed from the available raw summary instead of retaining the earlier exact-string facets.

## Stock coverage and confirmation

Stock preview defaults to partial coverage. Managers declare coverage separately for selected warehouses and the global depot. A partial import replaces present product values and preserves absent products with their prior observation dates. A full snapshot replaces the selected coverage, including removing absent products. Omitted warehouses always remain unchanged. Depot values are global, drawn from the whole file, and repeated product values are not summed.

Preview lists code additions, removals and quantity changes separately for each mapped warehouse and the depot. Any mapping or coverage change requires another preview. Apply requires the exact file hash, stock/agent version, mappings, coverage semantics and manager-bound impact confirmation; older clients without coverage confirmation must refresh before importing. Partial imports never advance the full-depot snapshot timestamp. Legacy imports without an explicit coverage decision are not certified as full coverage.

The stock CAS saves one bounded recovery copy of the prior state, including provenance and observation dates, atomically with the import. This is evidence for controlled recovery, not an automatic rollback over subsequent imports. Reusing a consumed preview fails the version check.

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
