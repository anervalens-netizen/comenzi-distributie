// Exercise the NEW coherent snapshot oracle with the unchanged SQLite cases.
// These repeat existing case identities; they are not additional business cases.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {build} from 'esbuild';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {catalogCustomerFixtureStatements,runCatalogCustomerContract} from './catalog-customer-contract.mjs';
import {runUserClientCountsContract} from './user-client-counts-contract.mjs';
import {runSettingsContract} from './settings-contract.mjs';
import {prepareReadSettingsOracles} from './read-settings-oracles.mjs';

mkdirSync('work',{recursive:true});const folder=mkdtempSync(resolve('work/read-settings-oracles-'));
let database,other;
const activationKeys=['MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID','MOBIUP_ACTIVATIONS_PILOT_AGENT_ID',
  'MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS'];
const previousActivation=new Map(activationKeys.map(key=>[key,process.env[key]]));
for(const [index,value]of ['fixture-global','fixture-a','','fixture-inactive'].entries())process.env[activationKeys[index]]=value;
try{
  const moduleFile=join(folder,'read-settings.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database';export * from './lib/sql-sqlite';"
    +"export * from './lib/session-repository-async';export * from './lib/authority-repository-async';"
    +"export * from './lib/catalog-customer-repository-async';export * from './lib/user-read-repository-async';"
    +"export * from './lib/settings-repository-async';export * from './lib/customer-membership-json';",
    loader:'ts',resolveDir:resolve('.')},outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),file=join(folder,'fixture.sqlite'),ledger=join(folder,'ledger.sqlite');
  const open=()=>{const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=100;PRAGMA journal_mode=WAL');
    db.prepare('ATTACH DATABASE ? AS ledger').run(ledger);return db;};
  const connection=open();
  for(const sql of [...authorityFixtureStatements(api,'main','ledger','sqlite'),...catalogCustomerFixtureStatements(api,'main')])connection.exec(sql);
  connection.exec('ALTER TABLE portfolio_revision ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 11');
  database=new api.SqliteDatabase(connection);other=new api.SqliteDatabase(open());
  const oracles=await prepareReadSettingsOracles({api,database,applicationSchema:'main',folder});
  const commits={catalog:0,users:0,settings:0};
  async function commit(group,statements){
    const worker=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.path);try{db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=1000;BEGIN IMMEDIATE');
        for(const item of workerData.statements)db.prepare(item.sql).run(...item.values);db.exec('COMMIT');parentPort.postMessage({committed:true});
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');parentPort.postMessage({error:error.message});}finally{db.close();}`,
    {eval:true,workerData:{path:file,statements:statements.map(({query,values})=>({sql:query.sqlite,values}))}});
    let timer;
    try{await new Promise((done,reject)=>{
      timer=setTimeout(()=>reject(new Error('Independent SQLite oracle fixture commit timed out')),5000);
      worker.once('error',reject);worker.once('message',result=>result.committed===true?done():reject(new Error(result.error??'No commit acknowledgement')));
      worker.once('exit',code=>{if(code!==0)reject(new Error('Independent writer exit '+code));});
    });commits[group]++;}finally{clearTimeout(timer);await worker.terminate();}
  }
  const catalog=await runCatalogCustomerContract(api,{database,other,applicationSchema:'main',legacyOracle:oracles.catalog,
    concurrentWrite:(query,values)=>commit('catalog',[{query,values}])});
  const users=await runUserClientCountsContract(api,{database,other,applicationSchema:'main',legacyOracle:oracles.users,
    concurrentWrite:(query,values)=>commit('users',[{query,values}])});
  const settings=await runSettingsContract(api,{database,other,applicationSchema:'main',legacyOracle:oracles.settings,
    concurrentWrite:statements=>commit('settings',statements)});
  assert.deepEqual([catalog.length,users.length,settings.length],[82,42,154]);
  assert.deepEqual(oracles.counts,{catalog:16,users:6,settings:108,settings_writes:61,snapshots:130});
  assert.deepEqual(commits,{catalog:5,users:8,settings:3});
  console.log(JSON.stringify({kind:'read-settings-coherent-oracle-sqlite-regression',passed:true,engine:'sqlite',
    case_ids:{catalog,users,settings},existing_case_count:278,new_business_cases:0,oracle_counts:oracles.counts,
    independent_commits:commits,original_source_sha256:oracles.source_sha256,postgresql_executed:false,runtime_wired:false}));
}finally{
  await database?.close();await other?.close();rmSync(folder,{recursive:true,force:true});
  for(const [key,value]of previousActivation)if(value===undefined)delete process.env[key];else process.env[key]=value;
}
