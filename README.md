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

## Contributions

Read AGENTS.md. Use a GitHub noreply author address. Keep public issues and comments limited to generic code behavior; exclude private logs, screenshots, addresses and account information. Run the public-data guard before committing.

The resource files used by builds are generated and ignored by Git. `npm run prepare:public` creates synthetic CI inputs only and refuses to overwrite unclassified existing resources. Production builds must use a separately stored, explicitly classified private resource set; synthetic builds must never be activated in production. See tools/build-private.mjs.

## Manager access

All managers can view national activity, partners, orders, stock, inventory and sales, with region and agent filters. Regional assignments still govern account changes and operational writes. Managers change their own password from their profile; regional managers reset assigned agents' passwords under Team → Passwords and accounts (the default subtab). Regional managers cannot change other regions' accounts or manager assignments.

## Lucru mobil și offline

Agentul poate folosi modul Listă și poate pregăti datele din „Lucru pe telefon” înainte de deplasare. Interfața arată data pregătirii și acoperirea catalogului/fișelor; pregătirea este limitată, cu fișele traseului săptămânii prioritare. Fundalul hărții necesită conexiune.

Ciornele, modificările fișelor, vizitele și planurile sunt păstrate separat pentru fiecare cont în IndexedDB. „Salvat pe telefon” confirmă doar persistența locală. Operațiunile se sincronizează în ordine când aplicația este deschisă și conexiunea revine. Finalizarea și exportul necesită confirmarea serverului. Erorile de sesiune, permisiune sau revizie păstrează lucrul pentru verificare; scoaterea unei operațiuni din coadă păstrează copia locală de recuperare.

Actualizările PWA nu reîncarcă automat editorul. Activarea unei versiuni noi este oferită după golirea cozii, iar resursele versiunilor anterioare rămân disponibile taburilor deschise.

Runtime-ul Node construiește un model derivat, regenerabil pentru portofoliu, cu revizii dedicate datelor și acoperirii utilizatorilor. Triggerele SQLite urmăresc și modificările făcute din alte conexiuni, fără funcții SQL private. Browse păstrează paginarea, totalurile și fațetele complete pentru selecție; harta agregă după nivelul de zoom și permite apropierea până la punctele individuale. Datele autoritative nu sunt rescrise pentru această optimizare.

## Customer sales imports

Settings → Imports includes a manager-only cumulative monthly customer-sales XLSX upload. Preview shows the inferred or declared month, totals and changed rows; applying replaces that month atomically and preserves all other months. Repeating the same active source is idempotent. Shorter coverage or removed/changed rows require explicit confirmation. Mixed-month reports are rejected. Original files, source rows and recovery copies remain in the private data directory.

Processing and derived activity rebuilds run in an isolated, persisted background job; returning to Settings restores progress. The standalone host needs Python 3 (including SQLite and zoneinfo) and util-linux flock. The build packages both Python importer files and the worker. Cloudflare returns an explicit unavailable response for this host-only operation.
