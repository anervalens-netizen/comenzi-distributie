// Reusable, entirely fictional contract. The caller supplies two dedicated
// adapters to the SAME isolated database and owns fixture DDL/cleanup.
import assert from 'node:assert/strict';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
export function authorityFixtureStatements(api,applicationSchema,ledgerSchema,dialect){
  const a=api.sqlIdentifier(applicationSchema),l=api.sqlIdentifier(ledgerSchema),integer=dialect==='postgresql'?'BIGINT':'INTEGER';
  const statements=[
    `CREATE TABLE ${a}.users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,manager_scope TEXT NOT NULL DEFAULT 'assigned',warehouse_id TEXT,warehouse_name TEXT,site_code TEXT NOT NULL DEFAULT '',password_hash TEXT NOT NULL,must_change_password INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,profile_revision ${integer} NOT NULL DEFAULT 1)`,
    `CREATE TABLE ${a}.sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES ${dialect==='sqlite'?'users':a+'.users'}(id),expires_at ${integer} NOT NULL)`,
    `CREATE TABLE ${a}.manager_agents(manager_id TEXT NOT NULL REFERENCES ${dialect==='sqlite'?'users':a+'.users'}(id),agent_id TEXT NOT NULL REFERENCES ${dialect==='sqlite'?'users':a+'.users'}(id),PRIMARY KEY(manager_id,agent_id))`,
    `CREATE TABLE ${a}.login_attempts(key TEXT PRIMARY KEY,attempts ${integer} NOT NULL,reset_at ${integer} NOT NULL)`,
    `CREATE TABLE ${a}.portfolio_revision(id INTEGER PRIMARY KEY CHECK(id=1),scope_revision ${integer} NOT NULL)`,
    `CREATE TABLE ${a}.settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    `CREATE TABLE ${l}.imports(id TEXT PRIMARY KEY,label TEXT NOT NULL)`,
    `INSERT INTO ${a}.portfolio_revision VALUES(1,1)`,
  ];
  if(dialect==='sqlite'){
    statements.push(`CREATE UNIQUE INDEX ${a}.fixture_active_site_code ON users(UPPER(TRIM(site_code))) WHERE role='agent' AND active=1 AND TRIM(site_code)<>''`);
    for(const [name,event,table]of [
      ['users_insert','INSERT','users'],['users_delete','DELETE','users'],
      ['users_update','UPDATE OF warehouse_id,active,role,manager_scope','users'],
      ['assignments_insert','INSERT','manager_agents'],['assignments_update','UPDATE','manager_agents'],['assignments_delete','DELETE','manager_agents'],
    ])statements.push(`CREATE TRIGGER ${a}.authority_${name} AFTER ${event} ON ${table} BEGIN UPDATE portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; END`);
  }else if(dialect==='postgresql'){
    statements.push(`CREATE UNIQUE INDEX fixture_active_site_code ON ${a}.users(TRANSLATE(TRIM(site_code),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ') COLLATE "C") WHERE role='agent' AND active=1 AND TRIM(site_code)<>''`);
    statements.push(`CREATE FUNCTION ${a}.authority_bump_scope() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN UPDATE ${a}.portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; RETURN NULL; END $fixture$`);
    for(const [name,event,table]of [
      ['users_insert_delete','INSERT OR DELETE','users'],['users_update','UPDATE OF warehouse_id,active,role,manager_scope','users'],
      ['assignments','INSERT OR UPDATE OR DELETE','manager_agents'],
    ])statements.push(`CREATE TRIGGER authority_${name} AFTER ${event} ON ${a}.${table} FOR EACH ROW EXECUTE FUNCTION ${a}.authority_bump_scope()`);
  }else throw new Error('Unsupported fixture dialect');
  return statements;
}

export async function runAuthoritySessionContract(api,fixture){
  const {database,other,applicationSchema,ledgerSchema}=fixture;
  const a=api.sqlIdentifier(applicationSchema),l=api.sqlIdentifier(ledgerSchema);
  const q=(kind,sqlite,postgresql=sqlite)=>api.sqlQuery(kind,sqlite,postgresql);
  const read=(sql,values=[],postgresql=sql)=>database.read(tx=>tx.query(q('read',sql,postgresql),values));
  const write=(sql,values=[],postgresql=sql,db=database)=>db.write(tx=>tx.query(q('write',sql,postgresql),values));
  const n=value=>api.safeSqlInteger(value);
  let now=1000;
  const repo=(db=database)=>new api.AuthorityRepository(db,applicationSchema,()=>now);
  const globalIdentity={userId:'manager',tokenHash:'fixture-global-token'};
  const regionalIdentity={userId:'fixture-regional',tokenHash:'fixture-regional-token'};
  const agentIdentity={userId:'fixture-agent-a',tokenHash:'fixture-agent-token'};
  const actor=(identity=globalIdentity)=>repo().captureRequestActor(identity);
  const target=(id='fixture-regional')=>repo().readAccount(id);
  const importAuthority={userId:'fixture-regional',profileVersion:1,managerScope:'assigned',tokenHash:'fixture-regional-token'};
  const importInsert=q('write',`INSERT INTO ${l}.imports(id,label) VALUES(?,?)`,`INSERT INTO ${l}.imports(id,label) VALUES($1,$2)`);
  const executeImport=(db=database,action=tx=>tx.query(importInsert,['fixture-import','Synthetic import']))=>
    api.withCapturedAsyncImportAuthorization(db,applicationSchema,importAuthority,action,()=>now);
  const imports=async()=>n((await read(`SELECT COUNT(*) AS n FROM ${l}.imports`)).rows[0].n);
  const sessions=async id=>(await read(`SELECT token_hash FROM ${a}.sessions WHERE user_id=? ORDER BY token_hash`,[id],
    `SELECT token_hash FROM ${a}.sessions WHERE user_id=$1 ORDER BY token_hash`)).rows.map(row=>row.token_hash);
  const attempt=async name=>(await read(`SELECT attempts FROM ${a}.login_attempts WHERE key=?`,[name],
    `SELECT attempts FROM ${a}.login_attempts WHERE key=$1`)).rows.map(row=>n(row.attempts));
  const snapshot=async()=>{
    const result={};
    for(const [table,order]of [['users','id'],['sessions','token_hash'],['manager_agents','manager_id,agent_id'],
      ['login_attempts','key'],['portfolio_revision','id'],['settings','key']])result[table]=(await read(`SELECT * FROM ${a}.${table} ORDER BY ${order}`)).rows;
    return result;
  };
  const reset=()=>database.write(async tx=>{
    for(const table of [l+'.imports',a+'.sessions',a+'.manager_agents',a+'.login_attempts',a+'.users',a+'.settings'])await tx.query(q('write','DELETE FROM '+table));
    const insert=q('write',`INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,?,?,?,?,?,?,0,1,1)`,
      `INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,1,1)`);
    for(const [id,role,scope,warehouse,site]of [
      ['manager','manager','global',null,''],['fixture-global-two','manager','global',null,''],
      ['fixture-regional','manager','assigned',null,''],['fixture-regional-two','manager','assigned',null,''],
      ['fixture-agent-a','agent','assigned','fixture-warehouse-a','SITE-A'],['fixture-agent-b','agent','assigned','fixture-warehouse-b','SITE-B'],
    ])await tx.query(insert,[id,id,'Fictional '+id,role,scope,warehouse,warehouse,site,'opaque-fixture-value-'+id]);
    const putSession=q('write',`INSERT INTO ${a}.sessions VALUES(?,?,?)`,`INSERT INTO ${a}.sessions VALUES($1,$2,$3)`);
    for(const [token,id,expiry]of [
      ['fixture-global-token','manager',2000],['fixture-global-other','manager',2000],
      ['fixture-regional-token','fixture-regional',2000],['fixture-regional-other','fixture-regional',2000],
      ['fixture-agent-token','fixture-agent-a',2000],['fixture-agent-b-token','fixture-agent-b',2000],
      ['fixture-expired-token','fixture-regional',500],
    ])await tx.query(putSession,[token,id,expiry]);
    for(const [manager,agent]of [['fixture-regional','fixture-agent-a'],['fixture-regional-two','fixture-agent-b']]){
      await tx.query(q('write',`INSERT INTO ${a}.manager_agents VALUES(?,?)`,`INSERT INTO ${a}.manager_agents VALUES($1,$2)`),[manager,agent]);
    }
    for(const key of ['account:fixture-regional','account:fixture-agent-a','account:fixture-renamed'])await tx.query(q('write',
      `INSERT INTO ${a}.login_attempts VALUES(?,4,5000)`,`INSERT INTO ${a}.login_attempts VALUES($1,4,5000)`),[key]);
    await tx.query(q('write',`UPDATE ${a}.portfolio_revision SET scope_revision=100 WHERE id=1`));
  });
  const cases=[];
  const check=async(name,action)=>{await reset();now=1000;await action();cases.push(name);};
  const status=expected=>error=>error instanceof api.AccountWriteError&&error.status===expected;
  const delegated=(db,queryHook,afterWrite)=>({
    read:action=>db.read(action),close:()=>Promise.resolve(),
    write:(action,authority)=>db.write(async tx=>{
      const proxy=queryHook?{dialect:tx.dialect,query:(query,values)=>queryHook(tx,query,values)}:tx;
      const result=await action(proxy);if(afterWrite)await afterWrite();return result;
    },authority),
  });
  const managerInput=(row,extra={})=>({target:row,username:row.username,name:row.name,agentIds:['fixture-agent-a'],...extra});

  await check('session_read_and_refresh_share_active_user_contract',async()=>{
    assert.equal((await repo().readSession(regionalIdentity.tokenHash)).user.id,regionalIdentity.userId);
    assert.equal(await repo().readSession('missing-fixture-token'),null);
    const fresh=await repo().refreshSession(regionalIdentity.tokenHash);
    assert.equal(fresh.expiresAt,now+api.ASYNC_SESSION_TTL_MS);
    assert.equal(fresh.user.profileVersion,1);
    assert.equal(await repo().refreshSession('fixture-expired-token'),null);
    await write(`UPDATE ${a}.users SET active=0 WHERE id='fixture-regional'`);
    assert.equal(await repo().readSession(regionalIdentity.tokenHash),null);
    assert.equal(await repo().refreshSession(regionalIdentity.tokenHash),null);
  });
  await check('logout_revokes_exact_session_without_self_postcheck',async()=>{
    await repo().logout(regionalIdentity);
    assert.deepEqual(await sessions(regionalIdentity.userId),['fixture-expired-token','fixture-regional-other']);
    await assert.rejects(repo().logout({...regionalIdentity,tokenHash:globalIdentity.tokenHash}),status(401));
    assert.equal((await repo().readSession(globalIdentity.tokenHash)).user.id,'manager');
  });
  await check('login_rate_limit_commits_denied_attempt_and_preserves_ip_first',async()=>{
    for(let i=1;i<=6;i++)assert.equal((await repo().reserveLoginAttempt('fixture-regional','fixture-ip')).allowed,true);
    assert.equal((await repo().reserveLoginAttempt('fixture-regional','fixture-ip')).allowed,false);
    assert.deepEqual(await attempt('account:fixture-regional'),[11]);
    await write(`INSERT INTO ${a}.login_attempts VALUES('ip:blocked-fixture-ip',80,5000)`);
    const denied=await repo().reserveLoginAttempt('unseen-fixture-user','blocked-fixture-ip');
    assert.equal(denied.allowed,false);assert.equal(denied.accountAttempts,null);
    assert.deepEqual(await attempt('account:unseen-fixture-user'),[]);
    assert.deepEqual(await attempt('ip:blocked-fixture-ip'),[80]);
  });
  await check('login_counter_window_and_cleanup_are_bounded',async()=>{
    await database.write(async tx=>{
      for(let i=0;i<105;i++)await tx.query(q('write',`INSERT INTO ${a}.login_attempts VALUES(?,1,0)`,
        `INSERT INTO ${a}.login_attempts VALUES($1,1,0)`),['expired-fixture-'+i]);
    });
    await repo().reserveLoginAttempt('new-fixture-user','new-fixture-ip');
    assert.equal(n((await read(`SELECT COUNT(*) AS n FROM ${a}.login_attempts WHERE reset_at=0`)).rows[0].n),5);
    now=901001;
    const renewed=await repo().reserveLoginAttempt('new-fixture-user','new-fixture-ip');
    assert.equal(renewed.ipAttempts,1);assert.equal(renewed.accountAttempts,1);
  });
  await check('wrong_password_keeps_counters_and_verifier_runs_outside_lock',async()=>{
    let verification=false;
    await assert.rejects(repo().authenticate({username:'fixture-regional',ipHash:'fixture-ip',
      verify:async encoded=>{verification=true;assert.equal(encoded,'opaque-fixture-value-fixture-regional');
        await other.write(tx=>tx.query(q('write',`INSERT INTO ${a}.settings VALUES('verifier-was-unlocked','yes')`)));return false;},
      issueTokenHash:()=>{throw new Error('Token must not be issued');}}),status(401));
    assert.equal(verification,true);assert.deepEqual(await attempt('account:fixture-regional'),[5]);
    assert.equal(n((await read(`SELECT COUNT(*) AS n FROM ${a}.settings`)).rows[0].n),1);
  });
  await check('missing_login_user_still_calls_fallback_verifier',async()=>{
    let verified=0;
    await assert.rejects(repo().authenticate({username:'missing-fixture-user',ipHash:'fixture-ip',
      verify:async encoded=>{assert.equal(encoded,null);verified++;return true;},issueTokenHash:()=>{throw new Error('Unexpected token');}}),status(401));
    assert.equal(verified,1);assert.deepEqual(await attempt('account:missing-fixture-user'),[1]);
  });
  await check('login_cas_uses_fresh_time_and_cleans_only_after_success',async()=>{
    const successful=await repo().authenticate({username:'fixture-regional',ipHash:'fixture-ip',
      verify:async()=>{now=1500;return true;},issueTokenHash:()=> 'fixture-new-token'});
    assert.equal(successful.expiresAt,1500+api.ASYNC_SESSION_TTL_MS);
    assert.deepEqual(await attempt('account:fixture-regional'),[]);
    assert(!((await sessions('fixture-regional')).includes('fixture-expired-token')));
    assert.deepEqual(await attempt('ip:fixture-ip'),[1]);
  });
  await check('stale_login_hash_or_revision_cannot_cleanup_or_create_session',async()=>{
    const before=await snapshot();
    const stale=await repo().loginCredential('fixture-regional');
    await write(`UPDATE ${a}.users SET password_hash='changed-fixture',profile_revision=profile_revision+1 WHERE id='fixture-regional'`);
    const afterReset=await snapshot();
    await assert.rejects(repo().createLoginSession(stale,'fixture-stale-token'),status(401));
    assert.deepEqual(await snapshot(),afterReset);
    assert.deepEqual((await snapshot()).sessions,before.sessions);
  });
  await check('login_hash_verification_can_lose_to_committed_password_reset',async()=>{
    const globalActor=await actor(),row=await target();
    await assert.rejects(repo().authenticate({username:row.username,ipHash:'fixture-ip',verify:async()=>{
      await repo(other).updateManager(globalActor,managerInput(row,{passwordHash:'reset-fixture-value'}));return true;
    },issueTokenHash:()=> 'fixture-late-token'}),status(401));
    assert.deepEqual(await sessions(row.id),[]);
    assert.equal((await repo().loginCredential(row.username)).passwordHash,'reset-fixture-value');
  });

  await check('own_password_preserves_current_session_and_clears_change_requirement',async()=>{
    await write(`UPDATE ${a}.users SET must_change_password=1 WHERE id='fixture-regional'`);
    const expected=await repo().ownPasswordCredential(regionalIdentity);
    await repo().changeOwnPassword(regionalIdentity,expected,'changed-fixture-value');
    const live=await repo().readSession(regionalIdentity.tokenHash);
    assert.equal(live.user.mustChangePassword,false);assert.equal(live.user.profileVersion,2);
    assert.deepEqual(await sessions(regionalIdentity.userId),[regionalIdentity.tokenHash]);
    assert.deepEqual(await attempt('account:fixture-regional'),[4]);
  });
  await check('administrative_reset_wins_over_stale_own_password_change',async()=>{
    const expected=await repo().ownPasswordCredential(regionalIdentity),globalActor=await actor(),row=await target();
    await repo().updateManager(globalActor,managerInput(row,{passwordHash:'administrative-fixture-reset'}));
    const before=await snapshot();
    await assert.rejects(repo().changeOwnPassword(regionalIdentity,expected,'late-self-fixture-value'),status(409));
    assert.deepEqual(await snapshot(),before);
  });
  await check('own_password_stale_revision_keeps_other_device_sessions',async()=>{
    const expected=await repo().ownPasswordCredential(regionalIdentity);
    await write(`UPDATE ${a}.users SET profile_revision=profile_revision+1 WHERE id='fixture-regional'`);
    const before=await snapshot();
    await assert.rejects(repo().changeOwnPassword(regionalIdentity,expected,'late-fixture-value'),status(409));
    assert.deepEqual(await snapshot(),before);
  });
  await check('own_password_checks_exact_user_and_manager_role',async()=>{
    const expected=await repo().ownPasswordCredential(regionalIdentity);
    await assert.rejects(async()=>repo().changeOwnPassword(globalIdentity,expected,'new-fixture-value'),status(403));
    await assert.rejects(repo().ownPasswordCredential(agentIdentity),status(403));
    await assert.rejects(repo().ownPasswordCredential({...regionalIdentity,tokenHash:globalIdentity.tokenHash}),status(401));
  });
  await check('auth_password_does_not_inherit_admin_portfolio_snapshot',async()=>{
    const expected=await repo().ownPasswordCredential(regionalIdentity);
    await write(`UPDATE ${a}.portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1`);
    await repo().changeOwnPassword(regionalIdentity,expected,'new-fixture-value');
    assert.equal((await repo().readSession(regionalIdentity.tokenHash)).user.profileVersion,2);
  });

  await check('global_manager_creation_is_assigned_and_assignment_set_is_exact',async()=>{
    await repo().createManager(await actor(),{id:'fixture-created-manager',username:'fixture-created-manager',name:'Created Fictional Manager',
      passwordHash:'new-fixture-value',agentIds:['fixture-agent-a','fixture-agent-a','fixture-agent-b']});
    const created=await repo().readAccount('fixture-created-manager');
    assert.equal(created.role,'manager');assert.equal(created.managerScope,'assigned');assert.equal(created.profileVersion,1);
    assert.equal(created.mustChangePassword,false);
    const ids=(await read(`SELECT agent_id FROM ${a}.manager_agents WHERE manager_id='fixture-created-manager' ORDER BY agent_id`)).rows.map(row=>row.agent_id);
    assert.deepEqual(ids,['fixture-agent-a','fixture-agent-b']);
  });
  await check('manager_update_replaces_assignments_increments_revision_preserves_sessions',async()=>{
    const before=await sessions('fixture-regional');
    await repo().updateManager(await actor(),managerInput(await target(),{name:'Updated Fictional Manager',agentIds:['fixture-agent-b']}));
    assert.equal((await target()).profileVersion,2);assert.deepEqual(await sessions('fixture-regional'),before);
    assert.deepEqual((await read(`SELECT agent_id FROM ${a}.manager_agents WHERE manager_id='fixture-regional'`)).rows.map(row=>row.agent_id),['fixture-agent-b']);
    await assert.rejects(executeImport(),error=>error.status===401);
  });
  await check('manager_rename_cleans_both_counter_names_and_revokes_all_other_accounts_sessions',async()=>{
    await repo().updateManager(await actor(),managerInput(await target(),{username:'fixture-renamed'}));
    assert.deepEqual(await attempt('account:fixture-regional'),[]);assert.deepEqual(await attempt('account:fixture-renamed'),[]);
    assert.deepEqual(await sessions('fixture-regional'),[]);
  });
  await check('self_global_manager_credential_update_preserves_own_device',async()=>{
    await repo().updateManager(await actor(),managerInput(await target('manager'),{username:'fixture-global-renamed',passwordHash:'new-global-fixture'}));
    assert.deepEqual(await sessions('manager'),[globalIdentity.tokenHash]);
    assert.equal((await repo().readSession(globalIdentity.tokenHash)).user.profileVersion,2);
  });
  await check('other_global_manager_cannot_be_modified',async()=>{
    const before=await snapshot();
    await assert.rejects(repo().updateManager(await actor(),managerInput(await target('fixture-global-two'))),status(403));
    assert.deepEqual(await snapshot(),before);
  });
  await check('assigned_manager_cannot_create_or_update_managers',async()=>{
    const regional=await actor(regionalIdentity);
    await assert.rejects(repo().createManager(regional,{id:'fixture-new',username:'fixture-new',name:'New',passwordHash:'fixture-value',agentIds:[]}),status(403));
    await assert.rejects(repo().updateManager(regional,managerInput(await target())),status(403));
  });
  await check('manager_assignment_validation_is_inside_writer_lock',async()=>{
    const globalActor=await actor(),row=await target();
    await write(`UPDATE ${a}.users SET active=0 WHERE id='fixture-agent-b'`);
    await assert.rejects(repo().updateManager(globalActor,managerInput(row,{agentIds:['fixture-agent-b']})),status(409));
    await assert.rejects(repo().updateManager(await actor(),managerInput(row,{agentIds:['fixture-agent-b']})),status(400));
  });
  await check('stale_admin_actor_profile_or_portfolio_snapshot_refuses_all_changes',async()=>{
    const original=await actor(),row=await target();
    await write(`UPDATE ${a}.users SET profile_revision=profile_revision+1 WHERE id='manager'`);
    const before=await snapshot();
    await assert.rejects(repo().updateManager(original,managerInput(row)),status(409));
    assert.deepEqual(await snapshot(),before);
    const recaptured=await actor();await write(`UPDATE ${a}.portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1`);
    const next=await snapshot();await assert.rejects(repo().updateManager(recaptured,managerInput(row)),status(409));
    assert.deepEqual(await snapshot(),next);
  });
  await check('admin_wrong_session_scope_and_must_change_password_are_denied',async()=>{
    const original=await actor(),row=await target();
    await assert.rejects(repo().updateManager({...original,tokenHash:regionalIdentity.tokenHash},managerInput(row)),status(409));
    await assert.rejects(repo().updateManager({...original,managerScope:'assigned'},managerInput(row)),status(409));
    await write(`UPDATE ${a}.users SET must_change_password=1 WHERE id='manager'`);
    await assert.rejects(repo().captureRequestActor(globalIdentity),status(428));
    await assert.rejects(repo().updateManager(original,managerInput(row)),status(409));
  });
  await check('stale_manager_target_has_no_assignment_session_or_attempt_cleanup',async()=>{
    const original=await actor(),row=await target();
    await write(`UPDATE ${a}.users SET profile_revision=2 WHERE id='fixture-regional'`);
    const before=await snapshot();await assert.rejects(repo().updateManager(original,managerInput(row,{passwordHash:'late-fixture',agentIds:[]})),status(409));
    assert.deepEqual(await snapshot(),before);
  });
  await check('zero_cas_rowcount_cannot_reuse_a_previous_statement_count',async()=>{
    const original=await actor(),row=await target(),before=await snapshot();let rejectedUpdate=false;
    const fault=delegated(database,async(tx,query,values)=>{
      if(query.kind==='write'&&/^UPDATE .*\.users SET username=/.test(query.sqlite)){rejectedUpdate=true;return{rows:[],changes:0};}
      return tx.query(query,values);
    });
    await assert.rejects(repo(fault).updateManager(original,managerInput(row,{passwordHash:'late-fixture',agentIds:[]})),status(409));
    assert.equal(rejectedUpdate,true);assert.deepEqual(await snapshot(),before);
  });
  await check('manager_cleanup_failure_rolls_back_cas_assignments_counters_and_sessions',async()=>{
    const original=await actor(),row=await target(),before=await snapshot();let injected=false;
    const fault=delegated(database,async(tx,query,values)=>{
      const result=await tx.query(query,values);
      if(query.kind==='write'&&query.sqlite.startsWith('DELETE FROM '+a+'.sessions')){injected=true;throw new Error('Synthetic cleanup failure');}
      return result;
    });
    await assert.rejects(repo(fault).updateManager(original,managerInput(row,{passwordHash:'changed-fixture',agentIds:['fixture-agent-b']})),/Synthetic cleanup failure/);
    assert.equal(injected,true);assert.deepEqual(await snapshot(),before);
  });
  await check('manager_creation_assignment_failure_rolls_back_new_user',async()=>{
    const original=await actor(),before=await snapshot();
    const fault=delegated(database,async(tx,query,values)=>{
      const result=await tx.query(query,values);
      if(query.sqlite.startsWith('INSERT INTO '+a+'.manager_agents'))throw new Error('Synthetic assignment failure');
      return result;
    });
    await assert.rejects(repo(fault).createManager(original,{id:'fixture-new',username:'fixture-new',name:'New',passwordHash:'fixture-value',agentIds:['fixture-agent-a']}),/Synthetic assignment failure/);
    assert.deepEqual(await snapshot(),before);
  });
  await check('expiry_during_admin_cleanup_rolls_back_intended_mutations',async()=>{
    const original=await actor(),row=await target(),before=await snapshot();
    const delayed=delegated(database,async(tx,query,values)=>{
      const result=await tx.query(query,values);
      if(query.sqlite.startsWith('DELETE FROM '+a+'.sessions'))now=2000;
      return result;
    });
    await assert.rejects(repo(delayed).updateManager(original,managerInput(row,{passwordHash:'changed-fixture'})),status(409));
    assert.deepEqual(await snapshot(),before);
  });
  await check('expiry_during_own_password_cleanup_rolls_back_without_old_profile_postcheck',async()=>{
    const expected=await repo().ownPasswordCredential(regionalIdentity),before=await snapshot();
    const delayed=delegated(database,async(tx,query,values)=>{
      const result=await tx.query(query,values);
      if(query.sqlite.startsWith('DELETE FROM '+a+'.sessions'))now=2000;
      return result;
    });
    await assert.rejects(repo(delayed).changeOwnPassword(regionalIdentity,expected,'changed-fixture'),status(409));
    assert.deepEqual(await snapshot(),before);
  });

  await check('assigned_manager_can_change_assigned_agent_credentials_only',async()=>{
    const regional=await actor(regionalIdentity),agent=await target('fixture-agent-a');
    await repo().updateAgentCredentials(regional,agent,'fixture-renamed','changed-agent-fixture');
    assert.deepEqual(await sessions(agent.id),[]);assert.deepEqual(await attempt('account:fixture-agent-a'),[]);
    assert.deepEqual(await attempt('account:fixture-renamed'),[4]);
    assert.equal((await target(agent.id)).profileVersion,2);
    await assert.rejects(repo().resetAgentPassword(await actor(regionalIdentity),await target('fixture-agent-b'),'forbidden-fixture'),status(403));
  });
  await check('agent_password_reset_revokes_sessions_after_exact_target_cas',async()=>{
    const original=await actor(regionalIdentity),agent=await target('fixture-agent-a');
    await repo().resetAgentPassword(original,agent,'reset-agent-fixture');
    assert.deepEqual(await sessions(agent.id),[]);assert.deepEqual(await attempt('account:fixture-agent-a'),[]);
    const before=await snapshot();await assert.rejects(repo().resetAgentPassword(original,agent,'stale-agent-fixture'),status(409));
    assert.deepEqual(await snapshot(),before);
  });
  await check('agent_profile_change_preserves_sessions_and_warehouse_identity',async()=>{
    const agent=await target('fixture-agent-a'),before=await sessions(agent.id);
    await repo().updateAgentProfile(await actor(regionalIdentity),agent,{name:'Edited Fictional Agent',warehouseName:'Edited Warehouse Label',siteCode:agent.siteCode});
    const updated=await target(agent.id);assert.equal(updated.profileVersion,2);assert.equal(updated.warehouseId,agent.warehouseId);
    assert.deepEqual(await sessions(agent.id),before);
  });
  await check('site_code_change_requires_global_and_rejects_ascii_case_collision',async()=>{
    const agent=await target('fixture-agent-a');
    await assert.rejects(repo().updateAgentProfile(await actor(regionalIdentity),agent,{name:agent.name,warehouseName:'Warehouse',siteCode:'CHANGED'}),status(403));
    await assert.rejects(repo().updateAgentProfile(await actor(),agent,{name:agent.name,warehouseName:'Warehouse',siteCode:'site-b'}),status(409));
    await repo().updateAgentProfile(await actor(),agent,{name:agent.name,warehouseName:'Warehouse',siteCode:'UNIQUE'});
    assert.equal((await target(agent.id)).siteCode,'UNIQUE');
  });
  await check('site_code_non_ascii_case_keeps_sqlite_ascii_upper_semantics',async()=>{
    await write(`UPDATE ${a}.users SET site_code='ă' WHERE id='fixture-agent-b'`);
    const agent=await target('fixture-agent-a');
    await repo().updateAgentProfile(await actor(),agent,{name:agent.name,warehouseName:'Warehouse',siteCode:'Ă'});
    assert.equal((await target(agent.id)).siteCode,'Ă');
  });
  await check('toggle_agent_revokes_devices_and_failed_reactivation_is_atomic',async()=>{
    const agent=await target('fixture-agent-a');
    await repo().toggleAgentActive(await actor(regionalIdentity),agent);
    assert.equal((await target(agent.id)).active,false);assert.deepEqual(await sessions(agent.id),[]);
    await write(`UPDATE ${a}.users SET site_code='SITE-A' WHERE id='fixture-agent-b'`);
    const inactive=await target(agent.id),before=await snapshot();
    await assert.rejects(repo().toggleAgentActive(await actor(regionalIdentity),inactive),status(409));
    assert.deepEqual(await snapshot(),before);
    await write(`UPDATE ${a}.users SET site_code='OTHER-SITE' WHERE id='fixture-agent-b'`);
    await repo().toggleAgentActive(await actor(regionalIdentity),inactive);
    assert.equal((await target(agent.id)).active,true);
  });
  await check('agent_creation_requires_global_and_server_catalog_warehouse',async()=>{
    const input={id:'fixture-created-agent',username:'fixture-created-agent',name:'Fictional Agent',warehouseId:'fixture-warehouse-a',passwordHash:'new-agent-fixture'};
    await assert.rejects(repo().createAgent(await actor(regionalIdentity),input,['fixture-warehouse-a']),status(403));
    await assert.rejects(async()=>repo().createAgent(await actor(),input,['different-fixture-warehouse']),status(400));
    await repo().createAgent(await actor(),input,['fixture-warehouse-a']);
    const created=await target(input.id);assert.equal(created.role,'agent');assert.equal(created.mustChangePassword,false);
    assert.equal(created.warehouseId,'fixture-warehouse-a');assert.equal(created.profileVersion,1);
  });
  await check('captured_admin_actor_loses_access_after_assignment_replacement',async()=>{
    const regional=await actor(regionalIdentity),agent=await target('fixture-agent-a');
    await repo().updateManager(await actor(),managerInput(await target(),{agentIds:['fixture-agent-b']}));
    await assert.rejects(repo().resetAgentPassword(regional,agent,'late-fixture'),status(409));
    await assert.rejects(repo().resetAgentPassword(await actor(regionalIdentity),agent,'late-fixture'),status(403));
  });

  // For manager active/role/must-change/scope there is no arbitrary HTTP setter.
  // Those migration/administrative fixtures explicitly use the shared writer;
  // logout, profile and assignments exercise the repository methods themselves.
  const revokers={
    logout:async()=>db=>repo(db).logout(regionalIdentity),
    expiry:async()=>db=>write(`UPDATE ${a}.sessions SET expires_at=0 WHERE token_hash='fixture-regional-token'`,[],undefined,db),
    inactive:async()=>db=>write(`UPDATE ${a}.users SET active=0 WHERE id='fixture-regional'`,[],undefined,db),
    role:async()=>db=>write(`UPDATE ${a}.users SET role='agent' WHERE id='fixture-regional'`,[],undefined,db),
    must_change_password:async()=>db=>write(`UPDATE ${a}.users SET must_change_password=1 WHERE id='fixture-regional'`,[],undefined,db),
    manager_scope:async()=>db=>write(`UPDATE ${a}.users SET manager_scope='global' WHERE id='fixture-regional'`,[],undefined,db),
    profile_revision:async()=>{const auth=await actor(),row=await target();return db=>repo(db).updateManager(auth,managerInput(row,{name:'Revised Fictional Manager'}));},
    manager_agents:async()=>{const auth=await actor(),row=await target();return db=>repo(db).updateManager(auth,managerInput(row,{agentIds:['fixture-agent-b']}));},
  };
  for(const [name,prepare]of Object.entries(revokers)){
    await check('import_commits_before_'+name+'_revocation',async()=>{
      const revoke=await prepare(),entered=deferred(),finish=deferred();
      const pending=executeImport(database,async tx=>{await tx.query(importInsert,['before','Synthetic import']);entered.resolve();await finish.promise;});
      await entered.promise;let revocationEntered=false;
      const wrapped=delegated(other,undefined,async()=>{revocationEntered=true;});
      const revocation=revoke(wrapped);let settled;
      try{await pause();assert.equal(revocationEntered,false);}finally{finish.resolve();settled=await Promise.allSettled([pending,revocation]);}
      assert(settled.every(result=>result.status==='fulfilled'));
      assert.equal(await imports(),1);await assert.rejects(executeImport(),error=>error.status===401);
    });
    await check(name+'_revocation_commits_before_waiting_import',async()=>{
      const revoke=await prepare(),entered=deferred(),finish=deferred();
      const wrapped=delegated(other,undefined,async()=>{entered.resolve();await finish.promise;});
      const revocation=revoke(wrapped);await entered.promise;let importEntered=false;
      const pending=executeImport(database,async tx=>{importEntered=true;return tx.query(importInsert,['after','Synthetic import']);});
      const denied=assert.rejects(pending,error=>error.status===401);
      try{await pause();assert.equal(importEntered,false);}finally{finish.resolve();await Promise.allSettled([revocation,denied]);}
      await revocation;await denied;assert.equal(await imports(),0);assert.equal(importEntered,false);
    });
  }
  for(const [name,prepare]of Object.entries({
    refresh:async()=>()=>repo().refreshSession(regionalIdentity.tokenHash),
    logout:async()=>()=>repo().logout(regionalIdentity),
    own_password:async()=>{const expected=await repo().ownPasswordCredential(regionalIdentity);return()=>repo().changeOwnPassword(regionalIdentity,expected,'late-fixture');},
    admin:async()=>{const auth=await actor(),row=await target();return()=>repo().updateManager(auth,managerInput(row));},
  })){
    await check(name+'_reads_expiry_after_waiting_for_writer_lock',async()=>{
      const operation=await prepare(),entered=deferred(),finish=deferred();
      const blocker=other.write(async()=>{entered.resolve();await finish.promise;});await entered.promise;
      const pending=operation();const result=name==='refresh'?pending:assert.rejects(pending,status(name==='admin'||name==='own_password'?409:401));
      try{await pause();now=2000;}finally{finish.resolve();await Promise.allSettled([blocker,result]);}
      await blocker;if(name==='refresh')assert.equal(await result,null);else await result;
      assert.equal((await target()).profileVersion,1);assert((await sessions('fixture-regional')).includes(regionalIdentity.tokenHash));
    });
  }
  await check('login_reservation_and_session_expiry_use_post_wait_clock',async()=>{
    const expected=await repo().loginCredential('fixture-regional'),entered=deferred(),finish=deferred();
    const blocker=other.write(async()=>{entered.resolve();await finish.promise;});await entered.promise;
    const reservation=repo().reserveLoginAttempt('fresh-fixture-user','fresh-fixture-ip');
    const login=repo().createLoginSession(expected,'fixture-waited-token');
    await pause();now=2500;finish.resolve();await blocker;await reservation;
    assert.equal((await login).expiresAt,2500+api.ASYNC_SESSION_TTL_MS);
    const row=(await read(`SELECT reset_at FROM ${a}.login_attempts WHERE key='ip:fresh-fixture-ip'`)).rows[0];
    assert.equal(n(row.reset_at),2500+900000);
  });
  await check('request_inputs_are_captured_before_waiting_for_lock',async()=>{
    const original={...await actor()},row=await target(),input=managerInput(row,{name:'Captured Name',agentIds:['fixture-agent-a']});
    const entered=deferred(),finish=deferred(),blocker=other.write(async()=>{entered.resolve();await finish.promise;});await entered.promise;
    const pending=repo().updateManager(original,input);
    original.tokenHash='changed-by-caller';input.name='Changed Name';input.agentIds.push('fixture-agent-b');
    finish.resolve();await blocker;await pending;
    assert.equal((await target()).name,'Captured Name');
    assert.equal(n((await read(`SELECT COUNT(*) AS n FROM ${a}.manager_agents WHERE manager_id='fixture-regional'`)).rows[0].n),1);
  });
  await check('seed_scope_initializer_is_explicit_fixed_and_idempotent',async()=>{
    await write(`UPDATE ${a}.users SET manager_scope='assigned' WHERE id='manager'`);
    const authority={userId:'manager',profileVersion:1,managerScope:'assigned',tokenHash:globalIdentity.tokenHash};
    assert.equal(await repo().initializeSeedManagerScope(),1);assert.equal(await repo().initializeSeedManagerScope(),0);
    assert.equal((await target()).managerScope,'assigned');
    await assert.rejects(api.withCapturedAsyncImportAuthorization(database,applicationSchema,authority,
      tx=>tx.query(importInsert,['stale-seed-scope','Synthetic']),()=>now),error=>error.status===401);
  });
  await check('one_time_assignment_initializer_rejects_populated_table',async()=>{
    await assert.rejects(repo().initializeAssignmentsForNewTable(),/newly created empty table/);
    await write(`DELETE FROM ${a}.manager_agents`);
    assert.equal(await repo().initializeAssignmentsForNewTable(),4);
    assert.equal(n((await read(`SELECT COUNT(*) AS n FROM ${a}.manager_agents WHERE manager_id='manager'`)).rows[0].n),0);
  });
  return cases;
}
