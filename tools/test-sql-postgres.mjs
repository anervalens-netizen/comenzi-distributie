// Explicit, disposable PostgreSQL fixture only. The caller owns lab isolation/resources.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {runImportContract} from './sql-adapter-contract.mjs';

const target=process.env.COMENZI_PG_TEST_DATABASE;
const urlText=process.env.COMENZI_PG_TEST_URL;
assert(target&&/^comenzi_adapter_fixture_[a-z0-9_]{1,30}$/.test(target),'Explicit disposable fixture database name required');
assert(urlText,'Explicit fixture URL required; no ambient PG fallback');
const url=new URL(urlText);
assert(['postgres:','postgresql:'].includes(url.protocol)&&decodeURIComponent(url.pathname.slice(1))===target,
  'Fixture URL must name the explicit disposable database');
assert([...url.searchParams.keys()].every(key=>key==='sslmode'||key==='host'),'Fixture URL cannot override account/database through query parameters');
if(url.searchParams.has('host'))assert(url.searchParams.get('host').startsWith('/'),'Explicit host query parameter is reserved for a Unix socket directory');
const bootstrap=new Pool({connectionString:urlText,max:1,connectionTimeoutMillis:3000,
  statement_timeout:5000,application_name:'comenzi-synthetic-fixture-bootstrap'});
const poolErrors=[];bootstrap.on('error',error=>poolErrors.push(error.message));
const suffix=randomBytes(6).toString('hex');
const names={app:'fixture_app_'+suffix,ledger:'fixture_ledger_'+suffix,
  appOwner:'fixture_app_owner_'+suffix,ledgerOwner:'fixture_ledger_owner_'+suffix,runtime:'fixture_runtime_'+suffix};
const quote=name=>'"'+name+'"';
const password=randomBytes(24).toString('hex');
const createdRoles=[],createdSchemas=[];
let folder,database,other,timed,alias,receipt,primaryError;
const cleanupErrors=[];
try {
  const identity=(await bootstrap.query(`SELECT current_database() AS database, current_setting('server_version_num')::integer AS version,
    pg_is_in_recovery() AS recovery,shobj_description(oid,'pg_database') AS fixture_marker
    FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert(identity.database===target&&identity.version>=180000&&identity.version<200000&&identity.recovery===false);
  assert.equal(identity.fixture_marker,'comenzi async adapter isolated fixture v1',
    'The lab owner must independently mark the fresh disposable database');
  const applicationRelations=(await bootstrap.query("SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')")).rows[0].n;
  assert.equal(applicationRelations,0,'Fixture database must have no existing application relations');
  for(const role of [names.appOwner,names.ledgerOwner,names.runtime]){
    await bootstrap.query('CREATE ROLE '+quote(role)+(role===names.runtime?" LOGIN PASSWORD '"+password+"'":' NOLOGIN')
      +' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    createdRoles.push(role);
  }
  for(const [schema,owner]of [[names.app,names.appOwner],[names.ledger,names.ledgerOwner]]){
    await bootstrap.query('CREATE SCHEMA '+quote(schema)+' AUTHORIZATION '+quote(owner));createdSchemas.push(schema);
  }
  const app=quote(names.app),ledger=quote(names.ledger);
  const tables=[
    [names.app,'users','id TEXT PRIMARY KEY,role TEXT,active INTEGER,must_change_password INTEGER,profile_revision BIGINT,manager_scope TEXT',names.appOwner],
    [names.app,'sessions','token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES '+app+'.users(id),expires_at BIGINT',names.appOwner],
    [names.app,'settings','key TEXT PRIMARY KEY,value TEXT',names.appOwner],
    [names.ledger,'imports','id TEXT PRIMARY KEY,amount_cents BIGINT,label TEXT',names.ledgerOwner],
    [names.ledger,'deferred_keys','id TEXT, CONSTRAINT fixture_deferred_key UNIQUE(id) DEFERRABLE INITIALLY DEFERRED',names.ledgerOwner],
  ];
  for(const [schema,table,columns,owner]of tables){
    const qualified=quote(schema)+'.'+quote(table);
    await bootstrap.query('CREATE TABLE '+qualified+'('+columns+')');
    await bootstrap.query('ALTER TABLE '+qualified+' OWNER TO '+quote(owner));
    await bootstrap.query('GRANT SELECT,INSERT,UPDATE,DELETE ON '+qualified+' TO '+quote(names.runtime));
  }
  for(const schema of [names.app,names.ledger])await bootstrap.query('GRANT USAGE ON SCHEMA '+quote(schema)+' TO '+quote(names.runtime));
  const acl=(await bootstrap.query(`SELECT
    has_table_privilege($1,$2,'UPDATE') AS application_owner_other_ledger,
    has_table_privilege($3,$4,'UPDATE') AS ledger_owner_application,
    has_database_privilege($5,current_database(),'CREATE') AS runtime_create_schema,
    has_schema_privilege($5,'public','CREATE') AS runtime_create_public`,
    [names.appOwner,names.ledger+'.imports',names.ledgerOwner,names.app+'.users',names.runtime])).rows[0];
  assert.deepEqual(acl,{application_owner_other_ledger:false,ledger_owner_application:false,
    runtime_create_schema:false,runtime_create_public:false});
  const owners=(await bootstrap.query(`SELECT n.nspname,c.relname,pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind='r' ORDER BY n.nspname,c.relname`,[[names.app,names.ledger]])).rows;
  assert.equal(owners.length,5);
  assert(owners.every(row=>row.owner===(row.nspname===names.app?names.appOwner:names.ledgerOwner)));

  mkdirSync('work',{recursive:true});folder=mkdtempSync(resolve('work/sql-postgres-fixture-'));
  const moduleFile=join(folder,'adapter.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-postgres'; export * from './lib/import-write-authorization-async';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile));
  const runtimeUrl=new URL(url);runtimeUrl.username=names.runtime;runtimeUrl.password=password;
  const positive=new Pool({connectionString:runtimeUrl.toString(),max:1,connectionTimeoutMillis:3000});
  try {assert.equal((await positive.query('SELECT current_user AS role')).rows[0].role,names.runtime);}
  finally {await positive.end();}
  const rejectedUrl=new URL(runtimeUrl);rejectedUrl.password='incorrect-'+password;
  const negative=new Pool({connectionString:rejectedUrl.toString(),max:1,connectionTimeoutMillis:3000});
  try {await assert.rejects(negative.query('SELECT current_user'),error=>error.code==='28P01');}
  finally {await negative.end();}
  const config={connectionString:runtimeUrl.toString(),expectedDatabase:target,maxConnections:2,
    lockTimeoutMs:500,statementTimeoutMs:3000,onIdleConnectionError:error=>poolErrors.push(error.message)};
  database=new api.PostgresDatabase(config);other=new api.PostgresDatabase(config);
  const reset=async()=>database.write(async tx=>{
    for(const sql of ['DELETE FROM '+ledger+'.imports','DELETE FROM '+app+'.settings','DELETE FROM '+app+'.sessions','DELETE FROM '+app+'.users',
      "INSERT INTO "+app+".users VALUES('synthetic-manager','manager',1,0,1,'assigned')",
      "INSERT INTO "+app+".sessions VALUES('synthetic-session-hash','synthetic-manager',2000)"])
      await tx.query(api.sqlQuery('write',sql,sql));
  });
  const cases=await runImportContract(api,{database,other,applicationSchema:names.app,ledgerSchema:names.ledger,reset});
  cases.push('separate_schema_owners_and_restricted_runtime_acl');
  cases.push('positive_and_negative_runtime_password_authentication');
  await reset();
  let release,entered;
  const hold=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const blocker=database.write(async()=>{entered();await hold;});
  try {
    await started;
    let authorized=false;
    await assert.rejects(other.write(async()=>{authorized=true;}),error=>error.code==='55P03');
    assert.equal(authorized,false,'lock timeout never enters the action');
  } finally {release();await blocker;}
  await other.write(tx=>tx.query(api.sqlQuery('write','DELETE FROM '+ledger+'.imports','DELETE FROM '+ledger+'.imports')));
  cases.push('actual_lock_timeout_releases_connection_and_recovers');
  const deferredInsert=api.sqlQuery('write','INSERT INTO '+ledger+'.deferred_keys(id) VALUES(?)',
    'INSERT INTO '+ledger+'.deferred_keys(id) VALUES($1)');
  await assert.rejects(database.write(async tx=>{
    await tx.query(deferredInsert,['duplicate']);await tx.query(deferredInsert,['duplicate']);
  }),error=>error.code==='23505'&&!(error instanceof api.CommitOutcomeUnknownError));
  const deferredCount=api.sqlQuery('read','SELECT COUNT(*) AS n FROM '+ledger+'.deferred_keys',
    'SELECT COUNT(*) AS n FROM '+ledger+'.deferred_keys');
  assert.equal(api.safeSqlInteger((await database.read(tx=>tx.query(deferredCount))).rows[0].n),0);
  await database.write(tx=>tx.query(deferredInsert,['committed-after-rejection']));
  assert.equal(api.safeSqlInteger((await database.read(tx=>tx.query(deferredCount))).rows[0].n),1);
  cases.push('deferred_constraint_commit_rejection_is_certain_and_recovers');
  timed=new api.PostgresDatabase({...config,lockTimeoutMs:50,statementTimeoutMs:100,idleTransactionTimeoutMs:2000});
  await timed.write(async tx=>{
    const sql="SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout";
    const row=(await tx.query(api.sqlQuery('read',sql,sql))).rows[0];
    assert.deepEqual(row,{statement_timeout:'100ms',idle_timeout:'2s'});
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal((await tx.query(api.sqlQuery('read','SELECT 1 AS n','SELECT 1 AS n'))).rows[0].n,1);
  });
  cases.push('await_between_statements_uses_independent_idle_budget');
  const aliasUrl=new URL(runtimeUrl);
  if(aliasUrl.searchParams.has('host'))aliasUrl.searchParams.set('host',aliasUrl.searchParams.get('host')+'/.');
  else aliasUrl.hostname=aliasUrl.hostname==='localhost'?'127.0.0.1':'localhost';
  alias=new api.PostgresDatabase({...config,connectionString:aliasUrl.toString()});
  const aliasIdentity=await alias.read(tx=>tx.query(api.sqlQuery('read',
    'SELECT current_database() AS database','SELECT current_database() AS database')));
  assert.equal(aliasIdentity.rows[0].database,target,'the alternate endpoint reaches the same fixture database');
  await assert.rejects(database.write(async()=>alias.write(async()=>{})),/Nested/);
  await assert.rejects(database.write(async()=>alias.close()),/active transaction/);
  await alias.close();alias=undefined;
  cases.push('same_database_endpoint_alias_cannot_nest_or_close_active_transaction');
  assert.deepEqual(poolErrors,[]);
  receipt={kind:'async-sql-adapter-postgresql-fixture',passed:true,engine:'postgresql',
    server_version_num:identity.version,case_count:cases.length,case_ids:cases,
    shared_contract_case_count:cases.length-6,synthetic_only:true,production_runtime_switched:false,
    independent_schema_ownership:true,runtime_superuser:false};
}catch(error){primaryError=error;}
finally {
  for(const db of [database,other,timed,alias])try{await db?.close();}catch(error){cleanupErrors.push(error.message);}
  for(const schema of createdSchemas.reverse())try{await bootstrap.query('DROP SCHEMA '+quote(schema)+' CASCADE');}catch(error){cleanupErrors.push(error.message);}
  for(const role of createdRoles.reverse())try{await bootstrap.query('DROP ROLE '+quote(role));}catch(error){cleanupErrors.push(error.message);}
  try{await bootstrap.end();}catch(error){cleanupErrors.push(error.message);}
  if(folder)rmSync(folder,{recursive:true,force:true});
}
if(primaryError||cleanupErrors.length||poolErrors.length){
  console.error(JSON.stringify({kind:'async-sql-adapter-postgresql-fixture',passed:false,
    error:primaryError?.message??'Fixture cleanup or connection observer failed',cleanup_errors:cleanupErrors,pool_errors:poolErrors}));
  process.exitCode=1;
}else console.log(JSON.stringify({...receipt,cleanup_passed:true}));
