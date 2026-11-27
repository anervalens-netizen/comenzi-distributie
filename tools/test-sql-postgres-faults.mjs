// Driver transport fault injection. This does not substitute for the actual PG contract.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const driver=`import {EventEmitter} from 'node:events';
export const transport={plans:[],pools:[],clients:[]};
class Client extends EventEmitter {
  constructor(plan){super();this.plan=plan;this.calls=[];this.releases=[];}
  async query(query){
    const text=typeof query==='string'?query:query.text;
    this.calls.push({text,values:query.values,queryMode:query.queryMode});
    if(this.plan.fail?.includes(text))throw new Error('Synthetic transport failure: '+text);
    if(text==='SELECT current_database() AS database')return{rows:[{database:this.plan.database??'synthetic_adapter'}],rowCount:1,command:'SELECT'};
    if(text==='SELECT authority')return{rows:this.plan.deny?[]:[{valid:1}],rowCount:1,command:'SELECT'};
    return{rows:[],rowCount:1,command:text==='COMMIT'?(this.plan.commitCommand??'COMMIT'):text.split(' ')[0]};
  }
  release(destroy){this.releases.push(destroy);}
}
export class Pool extends EventEmitter {
  constructor(config){super();this.config=config;this.ended=false;transport.pools.push(this);}
  async connect(){const plan=transport.plans.shift()??{};if(plan.connectFailure)throw new Error('Synthetic acquire failure');const client=new Client(plan);transport.clients.push(client);return client;}
  async end(){this.ended=true;}
}`;
mkdirSync('work',{recursive:true});
const folder=mkdtempSync(resolve('work/sql-postgres-faults-'));
try {
  const output=join(folder,'adapter.mjs');
  await build({stdin:{contents:"export * from './lib/sql-postgres'; export * from './lib/sql-database'; export {transport} from 'pg';",loader:'ts',resolveDir:resolve('.')},
    outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent',plugins:[{
      name:'synthetic-pg-transport',setup(build){build.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'fixture'}));
        build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:driver,loader:'js'}));},
    }]});
  const {PostgresDatabase,CommitOutcomeUnknownError,sqlQuery,transport}=await import(pathToFileURL(output));
  const options={connectionString:'postgresql://synthetic:synthetic@fixture.invalid/synthetic_adapter',
    expectedDatabase:'synthetic_adapter',onIdleConnectionError:()=>{},maxConnections:2};
  const write=sqlQuery('write','INSERT INTO synthetic VALUES(1)','INSERT INTO synthetic VALUES(1)');
  const read=sqlQuery('read','SELECT authority','SELECT authority');
  const authority=async tx=>{if((await tx.query(read)).rows.length!==1)throw new Error('Synthetic authority denied');};
  const cases=[];
  const check=async(name,plan,action)=>{
    transport.plans.push(plan);const db=new PostgresDatabase(options);
    const before=transport.clients.length;
    try {await action(db,()=>transport.clients.at(-1));cases.push(name);}
    finally {await db.close();await db.close();}
    assert(transport.pools.at(-1).ended);
    for(const client of transport.clients.slice(before)){
      assert.equal(client.releases.length,1,'every acquired connection is released exactly once');
      assert.equal(client.listenerCount('error'),0,'temporary client error listener is removed');
    }
  };
  await check('authority_read_and_write_share_locked_read_committed_client',{},async(db,last)=>{
    await db.write(tx=>tx.query(write),authority);
    const client=last(),sql=client.calls.map(c=>c.text);
    assert(sql.includes('BEGIN ISOLATION LEVEL READ COMMITTED'));
    const lock=sql.indexOf('SELECT pg_advisory_xact_lock($1::integer,$2::integer)');
    assert(lock>=0&&lock<sql.indexOf('SELECT authority'));
    assert.equal(sql.filter(s=>s==='SELECT authority').length,2);
    assert(sql.lastIndexOf('SELECT authority')>sql.indexOf(write.postgresql));
    assert.equal(sql.at(-1),'COMMIT');assert.deepEqual(client.releases,[false]);
    assert.deepEqual(client.calls[lock].values,[1129270605,1]);
    assert(client.calls.filter(c=>c.values).every(c=>c.queryMode==='extended'));
  });
  await check('reader_is_repeatable_read_read_only_without_writer_lock',{},async(db,last)=>{
    await db.read(tx=>tx.query(read));
    assert(last().calls.some(c=>c.text==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert(!last().calls.some(c=>c.text.includes('pg_advisory')));
  });
  await check('wrong_database_retires_client_before_begin',{database:'wrong_database'},async(db,last)=>{
    await assert.rejects(db.write(tx=>tx.query(write)),/identity differs/);
    assert.equal(last().calls.length,1);assert.deepEqual(last().releases,[true]);
  });
  await check('pool_acquire_failure_cannot_execute_action',{connectFailure:true},async db=>{
    let entered=false;await assert.rejects(db.write(async()=>{entered=true;}),/acquire failure/);assert(!entered);
  });
  await check('lock_failure_rolls_back_before_authority',{fail:['SELECT pg_advisory_xact_lock($1::integer,$2::integer)']},async(db,last)=>{
    await assert.rejects(db.write(tx=>tx.query(write),authority),/transport failure/);
    assert(!last().calls.some(c=>c.text==='SELECT authority'));assert.equal(last().calls.at(-1).text,'ROLLBACK');
  });
  await check('denied_authority_never_enters_write_callback',{deny:true},async(db,last)=>{
    let entered=false;await assert.rejects(db.write(async()=>{entered=true;},authority),/authority denied/);
    assert(!entered);assert.equal(last().calls.at(-1).text,'ROLLBACK');
  });
  await check('caught_query_failure_rolls_back',{fail:[write.postgresql]},async(db,last)=>{
    await assert.rejects(db.write(async tx=>{try{await tx.query(write);}catch{/* Deliberately swallowed. */}}),/transport failure/);
    assert.equal(last().calls.at(-1).text,'ROLLBACK');assert(!last().calls.some(c=>c.text==='COMMIT'));
  });
  await check('unawaited_query_is_drained_before_commit',{},async(db,last)=>{
    await db.write(async tx=>{void tx.query(write);});
    const sql=last().calls.map(c=>c.text);assert(sql.indexOf(write.postgresql)<sql.indexOf('COMMIT'));
  });
  await check('callback_failure_rolls_back',{},async(db,last)=>{
    await assert.rejects(db.write(async()=>{throw new Error('Synthetic callback failure');}),/callback failure/);
    assert.equal(last().calls.at(-1).text,'ROLLBACK');assert.deepEqual(last().releases,[false]);
  });
  await check('rollback_failure_retires_connection',{fail:['ROLLBACK']},async(db,last)=>{
    await assert.rejects(db.write(async()=>{throw new Error('Synthetic action failure');}),/action failure/);
    assert.deepEqual(last().releases,[true]);
  });
  await check('lost_commit_confirmation_is_unknown_and_never_retried',{fail:['COMMIT']},async(db,last)=>{
    await assert.rejects(db.write(tx=>tx.query(write)),CommitOutcomeUnknownError);
    assert.equal(last().calls.filter(c=>c.text==='COMMIT').length,1);
    assert(!last().calls.some(c=>c.text==='ROLLBACK'));assert.deepEqual(last().releases,[true]);
  });
  await check('commit_returning_rollback_is_not_success',{commitCommand:'ROLLBACK'},async(db,last)=>{
    await assert.rejects(db.write(tx=>tx.query(write)),CommitOutcomeUnknownError);
    assert.deepEqual(last().releases,[true]);
  });
  await check('checked_out_client_error_is_observed_and_retires_connection',{},async(db,last)=>{
    await assert.rejects(db.write(async tx=>{
      await tx.query(write);last().emit('error',new Error('Synthetic idle transaction disconnect'));
      await Promise.resolve();
    }),/idle transaction disconnect/);
    assert(!last().calls.some(c=>c.text==='COMMIT'));assert.deepEqual(last().releases,[true]);
  });
  await check('nested_instance_same_database_refused_before_pool_acquire',{},async db=>{
    const other=new PostgresDatabase(options);
    try {await assert.rejects(db.write(async()=>other.write(tx=>tx.query(write))),/Nested/);}
    finally {await other.close();}
  });
  await check('closing_active_transaction_refused_without_leaking_client',{},async db=>{
    await assert.rejects(db.write(async()=>db.close()),/active transaction/);
  });
  assert.throws(()=>new PostgresDatabase({...options,connectionString:''}),/Explicit/);
  assert.throws(()=>new PostgresDatabase({...options,maxConnections:200}),/bounded/);
  cases.push('explicit_target_and_bounded_pool_configuration');
  console.log(JSON.stringify({kind:'async-sql-postgres-transport-fault-contract',passed:true,
    case_count:cases.length,case_ids:cases,postgresql_executed:false}));
}finally {rmSync(folder,{recursive:true,force:true});}
