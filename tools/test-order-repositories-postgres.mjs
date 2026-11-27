// Fresh, explicitly marked PostgreSQL 19 fixture; no implicit database fallback.
// The external lab owns process isolation, resource bounds and raw SQL logs.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build,transformSync} from 'esbuild';
import {parse} from 'acorn';
import {Pool} from 'pg';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {orderDraftFixtureStatements,runOrderDraftContract} from './order-draft-contract.mjs';
import {runOrderListContract} from './order-list-contract.mjs';
import {checkPostgresOrderSchemaBuilder,runPostgresOrderSchemaContract} from './test-postgres-order-schema.mjs';

const target=process.env.COMENZI_PG_TEST_DATABASE,urlText=process.env.COMENZI_PG_TEST_URL;
assert(target&&/^comenzi_orders_fixture_[a-z0-9]{8,24}$/.test(target),'Explicit disposable orders database required');
assert(urlText,'Explicit fixture URL required; no ambient PG fallback');
const url=new URL(urlText);
assert(['postgres:','postgresql:'].includes(url.protocol)&&decodeURIComponent(url.pathname.slice(1))===target);
assert([...url.searchParams.keys()].every(key=>key==='sslmode'||key==='host'));
assert(url.searchParams.has('host')&&url.searchParams.get('host').startsWith('/')&&url.hostname==='localhost',
  'An explicitly isolated Unix socket is required');
const poolErrors=[],cleanupErrors=[],createdRoles=[],createdSchemas=[];
const bootstrap=new Pool({connectionString:urlText,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,
  application_name:'comenzi-orders-fixture-bootstrap'});
bootstrap.on('error',error=>poolErrors.push(error.message));
const suffix=randomBytes(6).toString('hex'),names={app:'fixture_orders_'+suffix,owner:'fixture_owner_'+suffix,
  reader:'fixture_reader_'+suffix,writer:'fixture_writer_'+suffix,foreign:'fixture_foreign_'+suffix};
const quote=name=>'"'+name+'"',password=randomBytes(24).toString('hex');
let client,folder,database,other,receipt,primaryError;

function declarations(file,names){
  const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'esm',target:'node24'}).code;
  const nodes=parse(code,{ecmaVersion:'latest',sourceType:'module'}).body
    .map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(Boolean);
  return names.map(name=>{
    const matches=nodes.filter(node=>node.id?.name===name||node.type==='VariableDeclaration'
      &&node.declarations.some(item=>item.id.name===name));
    assert.equal(matches.length,1,'Original oracle declaration must be unique: '+name);
    return code.slice(matches[0].start,matches[0].end);
  }).join('\n');
}

try{
  client=await bootstrap.connect();
  const identity=(await client.query(`SELECT current_database() AS database,
    current_setting('server_version_num')::integer AS version,pg_is_in_recovery() AS recovery,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert(identity.database===target&&identity.version>=190000&&identity.version<200000&&identity.recovery===false);
  assert.equal(identity.marker,'comenzi async orders isolated fixture v1');
  assert.equal((await client.query(`SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')`)).rows[0].n,0);
  assert.deepEqual((await client.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[names.app])).rows,[]);
  assert.deepEqual((await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',
    [[names.owner,names.reader,names.writer,names.foreign]])).rows,[]);
  mkdirSync('work',{recursive:true});folder=mkdtempSync(resolve('work/orders-postgres-fixture-'));
  const moduleFile=join(folder,'orders.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-postgres'; "
    +"export * from './lib/session-repository-async'; export * from './lib/authority-repository-async'; "
    +"export * from './lib/order-draft-repository-async'; export * from './lib/order-list-repository-async'; "
    +"export * from './lib/postgres-authority-schema'; export * from './lib/postgres-order-schema';",
    loader:'ts',resolveDir:resolve('.')},outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),builderCases=checkPostgresOrderSchemaBuilder(api),app=quote(names.app);
  for(const role of [names.owner,names.reader,names.writer,names.foreign]){
    const login=[names.reader,names.writer].includes(role);
    await client.query('CREATE ROLE '+quote(role)+(login?" LOGIN PASSWORD '"+password+"'":' NOLOGIN')
      +' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');createdRoles.push(role);
  }
  const options={schema:names.app,ownerRole:names.owner,readerRole:names.reader,writerRole:names.writer};
  const authority=api.postgresAuthoritySchema(options);
  createdSchemas.push(names.app);
  await client.query('BEGIN');
  try{
    for(const sql of authority.createStatements)await client.query(sql);
    await client.query('INSERT INTO '+app+'.portfolio_revision(id,data_revision,scope_revision) VALUES(1,11,23)');
    for(const sql of authority.activateStatements)await client.query(sql);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  const schema=await runPostgresOrderSchemaContract(api,{client,isolatedMutation:true,...options,foreignRole:names.foreign});
  assert.equal(schema.passed,true);
  const orderSchema=api.postgresOrderSchema({...options,payloadArchive:'absent'});
  // Only the draft tests' four-column customer fixture is created here. This is
  // not a claim that the complete customer/catalog storage has been ported.
  await client.query('CREATE TABLE '+app+'.customers(id TEXT COLLATE "C" PRIMARY KEY,warehouse_id TEXT COLLATE "C" NOT NULL,'
    +'data TEXT COLLATE "C" NOT NULL,active INTEGER NOT NULL DEFAULT 1)');
  await client.query('ALTER TABLE '+app+'.customers OWNER TO '+quote(names.owner));
  await client.query('REVOKE ALL ON '+app+'.customers FROM PUBLIC,'+quote(names.reader)+','+quote(names.writer));
  await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON '+app+'.customers TO '+quote(names.writer));
  const acl=(await client.query(`SELECT has_database_privilege($1,current_database(),'CREATE') AS create_database,
    has_schema_privilege($1,'public','CREATE') AS create_public,has_schema_privilege($1,$2,'CREATE') AS create_application,
    has_table_privilege($1,$3,'DELETE') AS delete_generation,has_table_privilege($1,$3,'INSERT') AS insert_generation,
    has_column_privilege($1,$3,'revision','UPDATE') AS update_generation`,[names.writer,names.app,names.app+'.order_list_revision'])).rows[0];
  assert.deepEqual(acl,{create_database:false,create_public:false,create_application:false,delete_generation:false,
    insert_generation:false,update_generation:true});
  for(const role of [names.reader,names.writer]){
    const roleUrl=new URL(url);roleUrl.username=role;roleUrl.password=password;
    const positive=new Pool({connectionString:roleUrl.toString(),max:1,connectionTimeoutMillis:3000});
    try{assert.equal((await positive.query('SELECT current_user AS role')).rows[0].role,role);}finally{await positive.end();}
    roleUrl.password='incorrect-'+password;
    const negative=new Pool({connectionString:roleUrl.toString(),max:1,connectionTimeoutMillis:3000});
    try{await assert.rejects(negative.query('SELECT current_user'),error=>error.code==='28P01');}finally{await negative.end();}
  }
  const runtimeUrl=new URL(url);runtimeUrl.username=names.writer;runtimeUrl.password=password;
  const config={connectionString:runtimeUrl.toString(),expectedDatabase:target,maxConnections:2,lockTimeoutMs:1000,
    statementTimeoutMs:3000,onIdleConnectionError:error=>poolErrors.push(error.message)};
  database=new api.PostgresDatabase(config);other=new api.PostgresDatabase(config);
  const draftCases=await runOrderDraftContract(api,{database,other,applicationSchema:names.app});
  assert.equal(draftCases.length,146);

  const oracleFile=join(folder,'legacy.mjs');
  const original=declarations('app/api/[...path]/route.ts',['nationalReadScope','listOrdersPage','orderScope','ORDER_PAGE_LIMIT','encodeOrderCursor','decodeOrderCursor','orderSearch'])
    +'\n'+declarations('lib/server.ts',['AppError','fail','isGlobalManager','textField','weekKey','orderView'])
    +'\n'+declarations('lib/manager-scope.ts',['managerFilter']);
  await build({stdin:{contents:"import {bucharestDayStartUtc} from './lib/bucharest-month';\nexport function makeOracle(db,now){\n"
    +"const Date=class extends globalThis.Date{constructor(value?:string|number){super(value===undefined?now:value);}};\n"
    +original+'\nreturn listOrdersPage;\n}',loader:'ts',resolveDir:resolve('.')},outfile:oracleFile,
    bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const {makeOracle}=await import(pathToFileURL(oracleFile));
  const normal=value=>typeof value==='bigint'?api.safeSqlInteger(value):Array.isArray(value)?value.map(normal):
    value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normal(item)])):value;
  let oracleSnapshots=0,independentWrites=0;
  const legacyOracle=async(id,params,now)=>{
    const snapshot=await database.read(async tx=>{
      const rows={};
      for(const table of ['users','sessions','manager_agents','orders','order_list_revision'])
        rows[table]=normal((await tx.query(api.sqlQuery('read','SELECT * FROM '+app+'.'+table,'SELECT * FROM '+app+'.'+table))).rows);
      return rows;
    });
    const sqlite=new DatabaseSync(':memory:');
    try{
      sqlite.exec("PRAGMA foreign_keys=ON; ATTACH DATABASE ':memory:' AS ledger");
      for(const sql of [...authorityFixtureStatements(api,'main','ledger','sqlite'),...orderDraftFixtureStatements(api,'main','sqlite')])sqlite.exec(sql);
      sqlite.exec('BEGIN');
      for(const table of ['users','sessions','manager_agents','orders'])for(const row of snapshot[table]){
        const columns=Object.keys(row);
        sqlite.prepare('INSERT INTO '+quote(table)+'('+columns.map(quote).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')')
          .run(...columns.map(key=>row[key]));
      }
      assert.equal(snapshot.order_list_revision.length,1);
      sqlite.prepare('UPDATE order_list_revision SET revision=? WHERE id=1').run(snapshot.order_list_revision[0].revision);
      sqlite.exec('COMMIT');
      const db=()=>({prepare:sql=>{
        const statement=values=>({bind:(...next)=>statement(next),first:async()=>normal(sqlite.prepare(sql).get(...values)??null),
          all:async()=>({results:normal(sqlite.prepare(sql).all(...values))})});return statement([]);
      }});
      const user=api.accountRecord(snapshot.users.find(row=>row.id===id));
      const result=await makeOracle(db,now)(user,params);oracleSnapshots++;return result;
    }finally{sqlite.close();}
  };
  const concurrentWrite=async(query,values)=>{
    const result=await other.write(tx=>tx.query(query,values));independentWrites++;return result;
  };
  const listCases=await runOrderListContract(api,{database,other,applicationSchema:names.app,orderSchema,concurrentWrite,legacyOracle});
  const invariantCases=listCases.filter(id=>id.startsWith('target_schema_'));
  assert.equal(listCases.length,140);assert.equal(invariantCases.length,2);assert.equal(oracleSnapshots,21);assert.equal(independentWrites,17);
  const generations=(await client.query('SELECT data_revision,scope_revision FROM '+app+'.portfolio_revision WHERE id=1')).rows;
  assert.equal(generations.length,1);assert.equal(api.safeSqlInteger(generations[0].data_revision),11);
  assert(api.safeSqlInteger(generations[0].scope_revision)>23);assert.deepEqual(poolErrors,[]);
  const integrationCases=['restricted_runtime_with_real_authority_and_order_schema','positive_and_negative_reader_writer_authentication',
    'original_route_oracle_reads_coherent_postgres_snapshot_in_sqlite','independent_postgres_commits_during_repeatable_read',
    'portfolio_data_generation_preserved'];
  const cases=[...schema.case_ids.map(id=>'schema:'+id),...draftCases.map(id=>'draft:'+id),...listCases.map(id=>'list:'+id),
    ...integrationCases.map(id=>'integration:'+id)];
  assert.equal(new Set(cases).size,cases.length);
  receipt={kind:'async-orders-postgresql-fixture',passed:true,engine:'postgresql',server_version_num:identity.version,
    case_count:cases.length,case_ids:cases,builder_case_ids:builderCases,schema_case_ids:schema.case_ids,draft_case_ids:draftCases,
    list_case_ids:listCases,list_common_case_count:138,list_target_invariant_ids:invariantCases,
    integration_case_ids:integrationCases,oracle_snapshot_count:oracleSnapshots,independent_write_count:independentWrites,
    fixture_names:names,real_authority_schema:true,real_order_schema:true,runtime_superuser:false,synthetic_only:true,
    customer_storage_scope:'four-column fixture only',production_runtime_switched:false};
}catch(error){primaryError=error;}
finally{
  for(const db of [database,other])try{await db?.close();}catch(error){cleanupErrors.push(error.message);}
  if(client){
    try{await client.query('ROLLBACK');}catch(error){cleanupErrors.push(error.message);}
    for(const schema of createdSchemas.reverse())try{await client.query('DROP SCHEMA IF EXISTS '+quote(schema)+' CASCADE');}
    catch(error){cleanupErrors.push(error.message);}
    for(const role of createdRoles.reverse())try{await client.query('DROP ROLE '+quote(role));}catch(error){cleanupErrors.push(error.message);}
    if(!cleanupErrors.length)try{
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=$1',[names.app])).rows[0].n,0);
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM pg_roles WHERE rolname=ANY($1::text[])',
        [[names.owner,names.reader,names.writer,names.foreign]])).rows[0].n,0);
    }catch(error){cleanupErrors.push(error.message);}
    client.release();
  }
  try{await bootstrap.end();}catch(error){cleanupErrors.push(error.message);}
  if(folder)rmSync(folder,{recursive:true,force:true});
}
if(primaryError||cleanupErrors.length||poolErrors.length){
  console.error(JSON.stringify({kind:'async-orders-postgresql-fixture',passed:false,error:primaryError?.message??'Cleanup or observer failed',
    cleanup_errors:cleanupErrors,pool_errors:poolErrors}));process.exitCode=1;
}else console.log(JSON.stringify({...receipt,cleanup_passed:true}));
