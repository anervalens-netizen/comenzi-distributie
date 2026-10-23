// Deterministic revocation during password derivation, using the real route,
// authentication helpers and SQLite mutation statements with synthetic accounts.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const database=new DatabaseSync(':memory:');
const temporary=mkdtempSync(join(tmpdir(),'agent-account-authorization-'));
const serverPath=resolve('lib/server.ts'),routePath=resolve('app/api/[...path]/route.ts');
const routeSource=readFileSync(routePath,'utf8'),unrelated=new Map();
for(const match of routeSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](@\/lib\/[^'"]+)['"]/g)){
  if(!['@/lib/server','@/lib/runtime','@/lib/customer-counts'].includes(match[2]))unrelated.set(match[2],match[1].split(',').map(name=>name.trim().split(/\s+as\s+/)[0]));
}
function statement(sql,args=[]){return {
  bind(...values){return statement(sql,values);},
  async first(){return database.prepare(sql).get(...args)||null;},
  async all(){return {results:database.prepare(sql).all(...args)};},
  async run(){beforeWrite();return {meta:{changes:Number(database.prepare(sql).run(...args).changes)}};},
  execute(){return {meta:{changes:Number(database.prepare(sql).run(...args).changes)}};},
};}
const fixture={
  prepare:statement,
  async batch(statements){beforeWrite();database.exec('BEGIN IMMEDIATE');try{const results=statements.map(statement=>statement.execute());database.exec('COMMIT');return results;}catch(error){database.exec('ROLLBACK');throw error;}},
  hash:async()=>{throw new Error('Unexpected password derivation');},
  verify:null,
  beforeWrite:null,
};
function beforeWrite(){const action=fixture.beforeWrite;fixture.beforeWrite=null;action?.();}
globalThis.__agentAccountFixture=fixture;
try{
  const output=join(temporary,'route.mjs');
  await build({entryPoints:[routePath],outfile:output,bundle:true,platform:'node',format:'esm',plugins:[{
    name:'synthetic-agent-account-boundary',
    setup(build){
      build.onResolve({filter:/^@\/lib\//},({path})=>path==='@/lib/request-timing'?{path:resolve('lib/request-timing.ts')}:{path,namespace:'agent-account-test'});
      build.onLoad({filter:/.*/,namespace:'agent-account-test'},({path})=>{
        if(path==='@/lib/server')return {loader:'js',resolveDir:process.cwd(),contents:`import {verifyPassword as originalVerifyPassword} from ${JSON.stringify(serverPath)};export * from ${JSON.stringify(serverPath)};export const hashPassword=password=>globalThis.__agentAccountFixture.hash(password);export const verifyPassword=(...args)=>globalThis.__agentAccountFixture.verify?globalThis.__agentAccountFixture.verify(...args):originalVerifyPassword(...args);`};
        if(path==='@/lib/runtime')return {loader:'js',contents:`export const runtimeKind='node';export const env={DB:globalThis.__agentAccountFixture};export const operationalStatus=()=>({});`};
        if(path==='@/lib/customer-counts')return {loader:'js',contents:`export const selectUsersWithClientCounts=()=>"SELECT u.*,0 client_count FROM users u";`};
        const names=unrelated.get(path);assert(names,'Unrecognized fixture boundary '+path);
        return {loader:'js',contents:names.map(name=>`export const ${name}=()=>{throw new Error('Unexpected unrelated service: ${name}');};`).join('\n')};
      });
    },
  }]});
  const route=await import(pathToFileURL(output));
  database.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,name TEXT,role TEXT,manager_scope TEXT DEFAULT 'assigned',warehouse_id TEXT,warehouse_name TEXT,site_code TEXT DEFAULT '',password_hash TEXT,profile_revision INTEGER NOT NULL DEFAULT 1,must_change_password INTEGER DEFAULT 0,active INTEGER DEFAULT 1);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
    CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
    CREATE TABLE login_attempts(key TEXT PRIMARY KEY,attempts INTEGER,reset_at INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);INSERT INTO settings VALUES('seed-v1','1');`);
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const actor='synthetic-manager',target='synthetic-agent',actorToken='synthetic-manager-session';
  function reset(scope='assigned',assigned=true){
    fixture.beforeWrite=null;fixture.verify=null;
    database.exec('DELETE FROM users;DELETE FROM sessions;DELETE FROM manager_agents;DELETE FROM login_attempts;');
    const insert=database.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,1,0,1)');
    insert.run(actor,actor,'Synthetic manager','manager',scope,null,null,'','synthetic-original-manager-hash');
    insert.run(target,target,'Synthetic agent','agent','assigned','warehouse','Synthetic warehouse','SITE','synthetic-original-agent-hash');
    const session=database.prepare('INSERT INTO sessions VALUES(?,?,?)');
    session.run(digest(actorToken),actor,Date.now()+3600000);
    session.run(digest('synthetic-agent-session-1'),target,Date.now()+3600000);
    session.run(digest('synthetic-agent-session-2'),target,Date.now()+3600000);
    database.prepare('INSERT INTO login_attempts VALUES(?,3,?)').run('account:'+target,Date.now()+3600000);
    if(assigned)database.prepare('INSERT INTO manager_agents VALUES(?,?)').run(actor,target);
  }
  const snapshot=()=>({
    target:database.prepare('SELECT * FROM users WHERE id=?').get(target),
    sessions:database.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY token_hash').all(target),
    attempts:database.prepare('SELECT * FROM login_attempts ORDER BY key').all(),
  });
  const request=(method,body)=>{
    const options={headers:{Cookie:'mobiup_session='+actorToken,'Content-Type':'application/json'},body:JSON.stringify(body)};
    return method==='PUT'?new Request('http://synthetic.invalid/api/admin/users/'+target,{...options,method:'PUT'}):new Request('http://synthetic.invalid/api/admin/users',{...options,method:'POST'});
  };
  const payload=method=>method==='PUT'?{username:target,password:'synthetic-new-password',version:'1'}:{action:'reset',id:target,password:'synthetic-new-password',version:'1'};
  let checks=0;
  for(const method of ['PUT','POST']){
    for(const [name,scope,assigned,mutation] of [
      ['actor session revoked','global',false,()=>database.prepare('DELETE FROM sessions WHERE user_id=?').run(actor)],
      ['actor session expired','global',false,()=>database.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(actor)],
      ['actor session rebound','global',false,()=>database.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run(target,actor)],
      ['assignment revoked','assigned',true,()=>database.prepare('DELETE FROM manager_agents WHERE manager_id=?').run(actor)],
      ['actor deactivated','global',false,()=>database.prepare('UPDATE users SET active=0 WHERE id=?').run(actor)],
      ['actor demoted to agent','global',false,()=>database.prepare("UPDATE users SET role='agent' WHERE id=?").run(actor)],
      ['global scope revoked','global',false,()=>database.prepare("UPDATE users SET manager_scope='assigned' WHERE id=?").run(actor)],
      ['target promoted','global',false,()=>database.prepare("UPDATE users SET role='manager' WHERE id=?").run(target)],
      ['target revision changed','global',false,()=>database.prepare('UPDATE users SET profile_revision=2,password_hash=? WHERE id=?').run('synthetic-concurrent-agent-hash',target)],
    ]){
      reset(scope,assigned);const originalActive=snapshot().target.active;
      let started,release;
      const deriving=new Promise(resolve=>{started=resolve;}),continueHash=new Promise(resolve=>{release=resolve;});
      fixture.hash=async()=>{started();await continueHash;return 'synthetic-replacement-hash';};
      const pending=route[method](request(method,payload(method)));
      await deriving;
      mutation();
      const expected=snapshot();
      assert.equal(expected.target.profile_revision,name==='target revision changed'?2:1,'authority revocation does not rely on a target revision change');
      release();
      const response=await pending;
      assert.equal(response.status,409,method+': '+name+' must deny the in-flight reset');
      assert.deepEqual(snapshot(),expected,method+': '+name+' preserves target credential, sessions and login-attempt state');
      assert.equal(snapshot().target.active,originalActive,method+': denied reset preserves target activation');
      checks++;
    }
    for(const [scope,assigned,active] of [['assigned',true,1],['global',false,1],['assigned',true,0]]){
      reset(scope,assigned);fixture.hash=async()=> 'synthetic-replacement-hash';
      database.prepare('UPDATE users SET active=? WHERE id=?').run(active,target);
      const response=await route[method](request(method,payload(method)));
      assert.equal(response.status,200,method+': authorized '+scope+' reset succeeds');
      const result=snapshot();assert.equal(result.target.password_hash,'synthetic-replacement-hash');assert.equal(result.target.profile_revision,2);assert.equal(result.sessions.length,0);assert.equal(result.attempts.length,0);
      assert.equal(result.target.active,active,method+': reset preserves active and inactive targets');
      checks++;
    }
  }
  for(const mode of ['profile','toggle']){
    for(const [name,scope,assigned,mutation,changeSite] of [
      ['actor session revoked','global',false,()=>database.prepare('DELETE FROM sessions WHERE user_id=?').run(actor),false],
      ['actor session expired','global',false,()=>database.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(actor),false],
      ['actor session rebound','global',false,()=>database.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run(target,actor),false],
      ['assignment revoked','assigned',true,()=>database.prepare('DELETE FROM manager_agents WHERE manager_id=?').run(actor),false],
      ['actor deactivated','global',false,()=>database.prepare('UPDATE users SET active=0 WHERE id=?').run(actor),false],
      ['actor role revoked','global',false,()=>database.prepare("UPDATE users SET role='agent' WHERE id=?").run(actor),false],
      ['global scope revoked','global',false,()=>database.prepare("UPDATE users SET manager_scope='assigned' WHERE id=?").run(actor),false],
      ['target revision changed','assigned',true,()=>database.prepare('UPDATE users SET profile_revision=2 WHERE id=?').run(target),false],
      ...(mode==='profile'?[['global site authority revoked','global',true,()=>database.prepare("UPDATE users SET manager_scope='assigned' WHERE id=?").run(actor),true]]:[]),
    ]){
      reset(scope,assigned);let expected;
      fixture.beforeWrite=()=>{mutation();expected=snapshot();};
      const method=mode==='profile'?'PUT':'POST',body=mode==='profile'?{name:'Changed synthetic agent',warehouseName:'Changed synthetic warehouse',siteCode:changeSite?'NEW-SITE':'SITE',version:'1'}:{action:'toggle',id:target,version:'1'};
      const response=await route[method](request(method,body));
      assert(expected,mode+': writer reservation boundary reached');
      assert.equal(response.status,409,mode+': '+name+' denies the write');
      assert.deepEqual(snapshot(),expected,mode+': '+name+' leaves no account/session side effects');
      checks++;
    }
    for(const [scope,assigned] of [['assigned',true],['global',false]]){
      reset(scope,assigned);
      const method=mode==='profile'?'PUT':'POST',body=mode==='profile'?{name:'Changed synthetic agent',warehouseName:'Changed synthetic warehouse',siteCode:'SITE',version:'1'}:{action:'toggle',id:target,version:'1'};
      const response=await route[method](request(method,body));assert.equal(response.status,200,mode+': authorized '+scope+' write succeeds');
      const result=snapshot();assert.equal(result.target.profile_revision,2);assert.equal(result.target.active,mode==='toggle'?0:1);assert.equal(result.sessions.length,mode==='toggle'?0:2);assert.equal(result.attempts.length,1);
      if(mode==='profile')assert.equal(result.target.name,'Changed synthetic agent');
      checks++;
    }
  }
  const fullSnapshot=()=>({users:database.prepare('SELECT * FROM users ORDER BY id').all(),sessions:database.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),assignments:database.prepare('SELECT * FROM manager_agents ORDER BY manager_id,agent_id').all(),attempts:database.prepare('SELECT * FROM login_attempts ORDER BY key').all(),settings:database.prepare('SELECT * FROM settings ORDER BY key').all()});
  const accountRequest=(method,path,body)=>{
    assert(['PUT','POST'].includes(method),'account fixture supports PUT and POST writes');
    const url='http://synthetic.invalid/api/'+path,options={headers:{Cookie:'mobiup_session='+actorToken,'Content-Type':'application/json'},body:JSON.stringify(body)};
    return method==='PUT'?new Request(url,{...options,method:'PUT'}):new Request(url,{...options,method:'POST'});
  };
  const warehouse=JSON.parse(readFileSync('resources/seed.json','utf8')).warehouses[0].id;
  function adjacent(mode,password=true){
    reset('global',false);
    for(const id of ['synthetic-old-agent','synthetic-next-agent'])database.prepare("INSERT INTO users(id,username,name,role,warehouse_id,password_hash) VALUES(?,?,?,'agent',?,?)").run(id,id,id,warehouse,'synthetic-unused-hash');
    if(mode==='manager-edit'){
      database.prepare("UPDATE users SET role='manager',manager_scope='assigned' WHERE id=?").run(target);
      database.prepare('INSERT INTO manager_agents VALUES(?,?)').run(target,'synthetic-old-agent');
    }
    const method=mode==='manager-edit'?'PUT':'POST',path=mode==='manager-edit'?'admin/managers/'+target:mode==='manager-create'?'admin/managers':'admin/users';
    const body=mode==='manager-edit'?{username:target,name:'Changed synthetic manager',version:'1',agentIds:['synthetic-next-agent']}:mode==='manager-create'?{username:'synthetic-new-manager',name:'Synthetic new manager',agentIds:['synthetic-next-agent']}:{username:'synthetic-new-agent',name:'Synthetic new agent',warehouseId:warehouse};
    if(password)body.password='synthetic-new-password';
    return {method,path,body};
  }
  const noProof=()=>assert.equal(database.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'account-write-proof-v1:%'").get().n,0,'transaction-local account proof never persists');
  for(const mode of ['manager-edit','manager-create','agent-create']){
    for(const [name,mutation] of [
      ['session deleted',()=>database.prepare('DELETE FROM sessions WHERE user_id=?').run(actor)],
      ['session expired',()=>database.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(actor)],
      ['session rebound',()=>database.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run('synthetic-old-agent',actor)],
      ['actor deactivated',()=>database.prepare('UPDATE users SET active=0 WHERE id=?').run(actor)],
      ['actor demoted',()=>database.prepare("UPDATE users SET role='agent' WHERE id=?").run(actor)],
      ['global scope revoked',()=>database.prepare("UPDATE users SET manager_scope='assigned' WHERE id=?").run(actor)],
      ...(mode!=='agent-create'?[['selected agent deactivated',()=>database.prepare('UPDATE users SET active=0 WHERE id=?').run('synthetic-next-agent')]]:[]),
      ...(mode==='manager-edit'?[['target promoted to global',()=>database.prepare("UPDATE users SET manager_scope='global' WHERE id=?").run(target)],['target changed role',()=>database.prepare("UPDATE users SET role='agent' WHERE id=?").run(target)]]:[]),
    ]){
      const input=adjacent(mode);let started,release;
      const deriving=new Promise(resolve=>{started=resolve;}),resume=new Promise(resolve=>{release=resolve;});
      fixture.hash=async()=>{started();await resume;return 'synthetic-adjacent-agent-hash';};
      const pending=route[input.method](accountRequest(input.method,input.path,input.body));await deriving;mutation();const expected=fullSnapshot();release();
      const response=await pending;assert.equal(response.status,409,mode+': '+name+' rejects at the write');assert.deepEqual(fullSnapshot(),expected,mode+': rejected write changes no account, session, assignment, lockout or settings');noProof();checks++;
    }
    const input=adjacent(mode);fixture.hash=async()=> 'synthetic-adjacent-agent-hash';
    const response=await route[input.method](accountRequest(input.method,input.path,input.body));assert.equal(response.status,200,mode+': authorized global manager succeeds');
    const saved=database.prepare('SELECT * FROM users WHERE username=?').get(input.body.username);assert.equal(saved.password_hash,'synthetic-adjacent-agent-hash');assert.equal(saved.active,1);assert.equal(saved.role,mode==='agent-create'?'agent':'manager');
    if(mode!=='agent-create')assert.deepEqual(database.prepare('SELECT agent_id FROM manager_agents WHERE manager_id=? ORDER BY agent_id').all(saved.id).map(row=>row.agent_id),['synthetic-next-agent']);
    if(mode==='manager-edit'){assert.equal(saved.profile_revision,2);assert.equal(snapshot().sessions.length,0);assert.equal(snapshot().attempts.length,0);}
    noProof();checks++;
  }
  for(const rejected of [false,true]){
    const input=adjacent('manager-edit',false);let expected;
    if(rejected)fixture.beforeWrite=()=>{database.prepare('UPDATE users SET username=?,name=?,profile_revision=2 WHERE id=?').run(input.body.username,input.body.name,target);expected=fullSnapshot();};
    const response=await route.PUT(accountRequest('PUT',input.path,input.body));assert.equal(response.status,rejected?409:200);
    if(rejected)assert.deepEqual(fullSnapshot(),expected,'stale metadata CAS cannot replace assignments after another identical metadata update');
    else{const saved=snapshot();assert.equal(saved.target.password_hash,'synthetic-original-agent-hash');assert.equal(saved.target.profile_revision,2);assert.equal(saved.sessions.length,2);assert.equal(saved.attempts.length,1);assert.deepEqual(database.prepare('SELECT agent_id FROM manager_agents WHERE manager_id=?').all(target).map(row=>row.agent_id),['synthetic-next-agent']);}
    noProof();checks++;
  }
  for(const mode of ['manager-edit','manager-create','agent-create']){
    const input=adjacent(mode);database.prepare("UPDATE users SET manager_scope='assigned' WHERE id=?").run(actor);const expected=fullSnapshot();
    const response=await route[input.method](accountRequest(input.method,input.path,input.body));assert.equal(response.status,403,'regional manager cannot '+mode);assert.deepEqual(fullSnapshot(),expected);checks++;
  }
  for(const mutation of [()=>database.prepare('DELETE FROM sessions WHERE user_id=?').run(actor),()=>database.prepare("UPDATE users SET manager_scope='assigned' WHERE id=?").run(actor)]){
    const input=adjacent('manager-edit',false);let expected;fixture.beforeWrite=()=>{mutation();expected=fullSnapshot();};
    const response=await route.PUT(accountRequest('PUT',input.path,input.body));assert.equal(response.status,409,'metadata-only manager edit checks live authority');assert.deepEqual(fullSnapshot(),expected);noProof();checks++;
  }
  const rollback=adjacent('manager-edit',false),beforeRollback=fullSnapshot();
  database.exec("CREATE TEMP TRIGGER fail_account_assignment BEFORE INSERT ON manager_agents BEGIN SELECT RAISE(ABORT,'synthetic assignment failure'); END;");
  const failed=await route.PUT(accountRequest('PUT',rollback.path,rollback.body));assert.equal(failed.status,500);assert.deepEqual(fullSnapshot(),beforeRollback,'failed batch rolls account and proof back with assignment changes');noProof();database.exec('DROP TRIGGER fail_account_assignment');checks++;
  reset('global',false);fixture.hash=async()=> 'synthetic-self-manager-hash';
  database.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest('synthetic-other-manager-session'),actor,Date.now()+3600000);
  const selfEdit=await route.PUT(accountRequest('PUT','admin/managers/'+actor,{username:actor,name:'Changed self manager',password:'synthetic-new-password',version:'1'}));assert.equal(selfEdit.status,200);assert.deepEqual(database.prepare('SELECT token_hash FROM sessions WHERE user_id=?').all(actor).map(row=>row.token_hash),[digest(actorToken)],'global manager edit retains the requesting session only');noProof();checks++;
  for(const scope of ['global','assigned']){
    reset(scope,false);fixture.verify=async()=>true;fixture.hash=async()=> 'synthetic-self-manager-hash';
    database.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest('synthetic-other-manager-session'),actor,Date.now()+3600000);
    const response=await route.POST(accountRequest('POST','auth/password',{currentPassword:'synthetic-old-password',password:'synthetic-new-password'}));assert.equal(response.status,200);assert.equal(database.prepare('SELECT password_hash FROM users WHERE id=?').get(actor).password_hash,'synthetic-self-manager-hash');assert.deepEqual(database.prepare('SELECT token_hash FROM sessions WHERE user_id=?').all(actor).map(row=>row.token_hash),[digest(actorToken)],'own password change retains current session for '+scope);checks++;
  }
  for(const [name,mutation] of [
    ['session deleted',()=>database.prepare('DELETE FROM sessions WHERE user_id=?').run(actor)],
    ['actor demoted',()=>database.prepare("UPDATE users SET role='agent' WHERE id=?").run(actor)],
    ['actor deactivated',()=>database.prepare('UPDATE users SET active=0 WHERE id=?').run(actor)],
    ['session expired',()=>database.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(actor)],
  ]){
    reset('global',false);fixture.verify=async()=>true;let started,release;
    const deriving=new Promise(resolve=>{started=resolve;}),resume=new Promise(resolve=>{release=resolve;});fixture.hash=async()=>{started();await resume;return 'synthetic-self-manager-hash';};
    const pending=route.POST(accountRequest('POST','auth/password',{currentPassword:'synthetic-old-password',password:'synthetic-new-password'}));await deriving;mutation();const expected=fullSnapshot();release();
    const response=await pending;assert.equal(response.status,409,'self password: '+name);assert.deepEqual(fullSnapshot(),expected,'self password denial preserves every table');checks++;
  }
  reset('global',false);fixture.verify=async()=>true;fixture.hash=async()=> 'synthetic-self-manager-hash';let expiredExpected;
  fixture.beforeWrite=()=>{const expiry=Date.now()+2;database.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(expiry,actor);while(Date.now()<=expiry+2){}expiredExpected=fullSnapshot();};
  const expired=await route.POST(accountRequest('POST','auth/password',{currentPassword:'synthetic-old-password',password:'synthetic-new-password'}));assert.equal(expired.status,409,'SQL write clock rejects a self-password session that expires while queued');assert.deepEqual(fullSnapshot(),expiredExpected);checks++;

  // Readers observe committed snapshots; the proof cannot leak between the
  // statement that creates it and its deletion inside the writer transaction.
  const proofPath=join(temporary,'proof-visibility.sqlite'),writer=new DatabaseSync(proofPath);
  writer.exec('PRAGMA journal_mode=WAL;CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);');const reader=new DatabaseSync(proofPath);
  try{writer.exec("BEGIN IMMEDIATE;INSERT INTO settings VALUES('account-write-proof-v1:synthetic','1');");assert.equal(reader.prepare('SELECT COUNT(*) n FROM settings').get().n,0);writer.exec("DELETE FROM settings WHERE key='account-write-proof-v1:synthetic';COMMIT;");assert.equal(reader.prepare('SELECT COUNT(*) n FROM settings').get().n,0);checks++;}finally{reader.close();writer.close();}

  reset('global',false);fixture.hash=async()=> 'synthetic-renamed-agent-hash';
  const renamed=await route.PUT(request('PUT',{...payload('PUT'),username:'synthetic-renamed-agent'}));
  assert.equal(renamed.status,200);
  assert.equal(snapshot().target.username,'synthetic-renamed-agent');
  assert.equal(snapshot().target.active,1);
  assert.equal(snapshot().attempts.length,0,'credential rename clears the versioned old username lockout');
  assert.equal(snapshot().sessions.length,0);
  checks++;
  // Advance only the SQL write clock across expiry. Once an authorized CAS
  // wins, required cleanup must finish even if the actor expires in the batch.
  for(const mode of ['PUT','POST','toggle']){
    reset('global',false);fixture.hash=async()=> 'synthetic-clock-agent-hash';
    const base=Math.floor(Date.now()/1000)*1000+60100;let sqlNow=base;
    database.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(base+1,actor);
    database.function('strftime',(format,_when)=>{
      if(format==='%s')return String(Math.floor(sqlNow/1000));
      assert.equal(format,'%f');
      const result=(sqlNow%60000/1000).toFixed(3).padStart(6,'0');sqlNow+=2;return result;
    });
    const method=mode==='PUT'?'PUT':'POST',body=mode==='toggle'?{action:'toggle',id:target,version:'1'}:payload(method);
    const response=await route[method](request(method,body));
    assert.equal(response.status,200,mode+': admitted account CAS completes its cleanup after actor expiry');
    assert(sqlNow>base+1,'SQL clock crossed the actor expiry');
    const result=snapshot();assert.equal(result.target.profile_revision,2);assert.equal(result.target.active,mode==='toggle'?0:1);assert.equal(result.sessions.length,0);assert.equal(result.attempts.length,mode==='toggle'?1:0);
    if(mode!=='toggle')assert.equal(result.target.password_hash,'synthetic-clock-agent-hash');
    checks++;
  }
  for(const mode of ['manager-edit','manager-create']){
    const input=adjacent(mode,mode!=='manager-edit');fixture.hash=async()=> 'synthetic-clock-manager-hash';
    const base=Math.floor(Date.now()/1000)*1000+60100;let sqlNow=base;
    database.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(base+1,actor);
    database.function('strftime',(format,_when)=>{if(format==='%s')return String(Math.floor(sqlNow/1000));assert.equal(format,'%f');const result=(sqlNow%60000/1000).toFixed(3).padStart(6,'0');sqlNow+=2;return result;});
    const response=await route[input.method](accountRequest(input.method,input.path,input.body));assert.equal(response.status,200,mode+': admitted CAS finishes assignments after actor expiry');assert(sqlNow>base+1);
    const saved=database.prepare('SELECT * FROM users WHERE username=?').get(input.body.username);assert.deepEqual(database.prepare('SELECT agent_id FROM manager_agents WHERE manager_id=?').all(saved.id).map(row=>row.agent_id),['synthetic-next-agent']);noProof();checks++;
  }
  console.log(`PASS: ${checks} deterministic account authorization, session/role/scope revocation, atomic cleanup and assignment cases.`);
}finally{database.close();delete globalThis.__agentAccountFixture;rmSync(temporary,{recursive:true,force:true});}
