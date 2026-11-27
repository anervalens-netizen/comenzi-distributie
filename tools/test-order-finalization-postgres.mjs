// Explicit disposable PostgreSQL 19 fixture. The external lab owns isolation,
// resource limits, exact image identity, raw diagnostics and container cleanup.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Pool } from 'pg';
import { runOrderFinalizationContract } from './order-finalization-contract.mjs';
import { runFinalizationSharedInputContract } from './test-finalization-shared-inputs.mjs';
import {
  checkPostgresFinalizationDependencyBuilders,
  runPostgresFinalizationDependencyContract,
} from './test-postgres-finalization-dependencies.mjs';

const target = process.env.COMENZI_PG_TEST_DATABASE;
const urlText = process.env.COMENZI_PG_TEST_URL;
assert(target && /^comenzi_finalization_fixture_[a-z0-9]{8,24}$/.test(target),
  'Explicit disposable finalization database required');
assert(urlText, 'Explicit fixture URL required; no ambient PostgreSQL fallback');
const url = new URL(urlText);
assert(['postgres:', 'postgresql:'].includes(url.protocol)
  && decodeURIComponent(url.pathname.slice(1)) === target);
assert([...url.searchParams.keys()].every(key => key === 'sslmode' || key === 'host'));
assert(url.searchParams.has('host') && url.searchParams.get('host').startsWith('/')
  && url.hostname === 'localhost', 'An explicitly isolated Unix socket is required');

const poolErrors = [], cleanupErrors = [], createdRoles = [], createdSchemas = [];
const bootstrap = new Pool({ connectionString: urlText, max: 1, connectionTimeoutMillis: 3000,
  statement_timeout: 5000, application_name: 'comenzi-finalization-fixture-bootstrap' });
bootstrap.on('error', error => poolErrors.push(error.message));
const suffix = randomBytes(6).toString('hex');
const names = {
  app: 'fixture_final_app_' + suffix, sales: 'fixture_final_sales_' + suffix,
  owner: 'fixture_owner_' + suffix, reader: 'fixture_reader_' + suffix,
  writer: 'fixture_writer_' + suffix, salesOwner: 'fixture_sales_owner_' + suffix,
  importer: 'fixture_importer_' + suffix, foreign: 'fixture_foreign_' + suffix,
};
const roles = [names.owner, names.reader, names.writer, names.salesOwner, names.importer, names.foreign];
const schemaNames = [names.app, names.sales];
const quote = name => '"' + name + '"', password = randomBytes(24).toString('hex');
let client, folder, database, other, fixtureDatabase, fixtureOther, receipt, primaryError;

try {
  client = await bootstrap.connect();
  const identity = (await client.query(`SELECT current_database() AS database,
    current_setting('server_version_num')::integer AS version,pg_is_in_recovery() AS recovery,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert(identity.database === target && identity.version >= 190000 && identity.version < 200000
    && identity.recovery === false);
  assert.equal(identity.marker, 'comenzi async finalization isolated fixture v1');
  assert.equal((await client.query(`SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')`)).rows[0].n, 0);
  assert.deepEqual((await client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [schemaNames])).rows, []);
  assert.deepEqual((await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])', [roles])).rows, []);

  mkdirSync('work', { recursive: true }); folder = mkdtempSync(resolve('work/finalization-postgres-fixture-'));
  const moduleFile = join(folder, 'finalization.mjs');
  await build({ stdin: { contents: [
    'sql-database', 'sql-postgres', 'session-repository-async', 'authority-repository-async',
    'order-write-authority-async', 'order-draft-repository-async', 'order-finalization-state-async',
    'order-limit-source-async', 'order-limit-repository-async', 'order-finalization-repository-async',
    'catalog-customer-repository-async', 'postgres-authority-schema', 'postgres-order-schema',
    'postgres-finalization-dependencies',
  ].map(name => `export * from './lib/${name}';`).join('\n'), loader: 'ts', resolveDir: resolve('.') },
  outfile: moduleFile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  const api = await import(pathToFileURL(moduleFile));
  const builderCases = checkPostgresFinalizationDependencyBuilders(api);
  for (const role of roles) {
    const login = [names.reader, names.writer, names.importer].includes(role);
    await client.query('CREATE ROLE ' + quote(role) + (login ? " LOGIN PASSWORD '" + password + "'" : ' NOLOGIN')
      + ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    createdRoles.push(role);
  }
  const application = { schema: names.app, ownerRole: names.owner, readerRole: names.reader, writerRole: names.writer };
  const sales = { schema: names.sales, ownerRole: names.salesOwner, importerRole: names.importer };
  const authorityPlan = api.postgresAuthoritySchema(application);
  const orderPlan = api.postgresOrderSchema({ ...application, payloadArchive: 'absent' });
  const a = quote(names.app);
  // These exact random names were absent above in a fresh marked database.
  // Register them before DDL so a later refusal still has bounded cleanup.
  createdSchemas.push(...schemaNames);
  await client.query('BEGIN');
  try {
    for (const plan of [authorityPlan, orderPlan]) for (const sql of plan.createStatements) await client.query(sql);
    await client.query(`INSERT INTO ${a}.portfolio_revision(id,data_revision,scope_revision) VALUES(1,11,23)`);
    await client.query(`INSERT INTO ${a}.order_list_revision(id,revision) VALUES(1,17)`);
    for (const plan of [authorityPlan, orderPlan]) for (const sql of plan.activateStatements) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }

  const dependencies = await runPostgresFinalizationDependencyContract(api, {
    client, application, sales, foreignRole: names.foreign, isolatedMutation: true,
  });
  assert.equal(dependencies.passed, true);
  assert.equal(dependencies.case_count, 28);
  assert.equal(dependencies.expected_negative_sql.length, 20);
  // This is deliberately not a production customer builder. Finalization only
  // reads customers. The 13 customer triggers and their dependent writes need
  // a separate preservation contract before any production writer can switch.
  await client.query(`CREATE TABLE ${a}.customers(id TEXT COLLATE "C" PRIMARY KEY,
    warehouse_id TEXT COLLATE "C" NOT NULL,data TEXT COLLATE "C" NOT NULL,active INTEGER NOT NULL DEFAULT 1)`);
  await client.query(`CREATE INDEX idx_customers_warehouse ON ${a}.customers(warehouse_id)`);
  await client.query(`ALTER TABLE ${a}.customers OWNER TO ${quote(names.owner)}`);
  await client.query(`REVOKE ALL ON ${a}.customers FROM PUBLIC,${quote(names.reader)},${quote(names.writer)}`);
  await client.query(`GRANT SELECT ON ${a}.customers TO ${quote(names.reader)},${quote(names.writer)}`);

  const authentication = [], authenticationErrors = [];
  for (const role of [names.reader, names.writer, names.importer]) {
    const roleUrl = new URL(url); roleUrl.username = role; roleUrl.password = password;
    const positive = new Pool({ connectionString: roleUrl.toString(), max: 1, connectionTimeoutMillis: 3000 });
    try { assert.equal((await positive.query('SELECT current_user AS role')).rows[0].role, role); }
    finally { await positive.end(); }
    roleUrl.password = 'incorrect-' + password;
    const negative = new Pool({ connectionString: roleUrl.toString(), max: 1, connectionTimeoutMillis: 3000 });
    try {
      await assert.rejects(negative.query('SELECT current_user'), error => {
        assert.equal(error.code, '28P01'); assert.equal(error.severity, 'FATAL');
        assert.equal(error.message, 'password authentication failed for user "' + role + '"');
        authenticationErrors.push({ role, code: error.code, message: error.message }); return true;
      });
    } finally { await negative.end(); }
    authentication.push({ role, correct_password: true, wrong_password_refused: true });
  }
  const runtimeUrl = new URL(url); runtimeUrl.username = names.writer; runtimeUrl.password = password;
  const config = connectionString => ({ connectionString, expectedDatabase: target, maxConnections: 2,
    lockTimeoutMs: 1000, statementTimeoutMs: 3000, onIdleConnectionError: error => poolErrors.push(error.message) });
  database = new api.PostgresDatabase(config(runtimeUrl.toString()));
  other = new api.PostgresDatabase(config(runtimeUrl.toString()));
  // Only setup and simulated independent input changes use these explicit
  // privileged fixture connections. All repositories use database/other above.
  fixtureDatabase = new api.PostgresDatabase(config(urlText));
  fixtureOther = new api.PostgresDatabase(config(urlText));
  const identitySql = 'SELECT current_user AS role,current_database() AS database,rolsuper FROM pg_roles WHERE rolname=current_user';
  const runtimeIdentity = await database.read(tx => tx.query(api.sqlQuery('read', identitySql, identitySql)));
  assert.deepEqual(runtimeIdentity.rows, [{ role: names.writer, database: target, rolsuper: false }]);
  const fixtureIdentity = await fixtureDatabase.read(tx => tx.query(api.sqlQuery('read', identitySql, identitySql)));
  assert.equal(fixtureIdentity.rows[0].database, target); assert.equal(fixtureIdentity.rows[0].rolsuper, true);
  assert.notEqual(fixtureIdentity.rows[0].role, names.writer);

  const runtimeNegative = [];
  const deniedCustomerWrite = `UPDATE ${a}.customers SET active=active`;
  await assert.rejects(database.write(tx => tx.query(api.sqlQuery('write', deniedCustomerWrite, deniedCustomerWrite))), error => {
    assert.equal(error.code, '42501'); assert.equal(error.severity, 'ERROR');
    assert.equal(error.message, 'permission denied for table customers');
    runtimeNegative.push({ case_id: 'customer_fixture_runtime_write_denied', code: error.code,
      message: error.message, position: error.position ?? null }); return true;
  });
  const inputCases = await runFinalizationSharedInputContract(api, { database, fixtureDatabase, applicationSchema: names.app });
  assert.equal(inputCases.length, 4);
  const finalizationCases = await runOrderFinalizationContract(api, {
    database, other, fixtureDatabase, fixtureOther, applicationSchema: names.app, salesSchema: names.sales,
  });
  assert.equal(finalizationCases.length, 79);
  const generations = (await client.query(`SELECT data_revision,scope_revision FROM ${a}.portfolio_revision WHERE id=1`)).rows;
  assert.equal(generations.length, 1); assert.equal(api.safeSqlInteger(generations[0].data_revision), 11);
  assert.equal(api.safeSqlInteger(generations[0].scope_revision), 100);
  assert((await client.query(`SELECT revision FROM ${a}.order_list_revision WHERE id=1`)).rows.length === 1);
  const schemaRelations = (await client.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind='r' ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`, [schemaNames])).rows;
  assert.equal(schemaRelations.length, 16);
  assert.deepEqual(poolErrors, []);
  const integrationCases = [
    'isolated_database_identity_and_fresh_owned_names',
    'positive_and_negative_reader_writer_importer_authentication',
    'runtime_uses_restricted_role_and_fixture_writes_are_explicit',
    'customer_fixture_runtime_write_denied',
    'qualified_generations_and_complete_dependency_table_inventory',
  ];
  const cases = [...dependencies.case_ids.map(id => 'dependencies:' + id),
    ...inputCases.map(id => 'inputs:' + id), ...finalizationCases.map(id => 'finalization:' + id),
    ...integrationCases.map(id => 'integration:' + id)];
  assert.equal(new Set(cases).size, cases.length);
  receipt = { kind: 'async-finalization-postgresql-fixture', passed: true, engine: 'postgresql',
    server_version_num: identity.version, case_count: cases.length, case_ids: cases,
    builder_case_ids: builderCases, dependency_case_ids: dependencies.case_ids,
    input_case_ids: inputCases, input_sqlite_oracle_count: 3, finalization_case_ids: finalizationCases,
    integration_case_ids: integrationCases, authentication,
    expected_negative_sql: [...dependencies.expected_negative_sql, ...runtimeNegative],
    expected_authentication_errors: authenticationErrors, fixture_names: names,
    real_authority_schema: true, real_order_schema: true, real_notifications_schema: true, real_sales_schema: true,
    customer_storage_scope: 'four-column SELECT-only runtime fixture; thirteen triggers not activated',
    customer_writers_qualified: false, production_sales_importer_qualified: false,
    production_export_store_implemented: false, fixture_admin_inputs_explicit: true,
    runtime_superuser: false, synthetic_only: true, production_runtime_switched: false };
} catch (error) { primaryError = error; }
finally {
  for (const db of [database, other, fixtureDatabase, fixtureOther]) try { await db?.close(); }
  catch (error) { cleanupErrors.push(error.message); }
  if (client) {
    try { await client.query('ROLLBACK'); } catch (error) { cleanupErrors.push(error.message); }
    for (const schema of createdSchemas.reverse()) try { await client.query('DROP SCHEMA IF EXISTS ' + quote(schema) + ' CASCADE'); }
    catch (error) { cleanupErrors.push(error.message); }
    for (const role of createdRoles.reverse()) try { await client.query('DROP ROLE ' + quote(role)); }
    catch (error) { cleanupErrors.push(error.message); }
    if (!cleanupErrors.length) try {
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=ANY($1::text[])', [schemaNames])).rows[0].n, 0);
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_roles WHERE rolname=ANY($1::text[])', [roles])).rows[0].n, 0);
    } catch (error) { cleanupErrors.push(error.message); }
    client.release();
  }
  try { await bootstrap.end(); } catch (error) { cleanupErrors.push(error.message); }
  if (folder) rmSync(folder, { recursive: true, force: true });
}
if (primaryError || cleanupErrors.length || poolErrors.length) {
  console.error(JSON.stringify({ kind: 'async-finalization-postgresql-fixture', passed: false,
    error: primaryError?.message ?? 'Cleanup or observer failed', cleanup_errors: cleanupErrors, pool_errors: poolErrors }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ ...receipt, cleanup_passed: true }));
