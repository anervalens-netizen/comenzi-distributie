// The external laboratory owns the disposable database, namespace and resources.
// No ambient PostgreSQL fallback, production import or application selector.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {Pool} from 'pg';
import {ACL_BASELINE,runPostgresSchemaAclContract} from './test-postgres-schema-acl.mjs';

const target=process.env.COMENZI_PG_TEST_DATABASE,urlText=process.env.COMENZI_PG_TEST_URL;
assert(target&&/^comenzi_schema_acl_fixture_[a-z0-9]{8,24}$/.test(target),'Explicit disposable ACL database required');
assert(urlText,'Explicit fixture URL required');
const url=new URL(urlText);
assert(['postgres:','postgresql:'].includes(url.protocol)&&decodeURIComponent(url.pathname.slice(1))===target);
assert([...url.searchParams.keys()].every(key=>key==='sslmode'||key==='host'));
assert(url.hostname==='localhost'&&url.searchParams.has('host')&&url.searchParams.get('host').startsWith('/'),
  'An explicitly isolated Unix socket is required');
const hash=value=>createHash('sha256').update(value).digest('hex');
const errors=[],cleanupErrors=[],createdRoles=[];
const bootstrap=new Pool({connectionString:urlText,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,
  application_name:'comenzi-schema-acl-fixture-bootstrap'});
bootstrap.on('error',error=>errors.push(error.message));
const suffix=randomBytes(6).toString('hex'),names={schema:'fixture_acl_'+suffix,
  ownerRole:'fixture_acl_owner_'+suffix,readerRole:'fixture_acl_reader_'+suffix,
  writerRole:'fixture_acl_writer_'+suffix,foreignRole:'fixture_acl_foreign_'+suffix};
let client,folder,api,receipt,primaryError,attemptedSchema=false;
try{
  client=await bootstrap.connect();
  const identity=(await client.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('server_version_num')::integer AS version,pg_is_in_recovery() AS recovery,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert(identity.database===target&&identity.version===190000&&identity.recovery===false);
  assert.equal(identity.marker,'comenzi schema ACL isolated fixture v1');
  assert.equal((await client.query(`SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')`)).rows[0].n,0);
  assert.deepEqual((await client.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[names.schema])).rows,[]);
  assert.deepEqual((await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',
    [Object.values(names).slice(1)])).rows,[]);
  mkdirSync('work',{recursive:true});folder=mkdtempSync(resolve('work/schema-acl-postgres-'));
  const baseline=resolve('fixtures/schema-acl-baseline');
  const baselineHashes={};
  for(const [name,expected] of [['postgres-authority-schema.ts',ACL_BASELINE.authority],
    ['postgres-order-schema.ts',ACL_BASELINE.orders],['sql-database.ts',hash(readFileSync('lib/sql-database.ts'))]]){
    const actual=hash(readFileSync(join(baseline,name)));assert.equal(actual,expected);baselineHashes[name]=actual;
  }
  const modules=[];
  for(const [name,dir] of [['candidate',resolve('lib')],['baseline',baseline]]){
    const output=join(folder,name+'.mjs');
    await build({stdin:{contents:"export * from './sql-database';export * from './postgres-authority-schema';export * from './postgres-order-schema';",
      loader:'ts',resolveDir:dir},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
    modules.push(await import(pathToFileURL(output)));
  }
  [api]=modules;
  for(const role of Object.values(names).slice(1)){
    await client.query('CREATE ROLE '+api.sqlIdentifier(role)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    createdRoles.push(role);
  }
  attemptedSchema=true;
  receipt=await runPostgresSchemaAclContract(api,{client,baselineApi:modules[1],isolatedMutation:true,
    expectedDatabase:target,expectedBootstrapRole:identity.role,expectedServerVersionNum:identity.version,...names});
  assert.equal(receipt.case_count,40);assert.equal(receipt.legacy_witness_count,31);
  receipt={...receipt,baseline_file_sha256:baselineHashes,synthetic_only:true,
    production_runtime_switched:false,messages_sent:false};
}catch(error){primaryError=error;}
finally{
  if(client){
    try{await client.query('ROLLBACK');}catch(error){cleanupErrors.push(error.message);}
    if(api&&attemptedSchema&&!cleanupErrors.length)try{
      await client.query('DROP SCHEMA IF EXISTS '+api.sqlIdentifier(names.schema)+' CASCADE');
    }catch(error){cleanupErrors.push(error.message);}
    if(api&&!cleanupErrors.length)for(const role of createdRoles.reverse())try{
      await client.query('DROP ROLE '+api.sqlIdentifier(role));
    }catch(error){cleanupErrors.push(error.message);}
    if(!cleanupErrors.length)try{
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=$1',[names.schema])).rows[0].n,0);
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_roles WHERE rolname=ANY($1::text[])',
        [Object.values(names).slice(1)])).rows[0].n,0);
    }catch(error){cleanupErrors.push(error.message);}
    client.release();
  }
  try{await bootstrap.end();}catch(error){cleanupErrors.push(error.message);}
  if(folder)rmSync(folder,{recursive:true,force:true});
}
if(primaryError||cleanupErrors.length||errors.length){
  console.error(JSON.stringify({kind:'postgres-authority-order-acl-contract',passed:false,
    error:primaryError?.message??'Cleanup or observer failed',cleanup_errors:cleanupErrors,pool_errors:errors}));
  process.exitCode=1;
}else console.log(JSON.stringify({...receipt,schema_retained_for_caller_cleanup:false,
  database_objects_removed:true,cleanup_passed:true}));
