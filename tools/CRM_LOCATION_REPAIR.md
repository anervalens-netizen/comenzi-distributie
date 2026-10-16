# Offline location corrections

`crm_location_repair.py` operates only on explicitly supplied local SQLite paths.
It makes no network calls and never starts or stops an application. Use an offline
copy with no application writers. This development change is not a deployment.

Prepare a SQLite backup of that offline copy using SQLite's backup API (including
committed WAL), then calculate its SHA-256. The CLI requires both the backup and
checksum, checks integrity and exact logical equality under a write transaction,
and refuses stale backups. Keep these files and the plan/output privately.

A synthetic plan:

```json
{
  "counties": [
    {"kind": "customer", "id": "synthetic-point", "county": "BV"},
    {"kind": "crm", "id": "synthetic-address", "county": "BV"}
  ],
  "merges": [{"from": "synthetic-duplicate", "into": "synthetic-point"}]
}
```

Run with operator-supplied private paths:

```sh
python3 tools/crm_location_repair.py --offline-copy \
  --database "$OFFLINE_DB" --backup "$VERIFIED_BACKUP" \
  --backup-sha256 "$BACKUP_SHA256" --plan "$REPAIR_PLAN"
```

The default performs the complete transaction and rolls it back. Inspect the
reported order references, then repeat with `--apply` against the unchanged copy.
Failures roll back. Reapplication requires a new backup and plan; existing aliases
cannot be merged again or chained. An authorized production operation must first
establish an offline maintenance/recovery procedure independently; this command
is **not** a live production migration or replacement/deployment procedure.

County overrides live in `location_county_overrides`. Triggers preserve effective
counties through future writes while leaving `crm_locations.source_json` untouched.
The CRM reconciler applies these overrides before planning and checks their state
again before writing. It preserves current warehouse assignments for corrections.
Other import tools may reject their expected digest when an override intervenes;
regenerate an override-aware plan instead of removing the protection.

Merging requires two active IDs with the same normalized CUI and an operator's
explicit decision. It never infers a merge from nearby addresses. Warehouse and
franchise memberships are combined. The old row is retained inactive; its full
original JSON is also archived in `customer_identity_aliases`. CRM links, profiles,
visits, agent attribution, partner requests and every order payload remain attached
to their historical IDs. Alias reactivation is blocked. Historical exports keep
original identity and document references. The alias table is the explicit mapping
for cross-ID audit queries; existing screens do not aggregate historical visits or
orders across these aliases. No profile fields are overwritten onto another profile.
Normal county-change triggers may invalidate an obsolete geocode.

Review both catalog and CRM correction IDs explicitly. Correcting one does not
silently infer or change the other. Retaining alias rows is intentional: do not
remove them or rewrite finalized payloads. Recovery means restoring the verified
copy using the operator's separately authorized process, not running a reverse merge.
