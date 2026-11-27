import { sqlIdentifier } from './sql-database';
import { postgresAuthoritySchema, type PostgresAuthoritySchemaOptions } from './postgres-authority-schema';

export type PostgresFinalizationDependencyPlan = Readonly<{
  version: 'postgres-notifications-schema-v1' | 'postgres-sales-schema-v1';
  schema: string;
  tables: readonly string[];
  createStatements: readonly string[];
  activateStatements: readonly string[];
}>;

export type PostgresSalesSchemaOptions = Readonly<{
  application: PostgresAuthoritySchemaOptions;
  schema: string;
  ownerRole: string;
  importerRole: string;
  /** Exact sqlite_sequence value copied from the same consistent sales snapshot. */
  sourceImportSequence: number;
}>;

const MAX_INTEGER = '9007199254740991';
const NOTIFICATIONS = Object.freeze(['notifications']);
const SALES = Object.freeze(['sales_meta', 'sales_imports', 'sales_months', 'sales_rows']);

function identifier(value: string): string {
  if (typeof value !== 'string' || value.startsWith('pg_') || value === 'public' || value === 'information_schema') {
    throw new Error('Reserved finalization dependency identifier');
  }
  return sqlIdentifier(value);
}
function authorityGuard(options: PostgresAuthoritySchemaOptions): string {
  const plan = postgresAuthoritySchema(options), guard = plan.createStatements[0];
  if (plan.version !== 'postgres-authority-schema-v1' || !guard.startsWith('DO $authority_roles$ BEGIN')) {
    throw new Error('Unsupported authority dependency precondition');
  }
  return guard;
}
function applicationGuard(options: PostgresAuthoritySchemaOptions): string {
  const { schema, ownerRole, readerRole, writerRole } = options;
  const names = postgresAuthoritySchema(options).tables.map(name => "'" + name + "'").join(',');
  return `DO $finalization_authority$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
   WHERE n.nspname='${schema}' AND r.rolname='${ownerRole}')
  OR (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='${schema}' AND c.relkind='r'
   AND c.relname IN (${names}) AND r.rolname='${ownerRole}') <> 6
  OR pg_catalog.has_schema_privilege('${readerRole}','${schema}','CREATE')
  OR pg_catalog.has_schema_privilege('${writerRole}','${schema}','CREATE')
  OR NOT pg_catalog.has_schema_privilege('${readerRole}','${schema}','USAGE')
  OR NOT pg_catalog.has_schema_privilege('${writerRole}','${schema}','USAGE') THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Finalization dependencies require the prepared authority schema';
 END IF;
END $finalization_authority$`;
}

/** New table only: copy its ten original columns before publishing the transaction. */
export function postgresNotificationSchema(options: PostgresAuthoritySchemaOptions): PostgresFinalizationDependencyPlan {
  const { schema, ownerRole, readerRole, writerRole } = options;
  const s = identifier(schema), owner = identifier(ownerRole), reader = identifier(readerRole), writer = identifier(writerRole);
  const table = s + '."notifications"';
  const createStatements = [authorityGuard(options), applicationGuard(options),
    `CREATE TABLE ${table} (
 id text COLLATE "C" PRIMARY KEY,
 recipient_id text COLLATE "C" NOT NULL REFERENCES ${s}."users"(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 event_key text COLLATE "C" NOT NULL,
 category text COLLATE "C" NOT NULL,
 title text COLLATE "C" NOT NULL,
 body text COLLATE "C" NOT NULL,
 target_type text COLLATE "C" NOT NULL,
 target_id text COLLATE "C" NOT NULL,
 created_at text COLLATE "C" NOT NULL,
 read_at text COLLATE "C"
)`,
    `CREATE UNIQUE INDEX notifications_recipient_event ON ${table}(recipient_id,event_key)`,
    `CREATE INDEX notifications_recipient_date ON ${table}(recipient_id,created_at DESC,id DESC)`,
    `CREATE INDEX notifications_unread ON ${table}(recipient_id,read_at)`,
    `ALTER TABLE ${table} OWNER TO ${owner}`,
    `REVOKE ALL ON TABLE ${table} FROM PUBLIC, ${reader}, ${writer}`,
    `GRANT SELECT ON TABLE ${table} TO ${reader}, ${writer}`,
    `GRANT INSERT, UPDATE, DELETE ON TABLE ${table} TO ${writer}`,
  ];
  const activateStatements = [tableAclGuard(schema, ownerRole, [readerRole], [writerRole], NOTIFICATIONS)];
  return Object.freeze({ version: 'postgres-notifications-schema-v1', schema, tables: NOTIFICATIONS,
    createStatements: Object.freeze(createStatements), activateStatements: Object.freeze(activateStatements) });
}

/**
 * Complete sales storage shape. Application roles can only read this schema.
 * A separately provisioned import role owns the write grant; it still must use
 * the shared application writer lock and same-client authority transaction.
 * No connection, role creation, data repair or runtime selection occurs here.
 */
export function postgresSalesSchema(options: PostgresSalesSchemaOptions): PostgresFinalizationDependencyPlan {
  const { application, schema, ownerRole, importerRole, sourceImportSequence } = options;
  const s = identifier(schema), owner = identifier(ownerRole), importer = identifier(importerRole);
  const reader = identifier(application.readerRole), writer = identifier(application.writerRole);
  const applicationGuardSql = authorityGuard(application);
  if (schema === application.schema || new Set([application.ownerRole, application.readerRole,
    application.writerRole, ownerRole, importerRole]).size !== 5) {
    throw new Error('Sales schema and its owner/importer must remain separate from application authority');
  }
  if (!Number.isSafeInteger(sourceImportSequence) || sourceImportSequence < 0) {
    throw new Error('Exact nonnegative sales import sequence required');
  }
  const table = (name: string) => s + '.' + sqlIdentifier(name);
  const createStatements = [applicationGuardSql, applicationGuard(application),
    `DO $sales_roles$ BEGIN
 IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('${ownerRole}','${importerRole}')) <> 2 THEN
  RAISE EXCEPTION USING ERRCODE='42704', MESSAGE='Sales roles must already exist';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('${ownerRole}','${importerRole}')
  AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}' AND rolcanlogin)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname<>'${ownerRole}'
   AND pg_catalog.pg_has_role('${ownerRole}',r.oid,'MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname<>'${importerRole}'
   AND pg_catalog.pg_has_role('${importerRole}',r.oid,'MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper
   AND r.rolname NOT IN ('${ownerRole}',current_user,session_user)
   AND pg_catalog.pg_has_role(r.oid,'${ownerRole}','MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper
   AND r.rolname NOT IN ('${importerRole}',current_user,session_user)
   AND pg_catalog.pg_has_role(r.oid,'${importerRole}','MEMBER')) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Sales role membership bypasses separation';
 END IF;
END $sales_roles$`,
    `CREATE SCHEMA ${s} AUTHORIZATION ${owner}`,
    `REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, ${reader}, ${writer}, ${importer}`,
    `GRANT USAGE ON SCHEMA ${s} TO ${reader}, ${writer}, ${importer}`,
    `CREATE TABLE ${table('sales_meta')} (key text COLLATE "C" PRIMARY KEY,value text COLLATE "C" NOT NULL)`,
    `CREATE TABLE ${table('sales_imports')} (
 id bigint GENERATED BY DEFAULT AS IDENTITY (MAXVALUE ${MAX_INTEGER} NO CYCLE) PRIMARY KEY
   CHECK (id BETWEEN -${MAX_INTEGER} AND ${MAX_INTEGER}),
 month text COLLATE "C" NOT NULL,
 file_hash text COLLATE "C" NOT NULL,
 filename text COLLATE "C" NOT NULL,
 imported_at text COLLATE "C" NOT NULL,
 imported_by text COLLATE "C" NOT NULL,
 row_count bigint NOT NULL CHECK (row_count BETWEEN -${MAX_INTEGER} AND ${MAX_INTEGER}),
 original_path text COLLATE "C" NOT NULL,
 revision bigint NOT NULL CHECK (revision BETWEEN -${MAX_INTEGER} AND ${MAX_INTEGER})
)`,
    `CREATE INDEX idx_sales_imports_month ON ${table('sales_imports')}(month,id DESC)`,
    `CREATE TABLE ${table('sales_months')} (
 month text COLLATE "C" PRIMARY KEY,
 import_id bigint NOT NULL REFERENCES ${table('sales_imports')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 imported_at text COLLATE "C" NOT NULL,
 filename text COLLATE "C" NOT NULL,
 file_hash text COLLATE "C" NOT NULL,
 revision bigint NOT NULL CHECK (revision BETWEEN -${MAX_INTEGER} AND ${MAX_INTEGER})
)`,
    `CREATE TABLE ${table('sales_rows')} (
 import_id bigint NOT NULL REFERENCES ${table('sales_imports')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 row_number bigint NOT NULL CHECK (row_number BETWEEN -${MAX_INTEGER} AND ${MAX_INTEGER}),
 date text COLLATE "C" NOT NULL,
 month text COLLATE "C" NOT NULL,
 site_code text COLLATE "C" NOT NULL,
 item_code text COLLATE "C" NOT NULL,
 item_name text COLLATE "C" NOT NULL,
 quantity double precision NOT NULL CHECK (quantity <> 'NaN'::double precision),
 brand text COLLATE "C" NOT NULL,
 price_cents bigint NOT NULL CHECK (price_cents BETWEEN -${MAX_INTEGER} AND ${MAX_INTEGER}),
 value_cents bigint NOT NULL CHECK (value_cents BETWEEN -${MAX_INTEGER} AND ${MAX_INTEGER}),
 location text COLLATE "C" NOT NULL,
 company text COLLATE "C" NOT NULL,
 asm text COLLATE "C" NOT NULL,
 regional text COLLATE "C" NOT NULL,
 order_number text COLLATE "C" NOT NULL,
 category text COLLATE "C" NOT NULL,
 sub_category text COLLATE "C" NOT NULL,
 agent text COLLATE "C" NOT NULL,
 PRIMARY KEY(import_id,row_number)
)`,
    `CREATE INDEX idx_sales_rows_month ON ${table('sales_rows')}(month)`,
    `CREATE INDEX idx_sales_rows_location_import ON ${table('sales_rows')}(location,import_id)`,
    `CREATE INDEX idx_sales_rows_month_site ON ${table('sales_rows')}(month,site_code)`,
    `CREATE INDEX idx_sales_rows_import_site_normalized ON ${table('sales_rows')}
 (import_id,translate(btrim(site_code,' '),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') COLLATE "C",date)`,
    `CREATE INDEX idx_sales_rows_site_month_normalized ON ${table('sales_rows')}
 (translate(btrim(site_code,' '),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') COLLATE "C",month,import_id)`,
  ];
  for (const name of SALES) createStatements.push(
    `ALTER TABLE ${table(name)} OWNER TO ${owner}`,
    `REVOKE ALL ON TABLE ${table(name)} FROM PUBLIC, ${reader}, ${writer}, ${importer}`,
    `GRANT SELECT ON TABLE ${table(name)} TO ${reader}, ${writer}, ${importer}`,
    `GRANT INSERT, UPDATE, DELETE ON TABLE ${table(name)} TO ${importer}`,
  );
  const sequence = table('sales_imports_id_seq');
  createStatements.push(`REVOKE ALL ON SEQUENCE ${sequence} FROM PUBLIC, ${reader}, ${writer}, ${importer}`,
    `GRANT USAGE ON SEQUENCE ${sequence} TO ${importer}`);
  const activateStatements = [
    `DO $sales_sequence$ BEGIN
 IF COALESCE((SELECT max(id) FROM ${table('sales_imports')}),0) > ${sourceImportSequence} THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Copied sales imports exceed the captured SQLite sequence';
 END IF;
 PERFORM pg_catalog.setval('${sequence}'::pg_catalog.regclass,${sourceImportSequence || 1},${sourceImportSequence > 0});
END $sales_sequence$`,
    tableAclGuard(schema, ownerRole, [application.readerRole, application.writerRole], [importerRole], SALES),
    `DO $sales_schema_acl$ BEGIN
 IF pg_catalog.has_schema_privilege('${application.readerRole}','${schema}','CREATE')
  OR pg_catalog.has_schema_privilege('${application.writerRole}','${schema}','CREATE')
  OR pg_catalog.has_schema_privilege('${importerRole}','${schema}','CREATE')
  OR NOT pg_catalog.has_schema_privilege('${application.readerRole}','${schema}','USAGE')
  OR NOT pg_catalog.has_schema_privilege('${application.writerRole}','${schema}','USAGE')
  OR NOT pg_catalog.has_schema_privilege('${importerRole}','${schema}','USAGE')
  OR pg_catalog.has_sequence_privilege('${application.readerRole}','${sequence}','USAGE,SELECT,UPDATE')
  OR pg_catalog.has_sequence_privilege('${application.writerRole}','${sequence}','USAGE,SELECT,UPDATE')
  OR pg_catalog.has_sequence_privilege('${importerRole}','${sequence}','SELECT,UPDATE')
  OR NOT pg_catalog.has_sequence_privilege('${importerRole}','${sequence}','USAGE')
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
   CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) x
   WHERE n.nspname='${schema}' AND (x.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles
    WHERE rolname IN ('${ownerRole}','${importerRole}','${application.readerRole}','${application.writerRole}'))
    OR x.is_grantable AND x.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}')
    OR x.privilege_type NOT IN ('USAGE','CREATE')
    OR x.privilege_type<>'USAGE' AND x.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}')))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('S',c.relowner))) x
   WHERE n.nspname='${schema}' AND c.relkind='S' AND (c.relname<>'sales_imports_id_seq'
    OR c.relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}')
    OR x.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('${ownerRole}','${importerRole}'))
    OR x.is_grantable AND x.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}')
    OR x.privilege_type NOT IN ('USAGE','SELECT','UPDATE')
    OR x.privilege_type<>'USAGE' AND x.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}'))) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Effective sales schema or sequence authority differs';
 END IF;
END $sales_schema_acl$`,
  ];
  return Object.freeze({ version: 'postgres-sales-schema-v1', schema, tables: SALES,
    createStatements: Object.freeze(createStatements), activateStatements: Object.freeze(activateStatements) });
}

function tableAclGuard(schema: string, owner: string, readers: readonly string[], writers: readonly string[], tables: readonly string[]): string {
  const names = tables.map(name => "'" + name + "'").join(',');
  const roleOids = (roles: readonly string[]) => `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${roles.map(name => "'" + name + "'").join(',')}))`;
  const allowed = [
    `(grantee=${roleOids([owner])} AND
      ((NOT is_column AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'))
       OR (is_column AND privilege_type IN ('SELECT','INSERT','UPDATE','REFERENCES'))))`,
    `(grantee IN ${roleOids(readers)} AND privilege_type='SELECT' AND NOT is_grantable)`,
    `(grantee IN ${roleOids(writers)} AND NOT is_grantable AND
      ((NOT is_column AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
       OR (is_column AND privilege_type IN ('SELECT','INSERT','UPDATE'))))`,
  ];
  const effective: string[] = [];
  for (const role of [...readers, ...writers]) effective.push(
    `NOT pg_catalog.has_table_privilege('${role}',relation.oid,'SELECT')`,
    `pg_catalog.has_table_privilege('${role}',relation.oid,'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')`,
    `pg_catalog.has_any_column_privilege('${role}',relation.oid,'REFERENCES')`,
  );
  for (const role of readers) effective.push(
    `pg_catalog.has_table_privilege('${role}',relation.oid,'INSERT,UPDATE,DELETE')`,
    `pg_catalog.has_any_column_privilege('${role}',relation.oid,'INSERT,UPDATE,REFERENCES')`,
  );
  for (const role of writers) for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
    effective.push(`NOT pg_catalog.has_table_privilege('${role}',relation.oid,'${privilege}')`);
  }
  return `DO $finalization_table_acl$ DECLARE relation record; BEGIN
 IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='${schema}' AND c.relkind='r' AND c.relname IN (${names})) <> ${tables.length}
  OR EXISTS (
   WITH grants AS (
    SELECT x.grantee,x.is_grantable,x.privilege_type,false AS is_column FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
     WHERE n.nspname='${schema}' AND c.relkind='r' AND c.relname IN (${names})
    UNION ALL
    SELECT x.grantee,x.is_grantable,x.privilege_type,true AS is_column FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
     WHERE n.nspname='${schema}' AND c.relkind='r' AND c.relname IN (${names})
   ) SELECT 1 FROM grants WHERE NOT (${allowed.join('\n    OR ')})
  ) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Unexpected finalization dependency table grant or inventory';
 END IF;
 FOR relation IN SELECT c.oid,c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='${schema}' AND c.relkind='r' AND c.relname IN (${names}) LOOP
  IF relation.relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${owner}')
   OR ${effective.join('\n   OR ')} THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Effective finalization dependency table authority differs';
  END IF;
 END LOOP;
END $finalization_table_acl$`;
}
