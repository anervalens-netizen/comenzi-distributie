// Explicitly marked, fresh PostgreSQL fixture. The external laboratory owns
// resources, namespaces, process lifetime, raw logs and final cleanup evidence.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {Pool} from 'pg';
import {runCatalogCustomerContract,runCustomerMembershipOracle} from './catalog-customer-contract.mjs';
import {runUserClientCountsContract,runCustomerCountCastOracle} from './user-client-counts-contract.mjs';
import {runSettingsContract} from './settings-contract.mjs';
import {prepareReadSettingsOracles,independentAdapterCommit} from './read-settings-oracles.mjs';

const target=process.env.COMENZI_PG_TEST_DATABASE,urlText=process.env.COMENZI_PG_TEST_URL;
assert(target&&/^comenzi_read_settings_fixture_[a-z0-9]{8,24}$/.test(target),'Explicit disposable read/settings database required');
assert(urlText,'Explicit fixture URL required; no ambient PostgreSQL fallback');
const url=new URL(urlText);
assert(['postgres:','postgresql:'].includes(url.protocol)&&decodeURIComponent(url.pathname.slice(1))===target);
assert([...url.searchParams.keys()].every(key=>key==='sslmode'||key==='host'));
assert(url.hostname==='localhost'&&url.searchParams.has('host')&&url.searchParams.get('host').startsWith('/'),
  'An explicitly isolated Unix socket is required');
const errors=[],cleanupErrors=[],createdRoles=[],createdSchemas=[];
const bootstrap=new Pool({connectionString:urlText,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,
  application_name:'comenzi-read-settings-fixture-bootstrap'});
bootstrap.on('error',error=>errors.push(error.message));
const suffix=randomBytes(6).toString('hex'),names={app:'fixture_read_settings_'+suffix,owner:'fixture_owner_'+suffix,
  reader:'fixture_reader_'+suffix,writer:'fixture_writer_'+suffix};
const quote=value=>'"'+value+'"',password=randomBytes(24).toString('hex');
let client,folder,database,other,setupDatabase,native,receipt,primaryError;
// Identical fictional activation policy to the original user/count runner.
const activationKeys=['MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID','MOBIUP_ACTIVATIONS_PILOT_AGENT_ID',
  'MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS'];
const previousActivation=new Map(activationKeys.map(key=>[key,process.env[key]]));
for(const [index,value]of ['fixture-global','fixture-a','','fixture-inactive'].entries())process.env[activationKeys[index]]=value;

try{
  client=await bootstrap.connect();
  const identity=(await client.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('server_version_num')::integer AS version,pg_is_in_recovery() AS recovery,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert(identity.database===target&&identity.version>=190000&&identity.version<200000&&identity.recovery===false);
  assert.equal(identity.marker,'comenzi async read settings isolated fixture v1');
  assert.equal((await client.query(`SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')`)).rows[0].n,0);
  assert.deepEqual((await client.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[names.app])).rows,[]);
  assert.deepEqual((await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[Object.values(names).slice(1)])).rows,[]);
  mkdirSync('work',{recursive:true});folder=mkdtempSync(resolve('work/read-settings-postgres-'));
  const moduleFile=join(folder,'read-settings.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database';export * from './lib/sql-postgres';"
    +"export * from './lib/session-repository-async';export * from './lib/authority-repository-async';"
    +"export * from './lib/catalog-customer-repository-async';export * from './lib/user-read-repository-async';"
    +"export * from './lib/settings-repository-async';export * from './lib/customer-membership-json';"
    +"export * from './lib/postgres-authority-schema';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),app=quote(names.app);
  for(const role of [names.owner,names.reader,names.writer]){
    const login=role!==names.owner;
    await client.query('CREATE ROLE '+quote(role)+(login?" LOGIN PASSWORD '"+password+"'":' NOLOGIN')
      +' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');createdRoles.push(role);
  }
  const authority=api.postgresAuthoritySchema({schema:names.app,ownerRole:names.owner,readerRole:names.reader,writerRole:names.writer});
  createdSchemas.push(names.app);
  await client.query('BEGIN');
  try{
    for(const sql of authority.createStatements)await client.query(sql);
    await client.query('INSERT INTO '+app+'.portfolio_revision(id,data_revision,scope_revision) VALUES(1,11,23)');
    for(const sql of authority.activateStatements)await client.query(sql);
    // Exact observed four-column customer contract. The production import/
    // projection triggers and JSON1 expression index are deliberately NOT
    // activated by this READ qualification. This is not a migration builder.
    await client.query('CREATE TABLE '+app+'.customers(id TEXT COLLATE "C" PRIMARY KEY,warehouse_id TEXT COLLATE "C" NOT NULL,'
      +'data TEXT COLLATE "C" NOT NULL,active INTEGER NOT NULL DEFAULT 1)');
    await client.query('CREATE INDEX idx_customers_warehouse ON '+app+'.customers(warehouse_id)');
    await client.query('ALTER TABLE '+app+'.customers OWNER TO '+quote(names.owner));
    await client.query('REVOKE ALL ON '+app+'.customers FROM PUBLIC,'+quote(names.reader)+','+quote(names.writer));
    await client.query('GRANT SELECT ON '+app+'.customers TO '+quote(names.reader)+','+quote(names.writer));
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  const columns=(await client.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression,c.collname AS collation FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation c ON c.oid=a.attcollation
    WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[names.app+'.customers'])).rows;
  assert.deepEqual(columns,[
    {name:'id',type:'text',not_null:true,default_expression:null,collation:'C'},
    {name:'warehouse_id',type:'text',not_null:true,default_expression:null,collation:'C'},
    {name:'data',type:'text',not_null:true,default_expression:null,collation:'C'},
    {name:'active',type:'integer',not_null:true,default_expression:'1',collation:null},
  ]);
  const customerTriggers=(await client.query('SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal',
    [names.app+'.customers'])).rows;assert.deepEqual(customerTriggers,[]);
  const customerAcl=(await client.query(`SELECT grantee::regrole::text AS grantee,privilege_type,is_grantable
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.oid=$1::regclass
    ORDER BY grantee::regrole::text COLLATE "C",privilege_type COLLATE "C"`,[names.app+'.customers'])).rows;
  assert(customerAcl.length>0);
  assert(customerAcl.every(row=>row.grantee===names.owner||[names.reader,names.writer].includes(row.grantee)
    &&row.privilege_type==='SELECT'&&row.is_grantable===false));
  for(const role of [names.reader,names.writer]){
    const privileges=(await client.query(`SELECT has_table_privilege($1,$2,'SELECT') AS select_customer,
      has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS mutate_customer,
      has_any_column_privilege($1,$2,'INSERT,UPDATE,REFERENCES') AS mutate_customer_column,
      has_schema_privilege($1,$3,'CREATE') AS create_application,
      has_database_privilege($1,current_database(),'CREATE') AS create_database,
      has_schema_privilege($1,'public','CREATE') AS create_public`,[role,names.app+'.customers',names.app])).rows[0];
    assert.deepEqual(privileges,{select_customer:true,mutate_customer:false,mutate_customer_column:false,
      create_application:false,create_database:false,create_public:false});
    const roleUrl=new URL(url);roleUrl.username=role;roleUrl.password=password;
    const positive=new Pool({connectionString:roleUrl.toString(),max:1,connectionTimeoutMillis:3000});
    try{assert.equal((await positive.query('SELECT current_user AS role')).rows[0].role,role);}finally{await positive.end();}
    roleUrl.password='incorrect-'+password;
    const negative=new Pool({connectionString:roleUrl.toString(),max:1,connectionTimeoutMillis:3000});
    try{await assert.rejects(negative.query('SELECT current_user'),error=>error.code==='28P01');}finally{await negative.end();}
  }
  const runtimeUrl=new URL(url);runtimeUrl.username=names.writer;runtimeUrl.password=password;
  const config={connectionString:runtimeUrl.toString(),expectedDatabase:target,maxConnections:2,lockTimeoutMs:1000,
    statementTimeoutMs:3000,onIdleConnectionError:error=>errors.push(error.message)};
  database=new api.PostgresDatabase(config);other=new api.PostgresDatabase(config);
  setupDatabase=new api.PostgresDatabase({...config,connectionString:urlText});
  const identitySql=`SELECT current_user AS role,session_user AS session_role,
    current_setting('role') AS role_setting,current_setting('transaction_read_only') AS readonly,
    current_setting('transaction_isolation') AS isolation,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user`;
  const identityQuery=api.sqlQuery('read',identitySql,identitySql);
  const runtimeIdentity=(await database.read(tx=>tx.query(identityQuery))).rows[0];
  assert.deepEqual(runtimeIdentity,{role:names.writer,session_role:names.writer,role_setting:'none',readonly:'on',
    isolation:'repeatable read',superuser:false});
  const negativeMutations=['INSERT INTO '+app+".customers VALUES('forbidden','fictional','{}',1)",
    'UPDATE '+app+'.customers SET active=0','DELETE FROM '+app+'.customers'];
  for(const sql of negativeMutations)await assert.rejects(database.write(tx=>tx.query(api.sqlQuery('write',sql,sql))),error=>error.code==='42501');
  const oracles=await prepareReadSettingsOracles({api,database,applicationSchema:names.app,folder});
  const independent={catalog:0,users:0,settings:0};let composableIdentity;
  const commit=async(group,connectionString,statements)=>{
    const result=await independentAdapterCommit(moduleFile,connectionString,target,statements);
    assert.equal(result.committed,true);independent[group]++;return result;
  };
  const catalogCases=await runCatalogCustomerContract(api,{database,other,setupDatabase,applicationSchema:names.app,
    legacyOracle:oracles.catalog,concurrentWrite:(query,values)=>commit('catalog',urlText,[{query,values}])});
  assert.equal(catalogCases.length,82);
  const userCases=await runUserClientCountsContract(api,{database,other,setupDatabase,applicationSchema:names.app,
    legacyOracle:oracles.users,concurrentWrite:(query,values)=>commit('users',urlText,[{query,values}]),
    composableSeedIdentity:async tx=>{
      assert.equal(composableIdentity,undefined);composableIdentity=(await tx.query(identityQuery)).rows[0];
      assert.deepEqual(composableIdentity,{role:identity.role,session_role:identity.role,role_setting:'none',readonly:'off',
        isolation:'read committed',superuser:true});
    }});
  assert.equal(userCases.length,42);
  const settingsCases=await runSettingsContract(api,{database,other,applicationSchema:names.app,legacyOracle:oracles.settings,
    concurrentWrite:statements=>commit('settings',runtimeUrl.toString(),statements)});
  assert.equal(settingsCases.length,154);
  assert.deepEqual(independent,{catalog:5,users:8,settings:3});
  assert.deepEqual(oracles.counts,{catalog:16,users:6,settings:108,settings_writes:61,snapshots:130});
  native=new DatabaseSync(':memory:');
  const membershipStatement=native.prepare("SELECT value FROM json_each(COALESCE(json_extract(?,'$.warehouseIds'),json_array(?)))");
  membershipStatement.setReadBigInts(true);
  const membershipCases=runCustomerMembershipOracle(api,(raw,fallback)=>membershipStatement.all(raw,fallback).map(row=>row.value));
  const castStatement=native.prepare("SELECT CAST(value AS TEXT) AS value FROM json_each(COALESCE(json_extract(?,'$.warehouseIds'),json_array(?)))");
  const castCases=runCustomerCountCastOracle(api,(raw,fallback)=>castStatement.all(raw,fallback).map(row=>row.value));
  assert.equal(membershipCases.length,41);assert.equal(castCases.length,63);
  const generation=(await client.query('SELECT data_revision,scope_revision FROM '+app+'.portfolio_revision WHERE id=1')).rows;
  assert.equal(generation.length,1);assert.equal(api.safeSqlInteger(generation[0].data_revision),11);
  assert(api.safeSqlInteger(generation[0].scope_revision)>23);
  assert.deepEqual((await database.read(tx=>tx.query(identityQuery))).rows[0],runtimeIdentity);
  assert.deepEqual(errors,[]);
  const integrationCases=['real_authority_schema_and_exact_customer_column_contract','customer_select_only_acl_and_three_write_denials',
    'positive_and_negative_reader_writer_authentication','runtime_role_and_repeatable_read_snapshot',
    'original_oracles_use_coherent_postgres_snapshot','independent_adapter_commits_during_read_snapshot',
    'composable_customer_mutation_uses_explicit_privileged_fixture_identity','data_generation_preserved'];
  const caseIds=[...catalogCases.map(id=>'catalog:'+id),...userCases.map(id=>'users:'+id),...settingsCases.map(id=>'settings:'+id),
    ...integrationCases.map(id=>'integration:'+id)];assert.equal(new Set(caseIds).size,caseIds.length);
  receipt={kind:'async-read-settings-postgresql-fixture',passed:true,engine:'postgresql',server_version_num:identity.version,
    case_count:caseIds.length,case_ids:caseIds,catalog_case_ids:catalogCases,user_case_ids:userCases,settings_case_ids:settingsCases,
    integration_case_ids:integrationCases,fixture_names:names,real_authority_schema:true,customer_columns:columns,
    customer_triggers:customerTriggers,customer_acl:customerAcl,customer_storage_scope:'read fixture; exact columns; customer writers and 13 production triggers unqualified',
    application_customer_mutation_allowed:false,composable_fixture_identity:composableIdentity,runtime_identity:runtimeIdentity,
    runtime_superuser:false,oracle_counts:oracles.counts,original_source_sha256:oracles.source_sha256,
    original_oracle_compiled_sha256:oracles.compiled_sha256,independent_commits:independent,
    native_oracle:{engine:'sqlite',version:process.versions.sqlite,membership_case_ids:membershipCases,cast_case_ids:castCases,
      matching_membership_cases:membershipCases.filter(id=>id.startsWith('native_json1_')).length,
      membership_ineligibility_witnesses:membershipCases.filter(id=>id.startsWith('unported_')).length,
      strict_membership_eligibility_cases:membershipCases.filter(id=>id.startsWith('strict_snapshot_')).length,
      matching_cast_cases:castCases.filter(id=>id.startsWith('native_cast_text:')).length,
      real_cast_ineligibility_witnesses:castCases.filter(id=>id.startsWith('unported_real_')).length,
      shared_cast_refusal_cases:castCases.filter(id=>id.startsWith('shared_')).length},
    synthetic_only:true,production_runtime_switched:false,messages_sent:false};
}catch(error){primaryError=error;}
finally{
  for(const db of [database,other,setupDatabase])try{await db?.close();}catch(error){cleanupErrors.push(error.message);}
  try{native?.close();}catch(error){cleanupErrors.push(error.message);}
  if(client){
    try{await client.query('ROLLBACK');}catch(error){cleanupErrors.push(error.message);}
    for(const schema of createdSchemas.reverse())try{await client.query('DROP SCHEMA IF EXISTS '+quote(schema)+' CASCADE');}
    catch(error){cleanupErrors.push(error.message);}
    for(const role of createdRoles.reverse())try{await client.query('DROP ROLE '+quote(role));}
    catch(error){cleanupErrors.push(error.message);}
    if(!cleanupErrors.length)try{
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=$1',[names.app])).rows[0].n,0);
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_roles WHERE rolname=ANY($1::text[])',
        [Object.values(names).slice(1)])).rows[0].n,0);
    }catch(error){cleanupErrors.push(error.message);}
    client.release();
  }
  try{await bootstrap.end();}catch(error){cleanupErrors.push(error.message);}
  if(folder)rmSync(folder,{recursive:true,force:true});
  for(const [key,value]of previousActivation)if(value===undefined)delete process.env[key];else process.env[key]=value;
}
if(primaryError||cleanupErrors.length||errors.length){
  console.error(JSON.stringify({kind:'async-read-settings-postgresql-fixture',passed:false,
    error:primaryError?.message??'Cleanup or observer failed',cleanup_errors:cleanupErrors,pool_errors:errors}));process.exitCode=1;
}else console.log(JSON.stringify({...receipt,cleanup_passed:true}));
