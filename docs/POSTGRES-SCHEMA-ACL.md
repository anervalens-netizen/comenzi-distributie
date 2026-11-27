# Exact application ACL checks for authority and orders

This change prepares stricter activation checks. It does not activate PostgreSQL,
change routes, migrate data or change the deployed application. PostgreSQL
execution of the new negative contract remains a separate qualification step.

## Defect and correction

The prior activation checks rejected an unknown grantee and several effective
privileges. A known application role could still receive column `REFERENCES`,
table `MAINTAIN`, or a grant option on a permitted privilege. Table privilege
checks do not replace inspection of column ACLs.

The new checks expand native ACL values with `pg_catalog.aclexplode`. They compare
the complete non-owner grants against the declared policy in both directions
with `EXCEPT ALL`. Object class, object name, column, grantee, grantor, privilege
and grant option remain distinct. Extra, missing or duplicate grants fail with
SQLSTATE `42501`. Every application grant must originate from the owning role
and must have no grant option. Redundant explicit column grants also fail: a
table-level permission does not make an unplanned column ACL part of the plan.

| Object | Reader | Writer |
| --- | --- | --- |
| Application schema | `USAGE` | `USAGE` |
| Ordinary authority and order tables | `SELECT` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `portfolio_revision` table | `SELECT` | `SELECT` |
| `portfolio_revision.data_revision` and `.scope_revision` | None | Column `UPDATE` |
| `order_list_revision` table | `SELECT` | `SELECT` |
| `order_list_revision.revision` | None | Column `UPDATE` |
| Each plan's generation trigger function | None | `EXECUTE` |

The authority plan checks the shared schema. The order plan checks its own four
tables and function. Both activation plans must run before publication, in the
same transaction as creation and copy. The owning role retains PostgreSQL's
inherent owner powers; its ACL is not represented as an application-role policy.
The owner must remain a distinct, nonadministrative `NOLOGIN` role. Existing
ownership, inbound/outbound membership and effective privilege checks remain.
Effective table checks now also name `MAINTAIN` explicitly.

The interface remains `postgres-authority-schema-v1` /
`postgres-order-schema-v1`. Creating DDL, granted privileges, copied values,
constraints, indexes, trigger bodies and activation order are unchanged. Only
each plan's final ACL gate changes. No historical row or ACL is repaired silently.

## Evidence contract

`tools/test-postgres-schema-acl.mjs` checks the new generated plans against the
exact original builders from commit
`ebf3f6aca3471c710ea51531f9b0cb56eea959cf`. It checks the old source hashes and
requires byte-identical creating statements and activation statements preceding
the final ACL gate. A new gate passed as the old baseline, or an unrelated DDL
change, is rejected. Running this file directly performs three source-only
checks. It never opens a database.

The separate PostgreSQL contract prepares forty independent negative cases. It
uses the actual old and new SQL gates on the same disposable database:

1. Create the unchanged ten-table schema and original generation rows. Activate
   both new plans and establish the exact initial ACL, ownership, counts and
   generation snapshot.
2. In a new transaction, apply one explicit grant or revoke as the owning role.
   Require the native ACL snapshot to change and the metadata/counts to remain.
3. For the thirty-one legacy acceptance witnesses, execute the actual original
   gate and require success. For the other nine negatives, old acceptance is
   deliberately untested and reported as `null`, not inferred.
4. Execute the new gate and require `42501` with its exact ACL rejection message.
   An unrelated SQL failure does not pass the case.
5. Roll back the transaction. Require the original native ACL/ownership and
   metadata snapshot byte values, and rerun both clean ACL gates plus role guard.

The cases cover normal and metadata tables, every allowed metadata update column,
both application roles, grant options on schema/table/column/function privileges,
column `REFERENCES`, `MAINTAIN`, redundant column grants, a foreign grantee and
missing required grants. None writes to application business tables.

`tools/test-schema-acl-postgres.mjs` is the opt-in driver. It requires an explicit
fresh fixture database name, the exact fixture marker, a Unix socket URL and the
expected PostgreSQL 19 version. The enclosing laboratory must independently
attest the database/container, image, namespaces, resources and cleanup. It must
bundle the three original TypeScript files under `fixtures/schema-acl-baseline/`
from the pinned commit; the driver verifies their hashes before compilation. The
driver creates four fictional `NOLOGIN` roles, runs only the ACL contract and
removes its exclusive schema and roles. It does not load application queues or
send messages. No DSN is read from application configuration.

Keep the forty new PostgreSQL cases, thirty-one legacy witnesses, and three pure
checks separate from prior authority/order/read-settings application proofs.
Earlier successful proofs remain tied to their original commits. Source
equivalence explains the unchanged business paths; it is not a claim that the
new ACL gate has already passed PostgreSQL or a complete migration is ready.

## PostgreSQL reference

The privilege and owner semantics used here are documented in the PostgreSQL 18
[privilege reference](https://www.postgresql.org/docs/18/ddl-priv.html) and
[access privilege inquiry functions](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE).
In particular, grant options permit onward delegation; owner grant options are
inherent; table and column ACLs are separate inputs. The qualification must use
the exact deployed target image and retain the resulting primary SQL evidence.
