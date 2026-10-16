# Activation ledger foundation

`activations.py` is a development/offline importer using Python's standard library.
It has no production path default, HTTP endpoint, permission bypass, UI, payroll
writer or automatic deployment. Supply a dedicated private data directory. The
application does not yet open this database. Future application integration must
use existing authenticated roles and organizational visibility, keep historical
site identities, and package the importer explicitly in the supported release.

```sh
python3 tools/activations.py --preview --data-dir /private/dev-activations /private/example.xlsx
python3 tools/activations.py --data-dir /private/dev-activations /private/example.xlsx
npm run test:activations
```

The example paths are placeholders. Never place real workbooks, databases or
receipts in the public checkout. Preview snapshots an existing database using
SQLite online backup and imports into disposable private storage. Applying is a
separate command which reconciles against the current database under a writer
reservation. It does not reuse a stale preview. A future web preview/apply flow
must bind file hashes, database revision, actor and reviewed impact.

## Data and provenance

One `activations.sqlite` covers every year. Schema/parser version 1 is explicit;
unknown database schemas are refused. SQLite WAL and foreign keys are enabled.

- `activation_imports`: SHA256, original filename, optional nominal period,
  parser version, timestamp, completion status and source-row count.
- `activation_movements`: immutable raw row JSON plus parsed fields. Signed
  per-serial `Qtty` supplies quantity; document-line `Cantitate` never does.
  Company, supplier, document detail and exact IMEI identify a source movement.
  A changed payload creates another version and blocks automatic attribution.
  Missing identities are retained as source-specific quarantined movements.
- `activation_occurrences`: each file/row points to a movement version. Exact
  overlap does not multiply quantity; every source coordinate remains available.
- `activation_facts`: replaceable derivation keyed by company, supplier and exact
  nonblank `Activat`, with actual activation date/month, product, candidate site,
  reasons and movement/return evidence. This is a provisional identity convention;
  reuse/reactivation semantics still require business confirmation.

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
and movements without Activat. Exact company/supplier/IMEI groups are reconciled
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

Upload jobs, authenticated UI/API, historical site-to-user mapping, commission
eligibility/rates, post-activation returns, period closing/corrections, source
revision acceptance and reliable refresh of older inventory remain separate work.
There are no payable totals. Coverage of all activation months cannot be inferred
from the nominal year of the latest file. Full-history import does not establish
that the upstream reports include all movements.

Before any future production promotion, add the new database and originals to the
supported backup/restore contract, package the importer, and validate runtime
identity and permissions. Do not deploy a development database by copying it over
production data. Online SQLite backup is required for consistent live recovery.
