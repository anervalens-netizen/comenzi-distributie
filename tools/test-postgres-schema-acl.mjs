// Synthetic ACL contracts. Importing this module never opens a DB connection.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const ACL_BASELINE = Object.freeze({
  commit:'ebf3f6aca3471c710ea51531f9b0cb56eea959cf',
  authority:'0849ba07cd429e888246446d7a43507f3384f17652d9dd615de30b2c21caae8f',
  orders:'12a29e1da6935a4b304e79f82060dbc1e6228e2beae88fd36e4033ff0a0d3e1b',
});
const hash=value=>createHash('sha256').update(value).digest('hex');
const jsonHash=value=>hash(JSON.stringify(value));
const defaultNames=()=>({schema:'fixture_acl',ownerRole:'fixture_acl_owner',
  readerRole:'fixture_acl_reader',writerRole:'fixture_acl_writer'});

function plans(api,names){
  return {authority:api.postgresAuthoritySchema(names),
    orders:api.postgresOrderSchema({...names,payloadArchive:'absent'})};
}

/** Compare real generated plans. Only the final ACL gate may change. */
export function assertAclSourceEquivalence(api,baselineApi,names=defaultNames()){
  const current=plans(api,names),old=plans(baselineApi,names),result={};
  for(const kind of ['authority','orders']){
    const value=current[kind],prior=old[kind];
    for(const key of ['version','schema','roles','tables','createStatements'])assert.deepEqual(value[key],prior[key]);
    assert.deepEqual(value.activateStatements.slice(0,-1),prior.activateStatements.slice(0,-1));
    const gate=value.activateStatements.at(-1),oldGate=prior.activateStatements.at(-1);
    assert(gate.startsWith('DO $'+(kind==='authority'?'authority':'orders')+'_acl$'));
    assert.notEqual(gate,oldGate,'The exact legacy gate must be supplied independently');
    assert(gate.includes('EXCEPT ALL')&&gate.includes('x.grantor')&&gate.includes('x.is_grantable'));
    result[kind]={create_sha256:jsonHash(value.createStatements),
      activation_without_acl_sha256:jsonHash(value.activateStatements.slice(0,-1)),
      legacy_acl_sha256:hash(oldGate),candidate_acl_sha256:hash(gate)};
  }
  return result;
}

function injections(api,names){
  const s=api.sqlIdentifier(names.schema),reader=api.sqlIdentifier(names.readerRole);
  const writer=api.sqlIdentifier(names.writerRole),foreign=api.sqlIdentifier(names.foreignRole);
  const result=[];
  for(const [scope,table,metadata,columns,fn] of [
    ['authority','users','portfolio_revision',['data_revision','scope_revision'],'authority_bump_scope'],
    ['orders','orders','order_list_revision',['revision'],'orders_bump_list_revision'],
  ]){
    const normal=s+'.'+api.sqlIdentifier(table),meta=s+'.'+api.sqlIdentifier(metadata);
    const add=(name,sql,legacyAccepted=true)=>result.push({id:scope+'_'+name,scope,sql,legacyAccepted});
    add('writer_column_references',`GRANT REFERENCES(id) ON ${normal} TO ${writer}`);
    add('writer_table_maintain',`GRANT MAINTAIN ON ${normal} TO ${writer}`);
    add('reader_table_maintain',`GRANT MAINTAIN ON ${normal} TO ${reader}`);
    add('writer_table_select_grant_option',`GRANT SELECT ON ${normal} TO ${writer} WITH GRANT OPTION`);
    add('reader_table_select_grant_option',`GRANT SELECT ON ${normal} TO ${reader} WITH GRANT OPTION`);
    add('writer_table_update_grant_option',`GRANT UPDATE ON ${normal} TO ${writer} WITH GRANT OPTION`);
    add('writer_column_update_grant_option',`GRANT UPDATE(id) ON ${normal} TO ${writer} WITH GRANT OPTION`);
    add('reader_column_select_grant_option',`GRANT SELECT(id) ON ${normal} TO ${reader} WITH GRANT OPTION`);
    add('redundant_writer_column_update',`GRANT UPDATE(id) ON ${normal} TO ${writer}`);
    add('redundant_reader_column_select',`GRANT SELECT(id) ON ${normal} TO ${reader}`);
    add('metadata_column_references',`GRANT REFERENCES(id) ON ${meta} TO ${writer}`);
    add('metadata_table_maintain',`GRANT MAINTAIN ON ${meta} TO ${writer}`);
    for(const column of columns)add('metadata_'+column+'_grant_option',
      `GRANT UPDATE(${api.sqlIdentifier(column)}) ON ${meta} TO ${writer} WITH GRANT OPTION`);
    add('function_execute_grant_option',`GRANT EXECUTE ON FUNCTION ${s}.${api.sqlIdentifier(fn)}() TO ${writer} WITH GRANT OPTION`);
    add('foreign_column_select',`GRANT SELECT(id) ON ${normal} TO ${foreign}`,false);
    add('reader_function_execute',`GRANT EXECUTE ON FUNCTION ${s}.${api.sqlIdentifier(fn)}() TO ${reader}`,false);
    add('missing_reader_select',`REVOKE SELECT ON ${normal} FROM ${reader}`,false);
    add('missing_writer_delete',`REVOKE DELETE ON ${normal} FROM ${writer}`,false);
  }
  for(const [label,role] of [['reader',reader],['writer',writer]])result.push({
    id:'authority_schema_usage_'+label+'_grant_option',scope:'authority',
    sql:`GRANT USAGE ON SCHEMA ${s} TO ${role} WITH GRANT OPTION`,legacyAccepted:true});
  result.push({id:'authority_schema_create_writer',scope:'authority',
    sql:`GRANT CREATE ON SCHEMA ${s} TO ${writer}`,legacyAccepted:false});
  return result;
}

export function checkSchemaAclBuilder(api,baselineApi){
  const names=defaultNames(),cases=[];
  assertAclSourceEquivalence(api,baselineApi,names);
  cases.push('only_final_acl_gates_differ_from_exact_legacy_plans');
  const probes=injections(api,{...names,foreignRole:'fixture_acl_foreign'});
  assert.equal(probes.length,40);assert.equal(new Set(probes.map(p=>p.id)).size,40);
  assert.equal(probes.filter(p=>p.legacyAccepted).length,31);
  cases.push('independent_grant_matrix_has_unique_object_and_privilege_cases');
  const wrong={...baselineApi,postgresAuthoritySchema:api.postgresAuthoritySchema};
  assert.throws(()=>assertAclSourceEquivalence(api,wrong,names),/legacy gate/);
  const altered={...api,postgresOrderSchema:options=>{
    const plan=api.postgresOrderSchema(options);
    return {...plan,createStatements:[...plan.createStatements,'SELECT 1']};
  }};
  assert.throws(()=>assertAclSourceEquivalence(altered,baselineApi,names));
  cases.push('source_equivalence_rejects_new_gate_as_baseline_or_changed_ddl');
  return {passed:true,case_count:cases.length,case_ids:cases,
    postgresql_executed:false,planned_negative_pg_cases:probes.length,planned_legacy_witnesses:31};
}

/**
 * The caller supplies an idle bootstrap client to an independently attested,
 * disposable DB and four existing fictional roles. No connection, role or DB is
 * created here. Baseline API must be built from the pinned source above. The
 * schema is exclusive and retained for the caller's exact-ownership cleanup.
 */
export async function runPostgresSchemaAclContract(api,options){
  const {client,baselineApi,isolatedMutation,expectedDatabase,expectedBootstrapRole,
    expectedServerVersionNum,foreignRole,...names}=options;
  assert.equal(isolatedMutation,true);
  api.sqlIdentifier(expectedDatabase);api.sqlIdentifier(expectedBootstrapRole);api.sqlIdentifier(foreignRole);
  assert(!Object.values(names).includes(foreignRole));
  assert(Number.isSafeInteger(expectedServerVersionNum)&&expectedServerVersionNum>=180000&&expectedServerVersionNum<200000);
  const query=(sql,args=[])=>client.query(sql,args);
  const identity=(await query(`SELECT current_database() AS database,current_user AS role,
 session_user AS session_role,(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser,
 current_setting('server_version_num')::integer AS version_num`)).rows[0];
  assert.deepEqual(identity,{database:expectedDatabase,role:expectedBootstrapRole,
    session_role:expectedBootstrapRole,superuser:true,version_num:expectedServerVersionNum});
  const equivalence=assertAclSourceEquivalence(api,baselineApi,names);
  const current=plans(api,names),legacy=plans(baselineApi,names),s=api.sqlIdentifier(names.schema);
  assert.equal((await query('SELECT pg_catalog.to_regnamespace($1) AS present',[names.schema])).rows[0].present,null);
  assert.equal((await query('SELECT count(*)::integer AS n FROM pg_catalog.pg_roles WHERE rolname=$1',[foreignRole])).rows[0].n,1);
  const allTables=[...current.authority.tables,...current.orders.tables];
  const guards=async()=>{
    await query(current.authority.createStatements[0]);
    for(const value of Object.values(current))await query(value.activateStatements.at(-1));
  };
  const snapshot=async()=>{
    const objects=(await query(`SELECT 'schema'::text AS kind,n.nspname::text AS object_name,''::text AS subobject,
 n.nspowner::text AS owner,n.nspacl::text AS acl FROM pg_catalog.pg_namespace n WHERE n.nspname=$1
 UNION ALL SELECT 'table',c.relname::text,'',c.relowner::text,c.relacl::text
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[])
 UNION ALL SELECT 'column',c.relname::text,a.attname::text,c.relowner::text,a.attacl::text
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'function',p.proname::text,pg_catalog.pg_get_function_identity_arguments(p.oid),p.proowner::text,p.proacl::text
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname=$1 AND p.proname IN ('authority_bump_scope','orders_bump_list_revision')
 ORDER BY kind,object_name,subobject`,[names.schema,allTables])).rows;
    const generations={portfolio:(await query(`SELECT * FROM ${s}.portfolio_revision ORDER BY id`)).rows,
      orders:(await query(`SELECT * FROM ${s}.order_list_revision ORDER BY id`)).rows};
    const counts=[];
    for(const name of allTables)counts.push([name,(await query('SELECT count(*)::text AS n FROM '+s+'.'+api.sqlIdentifier(name))).rows[0].n]);
    return {objects,generations,counts};
  };
  await query('BEGIN');
  try{
    for(const value of Object.values(current))for(const sql of value.createStatements)await query(sql);
    await query(`INSERT INTO ${s}.portfolio_revision VALUES(1,11,23)`);
    await query(`INSERT INTO ${s}.order_list_revision VALUES(1,41)`);
    for(const value of Object.values(current))for(const sql of value.activateStatements)await query(sql);
    await query('COMMIT');
  }catch(error){await query('ROLLBACK');throw error;}
  await guards();
  const before=await snapshot(),receipts=[];
  for(const probe of injections(api,{...names,foreignRole})){
    await query('BEGIN');
    let injected;
    try{
      await query('SET LOCAL ROLE '+api.sqlIdentifier(names.ownerRole));
      await query(probe.sql);await query('RESET ROLE');
      injected=await snapshot();assert.notDeepEqual(injected.objects,before.objects,'Injection must change the native ACL');
      assert.deepEqual(injected.generations,before.generations);assert.deepEqual(injected.counts,before.counts);
      if(probe.legacyAccepted)await query(legacy[probe.scope].activateStatements.at(-1));
      await assert.rejects(query(current[probe.scope].activateStatements.at(-1)),error=>
        error.code==='42501'&&error.message==='Unexpected default or object '+(probe.scope==='authority'?'authority':'order')+' grant');
    }finally{await query('ROLLBACK');}
    const restored=await snapshot();assert.deepEqual(restored,before,'Full native ACL and metadata must survive rollback unchanged');
    await guards();
    receipts.push({id:probe.id,passed:true,legacy_acceptance_tested:probe.legacyAccepted,
      legacy_accepted:probe.legacyAccepted?true:null,
      injected_acl_sha256:jsonHash(injected.objects),restored_snapshot_sha256:jsonHash(restored),
      sqlstate:'42501',rollback_verified:true,clean_gates_revalidated:true});
  }
  return {kind:'postgres-authority-order-acl-contract',passed:true,case_count:receipts.length,
    case_ids:receipts.map(p=>p.id),cases:receipts,legacy_witness_count:receipts.filter(p=>p.legacy_accepted).length,
    baseline_source:ACL_BASELINE,equivalence,identity,original_snapshot_sha256:jsonHash(before),
    schema_retained_for_caller_cleanup:true,runtime_wired:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {build}=await import('esbuild');mkdirSync('work',{recursive:true});
  const folder=mkdtempSync(resolve('work/schema-acl-'));
  try{
    const baseline=join(folder,'baseline');mkdirSync(baseline);
    for(const name of ['sql-database.ts','postgres-authority-schema.ts','postgres-order-schema.ts']){
      const bytes=execFileSync('git',['show',ACL_BASELINE.commit+':lib/'+name],{maxBuffer:1024*1024});
      const expected=name==='postgres-authority-schema.ts'?ACL_BASELINE.authority:
        name==='postgres-order-schema.ts'?ACL_BASELINE.orders:null;
      if(expected)assert.equal(hash(bytes),expected);else assert.equal(hash(bytes),hash(readFileSync('lib/'+name)));
      writeFileSync(join(baseline,name),bytes,{flag:'wx'});
    }
    const moduleFiles=[];
    for(const [label,dir] of [['current',resolve('lib')],['baseline',baseline]]){
      const target=join(folder,label+'.mjs');
      await build({stdin:{contents:"export * from './sql-database'; export * from './postgres-authority-schema'; export * from './postgres-order-schema';",
        loader:'ts',resolveDir:dir},outfile:target,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
      moduleFiles.push(target);
    }
    console.log(JSON.stringify(checkSchemaAclBuilder(await import(pathToFileURL(moduleFiles[0])),await import(pathToFileURL(moduleFiles[1])))));
  }finally{rmSync(folder,{recursive:true,force:true});}
}
