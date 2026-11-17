# Per-product order limits and manager exceptions

Replenishment orders for the privately configured manager’s currently assigned agents are checked per agent and product code, per order. Without a configured manager, the new quantity limits are disabled. Current stock and quantities in other orders are not subtracted or accumulated. This is a replenishment guardrail, not a stock reservation or a rolling purchasing quota. Serial-number delivery notes are outside this rule.

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
