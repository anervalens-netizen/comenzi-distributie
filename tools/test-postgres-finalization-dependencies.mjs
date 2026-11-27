import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkPostgresFinalizationDependencyBuilders(api) {
  const application = { schema: 'fictional_app', ownerRole: 'fictional_owner', readerRole: 'fictional_reader', writerRole: 'fictional_writer' };
  const input = { application, schema: 'fictional_sales', ownerRole: 'fictional_sales_owner', importerRole: 'fictional_importer', sourceImportSequence: 41 };
  const cases = [];
  for (const field of ['schema', 'ownerRole', 'importerRole']) for (const value of [null, undefined, '', 'public', 'pg_catalog', 'a.b', 'a";SELECT 1;--', 'a'.repeat(64)]) {
    assert.throws(() => api.postgresSalesSchema({ ...input, [field]: value }));
  }
  for (const field of ['schema', 'ownerRole', 'readerRole', 'writerRole']) for (const value of [undefined, '', 'public', 'pg_catalog', 'a.b', 'a";SELECT 1;--']) {
    assert.throws(() => api.postgresNotificationSchema({ ...application, [field]: value }));
  }
  cases.push('dependency_identifiers_reject_reserved_and_injected_names');
  for (const value of Object.values(application).slice(1)) {
    assert.throws(() => api.postgresSalesSchema({ ...input, ownerRole: value }), /separate/);
    assert.throws(() => api.postgresSalesSchema({ ...input, importerRole: value }), /separate/);
  }
  assert.throws(() => api.postgresSalesSchema({ ...input, schema: application.schema }), /separate/);
  assert.throws(() => api.postgresSalesSchema({ ...input, importerRole: input.ownerRole }), /separate/);
  cases.push('sales_ownership_and_import_role_cannot_alias_application_roles');
  for (const sourceImportSequence of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '41']) {
    assert.throws(() => api.postgresSalesSchema({ ...input, sourceImportSequence }), /sequence/);
  }
  cases.push('sales_sequence_requires_exact_safe_nonnegative_snapshot_value');
  for (const plan of [api.postgresNotificationSchema(application), api.postgresSalesSchema(input)]) {
    for (const value of [plan, plan.tables, plan.createStatements, plan.activateStatements]) assert(Object.isFrozen(value));
    assert(![...plan.createStatements, ...plan.activateStatements].some(sql =>
      /^\s*(?:DROP|TRUNCATE|CREATE\s+ROLE)\b|CREATE\s+(?:SCHEMA|TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS|CREATE\s+OR\s+REPLACE/im.test(sql)));
    assert(!plan.createStatements.some(sql => /^\s*INSERT\s+INTO\b/im.test(sql)));
  }
  cases.push('immutable_fresh_schema_plans_do_not_seed_repair_or_overwrite');
  return cases;
}

/** Caller attests a fresh disposable database, creates roles, and owns exact cleanup. */
export async function runPostgresFinalizationDependencyContract(api, fixture) {
  const { client, application, sales, foreignRole, isolatedMutation } = fixture;
  assert.equal(isolatedMutation, true);
  const a = api.sqlIdentifier(application.schema), s = api.sqlIdentifier(sales.schema),
    writer = api.sqlIdentifier(application.writerRole), reader = api.sqlIdentifier(application.readerRole),
    importer = api.sqlIdentifier(sales.importerRole), foreign = api.sqlIdentifier(foreignRole);
  const notifications = api.postgresNotificationSchema(application),
    salesPlan = api.postgresSalesSchema({ ...sales, application, sourceImportSequence: 41 });
  assert(![application.ownerRole, application.readerRole, application.writerRole, sales.ownerRole, sales.importerRole].includes(foreignRole));
  const query = (sql, args = []) => client.query(sql, args), cases = [], negative = [];
  const txn = async (role, action, rollback = false) => {
    await query('BEGIN');
    try {
      await query('SET LOCAL ROLE ' + role);
      const value = await action(); await query(rollback ? 'ROLLBACK' : 'COMMIT'); return value;
    } catch (error) { await query('ROLLBACK'); throw error; }
  };
  const reject = async (id, role, sql, args, code, message) => {
    await assert.rejects(txn(role, () => query(sql, args)), error => {
      assert.equal(error.code, code); assert.equal(error.severity, 'ERROR'); assert.equal(error.message, message);
      negative.push({ case_id: id, code, message, position: error.position ?? null }); return true;
    });
    cases.push(id);
  };
  for (const [label, plan] of [['notifications', notifications], ['sales', salesPlan]]) {
    await query('BEGIN');
    try {
      await query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${foreign}`);
      for (const sql of plan.createStatements) await query(sql);
      await assert.rejects((async () => { for (const sql of plan.activateStatements) await query(sql); })(), error => {
        assert.equal(error.code, '42501');
        assert.equal(error.message, 'Unexpected finalization dependency table grant or inventory');
        negative.push({ case_id: label + '_foreign_default_grant_refused', code: error.code, message: error.message, position: error.position ?? null });
        return true;
      });
    } finally { await query('ROLLBACK'); }
    assert.equal((await query('SELECT to_regclass($1) AS relation', [plan.schema + '.' + plan.tables[0]])).rows[0].relation, null);
    cases.push(label + '_foreign_default_grant_refused');
  }
  await query('BEGIN');
  try {
    for (const plan of [notifications, salesPlan]) for (const sql of plan.createStatements) await query(sql);
    await query(`INSERT INTO ${a}.users(id,username,name,role,password_hash,must_change_password)
      VALUES('fictional-notification-user','fictional-notification-user','Fictional','agent','synthetic-verifier',0)`);
    await query(`INSERT INTO ${a}.notifications VALUES('fictional-notification','fictional-notification-user','fictional-event','order','Fictional title','Exact raw body  ','order-approval','fictional-approval','2025-03-30T00:59:59.999Z',NULL)`);
    await query(`INSERT INTO ${s}.sales_meta VALUES('source','  lexical source value  ')`);
    await query(`INSERT INTO ${s}.sales_imports(id,month,file_hash,filename,imported_at,imported_by,row_count,original_path,revision)
      VALUES(7,'2025-01','synthetic-hash','synthetic.xlsx','2025-02-01T00:00:00.000Z','fictional-importer',1,'synthetic-source',3)`);
    await query(`INSERT INTO ${s}.sales_months VALUES('2025-01',7,'2025-02-01T00:00:00.000Z','synthetic.xlsx','synthetic-hash',3)`);
    await query(`INSERT INTO ${s}.sales_rows VALUES(7,1,'2025-01-31','2025-01','  sItE-ă  ','Item-a','Historical item',-1.25,'Synthetic',101,-126,'Warehouse A','Fictional company','Historical ASM','Historical RM','Fictional order','Synthetic category','Synthetic subgroup','Fictional agent')`);
    for (const plan of [notifications, salesPlan]) for (const sql of plan.activateStatements) await query(sql);
    await query('COMMIT');
  } catch (error) { await query('ROLLBACK'); throw error; }
  const notice = (await query(`SELECT * FROM ${a}.notifications`)).rows[0];
  assert.equal(Object.keys(notice).length, 10); assert.equal(notice.body, 'Exact raw body  '); assert.equal(notice.read_at, null);
  cases.push('notification_copy_preserves_all_ten_columns_and_nullable_read_state');
  const columns = (await query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='sales_rows' ORDER BY ordinal_position`, [sales.schema])).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['import_id', 'row_number', 'date', 'month', 'site_code', 'item_code', 'item_name', 'quantity', 'brand', 'price_cents', 'value_cents', 'location', 'company', 'asm', 'regional', 'order_number', 'category', 'sub_category', 'agent']);
  const row = (await query(`SELECT * FROM ${s}.sales_rows`)).rows[0];
  assert.equal(row.quantity, -1.25); assert.equal(api.safeSqlInteger(row.value_cents), -126);
  assert.equal(row.asm, 'Historical ASM'); assert.equal(row.regional, 'Historical RM');
  assert.equal((await query(`SELECT value FROM ${s}.sales_meta`)).rows[0].value, '  lexical source value  ');
  cases.push('sales_copy_preserves_nineteen_columns_negative_fraction_and_legacy_roles');
  const indexes = (await query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname LIKE 'idx_sales_%' ORDER BY indexname`, [sales.schema])).rows.map(row => row.indexname);
  assert.deepEqual(indexes, ['idx_sales_imports_month', 'idx_sales_rows_import_site_normalized', 'idx_sales_rows_location_import', 'idx_sales_rows_month', 'idx_sales_rows_month_site', 'idx_sales_rows_site_month_normalized']);
  assert.equal((await query(`SELECT translate(btrim(site_code,' '),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') AS site FROM ${s}.sales_rows`)).rows[0].site, 'SITE-ă');
  cases.push('six_sales_indexes_keep_ascii_site_normalization');
  const allTables = [...notifications.tables.map(table => [application.schema, table, application.ownerRole]),
    ...salesPlan.tables.map(table => [sales.schema, table, sales.ownerRole])];
  for (const [schema, table, owner] of allTables) assert.equal((await query(`SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r'`, [schema, table])).rows[0].owner, owner);
  cases.push('application_and_sales_table_owners_remain_separate');
  await query('BEGIN');
  try {
    await query(`GRANT SELECT ON ${a}.notifications TO ${reader} WITH GRANT OPTION`);
    await assert.rejects(query(notifications.activateStatements[0]), error => {
      assert.equal(error.code, '42501'); assert.equal(error.message, 'Unexpected finalization dependency table grant or inventory');
      negative.push({ case_id: 'notification_reader_cannot_receive_grant_option', code: error.code, message: error.message, position: error.position ?? null });
      return true;
    });
  } finally { await query('ROLLBACK'); }
  cases.push('notification_reader_cannot_receive_grant_option');
  const grantInjections = [
    ['notification_writer_column_references_refused',
      `GRANT REFERENCES(id) ON ${a}.notifications TO ${writer}`,
      notifications.activateStatements[0],
      'Unexpected finalization dependency table grant or inventory'],
    ['notification_writer_maintain_refused',
      `GRANT MAINTAIN ON ${a}.notifications TO ${writer}`,
      notifications.activateStatements[0],
      'Unexpected finalization dependency table grant or inventory'],
    ['sales_importer_sequence_select_refused',
      `GRANT SELECT ON SEQUENCE ${s}.sales_imports_id_seq TO ${importer}`,
      salesPlan.activateStatements.at(-1),
      'Effective sales schema or sequence authority differs'],
  ];
  for (const [id, grant, guard, message] of grantInjections) {
    await query('BEGIN');
    try {
      await query(grant);
      await assert.rejects(query(guard), error => {
        assert.equal(error.code, '42501'); assert.equal(error.severity, 'ERROR'); assert.equal(error.message, message);
        negative.push({ case_id: id, code: error.code, message: error.message, position: error.position ?? null });
        return true;
      });
    } finally { await query('ROLLBACK'); }
    // A refused activation must not leave the injected grant behind.
    await query(notifications.activateStatements[0]);
    await query(salesPlan.activateStatements[1]);
    await query(salesPlan.activateStatements.at(-1));
    cases.push(id);
  }
  await txn(reader, async () => {
    assert.equal((await query(`SELECT count(*)::integer AS n FROM ${a}.notifications`)).rows[0].n, 1);
    assert.equal((await query(`SELECT count(*)::integer AS n FROM ${s}.sales_rows`)).rows[0].n, 1);
  });
  await txn(writer, async () => {
    const result = await query(`INSERT INTO ${a}.notifications SELECT 'fictional-duplicate',recipient_id,event_key,category,title,body,target_type,target_id,created_at,NULL FROM ${a}.notifications ON CONFLICT(recipient_id,event_key) DO NOTHING`);
    assert.equal(result.rowCount, 0);
    await query(`UPDATE ${a}.notifications SET read_at='2025-03-30T01:00:00.000Z'`);
  });
  cases.push('runtime_reads_sales_and_notification_conflict_is_idempotent');
  await reject('notification_reader_write_denied', reader, `UPDATE ${a}.notifications SET read_at=NULL`, [], '42501', 'permission denied for table notifications');
  await reject('notification_orphan_recipient_refused', writer, `UPDATE ${a}.notifications SET recipient_id='fictional-missing'`, [], '23503', 'insert or update on table "notifications" violates foreign key constraint "notifications_recipient_id_fkey"');
  await reject('notification_recipient_history_prevents_user_delete', writer, `DELETE FROM ${a}.users WHERE id='fictional-notification-user'`, [], '23503', 'update or delete on table "users" violates foreign key constraint "notifications_recipient_id_fkey" on table "notifications"');
  for (const name of salesPlan.tables) await reject('application_cannot_write_' + name, writer, `DELETE FROM ${s}.${name}`, [], '42501', 'permission denied for table ' + name);
  await reject('sales_reader_cannot_write', reader, `DELETE FROM ${s}.sales_rows`, [], '42501', 'permission denied for table sales_rows');
  await reject('importer_cannot_mutate_application_authority', importer, `UPDATE ${a}.users SET active=active`, [], '42501', 'permission denied for schema ' + application.schema);
  await reject('importer_cannot_truncate_sales', importer, `TRUNCATE ${s}.sales_rows`, [], '42501', 'permission denied for table sales_rows');
  await reject('runtime_cannot_advance_sales_sequence', writer, `SELECT nextval('${s}.sales_imports_id_seq'::regclass)`, [], '42501', 'permission denied for sequence sales_imports_id_seq');
  await reject('importer_cannot_reset_sales_sequence', importer, `SELECT setval('${s}.sales_imports_id_seq'::regclass,1,false)`, [], '42501', 'permission denied for sequence sales_imports_id_seq');
  const insertImport = `INSERT INTO ${s}.sales_imports(month,file_hash,filename,imported_at,imported_by,row_count,original_path,revision) VALUES('2025-02','synthetic','synthetic.xlsx','2025-03-01','fictional-importer',0,'synthetic-source',1) RETURNING id`;
  const inserted = await txn(importer, () => query(insertImport));
  assert.equal(api.safeSqlInteger(inserted.rows[0].id), 42);
  cases.push('copied_deleted_high_water_sequence_is_not_reused');
  await reject('orphan_sales_row_import_refused', importer, `UPDATE ${s}.sales_rows SET import_id=99999`, [], '23503', 'insert or update on table "sales_rows" violates foreign key constraint "sales_rows_import_id_fkey"');
  await txn(importer, async () => {
    await query(`UPDATE ${s}.sales_months SET import_id=42`);
    assert.equal(api.safeSqlInteger((await query(`SELECT import_id FROM ${s}.sales_months`)).rows[0].import_id), 42);
  }, true);
  assert.equal(api.safeSqlInteger((await query(`SELECT import_id FROM ${s}.sales_months`)).rows[0].import_id), 7);
  cases.push('sales_publication_rollback_preserves_active_generation');
  const badSequence = api.postgresSalesSchema({ ...sales, application, sourceImportSequence: 0 });
  await reject('inconsistent_snapshot_sequence_refuses_activation', api.sqlIdentifier(sales.ownerRole), badSequence.activateStatements[0], [], '23514', 'Copied sales imports exceed the captured SQLite sequence');
  assert.equal(api.safeSqlInteger((await query(`SELECT last_value FROM ${s}.sales_imports_id_seq`)).rows[0].last_value), 42);
  cases.push('failed_sequence_activation_does_not_reset_allocated_ids');
  return { kind: 'postgres-finalization-dependency-contract', passed: true, case_count: cases.length,
    case_ids: cases, expected_negative_sql: negative, schema_retained_for_caller_cleanup: true,
    real_notifications_schema: true, real_sales_schema: true, customer_writers_qualified: false,
    production_sales_importer_qualified: false, runtime_wired: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { build } = await import('esbuild'); mkdirSync('work', { recursive: true });
  const folder = mkdtempSync(resolve('work/finalization-dependency-builder-'));
  try {
    const moduleFile = join(folder, 'schema.mjs');
    await build({ stdin: { contents: "export * from './lib/postgres-finalization-dependencies';", loader: 'ts', resolveDir: resolve('.') },
      outfile: moduleFile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
    const cases = checkPostgresFinalizationDependencyBuilders(await import(pathToFileURL(moduleFile)));
    console.log(JSON.stringify({ kind: 'postgres-finalization-dependency-builders', passed: true, case_count: cases.length,
      case_ids: cases, postgresql_executed: false, runtime_wired: false }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
