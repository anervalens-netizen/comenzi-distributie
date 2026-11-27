// Explicit synthetic PostgreSQL 19 fixture. The caller owns isolation and cleanup.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {Pool} from 'pg';
import {runAuthoritySessionContract} from './authority-session-contract.mjs';
import {checkPostgresAuthoritySchemaBuilder, runPostgresAuthoritySchemaContract}
  from './test-postgres-authority-schema.mjs';

const target = process.env.COMENZI_PG_TEST_DATABASE;
const urlText = process.env.COMENZI_PG_TEST_URL;
assert(target && /^comenzi_authority_fixture_[a-z0-9]{8,24}$/.test(target),
  'Explicit disposable authority fixture database required');
assert(urlText, 'Explicit fixture URL required; no ambient PG fallback');
const url = new URL(urlText);
assert(['postgres:', 'postgresql:'].includes(url.protocol)
  && decodeURIComponent(url.pathname.slice(1)) === target,
'Fixture URL must name the explicit disposable database');
assert([...url.searchParams.keys()].every(key => key === 'sslmode' || key === 'host'),
  'Fixture URL cannot override account/database through query parameters');
assert(url.searchParams.has('host') && url.searchParams.get('host').startsWith('/')
  && url.hostname === 'localhost', 'This fixture requires an explicit isolated Unix socket');

const poolErrors = [], cleanupErrors = [], createdRoles = [], createdSchemas = [];
const bootstrap = new Pool({connectionString: urlText, max: 1, connectionTimeoutMillis: 3000,
  statement_timeout: 5000, application_name: 'comenzi-authority-fixture-bootstrap'});
bootstrap.on('error', error => poolErrors.push(error.message));
const suffix = randomBytes(6).toString('hex');
const names = {app: 'fixture_authority_' + suffix, ledger: 'fixture_ledger_' + suffix,
  owner: 'fixture_owner_' + suffix, reader: 'fixture_reader_' + suffix,
  writer: 'fixture_writer_' + suffix, foreign: 'fixture_foreign_' + suffix,
  ledgerOwner: 'fixture_ledger_owner_' + suffix};
const quote = name => '"' + name + '"';
const password = randomBytes(24).toString('hex');
let client, folder, database, other, receipt, primaryError;

try {
  client = await bootstrap.connect();
  const identity = (await client.query(`SELECT current_database() AS database,
    current_setting('server_version_num')::integer AS version, pg_is_in_recovery() AS recovery,
    shobj_description(oid,'pg_database') AS fixture_marker FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert(identity.database === target && identity.version >= 190000 && identity.version < 200000
    && identity.recovery === false, 'Actual isolated PostgreSQL 19 primary required');
  assert.equal(identity.fixture_marker, 'comenzi async authority isolated fixture v1',
    'The lab owner must independently mark the fresh disposable database');
  assert.equal((await client.query(`SELECT count(*)::integer AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%'
    AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')`)).rows[0].n, 0,
  'Fixture database must have no existing application relations');

  mkdirSync('work', {recursive: true});
  folder = mkdtempSync(resolve('work/authority-postgres-fixture-'));
  const moduleFile = join(folder, 'authority.mjs');
  await build({stdin: {contents: "export * from './lib/sql-database'; export * from './lib/sql-postgres'; "
    + "export * from './lib/import-write-authorization-async'; export * from './lib/session-repository-async'; "
    + "export * from './lib/authority-repository-async'; export * from './lib/postgres-authority-schema';",
  loader: 'ts', resolveDir: resolve('.')}, outfile: moduleFile, bundle: true,
  platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent'});
  const api = await import(pathToFileURL(moduleFile));
  const builderCases = checkPostgresAuthoritySchemaBuilder(api);
  for (const role of [names.owner, names.reader, names.writer, names.foreign, names.ledgerOwner]) {
    const login = [names.reader, names.writer].includes(role);
    await client.query('CREATE ROLE ' + quote(role) + (login ? " LOGIN PASSWORD '" + password + "'" : ' NOLOGIN')
      + ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    createdRoles.push(role);
  }

  // The real builder's complete create/copy/activate and ACL/trigger contract
  // leaves this schema in place. The repository tests use exactly that schema;
  // authorityFixtureStatements is intentionally not used for PostgreSQL here.
  createdSchemas.push(names.app);
  const schema = await runPostgresAuthoritySchemaContract(api, {client, isolatedMutation: true,
    schema: names.app, ownerRole: names.owner, readerRole: names.reader,
    writerRole: names.writer, foreignRole: names.foreign});
  assert.equal(schema.passed, true);

  await client.query('CREATE SCHEMA ' + quote(names.ledger) + ' AUTHORIZATION ' + quote(names.ledgerOwner));
  createdSchemas.push(names.ledger);
  const ledger = quote(names.ledger), app = quote(names.app);
  await client.query('CREATE TABLE ' + ledger + '.imports(id TEXT PRIMARY KEY,label TEXT NOT NULL)');
  await client.query('ALTER TABLE ' + ledger + '.imports OWNER TO ' + quote(names.ledgerOwner));
  await client.query('GRANT USAGE ON SCHEMA ' + ledger + ' TO ' + quote(names.writer));
  await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + ledger + '.imports TO ' + quote(names.writer));
  const acl = (await client.query(`SELECT
    has_table_privilege($1,$2,'UPDATE') AS authority_owner_other_ledger,
    has_table_privilege($3,$4,'UPDATE') AS ledger_owner_authority,
    has_table_privilege($5,$2,'UPDATE') AS reader_other_ledger,
    has_database_privilege($6,current_database(),'CREATE') AS writer_create_schema,
    has_schema_privilege($6,'public','CREATE') AS writer_create_public`,
  [names.owner, names.ledger + '.imports', names.ledgerOwner, names.app + '.users', names.reader, names.writer])).rows[0];
  assert.deepEqual(acl, {authority_owner_other_ledger: false, ledger_owner_authority: false,
    reader_other_ledger: false, writer_create_schema: false, writer_create_public: false});

  for (const role of [names.reader, names.writer]) {
    const roleUrl = new URL(url); roleUrl.username = role; roleUrl.password = password;
    const positive = new Pool({connectionString: roleUrl.toString(), max: 1, connectionTimeoutMillis: 3000});
    try { assert.equal((await positive.query('SELECT current_user AS role')).rows[0].role, role); }
    finally { await positive.end(); }
    roleUrl.password = 'incorrect-' + password;
    const negative = new Pool({connectionString: roleUrl.toString(), max: 1, connectionTimeoutMillis: 3000});
    try { await assert.rejects(negative.query('SELECT current_user'), error => error.code === '28P01'); }
    finally { await negative.end(); }
  }
  const runtimeUrl = new URL(url); runtimeUrl.username = names.writer; runtimeUrl.password = password;
  const config = {connectionString: runtimeUrl.toString(), expectedDatabase: target,
    maxConnections: 2, lockTimeoutMs: 1000, statementTimeoutMs: 3000,
    onIdleConnectionError: error => poolErrors.push(error.message)};
  database = new api.PostgresDatabase(config); other = new api.PostgresDatabase(config);
  const authorityCases = await runAuthoritySessionContract(api, {database, other,
    applicationSchema: names.app, ledgerSchema: names.ledger});
  const generations = (await client.query('SELECT data_revision,scope_revision FROM ' + app + '.portfolio_revision WHERE id=1')).rows;
  assert.equal(generations.length, 1);
  assert.equal(api.safeSqlInteger(generations[0].data_revision), 11);
  assert(api.safeSqlInteger(generations[0].scope_revision) >= 100);
  assert.deepEqual(poolErrors, []);
  const integrationCases = ['separate_business_schema_owners_and_restricted_runtime_acl',
    'positive_and_negative_reader_writer_password_authentication',
    'authority_repository_uses_real_schema_and_preserves_data_generation'];
  const cases = [...schema.case_ids.map(id => 'schema:' + id),
    ...authorityCases.map(id => 'authority:' + id), ...integrationCases.map(id => 'integration:' + id)];
  assert.equal(new Set(cases).size, cases.length);
  receipt = {kind: 'async-authority-postgresql-fixture', passed: true, engine: 'postgresql',
    server_version_num: identity.version, case_count: cases.length, case_ids: cases,
    builder_case_ids: builderCases, schema_case_ids: schema.case_ids, authority_case_ids: authorityCases,
    integration_case_ids: integrationCases, fixture_names: names, real_authority_schema: true,
    independent_business_ownership: true, runtime_superuser: false, synthetic_only: true,
    production_runtime_switched: false};
} catch (error) { primaryError = error; }
finally {
  for (const db of [database, other]) try { await db?.close(); } catch (error) { cleanupErrors.push(error.message); }
  if (client) {
    // A failed contract rolls back its own transaction. Also end any remaining
    // aborted transaction before cleaning this fresh, explicitly marked fixture.
    try { await client.query('ROLLBACK'); } catch (error) { cleanupErrors.push(error.message); }
    for (const schema of createdSchemas.reverse()) try {
      await client.query('DROP SCHEMA IF EXISTS ' + quote(schema) + ' CASCADE');
    } catch (error) { cleanupErrors.push(error.message); }
    for (const role of createdRoles.reverse()) try {
      await client.query('DROP ROLE ' + quote(role));
    } catch (error) { cleanupErrors.push(error.message); }
    if (!cleanupErrors.length) try {
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=ANY($1::text[])',
        [[names.app, names.ledger, names.app + '_acl_probe']])).rows[0].n, 0);
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_roles WHERE rolname=ANY($1::text[])',
        [[names.owner, names.reader, names.writer, names.foreign, names.ledgerOwner]])).rows[0].n, 0);
    } catch (error) { cleanupErrors.push(error.message); }
    client.release();
  }
  try { await bootstrap.end(); } catch (error) { cleanupErrors.push(error.message); }
  if (folder) rmSync(folder, {recursive: true, force: true});
}
if (primaryError || cleanupErrors.length || poolErrors.length) {
  console.error(JSON.stringify({kind: 'async-authority-postgresql-fixture', passed: false,
    error: primaryError?.message ?? 'Fixture cleanup or connection observer failed',
    cleanup_errors: cleanupErrors, pool_errors: poolErrors}));
  process.exitCode = 1;
} else console.log(JSON.stringify({...receipt, cleanup_passed: true}));
