// Real SQLite fixtures plus pure value/lifecycle guards. PostgreSQL parity is a separate explicit run.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {runImportContract} from './sql-adapter-contract.mjs';
mkdirSync('work',{recursive:true});
const folder=mkdtempSync(resolve('work/sql-adapter-'));
let database,other;
try {
  const moduleFile=join(folder,'adapter.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-sqlite'; export * from './lib/import-write-authorization-async';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile));
  const appFile=join(folder,'app.sqlite'),ledgerFile=join(folder,'ledger.sqlite');
  const open=()=>{
    const sql=new DatabaseSync(appFile);
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100');
    sql.prepare('ATTACH DATABASE ? AS ledger').run(ledgerFile);
    return sql;
  };
  const setup=open();
  setup.exec('CREATE TABLE main.users(id TEXT PRIMARY KEY,role TEXT,active INTEGER,must_change_password INTEGER,profile_revision INTEGER,manager_scope TEXT);'
    +'CREATE TABLE main.sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires_at INTEGER);'
    +'CREATE TABLE main.settings(key TEXT PRIMARY KEY,value TEXT);'
    +'CREATE TABLE ledger.imports(id TEXT PRIMARY KEY,amount_cents INTEGER,label TEXT)');
  database=new api.SqliteDatabase(setup);
  other=new api.SqliteDatabase(open());
  const reset=async()=>database.write(async tx=>{
    for(const sql of ['DELETE FROM ledger.imports','DELETE FROM main.settings','DELETE FROM main.sessions','DELETE FROM main.users',
      "INSERT INTO main.users VALUES('synthetic-manager','manager',1,0,1,'assigned')",
      "INSERT INTO main.sessions VALUES('synthetic-session-hash','synthetic-manager',2000)"]) {
      await tx.query(api.sqlQuery('write',sql,sql));
    }
  });
  const cases=await runImportContract(api,{database,other,applicationSchema:'main',ledgerSchema:'ledger',reset});
  assert.throws(()=>api.sqlValues([Number.MAX_SAFE_INTEGER+1]),/lossy/);
  assert.throws(()=>api.sqlValues([Infinity]),/lossy/);
  assert.throws(()=>api.safeSqlInteger('12.5'),/outside/);
  assert.throws(()=>api.sqlIdentifier('app"; DROP SCHEMA public'),/Invalid/);
  assert.throws(()=>api.sqlQuery('other','UPDATE test SET value=1','UPDATE test SET value=1'),/Unsupported/);
  const bytes=new Uint8Array([1,2]),values=api.sqlValues([bytes]);bytes[0]=9;
  assert.equal(values[0][0],1);
  cases.push('safe_integer_identifier_and_binary_value_contract');
  const issued=[];
  const session=new api.SqlSession('postgresql',true,async(query,values)=>{
    issued.push({query,values});return{rows:[],changes:1};
  });
  const input=new Uint8Array([3,4]),params=[input];
  const operation=session.query(api.sqlQuery('write','INSERT INTO test VALUES(?)','INSERT INTO test VALUES($1)'),params);
  input[0]=8;params[0]='changed';
  await operation;await session.finish();
  assert.deepEqual([...issued[0].values[0]],[3,4]);
  cases.push('statement_parameters_captured_before_async_execution');
  await database.close();await database.close();database=undefined;
  await other.close();other=undefined;
  console.log(JSON.stringify({kind:'async-sql-adapter-synthetic-contract',engine:'sqlite',passed:true,
    case_count:cases.length,case_ids:cases,postgresql_executed:false}));
}finally{
  await database?.close();await other?.close();
  rmSync(folder,{recursive:true,force:true});
}
