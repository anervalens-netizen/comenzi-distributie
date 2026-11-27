// Actual SQLite and original source oracles. No HTTP service or external DB.
import {build,transformSync} from 'esbuild';
import {parse} from 'acorn';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {catalogCustomerFixtureStatements,runCatalogCustomerContract,runCustomerMembershipOracle} from './catalog-customer-contract.mjs';

mkdirSync('work',{recursive:true});const folder=mkdtempSync(resolve('work/catalog-customer-'));
let database,other,oracleDatabase;
const parsed=file=>{
  const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'esm',target:'node24'}).code;
  const nodes=parse(code,{ecmaVersion:'latest',sourceType:'module'}).body.map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(Boolean);
  return{code,nodes};
};
const source=(file,names)=>{
  const {code,nodes}=parsed(file);
  return names.map(name=>{
    const matches=nodes.filter(node=>node.id?.name===name||node.type==='VariableDeclaration'&&node.declarations.some(item=>item.id.name===name));
    if(matches.length!==1)throw new Error('Original declaration missing or duplicated: '+name);
    return code.slice(matches[0].start,matches[0].end);
  }).join('\n');
};
try{
  const moduleFile=join(folder,'catalog.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-sqlite'; export * from './lib/session-repository-async'; "
    +"export * from './lib/catalog-customer-repository-async'; export * from './lib/customer-membership-json';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),file=join(folder,'app.sqlite'),ledger=join(folder,'ledger.sqlite');
  const open=()=>{const connection=new DatabaseSync(file);connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL');
    connection.prepare('ATTACH DATABASE ? AS ledger').run(ledger);return connection;};
  const setup=open();
  for(const sql of [...authorityFixtureStatements(api,'main','ledger','sqlite'),...catalogCustomerFixtureStatements(api,'main')])setup.exec(sql);
  database=new api.SqliteDatabase(setup);other=new api.SqliteDatabase(open());
  const {code,nodes}=parsed('app/api/[...path]/route.ts');
  const route=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='authenticatedRoute');
  const matches=route.body.body.filter(node=>node.type==='IfStatement'
    &&/path\[0\]\s*===\s*["']clients["']/.test(code.slice(node.test.start,node.test.end))
    &&/req\.method\s*===\s*["']GET["']/.test(code.slice(node.test.start,node.test.end)));
  if(matches.length!==1)throw new Error('Original customer GET branch missing or duplicated');
  const clientBody=code.slice(matches[0].consequent.start,matches[0].consequent.end);
  const original=source('lib/catalog.ts',['photoKey','readProductPhoto','readCatalog'])+'\n'
    +source('app/api/[...path]/route.ts',['nationalReadScope','visibleWarehouses'])+'\n'
    +source('lib/server.ts',['AppError','fail','isGlobalManager','canAccessWarehouse','requireWarehouseAccess']);
  const oracleFile=join(folder,'legacy.mjs');
  await build({stdin:{contents:"import {createHash} from 'node:crypto'; import {validEan} from './lib/barcodes'; "
    +"import {stockCode} from './lib/stock-types'; import {productPhotoMime} from './lib/product-photo';\n"
    +"export function makeOracle(db,seed){const warehouses=seed.warehouses;const sha256=value=>createHash('sha256').update(value).digest('hex');const response=value=>value;\n"
    +original+'\nasync function customers(user,warehouseId){const readUser=nationalReadScope(user);const url=new URL("https://fixture.invalid/clients");'
    +'if(warehouseId!==null)url.searchParams.set("warehouseId",warehouseId);const req=new Request(url);'+clientBody+'}\n'
    +'return {catalog:readCatalog,photo:readProductPhoto,customers,warehouses:visibleWarehouses};}',loader:'ts',resolveDir:resolve('.')},
    outfile:oracleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const {makeOracle}=await import(pathToFileURL(oracleFile));
  const normal=value=>typeof value==='bigint'?api.safeSqlInteger(value):Array.isArray(value)?value.map(normal):
    value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normal(item)])):value;
  const db=()=>({prepare:sql=>{
    const statement=values=>({bind:(...next)=>statement(next),first:async()=>normal((await database.read(tx=>tx.query(api.sqlQuery('read',sql,sql),values))).rows[0]??null),
      all:async()=>({results:normal((await database.read(tx=>tx.query(api.sqlQuery('read',sql,sql),values))).rows)})});return statement([]);
  }});
  let legacyComparisons=0,independentWrites=0;
  const legacyOracle=async(kind,input)=>{
    const oracle=makeOracle(db,input.seed);legacyComparisons++;
    if(kind==='catalog')return oracle.catalog();
    if(kind==='photo')return oracle.photo(input.encodedId,input.filename);
    const row=(await database.read(tx=>tx.query(api.sqlQuery('read','SELECT * FROM users WHERE id=?','SELECT * FROM users WHERE id=$1'),[input.userId]))).rows[0];
    const user=api.accountRecord(row);
    if(kind==='customers')return (await oracle.customers(user,input.warehouseId)).clients;
    if(kind==='warehouses')return oracle.warehouses(user);
    throw new Error('Unknown original source oracle');
  };
  const concurrentWrite=async(query,values)=>{
    const worker=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.path);try{db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
        const result=db.prepare(workerData.sql).run(...workerData.values);db.exec('COMMIT');parentPort.postMessage({changes:result.changes});
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');parentPort.postMessage({error:error.message});}finally{db.close();}`,{
      eval:true,workerData:{path:file,sql:query.sqlite,values}});
    let timeout;
    try{const result=await new Promise((done,reject)=>{
      timeout=setTimeout(()=>reject(new Error('Independent customer fixture writer timed out')),5000);
      worker.once('error',reject);worker.once('message',result=>result.error?reject(new Error(result.error)):done(result));
      worker.once('exit',code=>{if(code!==0)reject(new Error('Independent fixture writer exited '+code));});
    });independentWrites++;return result;}finally{clearTimeout(timeout);await worker.terminate();}
  };
  const cases=await runCatalogCustomerContract(api,{database,other,applicationSchema:'main',concurrentWrite,legacyOracle});
  oracleDatabase=new DatabaseSync(':memory:');
  const native=oracleDatabase.prepare("SELECT value FROM json_each(COALESCE(json_extract(?,'$.warehouseIds'),json_array(?)))");native.setReadBigInts(true);
  const membership=runCustomerMembershipOracle(api,(raw,fallback)=>native.all(raw,fallback).map(row=>row.value));
  console.log(JSON.stringify({kind:'async-catalog-customer-synthetic-contract',engine:'sqlite',sqlite_version:process.versions.sqlite,passed:true,case_count:cases.length,case_ids:cases,
    legacy_oracle_comparisons:legacyComparisons,independent_wal_commits:independentWrites,membership_case_count:membership.length,
    membership_case_ids:membership,json5_eligibility_limit_count:membership.filter(id=>id.startsWith('unported_json5')).length,
    unicode_eligibility_limit_count:membership.filter(id=>id.startsWith('unported_unicode')).length,
    postgresql_executed:false,runtime_wired:false,user_client_count_ported:false}));
}finally{await database?.close();await other?.close();oracleDatabase?.close();rmSync(folder,{recursive:true,force:true});}
