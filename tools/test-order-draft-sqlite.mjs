// Synthetic SQLite only. No HTTP server, production path or external database.
import {build} from 'esbuild';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {orderDraftFixtureStatements,runOrderDraftContract} from './order-draft-contract.mjs';

mkdirSync('work',{recursive:true});
const folder=mkdtempSync(resolve('work/order-draft-'));
let database,other;
try{
  const moduleFile=join(folder,'orders.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-sqlite'; export * from './lib/session-repository-async'; export * from './lib/authority-repository-async'; export * from './lib/order-write-authority-async'; export * from './lib/order-draft-repository-async';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),appFile=join(folder,'app.sqlite'),ledgerFile=join(folder,'ledger.sqlite');
  const open=()=>{
    const sql=new DatabaseSync(appFile);sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100');
    sql.prepare('ATTACH DATABASE ? AS ledger').run(ledgerFile);return sql;
  };
  const setup=open();
  // Execute the legacy JSON1 predicate itself, not an imitation of the new
  // projection. The cross-engine contract retains the resulting expectations.
  for(const [membership,allowed]of [[undefined,true],[null,true],[[],false],[['fixture-warehouse-a'],true],
    [['fixture-warehouse-b'],false],[{legacy:'fixture-warehouse-a'},true],['"fixture-warehouse-a"',true],
    ['["fixture-warehouse-a"]',true],[true,false],[1,false],['1',false]]){
    const data=JSON.stringify(membership===undefined?{}:{warehouseIds:membership});
    const row=setup.prepare("SELECT EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(?,'$.warehouseIds'),json_array(?))) WHERE value=?) AS allowed")
      .get(data,'fixture-warehouse-a','fixture-warehouse-a');
    assert.equal(row.allowed,allowed?1:0);
  }
  assert.throws(()=>setup.prepare("SELECT value FROM json_each(json_extract(?,'$.warehouseIds'))")
    .all(JSON.stringify({warehouseIds:'fixture-warehouse-a'})),/malformed JSON/);
  for(const sql of [...authorityFixtureStatements(api,'main','ledger','sqlite'),...orderDraftFixtureStatements(api,'main','sqlite')])setup.exec(sql);
  database=new api.SqliteDatabase(setup);other=new api.SqliteDatabase(open());
  const cases=await runOrderDraftContract(api,{database,other,applicationSchema:'main'});
  console.log(JSON.stringify({kind:'async-order-draft-synthetic-contract',engine:'sqlite',passed:true,
    case_count:cases.length,case_ids:cases,postgresql_executed:false,runtime_wired:false}));
}finally{
  await database?.close();await other?.close();rmSync(folder,{recursive:true,force:true});
}
