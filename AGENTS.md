# Contributor instructions

Read README.md and the relevant source/tests before editing. Preserve concurrent changes. Run relevant type, functional and operational tests; do not weaken assertions to obtain a passing result. Keep installed application identifiers stable unless a deliberate compatibility migration is planned.

This repository is public. Use wholly synthetic fixtures and generic examples. Never commit personal information, customer or employee data, production databases, credentials, password verifiers, private endpoints, local work reports or screenshots of real data. Keep project memory and deployment records in private owner-controlled storage, not issues, comments, logs or commits. Use a noreply Git author address.

Production operations must use explicitly configured hosts, secrets and data directories; a repository checkout is not evidence of runtime identity or deployment health. Preserve a verified recovery copy before changing persistent production data.

## Source roles

Resolve the official checkout through the installed application registry's `source_path` / `dell_source_path`; use that checkout or its temporary worktrees for new work. A compatibility build mirror does not redefine source authority. Release activation uses the configured source synchronization gate; never substitute manual resets for a failed reconciliation. Keep immutable runtime releases, private data/configuration and disposable build/restore work separate. Preserve existing worktrees and unpublished work before consolidating older clones.

## Backup and storage budget (mandatory for all agents)

- Code-only edits and repeat tests do not require another full production-data backup. First inspect the existing verified recovery point.
- For destructive data/schema work, use the established coordinated backup process; create at most one new necessary generation and verify it independently on the recovery destination. Do not duplicate entire live data trees to a permanent backup directory.
- An extracted restore, test database, or preflight copy is temporary work, not a backup. Keep it in isolated scratch space (never within long-term `backups/`), clean it during the same run even after errors, and retain only compact evidence. Do not execute SQLite from a network/SMB share.
- On the production storage volume, calculate expected scratch growth before starting and preserve at least 40 GiB of free space **after** that growth. If insufficient, run the test elsewhere or reduce scope, not the reserve.
- One large isolated restore at a time; no unbounded rollback, release, activation-generation or preflight copies. Every exceptional retained artifact needs an explicit purpose, expiry and destination.
- Finish each change by removing temporary artifacts, checking disk usage, preserving scheduled backups and confirming an independent recovery copy. Never silently accumulate backups on top of backups.

<!-- portfolio-review:start -->
## Development review

For application changes, the development agent requests/reuses both Codex Connector and DSH reviews of the current PR head, resolves confirmed findings, and checks required CI before normal merge/deploy. The owner does not coordinate mentions. Finish a stable, locally validated candidate before requesting reviewers. Use the shared review-cycle.py helper to reuse requests and publish explicit, version-bound dispositions; read back closure of the grouped ContextKeep review task. A merge alone does not close review work. Verify deployed read-only contracts for cross-application changes. Attribute developer decisions to the development agent, not to the owner. Reuse requests on retries; record both review URLs, SHAs and dispositions in the active ContextKeep task. Status/read-only/trivial formatting work needs no worker. Incident restoration may precede review with a recorded follow-up. DSH reports must not mention other bots or request their own review. Use the concise shared workflow: https://github.com/anervalens-netizen/astancu-website/blob/master/ops/dsh-integration/DEVELOPMENT-WORKFLOW.md .

## Code Review Rules

- Offline writes must preserve the last valid snapshot on quota, interruption or failure; check atomic publication, concurrent tabs, account isolation and v1 compatibility.
- Privacy changes must distinguish new publication from existing history without disabling other checks. Review scaling on representative cache sizes; keep normal single writes independent of total cache size where possible.
<!-- portfolio-review:end -->
