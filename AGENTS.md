# Contributor instructions

Read README.md and the relevant source/tests before editing. Preserve concurrent changes. Run relevant type, functional and operational tests; do not weaken assertions to obtain a passing result. Keep installed application identifiers stable unless a deliberate compatibility migration is planned.

This repository is public. Use wholly synthetic fixtures and generic examples. Never commit personal information, customer or employee data, production databases, credentials, password verifiers, private endpoints, local work reports or screenshots of real data. Keep project memory and deployment records in private owner-controlled storage, not issues, comments, logs or commits. Use a noreply Git author address.

Production operations must use explicitly configured hosts, secrets and data directories; a repository checkout is not evidence of runtime identity or deployment health. Preserve a verified recovery copy before changing persistent production data.

## Backup and storage budget (mandatory for all agents)

- Code-only edits and repeat tests do not require another full production-data backup. First inspect the existing verified recovery point.
- For destructive data/schema work, use the established coordinated backup process; create at most one new necessary generation and verify it independently on the recovery destination. Do not duplicate entire live data trees to a permanent backup directory.
- An extracted restore, test database, or preflight copy is temporary work, not a backup. Keep it in isolated scratch space (never within long-term `backups/`), clean it during the same run even after errors, and retain only compact evidence. Do not execute SQLite from a network/SMB share.
- On the production storage volume, calculate expected scratch growth before starting and preserve at least 40 GiB of free space **after** that growth. If insufficient, run the test elsewhere or reduce scope, not the reserve.
- One large isolated restore at a time; no unbounded rollback, release, activation-generation or preflight copies. Every exceptional retained artifact needs an explicit purpose, expiry and destination.
- Finish each change by removing temporary artifacts, checking disk usage, preserving scheduled backups and confirming an independent recovery copy. Never silently accumulate backups on top of backups.
