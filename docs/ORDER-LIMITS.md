# Weekly accessory-order count (separate from per-product limits)

The global manager selects **Fără limită** (API value `0`) or a finite cap of 1–7. The default without an explicit setting is unlimited. Drafts, stands and SIM delivery notes do not consume the weekly accessory count. The server validates persisted values before binding the finalization predicate: only integers 0–7 or the exact legacy unlimited marker are valid. An invalid stored value is exposed as `null` (unavailable, never unlimited). Only finalization of orders consuming the weekly accessory count fails closed with HTTP 503. Bootstrap, existing mail and other operations remain available. The global manager repairs the setting by explicitly selecting a valid value in Admin; the repair PUT sends only `weeklyLimit` and `repairWeeklyLimit: true`, preserves the rest of the persisted configuration, and rejects stale or ordinary full-form submissions while the limit is invalid. If bootstrap fails, the UI does not offer a save form. Never silently coerce strings, fractions, booleans or null to a number.

## Release rollback and database migration

- Unlimited is persisted as the JSON integer `2147483647` for old-runtime order-finalization compatibility. API and UI expose `0`; do not rewrite the stored value to `0` while a pre-unlimited runtime may be used for recovery. Preserve the integer type through data migration.
- Before rolling back, inspect the target release and current `settings.app.weeklyLimit` read-only. Prefer a verified unlimited-capable release (one that normalizes the marker and accepts 0 or the marker on settings PUT). It supports both finalization and admin saves. Exercise both operations in an isolated recovery fixture before selecting an unfamiliar target.
- A release predating explicit unlimited support accepts the marker for finalization but rejects it in admin settings (UI constraint and HTTP 400). Do not use such a release as a normal rollback target while unlimited is required. If emergency service restoration requires it, preserve the marker so orders remain possible, report that admin settings are temporarily read-only, and promptly restore a compatible release. Changing to a finite cap requires an explicit owner decision; do not silently restore a cap.
- After rollback or database cutover, verify the stored integer, effective API value, agent label, admin save, finalization and independent product-limit enforcement using isolated synthetic evidence wherever a write would otherwise create real orders.

# Per-product order limits and manager exceptions

Replenishment orders for the privately configured managers’ currently assigned agents are checked per agent and product code, per order. The existing `MOBIUP_ORDER_LIMIT_MANAGER_ID` setting selects the original manager. Optional `MOBIUP_ORDER_LIMIT_ADDITIONAL_MANAGER_IDS` adds comma-separated manager IDs; blanks and duplicate IDs are ignored. An agent assigned to any configured active manager is in scope, and changes in `manager_agents` take effect without maintaining a fixed list of agents. Without a configured manager, the new quantity limits are disabled. Every configured manager ID must resolve to an active manager account. A missing, misspelled or inactive entry returns an explicit 503 for affected limit and approval operations and prevents finalizing orders containing capped products, rather than silently exempting any configured team. Validate the environment list against active manager records before restarting production. Current stock and quantities in other orders are not subtracted or accumulated. This is a replenishment guardrail, not a stock reservation or a rolling purchasing quota. Serial-number delivery notes are outside this rule.

The initial configured categories use these minimum allowances:

| Category | Minimum quantity per product code |
| --- | ---: |
| Cases and screen protectors | 5 |
| Chargers | 10 |
| Cables and adapters | 10 |
| Prepaid SIM cards ordered for stock | 250 |

The allowance is the greater of the configured category minimum and the agent's net quantity sold in the three complete calendar months before the current month. Returns retain their source sign; the category minimum prevents a negative or low net quantity from blocking ordinary replenishment. The stock already held by the agent does not reduce this allowance. Other categories have no newly invented default allowance in this rollout.

Sales attribution must reuse the reporting identity rules, including verified warehouse/site aliases, and use only each month's active import. Replaced imports must not be counted twice. Missing or ambiguous data must not be presented as verified zero sales. A globally covered month without sales for the agent counts as zero. If one of the three active monthly imports is missing, or attribution is ambiguous, the category minimum is used and the UI identifies the incomplete or unavailable history.

An agent can save quantities above the allowance and request a manager's confirmation. The request describes the saved order revision and the quantities requiring an exception. All assigned eligible managers receive an in-app notification. A currently assigned manager who was a recipient of that request can approve or reject it; one decision wins. The original request and decision remain an audit record.

An approval covers only its saved order revision. Editing the order invalidates that approval. Finalization independently validates the current account/session, scope, catalog and approval, then consumes the approval atomically with finalization. A notification, client-side button state or previously loaded screen is never proof of approval.

The mail preparation/export flow remains unchanged. Approval notifications do not send email. Notifications require server-side recipient and current-scope checks, including after manager reassignment.

# Partner billing metrics

First billing means the earliest eligible invoice in the full currently active invoice history for the selected company/work-point identity. It is independent of the visible date filter.

The lifetime invoice average divides the number of distinct eligible invoices through today by the inclusive number of calendar months between first billing and the present month in Europe/Bucharest. Both endpoint months and months with no invoices count. A partner without an eligible invoice shows an unavailable value, not a fabricated start date. Selected-period invoice count remains a separate metric.

These definitions preserve the existing document grouping, company/site identity scope and matching-confidence indicators. The current database is the authoritative history for this feature; there is no separate older archive to query.
