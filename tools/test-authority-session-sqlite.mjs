// Low-resource synthetic SQLite contract only. No HTTP server or external DB.
import {build} from 'esbuild';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {authorityFixtureStatements,runAuthoritySessionContract} from './authority-session-contract.mjs';

mkdirSync('work',{recursive:true});
const folder=mkdtempSync(resolve('work/authority-session-'));
let database,other;
try{
  const moduleFile=join(folder,'authority.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-sqlite'; export * from './lib/import-write-authorization-async'; export * from './lib/session-repository-async'; export * from './lib/authority-repository-async';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),appFile=join(folder,'app.sqlite'),ledgerFile=join(folder,'ledger.sqlite');
  const open=()=>{
    const sql=new DatabaseSync(appFile);
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100');
    sql.prepare('ATTACH DATABASE ? AS ledger').run(ledgerFile);
    return sql;
  };
  const setup=open();
  for(const sql of authorityFixtureStatements(api,'main','ledger','sqlite'))setup.exec(sql);
  database=new api.SqliteDatabase(setup);other=new api.SqliteDatabase(open());
  const cases=await runAuthoritySessionContract(api,{database,other,applicationSchema:'main',ledgerSchema:'ledger'});
  console.log(JSON.stringify({kind:'async-authority-session-synthetic-contract',engine:'sqlite',passed:true,
    case_count:cases.length,case_ids:cases,postgresql_executed:false,runtime_wired:false}));
}finally{
  await database?.close();await other?.close();rmSync(folder,{recursive:true,force:true});
}
