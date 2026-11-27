// Actual SQLite, original route oracle and two connections to an owned WAL file.
// No HTTP service, live path, PostgreSQL selector or external database is used.
import {build,transformSync} from 'esbuild';
import {parse} from 'acorn';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {orderDraftFixtureStatements} from './order-draft-contract.mjs';
import {runOrderListContract} from './order-list-contract.mjs';

mkdirSync('work',{recursive:true});
const folder=mkdtempSync(resolve('work/order-list-'));
let database,other;
const source=(file,names)=>{
  const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'esm',target:'node24'}).code;
  const nodes=parse(code,{ecmaVersion:'latest',sourceType:'module'}).body.map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(Boolean);
  return names.map(name=>{
    const match=nodes.filter(item=>item.id?.name===name||item.type==='VariableDeclaration'&&item.declarations.some(d=>d.id.name===name));
    if(match.length!==1)throw new Error('Legacy oracle declaration missing or duplicated: '+name);
    return code.slice(match[0].start,match[0].end);
  }).join('\n');
};
try{
  const moduleFile=join(folder,'list.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-sqlite'; export * from './lib/session-repository-async'; export * from './lib/order-list-repository-async';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),appFile=join(folder,'app.sqlite'),ledgerFile=join(folder,'ledger.sqlite');
  const open=()=>{
    const connection=new DatabaseSync(appFile);connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL');
    connection.prepare('ATTACH DATABASE ? AS ledger').run(ledgerFile);return connection;
  };
  const setup=open();
  for(const sql of [...authorityFixtureStatements(api,'main','ledger','sqlite'),...orderDraftFixtureStatements(api,'main','sqlite')])setup.exec(sql);
  database=new api.SqliteDatabase(setup);other=new api.SqliteDatabase(open());
  const oracleFile=join(folder,'legacy.mjs');
  const original=source('app/api/[...path]/route.ts',['nationalReadScope','listOrdersPage','orderScope','ORDER_PAGE_LIMIT','encodeOrderCursor','decodeOrderCursor','orderSearch'])
    +'\n'+source('lib/server.ts',['AppError','fail','isGlobalManager','textField','weekKey','orderView'])
    +'\n'+source('lib/manager-scope.ts',['managerFilter']);
  await build({stdin:{contents:"import {bucharestDayStartUtc} from './lib/bucharest-month';\nexport function makeOracle(db,now){\n"
    +"const Date=class extends globalThis.Date{constructor(value?:string|number){super(value===undefined?now:value);}};\n"
    +original+'\nreturn listOrdersPage;\n}',loader:'ts',resolveDir:resolve('.')},outfile:oracleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const {makeOracle}=await import(pathToFileURL(oracleFile));
  const normal=value=>typeof value==='bigint'?api.safeSqlInteger(value):Array.isArray(value)?value.map(normal):
    value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normal(item)])):value;
  const legacyDb=()=>({prepare:sql=>{
    const statement=values=>({bind:(...next)=>statement(next),first:async()=>normal((await database.read(tx=>tx.query(api.sqlQuery('read',sql,sql),values))).rows[0]??null),
      all:async()=>({results:normal((await database.read(tx=>tx.query(api.sqlQuery('read',sql,sql),values))).rows)})});
    return statement([]);
  }});
  const legacyOracle=async(id,params,now)=>{
    const record=(await database.read(tx=>tx.query(api.sqlQuery('read','SELECT * FROM users WHERE id=?','SELECT * FROM users WHERE id=$1'),[id]))).rows[0];
    const user=api.accountRecord(record);
    return makeOracle(legacyDb,now)(user,params);
  };
  const concurrentWrite=async(query,values)=>{
    const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.path); try{db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
        const result=db.prepare(workerData.sql).run(...workerData.values);db.exec('COMMIT');parentPort.postMessage({changes:result.changes});
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');parentPort.postMessage({error:error.message});}finally{db.close();}`,{
      eval:true,workerData:{path:appFile,sql:query.sqlite,values}});
    let deadline;
    try{return await new Promise((done,reject)=>{
      deadline=setTimeout(()=>reject(new Error('Independent SQLite fixture writer timed out')),5000);
      worker.once('error',reject);worker.once('message',result=>result.error?reject(new Error(result.error)):done(result));
      worker.once('exit',code=>{if(code!==0)reject(new Error('Independent SQLite fixture writer exited '+code));});
    });}finally{clearTimeout(deadline);await worker.terminate();}
  };
  const cases=await runOrderListContract(api,{database,other,applicationSchema:'main',concurrentWrite,legacyOracle});
  console.log(JSON.stringify({kind:'async-order-list-synthetic-contract',engine:'sqlite',passed:true,case_count:cases.length,case_ids:cases,
    original_route_oracle:true,independent_wal_writer:true,postgresql_executed:false,runtime_wired:false}));
}finally{
  await database?.close();await other?.close();rmSync(folder,{recursive:true,force:true});
}
