import { sqlIdentifier } from './sql-database';

/** Existing, explicitly provisioned roles. This builder never creates a role. */
export type PostgresAuthoritySchemaOptions = Readonly<{
  schema: string;
  ownerRole: string;
  readerRole: string;
  writerRole: string;
}>;

export type PostgresAuthoritySchemaPlan = Readonly<{
  version: 'postgres-authority-schema-v1';
  schema: string;
  roles: Readonly<{ owner: string; reader: string; writer: string }>;
  tables: readonly string[];
  createStatements: readonly string[];
  activateStatements: readonly string[];
}>;

const MAX_SAFE_INTEGER = '9007199254740991';
const MAX_REVISION = '9007199254740990';
const TABLES = Object.freeze(['users', 'sessions', 'login_attempts', 'manager_agents',
  'settings', 'portfolio_revision']);

function identifier(value: string, kind: 'schema' | 'role'): string {
  if (typeof value !== 'string') throw new Error('Authority identifier must be a string');
  const quoted = sqlIdentifier(value);
  if (value.startsWith('pg_') || value === 'public' || value === 'information_schema') {
    throw new Error('Reserved authority ' + kind + ' identifier');
  }
  return quoted;
}

/**
 * A new-schema plan, not an executor or an upgrade of an existing schema.
 * Apply createStatements in an explicit transaction, copy validated rows,
 * then apply activateStatements in that same transaction before publication.
 * No seed rows, membership grants, data repair, connection or runtime selector occur here.
 */
export function postgresAuthoritySchema(options: PostgresAuthoritySchemaOptions): PostgresAuthoritySchemaPlan {
  const { schema, ownerRole, readerRole, writerRole } = options;
  const s = identifier(schema, 'schema'), owner = identifier(ownerRole, 'role');
  const reader = identifier(readerRole, 'role'), writer = identifier(writerRole, 'role');
  if (new Set([ownerRole, readerRole, writerRole]).size !== 3) {
    throw new Error('Authority owner, reader and writer roles must be distinct');
  }
  const table = (name: string) => s + '.' + sqlIdentifier(name);
  // Identifiers above accept ASCII letters/digits/underscore only. These values
  // are safe SQL string literals as well as quoted identifiers.
  const roleNames = [ownerRole, readerRole, writerRole].map(value => "'" + value + "'").join(',');
  const statements = [
    `DO $authority_roles$ BEGIN
 PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
 IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN (${roleNames})) <> 3 THEN
  RAISE EXCEPTION USING ERRCODE='42704', MESSAGE='Authority roles must already exist';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN (${roleNames})
  AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}' AND rolcanlogin) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Authority roles have administrative capabilities';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname <> '${readerRole}'
   AND pg_catalog.pg_has_role('${readerRole}',r.oid,'MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname NOT IN ('${writerRole}','${readerRole}')
   AND pg_catalog.pg_has_role('${writerRole}',r.oid,'MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname <> '${ownerRole}'
   AND pg_catalog.pg_has_role('${ownerRole}',r.oid,'MEMBER')) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Authority role membership bypasses separation';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper
   AND r.rolname NOT IN ('${ownerRole}',current_user,session_user)
   AND pg_catalog.pg_has_role(r.oid,'${ownerRole}','MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper
   AND r.rolname NOT IN ('${writerRole}',current_user,session_user)
   AND pg_catalog.pg_has_role(r.oid,'${writerRole}','MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper
   AND r.rolname NOT IN ('${readerRole}','${writerRole}',current_user,session_user)
   AND pg_catalog.pg_has_role(r.oid,'${readerRole}','MEMBER')) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Unexpected principal can assume an authority role';
 END IF;
END $authority_roles$`,
    `CREATE SCHEMA ${s} AUTHORIZATION ${owner}`,
    `REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, ${reader}, ${writer}`,
    `GRANT USAGE ON SCHEMA ${s} TO ${reader}, ${writer}`,
    `CREATE TABLE ${table('users')} (
 id text COLLATE "C" PRIMARY KEY,
 username text COLLATE "C" NOT NULL UNIQUE,
 name text COLLATE "C" NOT NULL,
 role text COLLATE "C" NOT NULL,
 manager_scope text COLLATE "C" NOT NULL DEFAULT 'assigned',
 warehouse_id text COLLATE "C",
 warehouse_name text COLLATE "C",
 site_code text COLLATE "C" NOT NULL DEFAULT '',
 password_hash text COLLATE "C" NOT NULL,
 must_change_password integer NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
 active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 profile_revision bigint NOT NULL DEFAULT 1 CHECK (profile_revision BETWEEN 1 AND ${MAX_REVISION}),
 CHECK (role <> 'manager' OR manager_scope IN ('assigned','global'))
)`,
    `CREATE UNIQUE INDEX users_active_site_code_unique ON ${table('users')}
 (TRANSLATE(TRIM(site_code),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') COLLATE "C")
 WHERE role='agent' AND active=1 AND TRIM(site_code)<>''`,
    `CREATE TABLE ${table('sessions')} (
 token_hash text COLLATE "C" PRIMARY KEY,
 user_id text COLLATE "C" NOT NULL REFERENCES ${table('users')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 expires_at bigint NOT NULL CHECK (expires_at BETWEEN 0 AND ${MAX_SAFE_INTEGER})
)`,
    `CREATE INDEX idx_sessions_user ON ${table('sessions')}(user_id)`,
    `CREATE TABLE ${table('login_attempts')} (
 key text COLLATE "C" PRIMARY KEY,
 attempts bigint NOT NULL CHECK (attempts BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
 reset_at bigint NOT NULL CHECK (reset_at BETWEEN 0 AND ${MAX_SAFE_INTEGER})
)`,
    `CREATE TABLE ${table('manager_agents')} (
 manager_id text COLLATE "C" NOT NULL REFERENCES ${table('users')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 agent_id text COLLATE "C" NOT NULL REFERENCES ${table('users')}(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
 PRIMARY KEY (manager_id,agent_id)
)`,
    `CREATE INDEX idx_manager_agents_agent ON ${table('manager_agents')}(agent_id)`,
    `CREATE TABLE ${table('settings')} (
 key text COLLATE "C" PRIMARY KEY, value text COLLATE "C" NOT NULL
)`,
    `CREATE TABLE ${table('portfolio_revision')} (
 id integer PRIMARY KEY CHECK (id=1),
 data_revision bigint NOT NULL CHECK (data_revision BETWEEN 1 AND ${MAX_REVISION}),
 scope_revision bigint NOT NULL CHECK (scope_revision BETWEEN 1 AND ${MAX_REVISION})
)`,
  ];
  for (const name of TABLES) {
    statements.push(`ALTER TABLE ${table(name)} OWNER TO ${owner}`);
    statements.push(`REVOKE ALL ON TABLE ${table(name)} FROM PUBLIC, ${reader}, ${writer}`);
    statements.push(`GRANT SELECT ON TABLE ${table(name)} TO ${reader}, ${writer}`);
    if (name !== 'portfolio_revision') {
      statements.push(`GRANT INSERT, UPDATE, DELETE ON TABLE ${table(name)} TO ${writer}`);
    }
  }
  statements.push(`GRANT UPDATE (data_revision,scope_revision) ON TABLE ${table('portfolio_revision')} TO ${writer}`);

  const functionName = s + '."authority_bump_scope"';
  const activate = [
    `DO $authority_generation$ BEGIN
 IF (SELECT count(*) FROM ${table('portfolio_revision')}) <> 1 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Copy the exact portfolio generation before activation';
 END IF;
END $authority_generation$`,
    `CREATE FUNCTION ${functionName}() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $authority_scope$
BEGIN
 UPDATE ${table('portfolio_revision')} SET scope_revision=scope_revision+1 WHERE id=1;
 IF NOT FOUND THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Missing portfolio authority generation';
 END IF;
 RETURN NULL;
END $authority_scope$`,
    `ALTER FUNCTION ${functionName}() OWNER TO ${owner}`,
    `REVOKE ALL ON FUNCTION ${functionName}() FROM PUBLIC, ${reader}, ${writer}`,
    `GRANT EXECUTE ON FUNCTION ${functionName}() TO ${writer}`,
  ];
  for (const [name, event, relation] of [
    ['portfolio_scope_users_insert', 'INSERT', 'users'],
    ['portfolio_scope_users_update', 'UPDATE OF warehouse_id,active,role,manager_scope', 'users'],
    ['portfolio_scope_users_delete', 'DELETE', 'users'],
    ['portfolio_scope_manager_agents_insert', 'INSERT', 'manager_agents'],
    ['portfolio_scope_manager_agents_update', 'UPDATE', 'manager_agents'],
    ['portfolio_scope_manager_agents_delete', 'DELETE', 'manager_agents'],
  ]) activate.push(`CREATE TRIGGER ${sqlIdentifier(name)} AFTER ${event} ON ${table(relation)}
 FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

  const tableNames = TABLES.map(name => "'" + name + "'").join(',');
  // Default privileges belong to the creating role. ALTER OWNER does not erase
  // grants to another principal. Refuse them before this transaction is visible.
  activate.push(`DO $authority_acl$ DECLARE relation record; BEGIN
 IF EXISTS (
  WITH grants AS (
   SELECT x.grantee FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) x
    WHERE n.nspname='${schema}'
   UNION ALL
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
    WHERE n.nspname='${schema}' AND p.proname='authority_bump_scope'
  ) SELECT 1 FROM grants WHERE grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${roleNames}))
 ) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Unexpected default or object authority grant';
 END IF;
 IF pg_catalog.has_schema_privilege('${readerRole}','${schema}','CREATE')
  OR pg_catalog.has_schema_privilege('${writerRole}','${schema}','CREATE')
  OR pg_catalog.has_function_privilege('${readerRole}','${functionName}()','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('${writerRole}','${functionName}()','EXECUTE') THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Effective schema or function authority differs';
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
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Effective table authority differs';
  END IF;
  IF relation.relname='portfolio_revision' THEN
   IF pg_catalog.has_table_privilege('${writerRole}',relation.oid,'INSERT,UPDATE,DELETE')
    OR pg_catalog.has_column_privilege('${writerRole}',relation.oid,'id','UPDATE')
    OR NOT pg_catalog.has_column_privilege('${writerRole}',relation.oid,'data_revision','UPDATE')
    OR NOT pg_catalog.has_column_privilege('${writerRole}',relation.oid,'scope_revision','UPDATE') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Portfolio metadata authority differs';
   END IF;
  ELSIF NOT pg_catalog.has_table_privilege('${writerRole}',relation.oid,'INSERT')
   OR NOT pg_catalog.has_table_privilege('${writerRole}',relation.oid,'UPDATE')
   OR NOT pg_catalog.has_table_privilege('${writerRole}',relation.oid,'DELETE') THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Missing application writer authority';
  END IF;
 END LOOP;
END $authority_acl$`);

  return Object.freeze({ version: 'postgres-authority-schema-v1', schema,
    roles: Object.freeze({ owner: ownerRole, reader: readerRole, writer: writerRole }),
    tables: TABLES, createStatements: Object.freeze(statements), activateStatements: Object.freeze(activate) });
}
