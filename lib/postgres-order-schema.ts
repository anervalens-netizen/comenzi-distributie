import { sqlIdentifier } from './sql-database';
import { postgresAuthoritySchema, type PostgresAuthoritySchemaOptions } from './postgres-authority-schema';

export type PostgresOrderSchemaOptions = PostgresAuthoritySchemaOptions & Readonly<{
  /** A snapshot with an archive requires a separately reviewed preservation plan. */
  payloadArchive: 'absent';
}>;

export type PostgresOrderSchemaPlan = Readonly<{
  version: 'postgres-order-schema-v1';
  schema: string;
  roles: Readonly<{ owner: string; reader: string; writer: string }>;
  tables: readonly string[];
  createStatements: readonly string[];
  activateStatements: readonly string[];
}>;

const MAX_REVISION = '9007199254740990';
const TABLES = Object.freeze(['orders', 'serials', 'order_list_revision', 'order_limit_approvals']);

/**
 * Add new order tables to an authority schema created by postgresAuthoritySchema.
 * The caller owns one transaction: create authority/order tables, copy all rows
 * and original generations, then activate both plans before commit/publication.
 * This pure builder opens no connection, creates no role, seeds no row and
 * never alters a runtime selector or an existing order table.
 */
export function postgresOrderSchema(options: PostgresOrderSchemaOptions): PostgresOrderSchemaPlan {
  if (options.payloadArchive !== 'absent') {
    throw new Error('Order payload archive requires an explicit preservation plan');
  }
  const authority = postgresAuthoritySchema(options);
  // Reuse the complete qualified role-separation guard, including inherited
  // privileges and incoming role membership. Fail closed if its plan changes.
  const rolesGuard = authority.createStatements[0];
  if (authority.version !== 'postgres-authority-schema-v1'
    || !rolesGuard.startsWith('DO $authority_roles$ BEGIN')) {
    throw new Error('Unsupported authority schema precondition');
  }
  const { schema, ownerRole, readerRole, writerRole } = options;
  const s = sqlIdentifier(schema), owner = sqlIdentifier(ownerRole);
  const reader = sqlIdentifier(readerRole), writer = sqlIdentifier(writerRole);
  const table = (name: string) => s + '.' + sqlIdentifier(name);
  const roleNames = [ownerRole, readerRole, writerRole].map(value => "'" + value + "'").join(',');
  const authorityNames = authority.tables.map(name => "'" + name + "'").join(',');
  const statements = [rolesGuard,
    `DO $orders_authority$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
  WHERE n.nspname='${schema}' AND r.rolname='${ownerRole}')
  OR (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='${schema}' AND c.relkind='r'
   AND c.relname IN (${authorityNames}) AND r.rolname='${ownerRole}') <> ${authority.tables.length}
  OR pg_catalog.has_schema_privilege('${readerRole}','${schema}','CREATE')
  OR pg_catalog.has_schema_privilege('${writerRole}','${schema}','CREATE')
  OR NOT pg_catalog.has_schema_privilege('${readerRole}','${schema}','USAGE')
  OR NOT pg_catalog.has_schema_privilege('${writerRole}','${schema}','USAGE') THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Order tables require the prepared authority schema';
 END IF;
 IF pg_catalog.to_regclass('${schema}.order_payload_archive') IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Order payload archive requires an explicit preservation plan';
 END IF;
END $orders_authority$`,
    `CREATE TABLE ${table('orders')} (
 id text COLLATE "C" PRIMARY KEY,
 number text COLLATE "C" NOT NULL,
 user_id text COLLATE "C" NOT NULL REFERENCES ${table('users')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 warehouse_id text COLLATE "C" NOT NULL,
 kind text COLLATE "C" NOT NULL,
 status text COLLATE "C" NOT NULL,
 payload text COLLATE "C" NOT NULL,
 created_at text COLLATE "C" NOT NULL,
 finalized_at text COLLATE "C",
 week_key text COLLATE "C",
 source_order_id text COLLATE "C",
 revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND ${MAX_REVISION})
)`,
    `CREATE UNIQUE INDEX orders_number_unique ON ${table('orders')}(number)`,
    `CREATE INDEX idx_orders_user_created ON ${table('orders')}(user_id,created_at)`,
    `CREATE INDEX idx_orders_user_created_id ON ${table('orders')}(user_id,created_at DESC,id DESC)`,
    `CREATE INDEX idx_orders_created_id ON ${table('orders')}(created_at DESC,id DESC)`,
    `CREATE INDEX idx_orders_week ON ${table('orders')}(user_id,kind,week_key,status)`,
    `CREATE TABLE ${table('serials')} (
 serial text COLLATE "C" PRIMARY KEY,
 order_id text COLLATE "C" NOT NULL REFERENCES ${table('orders')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION
)`,
    `CREATE INDEX idx_serials_order ON ${table('serials')}(order_id)`,
    `CREATE TABLE ${table('order_list_revision')} (
 id integer PRIMARY KEY CHECK (id=1),
 revision bigint NOT NULL CHECK (revision BETWEEN 1 AND ${MAX_REVISION})
)`,
    `CREATE TABLE ${table('order_limit_approvals')} (
 id text COLLATE "C" PRIMARY KEY,
 order_id text COLLATE "C" NOT NULL REFERENCES ${table('orders')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 order_revision bigint NOT NULL CHECK (order_revision BETWEEN 1 AND ${MAX_REVISION}),
 agent_id text COLLATE "C" NOT NULL REFERENCES ${table('users')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 agent_revision bigint NOT NULL CHECK (agent_revision BETWEEN 1 AND ${MAX_REVISION}),
 warehouse_id text COLLATE "C" NOT NULL,
 manager_ids text COLLATE "C" NOT NULL,
 input_key text COLLATE "C" NOT NULL,
 sales_version text COLLATE "C" NOT NULL,
 mapping_version text COLLATE "C" NOT NULL,
 policy_version text COLLATE "C" NOT NULL,
 catalog_version text COLLATE "C" NOT NULL,
 violations text COLLATE "C" NOT NULL,
 status text COLLATE "C" NOT NULL CONSTRAINT order_limit_approvals_status_check
  CHECK (status IN ('pending','approved','rejected','consumed')),
 reason text COLLATE "C" NOT NULL DEFAULT '',
 comment text COLLATE "C" NOT NULL DEFAULT '',
 decided_by text COLLATE "C" REFERENCES ${table('users')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 decided_at text COLLATE "C",
 created_at text COLLATE "C" NOT NULL,
 updated_at text COLLATE "C" NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND ${MAX_REVISION})
)`,
    `CREATE UNIQUE INDEX order_limit_approvals_order_input ON ${table('order_limit_approvals')}(order_id,order_revision,input_key)`,
    `CREATE INDEX order_limit_approvals_date ON ${table('order_limit_approvals')}(created_at DESC,id DESC)`,
    `CREATE INDEX order_limit_approvals_scope ON ${table('order_limit_approvals')}(agent_id,created_at DESC,id DESC)`,
  ];
  for (const name of TABLES) {
    statements.push(`ALTER TABLE ${table(name)} OWNER TO ${owner}`);
    statements.push(`REVOKE ALL ON TABLE ${table(name)} FROM PUBLIC, ${reader}, ${writer}`);
    statements.push(`GRANT SELECT ON TABLE ${table(name)} TO ${reader}, ${writer}`);
    if (name !== 'order_list_revision') statements.push(`GRANT INSERT, UPDATE, DELETE ON TABLE ${table(name)} TO ${writer}`);
  }
  statements.push(`GRANT UPDATE (revision) ON TABLE ${table('order_list_revision')} TO ${writer}`);
  const functionName = s + '."orders_bump_list_revision"';
  const activate = [
    `DO $orders_generation$ BEGIN
 IF (SELECT count(*) FROM ${table('order_list_revision')}) <> 1 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Copy the exact order list generation before activation';
 END IF;
END $orders_generation$`,
    `CREATE FUNCTION ${functionName}() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $orders_revision$
BEGIN
 UPDATE ${table('order_list_revision')} SET revision=revision+1 WHERE id=1;
 IF NOT FOUND THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Missing order list generation';
 END IF;
 RETURN NULL;
END $orders_revision$`,
    `ALTER FUNCTION ${functionName}() OWNER TO ${owner}`,
    `REVOKE ALL ON FUNCTION ${functionName}() FROM PUBLIC, ${reader}, ${writer}`,
    `GRANT EXECUTE ON FUNCTION ${functionName}() TO ${writer}`,
  ];
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    activate.push(`CREATE TRIGGER ${sqlIdentifier('order_list_revision_' + event.toLowerCase())}
 AFTER ${event} ON ${table('orders')} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  }
  const tableNames = TABLES.map(name => "'" + name + "'").join(',');
  activate.push(`DO $orders_acl$ DECLARE relation record; BEGIN
 IF EXISTS (
  WITH grants AS (
   SELECT x.grantee FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
    WHERE n.nspname='${schema}' AND c.relkind='r' AND c.relname IN (${tableNames})
   UNION ALL
   SELECT x.grantee FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
    WHERE n.nspname='${schema}' AND c.relkind='r' AND c.relname IN (${tableNames})
   UNION ALL
   SELECT x.grantee FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x
    WHERE n.nspname='${schema}' AND p.proname='orders_bump_list_revision'
  ) SELECT 1 FROM grants WHERE grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${roleNames}))
 ) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Unexpected default or object order grant';
 END IF;
 IF pg_catalog.has_function_privilege('${readerRole}','${functionName}()','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('${writerRole}','${functionName}()','EXECUTE') THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Effective order generation function authority differs';
 END IF;
 FOR relation IN SELECT c.oid,c.relname,c.relowner FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='${schema}' AND c.relkind='r' AND c.relname IN (${tableNames}) LOOP
  IF relation.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}')
   OR NOT pg_catalog.has_table_privilege('${readerRole}',relation.oid,'SELECT')
   OR NOT pg_catalog.has_table_privilege('${writerRole}',relation.oid,'SELECT')
   OR pg_catalog.has_table_privilege('${readerRole}',relation.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR pg_catalog.has_any_column_privilege('${readerRole}',relation.oid,'INSERT,UPDATE,REFERENCES')
   OR pg_catalog.has_table_privilege('${writerRole}',relation.oid,'TRUNCATE,REFERENCES,TRIGGER') THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Effective order table authority differs';
  END IF;
  IF relation.relname='order_list_revision' THEN
   IF pg_catalog.has_table_privilege('${writerRole}',relation.oid,'INSERT,UPDATE,DELETE')
    OR pg_catalog.has_column_privilege('${writerRole}',relation.oid,'id','UPDATE')
    OR NOT pg_catalog.has_column_privilege('${writerRole}',relation.oid,'revision','UPDATE') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Order list metadata authority differs';
   END IF;
  ELSIF NOT pg_catalog.has_table_privilege('${writerRole}',relation.oid,'INSERT')
   OR NOT pg_catalog.has_table_privilege('${writerRole}',relation.oid,'UPDATE')
   OR NOT pg_catalog.has_table_privilege('${writerRole}',relation.oid,'DELETE') THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Missing order writer authority';
  END IF;
 END LOOP;
END $orders_acl$`);
  return Object.freeze({ version: 'postgres-order-schema-v1', schema, roles: authority.roles,
    tables: TABLES, createStatements: Object.freeze(statements), activateStatements: Object.freeze(activate) });
}
