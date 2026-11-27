// Shared synthetic application contract. No installation data or endpoints.
import assert from 'node:assert/strict';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const pause=()=>new Promise(resolve=>setTimeout(resolve,25));
export async function runImportContract(api, fixture) {
  const {sqlQuery,safeSqlInteger,withCapturedAsyncImportAuthorization}=api;
  const {database,other,applicationSchema,ledgerSchema,reset}=fixture;
  const app='"'+applicationSchema+'"',ledger='"'+ledgerSchema+'"';
  const statement=(kind,sqlite,postgresql=sqlite)=>sqlQuery(kind,sqlite,postgresql);
  const insert=statement('write','INSERT INTO '+ledger+'.imports(id,amount_cents,label) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id',
    'INSERT INTO '+ledger+'.imports(id,amount_cents,label) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id');
  const count=statement('read','SELECT COUNT(*) AS n FROM '+ledger+'.imports');
  const authority={userId:'synthetic-manager',profileVersion:1,managerScope:'assigned',tokenHash:'synthetic-session-hash'};
  let now=1000;
  const execute=(db=database,action=async tx=>tx.query(insert,['one',-125,'Synthetic return']))=>
    withCapturedAsyncImportAuthorization(db,applicationSchema,authority,action,()=>now);
  const total=async()=>safeSqlInteger((await database.read(tx=>tx.query(count))).rows[0].n);
  const cases=[];
  const check=async(name,action)=>{await reset();now=1000;await action();cases.push(name);};
  await check('authorized_import_commits_once_with_exact_money',async()=>{
    assert.equal((await execute()).changes,1);
    assert.equal((await execute()).changes,0);
    assert.equal(await total(),1);
    const row=(await database.read(tx=>tx.query(statement('read','SELECT amount_cents FROM '+ledger+'.imports')))).rows[0];
    assert.equal(safeSqlInteger(row.amount_cents),-125);
  });
  const mutations={
    logout:'DELETE FROM '+app+'.sessions',
    expiry:'UPDATE '+app+'.sessions SET expires_at=0',
    inactive:'UPDATE '+app+'.users SET active=0',
    role:"UPDATE "+app+".users SET role='agent'",
    revision:'UPDATE '+app+'.users SET profile_revision=2',
    scope:"UPDATE "+app+".users SET manager_scope='global'",
    password_change:'UPDATE '+app+'.users SET must_change_password=1',
  };
  for(const [name,sql]of Object.entries(mutations)){
    await check('revocation_'+name+'_rejects_import',async()=>{
      await other.write(tx=>tx.query(statement('write',sql)));
      await assert.rejects(execute(),error=>error.status===401);
      assert.equal(await total(),0);
    });
  }
  await check('exact_session_user_binding',async()=>{
    const wrong={...authority,userId:'different-manager'};
    await assert.rejects(withCapturedAsyncImportAuthorization(database,applicationSchema,wrong,
      tx=>tx.query(insert,['wrong',1,'Synthetic']),()=>now),error=>error.status===401);
    assert.equal(await total(),0);
  });
  await check('expiration_during_async_import_rolls_back',async()=>{
    await assert.rejects(execute(database,async tx=>{
      await tx.query(insert,['expired',1,'Synthetic']);
      await pause();now=2000;
    }),error=>error.status===401);
    assert.equal(await total(),0);
  });
  await check('application_and_ledger_rollback_together',async()=>{
    const put=statement('write','INSERT INTO '+app+'.settings(key,value) VALUES(?,?)',
      'INSERT INTO '+app+'.settings(key,value) VALUES($1,$2)');
    await assert.rejects(execute(database,async tx=>{
      await tx.query(put,['publication','changed']);
      await tx.query(insert,['failed',12,'Synthetic']);
      throw new Error('Synthetic failure after both writes');
    }),/Synthetic failure/);
    assert.equal(await total(),0);
    assert.equal((await database.read(tx=>tx.query(statement('read','SELECT * FROM '+app+'.settings')))).rows.length,0);
  });
  await check('caught_database_failure_cannot_commit',async()=>{
    await assert.rejects(execute(database,async tx=>{
      await tx.query(insert,['rollback',12,'Synthetic']);
      try {await tx.query(statement('write','INSERT INTO '+ledger+'.missing_table(id) VALUES(1)'));}catch{/* Caller cannot convert a failed transaction into a pass. */}
    }));
    assert.equal(await total(),0);
    await execute();
    assert.equal(await total(),1,'connection and writer lock are reusable after rollback');
  });
  await check('escaped_transaction_cannot_write_after_commit',async()=>{
    let escaped;
    await execute(database,async tx=>{escaped=tx;await tx.query(insert,['committed',1,'Synthetic']);});
    await assert.rejects(escaped.query(insert,['late',1,'Synthetic']),/closed|read-only/);
    assert.equal(await total(),1);
  });
  await check('reader_refuses_mutation_and_scripts',async()=>{
    await assert.rejects(database.read(tx=>tx.query(insert,['forbidden',1,'Synthetic'])),/read-only/);
    await assert.rejects(database.read(tx=>tx.query({kind:'read',sqlite:'SELECT 1; DELETE FROM '+ledger+'.imports',
      postgresql:'SELECT 1; DELETE FROM '+ledger+'.imports'})),/Unsupported/);
    await assert.rejects(database.read(tx=>tx.query({kind:'read',sqlite:'COMMIT',postgresql:'COMMIT'})),/Unsupported/);
    assert.equal(await total(),0);
  });
  await check('nested_same_database_rejected_without_lock_wait',async()=>{
    await assert.rejects(database.write(async()=>{
      await other.write(tx=>tx.query(insert,['nested',1,'Synthetic']));
    }),/Nested/);
    assert.equal(await total(),0);
  });
  await check('import_holds_authority_lock_until_commit',async()=>{
    const entered=deferred(),finish=deferred();
    const pending=execute(database,async tx=>{
      await tx.query(insert,['first',1,'Synthetic']);
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    let revokeEntered=false;
    const revoke=other.write(async tx=>{revokeEntered=true;return tx.query(statement('write',mutations.logout));});
    try {
      await pause();
      assert.equal(revokeEntered,false,'revocation cannot enter while import owns the writer lock');
    } finally {finish.resolve();await Promise.allSettled([pending,revoke]);}
    await pending;await revoke;
    assert.equal(await total(),1);
    await assert.rejects(execute(),error=>error.status===401);
  });
  await check('waiting_import_reads_committed_revocation',async()=>{
    const entered=deferred(),finish=deferred();
    const revoke=other.write(async tx=>{
      await tx.query(statement('write',mutations.logout));entered.resolve();await finish.promise;
    });
    await entered.promise;
    let importEntered=false;
    const pending=execute(database,async tx=>{importEntered=true;await tx.query(insert,['late',1,'Synthetic']);});
    // Register rejection before releasing the blocker.
    const rejected=assert.rejects(pending,error=>error.status===401);
    try {await pause();assert.equal(importEntered,false);}
    finally {finish.resolve();await Promise.allSettled([revoke,rejected]);}
    await revoke;await rejected;
    assert.equal(importEntered,false);assert.equal(await total(),0);
  });
  await check('callback_failure_releases_waiting_writer',async()=>{
    const entered=deferred(),finish=deferred();
    const failed=execute(database,async tx=>{
      await tx.query(insert,['discarded',1,'Synthetic']);entered.resolve();await finish.promise;
      throw new Error('Synthetic rollback');
    });
    const rejected=assert.rejects(failed,/Synthetic rollback/);
    await entered.promise;
    const success=execute(other,tx=>tx.query(insert,['retained',1,'Synthetic']));
    await pause();finish.resolve();await rejected;await success;
    assert.equal(await total(),1);
  });
  await check('binary_order_and_lossless_integer_results',async()=>{
    await execute(database,async tx=>{
      for(const [id,label]of [['c','ă'],['a','Z'],['b','A']])await tx.query(insert,[id,9007199254740993n,label]);
    });
    const ordered=statement('read','SELECT id,amount_cents,label FROM '+ledger+'.imports ORDER BY label COLLATE BINARY,id',
      'SELECT id,amount_cents,label FROM '+ledger+'.imports ORDER BY label COLLATE "C",id');
    const rows=(await database.read(tx=>tx.query(ordered))).rows;
    assert.deepEqual(rows.map(row=>row.id),['b','a','c']);
    assert(rows.every(row=>String(row.amount_cents)==='9007199254740993'));
    assert.throws(()=>safeSqlInteger(rows[0].amount_cents),/outside/);
  });
  return cases;
}
