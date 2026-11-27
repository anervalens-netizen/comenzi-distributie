// Synthetic SQLite only. No production runtime, server, queue or external DB.
import {build,transformSync} from 'esbuild';
import {parse} from 'acorn';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {catalogCustomerFixtureStatements} from './catalog-customer-contract.mjs';
import {runUserClientCountsContract,runCustomerCountCastOracle} from './user-client-counts-contract.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
mkdirSync('work',{recursive:true});const folder=mkdtempSync(resolve('work/user-client-counts-'));
let database,other,native,originalConnection;
const envKeys=['MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID','MOBIUP_ACTIVATIONS_PILOT_AGENT_ID',
  'MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS'];
const previousEnv=new Map(envKeys.map(key=>[key,process.env[key]]));
process.env[envKeys[0]]='fixture-global';process.env[envKeys[1]]='fixture-a';
process.env[envKeys[2]]='';process.env[envKeys[3]]='fixture-inactive';
const source=(file,names)=>{
  const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'esm',target:'node24'}).code;
  const nodes=parse(code,{ecmaVersion:'latest',sourceType:'module'}).body.map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(Boolean);
  return names.map(name=>{
    const matches=nodes.filter(node=>node.id?.name===name||node.type==='VariableDeclaration'&&node.declarations.some(item=>item.id.name===name));
    if(matches.length!==1)throw new Error('Original declaration missing or duplicated: '+name);
    return code.slice(matches[0].start,matches[0].end);
  }).join('\n');
};
try{
  const moduleFile=join(folder,'users.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database'; export * from './lib/sql-sqlite'; export * from './lib/session-repository-async'; "
    +"export * from './lib/user-read-repository-async'; export * from './lib/customer-membership-json';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),file=join(folder,'app.sqlite'),ledger=join(folder,'ledger.sqlite');
  const open=()=>{const connection=new DatabaseSync(file);connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL');
    connection.prepare('ATTACH DATABASE ? AS ledger').run(ledger);return connection;};
  const setup=open();
  for(const sql of [...authorityFixtureStatements(api,'main','ledger','sqlite'),...catalogCustomerFixtureStatements(api,'main')])setup.exec(sql);
  database=new api.SqliteDatabase(setup);other=new api.SqliteDatabase(open());
  const originals=['lib/customer-counts.ts','lib/server.ts','app/api/[...path]/route.ts','lib/activation-access.ts'];
  const oracleCode=source(originals[0],['selectUsersWithClientCounts'])+'\n'+source(originals[1],['userView'])+'\n'
    +source(originals[2],['getUsers']);
  const oracleFile=join(folder,'original.mjs');
  await build({stdin:{contents:"import {canViewActivations} from './lib/activation-access'; export function makeOracle(db,warehouses){\n"
    +oracleCode+'\nreturn getUsers;}',loader:'ts',resolveDir:resolve('.')},outfile:oracleFile,bundle:true,
    platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const {makeOracle}=await import(pathToFileURL(oracleFile));
  const normal=value=>typeof value==='bigint'?api.safeSqlInteger(value):Array.isArray(value)?value.map(normal):
    value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normal(item)])):value;
  let originalComparisons=0,independentCommits=0;
  originalConnection=new DatabaseSync(file,{readOnly:true});originalConnection.exec('PRAGMA query_only=ON');
  const legacyOracle=async(viewerId,warehouses)=>{
    // Run the original WITH query unchanged on a fixture-only read connection.
    // Do not broaden or bypass the production adapter's SELECT allowlist.
    originalConnection.exec('BEGIN');
    const db=()=>({prepare:sql=>{
      const statement=values=>({bind:(...next)=>statement(next),all:async()=>({results:normal(originalConnection.prepare(sql).all(...values))})});
      return statement([]);
    }});
    try{
      const viewer=originalConnection.prepare('SELECT * FROM users WHERE id=?').get(viewerId);
      const result=await makeOracle(db,warehouses)(api.accountRecord(viewer));
      originalConnection.exec('COMMIT');originalComparisons++;return result;
    }catch(error){if(originalConnection.isTransaction)originalConnection.exec('ROLLBACK');throw error;}
  };
  const concurrentWrite=async(query,values)=>{
    const worker=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.path);try{db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
        const result=db.prepare(workerData.sql).run(...workerData.values);db.exec('COMMIT');parentPort.postMessage({changes:result.changes});
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');parentPort.postMessage({error:error.message});}finally{db.close();}`,{
      eval:true,workerData:{path:file,sql:query.sqlite,values}});
    let timeout;
    try{const result=await new Promise((done,reject)=>{
      timeout=setTimeout(()=>reject(new Error('Independent user/count fixture writer timed out')),5000);
      worker.once('error',reject);worker.once('message',value=>value.error?reject(new Error(value.error)):done(value));
      worker.once('exit',code=>{if(code!==0)reject(new Error('Independent user/count writer exited '+code));});
    });independentCommits++;return result;}finally{clearTimeout(timeout);await worker.terminate();}
  };
  const cases=await runUserClientCountsContract(api,{database,other,applicationSchema:'main',legacyOracle,concurrentWrite});
  native=new DatabaseSync(':memory:');
  const cast=native.prepare("SELECT CAST(value AS TEXT) AS value FROM json_each(COALESCE(json_extract(?,'$.warehouseIds'),json_array(?)))");
  const castCases=runCustomerCountCastOracle(api,(raw,fallback)=>cast.all(raw,fallback).map(row=>row.value));
  console.log(JSON.stringify({kind:'async-user-client-counts-synthetic-contract',engine:'sqlite',sqlite_version:process.versions.sqlite,
    passed:true,case_count:cases.length,case_ids:cases,original_source_oracle_comparisons:originalComparisons,
    independent_wal_commits:independentCommits,cast_case_count:castCases.length,cast_case_ids:castCases,
    matching_cast_cases:castCases.filter(id=>id.startsWith('native_cast_text:')).length,
    unported_real_cast_witnesses:castCases.filter(id=>id.startsWith('unported_real_cast_')).length,
    original_source_sha256:Object.fromEntries(originals.map(path=>[path,hash(readFileSync(path))])),
    postgresql_executed:false,runtime_wired:false,production_source_eligibility_verified:false}));
}finally{
  await database?.close();await other?.close();native?.close();originalConnection?.close();rmSync(folder,{recursive:true,force:true});
  for(const [key,value]of previousEnv)if(value===undefined)delete process.env[key];else process.env[key]=value;
}
