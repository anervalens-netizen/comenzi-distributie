// Fictional fixtures only. The caller supplies an independently attested disposable DB.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function checkPostgresOrderSchemaBuilder(api) {
  const input={schema:'fixture_orders',ownerRole:'fixture_owner',readerRole:'fixture_reader',
    writerRole:'fixture_writer',payloadArchive:'absent'},cases=[];
  for(const field of ['schema','ownerRole','readerRole','writerRole']){
    for(const value of [null,undefined,'','public','pg_catalog','a.b','a"; SELECT 1; --','a'.repeat(64)]){
      assert.throws(()=>api.postgresOrderSchema({...input,[field]:value}));
    }
  }
  assert.throws(()=>api.postgresOrderSchema({...input,readerRole:input.writerRole}));
  cases.push('reject_invalid_identifiers_and_role_aliases');
  for(const value of [undefined,null,true,'present','unknown']){
    assert.throws(()=>api.postgresOrderSchema({...input,payloadArchive:value}),/archive/);
  }
  cases.push('require_explicit_archive_absence_contract');
  const plan=api.postgresOrderSchema(input);input.schema='changed_after_capture';
  assert.equal(plan.schema,'fixture_orders');
  for(const part of [plan,plan.roles,plan.tables,plan.createStatements,plan.activateStatements])assert(Object.isFrozen(part));
  assert.throws(()=>plan.activateStatements.push('SELECT 1'));
  cases.push('immutable_plan_captures_inputs');
  assert.equal(plan.version,'postgres-order-schema-v1');
  assert(!plan.createStatements.some(sql=>/^\s*(?:CREATE\s+TRIGGER|INSERT\s+INTO)\b/im.test(sql)));
  assert(![...plan.createStatements,...plan.activateStatements].some(sql=>
    /^\s*(?:DROP|TRUNCATE|CREATE\s+ROLE)\b|CREATE\s+(?:SCHEMA|TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS|CREATE\s+OR\s+REPLACE/im.test(sql)));
  cases.push('copy_before_triggers_without_seed_or_repair');
  return cases;
}

/** Leaves the prepared schema for repository parity tests and caller cleanup. */
export async function runPostgresOrderSchemaContract(api,options){
  const {client,isolatedMutation,foreignRole,...names}=options;
  assert.equal(isolatedMutation,true,'Explicit isolated mutation permission required');
  const plan=api.postgresOrderSchema({...names,payloadArchive:'absent'}),s=api.sqlIdentifier(plan.schema);
  const owner=api.sqlIdentifier(plan.roles.owner),reader=api.sqlIdentifier(plan.roles.reader);
  const writer=api.sqlIdentifier(plan.roles.writer),foreign=api.sqlIdentifier(foreignRole);
  assert(!Object.values(plan.roles).includes(foreignRole));
  const query=(sql,args=[])=>client.query(sql,args),cases=[];
  const count=async sql=>api.safeSqlInteger((await query(sql)).rows[0].n);
  const generation=()=>count(`SELECT revision AS n FROM ${s}.order_list_revision WHERE id=1`);
  const txn=async(role,action,rollback=false)=>{
    await query('BEGIN');
    try{await query('SET LOCAL ROLE '+role);const value=await action();await query(rollback?'ROLLBACK':'COMMIT');return value;}
    catch(error){await query('ROLLBACK');throw error;}
  };
  const addUser=`INSERT INTO ${s}.users(id,username,name,role,password_hash,must_change_password)
 VALUES('fixture-order-agent','fixture-order-agent','Synthetic order agent','agent','fictional-verifier',0)`;
  const addOrder=`INSERT INTO ${s}.orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,revision)
 VALUES($1,$2,'fixture-order-agent','fixture-warehouse','accessories','draft',$3,$4,$5)`;
  const orderArgs=(id,number=id)=>[id,number,'{"note":"historical lexical payload","items":[]}',
    '2025-03-30T00:59:59.999Z',7];

  // A foreign default grant must not be erased or silently copied into the plan.
  // The complete attempt is rolled back, including the default privilege change.
  await query('BEGIN');
  try{
    await query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${foreign}`);
    for(const sql of plan.createStatements)await query(sql);
    await query(`INSERT INTO ${s}.order_list_revision VALUES(1,41)`);
    await assert.rejects((async()=>{for(const sql of plan.activateStatements)await query(sql);})(),
      error=>error.code==='42501'&&error.message==='Unexpected default or object order grant');
  }finally{await query('ROLLBACK');}
  assert.equal((await query('SELECT to_regclass($1) AS value',[plan.schema+'.orders'])).rows[0].value,null);
  cases.push('foreign_default_order_grant_rolls_back_entire_plan');

  await query('BEGIN');
  try{
    await query(`CREATE TABLE ${s}.order_payload_archive(id text)`);
    await assert.rejects(query(plan.createStatements[1]),error=>error.code==='23514');
  }finally{await query('ROLLBACK');}
  cases.push('existing_archive_is_refused_without_deleting_it');

  await query('BEGIN');
  try{
    for(const sql of plan.createStatements)await query(sql);
    await query('SAVEPOINT missing_order_generation');
    await assert.rejects(query(plan.activateStatements[0]),error=>error.code==='23514');
    await query('ROLLBACK TO SAVEPOINT missing_order_generation');
    await query('RELEASE SAVEPOINT missing_order_generation');
    await query(addUser);
    await query(addOrder,orderArgs('fixture-order-existing'));
    await query(`INSERT INTO ${s}.serials VALUES('00000000000000000001','fixture-order-existing')`);
    await query(`INSERT INTO ${s}.order_list_revision VALUES(1,41)`);
    for(const sql of plan.activateStatements)await query(sql);
    await query('COMMIT');
  }catch(error){await query('ROLLBACK');throw error;}
  assert.equal(await generation(),41);
  assert.equal(await count(`SELECT revision AS n FROM ${s}.orders WHERE id='fixture-order-existing'`),7);
  assert.equal((await query(`SELECT payload,created_at FROM ${s}.orders WHERE id='fixture-order-existing'`)).rows[0].payload,
    orderArgs('unused')[2]);
  cases.push('missing_generation_prevents_activation','copy_then_activate_preserves_list_row_revision_and_payload');

  const actual=await query(`SELECT c.relname,pg_catalog.pg_get_userbyid(c.relowner) AS owner
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind='r' ORDER BY c.relname`,[plan.schema,plan.tables]);
  assert.deepEqual(actual.rows.map(row=>row.relname),[...plan.tables].sort((left,right)=>left<right?-1:left>right?1:0));
  assert(actual.rows.every(row=>row.owner===plan.roles.owner));
  const triggers=await query(`SELECT t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='orders'
 AND NOT t.tgisinternal ORDER BY t.tgname`,[plan.schema]);
  assert.deepEqual(triggers.rows.map(row=>row.tgname),['order_list_revision_delete','order_list_revision_insert','order_list_revision_update']);
  cases.push('exact_order_ownership_and_three_row_triggers');

  let revision=41;
  const bump=async(id,sql,args=[],increment=1)=>{
    await txn(writer,()=>query(sql,args));revision+=increment;assert.equal(await generation(),revision);cases.push(id);
  };
  await bump('insert_bumps_list_once',addOrder,orderArgs('fixture-order-second'));
  await bump('unchanged_update_bumps_list_once',`UPDATE ${s}.orders SET payload=payload WHERE id='fixture-order-second'`);
  assert.equal(await count(`SELECT revision AS n FROM ${s}.orders WHERE id='fixture-order-second'`),7);
  cases.push('row_revision_has_no_implicit_trigger_increment');
  await bump('explicit_row_revision_increment_is_not_doubled',`UPDATE ${s}.orders SET revision=revision+1 WHERE id='fixture-order-second'`);
  assert.equal(await count(`SELECT revision AS n FROM ${s}.orders WHERE id='fixture-order-second'`),8);
  await bump('two_rows_increment_list_twice',`UPDATE ${s}.orders SET status=status`,[],2);
  await bump('zero_rows_do_not_increment_list',`UPDATE ${s}.orders SET status=status WHERE id='fixture-absent'`,[],0);
  await bump('delete_bumps_list_once',`DELETE FROM ${s}.orders WHERE id='fixture-order-second'`);
  await txn(writer,()=>query(addOrder,orderArgs('fixture-order-rollback')),true);
  assert.equal(await generation(),revision);
  assert.equal(await count(`SELECT count(*) AS n FROM ${s}.orders WHERE id='fixture-order-rollback'`),0);
  cases.push('order_and_list_generation_rollback_atomically');

  const reject=async(id,role,sql,args,code)=>{
    const before=await generation();await assert.rejects(txn(role,()=>query(sql,args)),error=>error.code===code);
    assert.equal(await generation(),before);cases.push(id);
  };
  await reject('duplicate_order_number_does_not_invalidate',writer,addOrder,
    orderArgs('fixture-number-collision','fixture-order-existing'),'23505');
  await reject('unsafe_order_revision_refused',writer,`UPDATE ${s}.orders SET revision=9007199254740991`,[],'23514');
  await reject('zero_order_revision_refused',writer,`UPDATE ${s}.orders SET revision=0`,[],'23514');
  await reject('orphan_order_user_refused',writer,`UPDATE ${s}.orders SET user_id='fixture-missing'`,[],'23503');
  await reject('orphan_serial_refused',writer,`INSERT INTO ${s}.serials VALUES('00000000000000000002','fixture-missing')`,[],'23503');
  await reject('serial_reference_does_not_cascade',writer,`DELETE FROM ${s}.orders WHERE id='fixture-order-existing'`,[],'23503');
  await reject('reader_cannot_write_orders',reader,`UPDATE ${s}.orders SET payload=payload`,[],'42501');
  await reject('writer_cannot_truncate_orders',writer,`TRUNCATE ${s}.orders`,[],'42501');
  await reject('writer_cannot_delete_list_generation',writer,`DELETE FROM ${s}.order_list_revision`,[],'42501');
  await reject('writer_cannot_change_generation_identity',writer,`UPDATE ${s}.order_list_revision SET id=id`,[],'42501');

  await txn(writer,()=>query(`INSERT INTO ${s}.order_limit_approvals(id,order_id,order_revision,agent_id,agent_revision,
 warehouse_id,manager_ids,input_key,sales_version,mapping_version,policy_version,catalog_version,violations,status,created_at,updated_at)
 VALUES('fixture-approval','fixture-order-existing',7,'fixture-order-agent',1,'fixture-warehouse','[]','fixture-input',
 'v1','v1','v1','v1','[]','approved','historical-created','historical-updated')`));
  assert.equal(await generation(),revision);cases.push('approval_write_does_not_change_order_list_generation');
  await reject('approval_status_constraint_preserved',writer,`UPDATE ${s}.order_limit_approvals SET status='unknown'`,[],'23514');
  await reject('approval_history_prevents_physical_order_delete',writer,
    `DELETE FROM ${s}.serials; DELETE FROM ${s}.orders WHERE id='fixture-order-existing'`,[],'23503');
  assert.equal(await count(`SELECT count(*) AS n FROM ${s}.serials`),1);
  await txn(reader,async()=>assert.equal(await count(`SELECT count(*) AS n FROM ${s}.orders`),1));
  cases.push('reader_can_read_without_generation_function');
  assert.equal((await query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',
    [plan.roles.reader,s+'.orders_bump_list_revision()'])).rows[0].allowed,false);
  await query('BEGIN');
  try{
    await query('SET LOCAL ROLE '+owner);await query(`DELETE FROM ${s}.order_list_revision`);
    await query('SET LOCAL ROLE '+writer);
    await assert.rejects(query(addOrder,orderArgs('fixture-missing-generation')),error=>error.code==='23514');
  }finally{await query('ROLLBACK');}
  assert.equal(await generation(),revision);cases.push('missing_generation_rolls_back_business_write');
  return {kind:'postgres-order-schema-contract',passed:true,case_count:cases.length,case_ids:cases,
    roles_created:false,schema_retained_for_caller_cleanup:true,runtime_wired:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {build}=await import('esbuild');mkdirSync('work',{recursive:true});
  const folder=mkdtempSync(resolve('work/order-schema-'));
  try{
    const moduleFile=join(folder,'schema.mjs');
    await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/postgres-authority-schema'; export * from './lib/postgres-order-schema';",
      loader:'ts',resolveDir:resolve('.')},outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
    const cases=checkPostgresOrderSchemaBuilder(await import(pathToFileURL(moduleFile)));
    console.log(JSON.stringify({kind:'postgres-order-schema-builder',passed:true,case_count:cases.length,
      case_ids:cases,postgresql_executed:false,runtime_wired:false}));
  }finally{rmSync(folder,{recursive:true,force:true});}
}
