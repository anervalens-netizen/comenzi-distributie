// Synthetic contracts only. No environment DSN, role creation or automatic DB connection.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function checkPostgresAuthoritySchemaBuilder(api) {
  const input = {schema:'fixture_authority', ownerRole:'fixture_owner',
    readerRole:'fixture_reader', writerRole:'fixture_writer'};
  const plan = api.postgresAuthoritySchema(input), cases = [];
  for (const key of Object.keys(input)) {
    for (const value of [undefined, null, '', 'a"; SELECT 1; --', 'x.y', 'a\n', 'a'.repeat(64), 'pg_catalog', 'public']) {
      assert.throws(() => api.postgresAuthoritySchema({...input, [key]:value}));
    }
  }
  cases.push('reject_unbounded_reserved_and_injected_identifiers');
  for (const [left,right] of [['ownerRole','readerRole'],['ownerRole','writerRole'],['readerRole','writerRole']]) {
    assert.throws(() => api.postgresAuthoritySchema({...input,[left]:input[right]}));
  }
  cases.push('reject_role_aliasing');
  input.schema = 'changed_after_capture';
  assert.equal(plan.schema, 'fixture_authority');
  for (const value of [plan, plan.roles, plan.tables, plan.createStatements, plan.activateStatements]) {
    assert(Object.isFrozen(value));
  }
  assert.throws(() => plan.createStatements.push('SELECT 1'));
  cases.push('immutable_plan_captures_inputs');
  assert.equal(plan.version,'postgres-authority-schema-v1');
  assert(plan.createStatements.length > 0 && plan.activateStatements.length > 0);
  assert(!plan.createStatements.some(sql => /CREATE\s+TRIGGER|INSERT\s+INTO/i.test(sql)));
  assert(![...plan.createStatements,...plan.activateStatements].some(sql =>
    /^\s*(?:DROP|TRUNCATE|CREATE\s+ROLE)\b|IF\s+NOT\s+EXISTS|CREATE\s+OR\s+REPLACE/im.test(sql)));
  cases.push('new_schema_without_data_seed_or_destructive_repair');
  return cases;
}

/**
 * The caller supplies an idle, attested client to a DISPOSABLE database, three
 * existing nonadministrative roles, a fourth foreign fixture role, and a new schema. The caller owns exact-ID
 * isolation and cleanup. This function never opens a connection or creates roles.
 * It leaves its new schema for the caller's subsequent repository contract.
 */
export async function runPostgresAuthoritySchemaContract(api, options) {
  const {client, isolatedMutation, foreignRole, ...names} = options;
  assert.equal(isolatedMutation, true, 'Only an explicitly isolated caller may execute this contract');
  const plan = api.postgresAuthoritySchema(names), s = api.sqlIdentifier(plan.schema);
  const writer = api.sqlIdentifier(plan.roles.writer), reader = api.sqlIdentifier(plan.roles.reader);
  const owner = api.sqlIdentifier(plan.roles.owner), cases = [];
  const foreign = api.sqlIdentifier(foreignRole);
  assert(!Object.values(plan.roles).includes(foreignRole));
  const probeSchema = plan.schema + '_acl_probe';
  const probe = api.postgresAuthoritySchema({...names,schema:probeSchema});
  const query = (sql, args=[]) => client.query(sql,args);
  const count = async sql => api.safeSqlInteger((await query(sql)).rows[0].n);
  const generation = async () => {
    const row = (await query(`SELECT data_revision,scope_revision FROM ${s}.portfolio_revision WHERE id=1`)).rows[0];
    return [api.safeSqlInteger(row.data_revision),api.safeSqlInteger(row.scope_revision)];
  };
  const transaction = async (role, action, rollback=false) => {
    await query('BEGIN');
    try {
      await query('SET LOCAL ROLE ' + role);
      const result = await action();
      await query(rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch(error) { await query('ROLLBACK'); throw error; }
  };
  const rejected = async (id,role,sql,args,code) => {
    const before = await generation();
    await assert.rejects(transaction(role,()=>query(sql,args)), error=>error.code===code);
    assert.deepEqual(await generation(),before);
    cases.push(id);
  };
  const addUser = `INSERT INTO ${s}.users(id,username,name,role,manager_scope,site_code,password_hash,must_change_password)
 VALUES($1,$2,'Synthetic account',$3,$4,$5,'opaque-fictional-value',0)`;

  // These changes to fixture defaults/membership are transactionally rolled back.
  // No original grant or role setting is altered after the probe.
  await query('BEGIN');
  try {
    await query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${foreign}`);
    for (const sql of probe.createStatements) await query(sql);
    await query(`INSERT INTO ${api.sqlIdentifier(probeSchema)}.portfolio_revision VALUES(1,1,1)`);
    await assert.rejects((async()=>{for(const sql of probe.activateStatements) await query(sql);})(),
      error=>error.code==='42501' && error.message==='Unexpected default or object authority grant');
  } finally { await query('ROLLBACK'); }
  assert.equal((await query('SELECT pg_catalog.to_regnamespace($1) AS value',[probeSchema])).rows[0].value,null);
  cases.push('foreign_default_table_grant_rejects_and_rolls_back');
  await query('BEGIN');
  try {
    await query(`GRANT pg_write_all_data TO ${reader}`);
    await assert.rejects(query(probe.createStatements[0]),error=>error.code==='42501');
  } finally { await query('ROLLBACK'); }
  cases.push('inherited_global_writer_membership_rejected');
  await query('BEGIN');
  try {
    await query(`GRANT ${owner} TO ${foreign}`);
    await assert.rejects(query(probe.createStatements[0]),error=>error.code==='42501'
      && error.message==='Unexpected principal can assume an authority role');
  } finally { await query('ROLLBACK'); }
  cases.push('foreign_principal_cannot_assume_owner');

  await query('BEGIN');
  try {
    for (const sql of plan.createStatements) await query(sql);
    await query('SAVEPOINT missing_generation');
    await assert.rejects(query(plan.activateStatements[0]), error=>error.code==='23514');
    await query('ROLLBACK TO SAVEPOINT missing_generation');
    await query('RELEASE SAVEPOINT missing_generation');
    for (const row of [
      ['fixture-manager','fixture-manager','manager','global',''],
      ['fixture-agent-a','fixture-agent-a','agent','assigned','AB'],
      ['fixture-agent-b','fixture-agent-b','agent','assigned','CD'],
    ]) await query(addUser,row);
    await query(`INSERT INTO ${s}.manager_agents VALUES('fixture-manager','fixture-agent-a')`);
    await query(`INSERT INTO ${s}.sessions VALUES('fictional-token','fixture-agent-a',4000)`);
    await query(`INSERT INTO ${s}.login_attempts VALUES('account:fixture-agent-a',2,5000)`);
    await query(`INSERT INTO ${s}.settings VALUES('fixture-setting','fictional-value')`);
    await query(`INSERT INTO ${s}.portfolio_revision VALUES(1,11,23)`);
    for (const sql of plan.activateStatements) await query(sql);
    await query('COMMIT');
  } catch(error) { await query('ROLLBACK'); throw error; }
  assert.deepEqual(await generation(),[11,23]);
  assert.equal(await count(`SELECT count(*) AS n FROM ${s}.users WHERE profile_revision=1`),3);
  cases.push('missing_generation_blocks_activation','copy_then_activate_preserves_original_generations');

  const observed = await query(`SELECT c.relname,pg_catalog.pg_get_userbyid(c.relowner) AS owner
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,[plan.schema]);
  assert.deepEqual(observed.rows.map(x=>x.relname),[...plan.tables].sort((a,b)=>a<b?-1:a>b?1:0));
  assert(observed.rows.every(x=>x.owner===plan.roles.owner));
  const triggerRows = await query(`SELECT t.tgname FROM pg_catalog.pg_trigger t
 JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`,[plan.schema]);
  assert.equal(triggerRows.rows.length,6);
  cases.push('exact_table_ownership_and_six_scope_triggers');

  let scope = 23;
  const bump = async (id,sql,args=[],increment=1) => {
    await transaction(writer,()=>query(sql,args));
    scope += increment;
    assert.deepEqual(await generation(),[11,scope]); cases.push(id);
  };
  await bump('update_of_unchanged_active_invalidates',`UPDATE ${s}.users SET active=active WHERE id='fixture-agent-a'`);
  await bump('profile_increment_is_explicit_once',`UPDATE ${s}.users SET name='Renamed',profile_revision=profile_revision+1 WHERE id='fixture-agent-a'`,[],0);
  assert.equal(await count(`SELECT profile_revision AS n FROM ${s}.users WHERE id='fixture-agent-a'`),2);
  await bump('update_of_unchanged_nullable_warehouse_invalidates',`UPDATE ${s}.users SET warehouse_id=NULL WHERE id='fixture-agent-a'`);
  await bump('user_insert_invalidates',addUser,['fixture-temporary','fixture-temporary','agent','assigned','']);
  await bump('user_delete_invalidates',`DELETE FROM ${s}.users WHERE id='fixture-temporary'`);
  await bump('assignment_insert_invalidates',`INSERT INTO ${s}.manager_agents VALUES('fixture-manager','fixture-agent-b')`);
  await bump('assignment_unchanged_update_invalidates',`UPDATE ${s}.manager_agents SET agent_id=agent_id WHERE agent_id='fixture-agent-b'`);
  await bump('assignment_delete_invalidates',`DELETE FROM ${s}.manager_agents WHERE agent_id='fixture-agent-b'`);
  await bump('two_scope_columns_increment_once_per_row',`UPDATE ${s}.users SET role=role,manager_scope=manager_scope WHERE id='fixture-agent-a'`);
  await bump('zero_rows_do_not_invalidate',`UPDATE ${s}.users SET active=active WHERE id='fixture-absent'`,[],0);

  const beforeRollback = await generation();
  await transaction(writer,()=>query(addUser,['fixture-rollback','fixture-rollback','agent','assigned','']),true);
  assert.deepEqual(await generation(),beforeRollback);
  assert.equal(await count(`SELECT count(*) AS n FROM ${s}.users WHERE id='fixture-rollback'`),0);
  cases.push('business_row_and_scope_generation_rollback_together');

  await rejected('flag_outside_zero_one_rejected',writer,`UPDATE ${s}.users SET active=2 WHERE id='fixture-agent-a'`,[],'23514');
  await rejected('invalid_profile_revision_rejected',writer,`UPDATE ${s}.users SET profile_revision=0 WHERE id='fixture-agent-a'`,[],'23514');
  await rejected('unsafe_profile_revision_rejected',writer,`UPDATE ${s}.users SET profile_revision=9007199254740991 WHERE id='fixture-agent-a'`,[],'23514');
  await rejected('negative_session_epoch_rejected',writer,`UPDATE ${s}.sessions SET expires_at=-1 WHERE token_hash='fictional-token'`,[],'23514');
  await rejected('unsafe_attempt_count_rejected',writer,`UPDATE ${s}.login_attempts SET attempts=9007199254740992`,[],'23514');
  await rejected('session_foreign_key_rejected',writer,`INSERT INTO ${s}.sessions VALUES('fictional-orphan','fixture-absent',4000)`,[],'23503');
  await rejected('referenced_user_delete_does_not_cascade',writer,`DELETE FROM ${s}.users WHERE id='fixture-agent-a'`,[],'23503');
  await rejected('duplicate_assignment_rejected',writer,`INSERT INTO ${s}.manager_agents VALUES('fixture-manager','fixture-agent-a')`,[],'23505');
  await rejected('ascii_site_code_fold_and_trim_are_unique',writer,addUser,['fixture-duplicate','fixture-duplicate','agent','assigned',' ab '],'23505');
  await bump('non_ascii_lowercase_site_code',addUser,['fixture-lower','case','agent','assigned','ä']);
  await bump('non_ascii_uppercase_site_and_binary_username_remain_distinct',addUser,['fixture-upper','CASE','agent','assigned','Ä']);
  await bump('inactive_site_code_duplicate_is_allowed',`INSERT INTO ${s}.users(id,username,name,role,site_code,password_hash,active)
 VALUES('fixture-inactive','fixture-inactive','Inactive','agent','ab','opaque-fictional-value',0)`);

  await transaction(reader,async()=>assert.equal(await count(`SELECT count(*) AS n FROM ${s}.settings`),1));
  cases.push('reader_reads_application_tables');
  await rejected('reader_cannot_write',reader,`UPDATE ${s}.users SET name='Denied' WHERE id='fixture-agent-a'`,[],'42501');
  await rejected('writer_cannot_create_schema_objects',writer,`CREATE TABLE ${s}.denied(id integer)`,[],'42501');
  await rejected('writer_cannot_truncate_accounts',writer,`TRUNCATE ${s}.login_attempts`,[],'42501');
  await rejected('writer_cannot_delete_generation',writer,`DELETE FROM ${s}.portfolio_revision`,[],'42501');
  const executable = await query('SELECT pg_catalog.has_function_privilege($1,$2,\'EXECUTE\') AS allowed',
    [plan.roles.reader,s+'.authority_bump_scope()']);
  assert.equal(executable.rows[0].allowed,false); cases.push('reader_has_no_scope_function_grant');

  await query('BEGIN');
  try {
    await query('SET LOCAL ROLE '+owner);
    await query(`DELETE FROM ${s}.portfolio_revision`);
    await query('SET LOCAL ROLE '+writer);
    await assert.rejects(query(addUser,['fixture-failclosed','fixture-failclosed','agent','assigned','']),error=>error.code==='23514');
  } finally { await query('ROLLBACK'); }
  assert.deepEqual(await generation(),[11,scope]);
  assert.equal(await count(`SELECT count(*) AS n FROM ${s}.users WHERE id='fixture-failclosed'`),0);
  cases.push('missing_generation_fails_write_and_restores_on_rollback');
  return {kind:'postgres-authority-schema-contract',passed:true,case_count:cases.length,case_ids:cases,
    runtime_wired:false,roles_created:false,schema_retained_for_caller_cleanup:true};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {build} = await import('esbuild');
  mkdirSync('work',{recursive:true});
  const folder = mkdtempSync(resolve('work/authority-schema-'));
  try {
    const moduleFile = join(folder,'schema.mjs');
    await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/postgres-authority-schema';",
      loader:'ts',resolveDir:resolve('.')},outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
    const cases = checkPostgresAuthoritySchemaBuilder(await import(pathToFileURL(moduleFile)));
    console.log(JSON.stringify({kind:'postgres-authority-schema-builder',passed:true,case_count:cases.length,
      case_ids:cases,postgresql_executed:false,runtime_wired:false}));
  } finally { rmSync(folder,{recursive:true,force:true}); }
}
