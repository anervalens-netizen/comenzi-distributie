# Activation ledger foundation

`activations.py` is a development/offline importer using Python's standard library.
It has no production path default, payroll writer or automatic deployment.
Supply a dedicated private data directory. The application reads a serial-free
aggregate through its authenticated Activări pilot API; it never writes the
ledger. The importer remains offline. The two pilot account IDs are configured
privately; every other user receives 403 from the API and no navigation tab.

```sh
python3 tools/activations.py --preview --operator example-network --data-dir /private/dev-activations /private/example.xlsx
python3 tools/activations.py --operator example-network --data-dir /private/dev-activations /private/example.xlsx
npm run test:activations
```

The example paths are placeholders. Never place real workbooks, databases or
receipts in the public checkout. Preview snapshots an existing database using
SQLite online backup and imports into disposable private storage. Applying is a
separate command which reconciles against the current database under a writer
reservation. It does not reuse a stale preview. A future web preview/apply flow
must bind file hashes, database revision, actor and reviewed impact.

## Data and provenance

One `activations.sqlite` covers every year. Schema/parser version 2 is explicit;
unknown database schemas are refused. SQLite WAL and foreign keys are enabled.

- `activation_imports`: SHA256, original filename, explicit operator namespace, optional nominal period,
  parser version, timestamp, completion status and source-row count.
- `activation_movements`: immutable raw row JSON plus parsed fields. Signed
  per-serial `Qtty` supplies quantity; document-line `Cantitate` never does.
  Company, operator, document detail and exact IMEI identify a source movement.
  A changed payload creates another version and blocks automatic attribution.
  Missing identities are retained as source-specific quarantined movements.
- `activation_occurrences`: each file/row points to a movement version. Exact
  overlap does not multiply quantity; every source coordinate remains available.
- `activation_facts`: replaceable derivation keyed by company, operator and exact
  nonblank `Activat`, with actual activation date/month, product, candidate site,
  reasons and movement/return evidence. This is a provisional identity convention;
  reuse/reactivation semantics still require business confirmation.

The operator namespace is mandatory and must identify the network consistently
across imports. `Furnizor` is a raw supplier field and may change or be blank; it
never partitions an activation identity. A previously imported source cannot be
relabelled to another operator. Operator namespace configuration is an integration
responsibility, not inferred from a filename.

Original XLSX files are kept under their SHA256 in `activation-originals`, with
private permissions. Files are copied, fsynced and hashed before parsing. A failed
import can leave an unreferenced checksummed original for diagnosis; no source
rows, batches or derived facts from that transaction are committed. All supplied
files and the rebuilt derivation commit atomically. Reupload is idempotent. Failed
imports do not erase earlier successful imports. No replacement/deletion or
source-conflict acceptance workflow exists yet; newer exports never silently
supersede older observations. There is no automatic cleanup of source evidence.

## Parsing and conservative attribution

The importer requires one SIM sheet with all 33 distinct headers at row 5. Header
order can vary. ZIP size, entry count, column and row limits are bounded. Rows are
streamed; shared strings are bounded by the package/string size limits. Numeric
serial cells, formulas and Excel errors reject the import rather than risk
precision loss. Other invalid row facts remain visible as unresolved issues.
Serials remain text with leading zeros. Blank/shared-string-empty `Activat` never
creates an activation; a date alone does not create one. The known 19-digit IMEI
and 18-digit Activat relation is validated for SIM, never used to generate an
identity or applied by truncating arbitrary identifiers.

All source movements are retained, including non-TR and head-office returns,
and movements without Activat. Exact company/operator/IMEI groups are reconciled
before a distinct TR token is considered. A negative movement links only to a
unique earlier positive for the same product and nonempty exact company customer
and workpoint codes. Same-day order, unmatched or ambiguous returns stay unresolved.
The sole surviving TR sale with net quantity one may produce a **candidate site**;
it is not an employee/payee assignment. No first/last-row shortcut is used.

Activation month comes exclusively from strictly parsed `DataActivare`. Sale date
and nominal file period do not restrict it. Conflicting dates have no month.
Changed movement versions, conflicting identities/products, missing identities,
invalid values, post-activation movements and nonunique survivors prevent a
candidate. Historical account active/inactive state is never an ingestion filter.
Mismatching IMEIs for one activation serial are quarantined without selecting one.

TELSIM and unknown product types are retained for analysis. Candidate status does
not imply product eligibility, rate, payment or employee mapping. All evidence
carries `commissionStatus=rules_pending` and `employeeMapping=unconfirmed`.

## Remaining integration and business decisions

Upload jobs, confirmed historical site-to-user mapping, commission
eligibility/rates, post-activation returns, period closing/corrections, source
revision acceptance and reliable refresh of older inventory remain separate work.
There are no payable totals. Coverage of all activation months cannot be inferred
from the nominal year of the latest file. Full-history import does not establish
that the upstream reports include all movements.

For production, keep the ledger, report and `activation-originals` together in
the `activations` subdirectory of the configured data directory and set
`MOBIUP_ACTIVATIONS_DIR` to that directory. Backup/restore includes both SQLite
snapshots and verifies original workbook checksums. Validate isolated recovery,
runtime identity and permissions during promotion. Never overwrite existing
production data with a development database. Use online SQLite backup to provision
a verified new ledger or preserve live recovery.

## Separate network ledgers

The existing activation directory remains the Vodafone ledger. Digi uses its own
`digi/` subdirectory with independent `activations.sqlite`, `activation-report.sqlite`
and `activation-originals/`. The API defaults to Vodafone and accepts only
`provider=vodafone` or `provider=digi`; permissions and TR scope apply to both.
The selector never combines network totals. Missing or stale Digi data does not
invalidate the Vodafone report. Report version 2 carries an explicit provider;
the reader preserves compatibility with the original Vodafone version 1 report.
Backup and restore verify both ledgers and each network's source checksums.

Digi imports require `--operator digi` and a dedicated database. The internal
source has one SIM sheet, ten named columns and a row-1 header. `Activat` must be the exact
19-digit text IMEI; `DataDigi` supplies the activation month. `Cantitate` is a
repeated signed document quantity: each serial row contributes only its sign.
Blank activations, numeric serials, invalid dates, contradictory observations,
ambiguous returns and indistinguishable repeated rows are never auto-assigned.
Original rows, including retail and inventory observations, remain private source
evidence. Only distinct TR sale facts enter the application report. Inventory
channels ending in `Inv` remain distinct and never enter the TR population.

For an internal Digi import, `--site-reference-data-dir /private/vodafone-ledger`
can supply unique exact company and TR-label mappings from the historical Vodafone
ledger. This opens the reference read-only. The first internal import records the
mapping snapshot and may replace an empty snapshot left by an older operator-only
ledger. Subsequent internal imports must match the stored mapping. Changes
require explicit reconciliation. Operator imports use only the official report
and its company namespace. No fuzzy person matching, company merging or current
account activity filtering is performed. Missing aliases remain unassigned.
The application uses the published Vodafone ledger as the read-only reference
when the first internal Digi import needs a mapping. If the reference mapping
changes after preview, the application requires a new preview before committing.

## Reporting revisions and atomic jobs

Schema/parser version 3 migrates version 2 in staging and retains all raw rows,
occurrences and archived bytes. Commercial movement versions are selected by an
explicit verified `source_at` date. Activation-only changes do not create extra
quantities. Equal-revision commercial contradictions remain quarantined. Source
file names and import order never establish precedence. Unknown activation fields
cannot erase known values; independent operator observations take precedence over
internal observations for valid supplied fields. Numeric serial cells are refused.

`source_kind=operator` requires an explicit company namespace for Vodafone or
Digi. Each workbook uses its provider's activation sheet and columns.

- Vodafone uses the `Detailed SIM` sheet with `SerieText`, `DATE_OF_ACTIVATION`,
  `COUNTY_OF_ACTIVATION` and `Paid SIM Category`. `SerieText` is an 18-digit
  serial. A leading Excel apostrophe is accepted as a text marker and retained
  in raw evidence. An optional extracted `serial` must agree with the decoded
  `SerieText`. Attribution uses the validated 19/18-digit commercial relationship.
- Digi uses the `activari` sheet with `Distribuitor`, `Seria SIM (iccid)` and
  `Data activare`. The distributor must match the declared company ignoring case.
  The serial is a 19-digit ICCID stored as text and the date uses ISO format.
  Attribution uses the exact ICCID and the validated equality between the
  19-digit `Activat` and `IMEI` values when both appear in a commercial record.

The application also accepts private Vodafone `.json.gz` extracts. The
low-level importer accepts `.json.gz` extracts using the respective provider's
fields. Operator rows without verified TR distribution stay in reconciliation.
An activation requires a reported date in addition to the SIM identifier.

Use `tools/activation_job.py --data-dir /private/network --manifest
/private/batches.json --rules /private/rules.json` for a complete import/rebuild.
The manifest is an array of import options with explicit `files`, `operator`,
`source_kind`, `source_at`, `period_start`, `period_end` and, for operator inputs,
`company`. Omitted source dates stay unknown. Periods describe coverage and never
cause implicit deletion of absent movements or older months.

The job locks one network, snapshots the ledger with SQLite backup, preserves
checksummed originals, migrates/imports/rebuilds in a new generation and validates
integrity before atomically publishing `current`. Import/report failure leaves the
previous generation active. Failed staging is retained privately for diagnosis.
The low-level importer refuses a published generation root. Vodafone and Digi have
independent pointers and physical databases. Backups pin the published directory,
verify report/ledger generation coherence and restore it as ordinary files; retained
prior generations support a controlled rollback without destructive down-migrations.

Projection version 4 contains private indexed detail/cohort tables and precomputed
monthly dimensions. Configure the private `distribution-rules-v1` settings record
with a new revision for every changed mapping. Invalid or stale rules fail closed.
`tools/distribution_configure.py` validates account/site identities, verifies a
new recovery copy and applies only explicit additive county memberships, retaining
all other memberships and transactions. Real configuration belongs outside Git.

Point drill-down searches exact point keys or unresolved row IDs. Company drill-down
requires the covering `detail_company_scope` index generated by the supported report
builder; an older projection without it fails closed for that view until rebuilt.
Publish an upgraded projection in a new immutable generation, preserving the ledger,
source generation and originals. Do not modify a published report in place.

The reporting API supports deduplicated `months` and `projects` selections. Empty
explicit selections mean no rows; omission uses the current Bucharest month and all
projects. The same server scope protects totals, month discovery, point/company
history and paginated export. Existing pilot admission remains mandatory; additional
agent admission is explicit through `MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS`.
National manager read policy does not grant operational write permission.

Partner keys use the existing CIF/franchise identity conventions. Current portfolio
links require exact verified codes; missing/ambiguous associations remain visible
and never merge by name. Company drill-up reuses authorized distinct activation
identities. Recent windows are inclusive calendar dates ending at each source's
reported date. SIM0 cohort counts use reconciled distribution identities, not the
activation-month total, and do not claim physical inventory.

Projection v4 keeps a uniquely reconciled distribution cohort member when its
activation predates a later movement. The activation remains an attribution
exception where required; it is not erased from the cohort or counted twice.
The projection build revision participates in pagination identity.

## Vodafone Focus evidence

The activation job prepares `vodafone-focus-evidence.sqlite` in each private Vodafone
generation before publishing it. The worker checks the directory identity, ledger
generation, facts version and complete import manifest, then applies current order
slips, distribution rules and user scope. Missing, obsolete or unreadable evidence
falls back to the authoritative ledger. The publication receipt records
`report.focusEvidence`. Digi generations skip this projection.

After restoring a backup or installing the reader against an existing generation,
run the following from the deployed runtime as the activation ledger owner.

```sh
python3 activation_focus_evidence.py --generation-dir /storage/comenzi-distributie/activations/current
```

The command reads the ledger, writes a private temporary file and atomically
renames it inside the resolved generation. A second invocation reports
`current`. Use `--force` to rebuild a damaged projection. Recovery can
recreate this file from the authoritative ledger. Treat it as private
commercial evidence since it contains SIM and work-point identifiers.
