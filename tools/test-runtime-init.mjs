import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const folder=resolve('work/runtime-init-qa');
rmSync(folder,{recursive:true,force:true});mkdirSync(folder,{recursive:true});
const dbPath=resolve(folder,'mobiup.sqlite'),db=new DatabaseSync(dbPath);
db.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
db.exec("ALTER TABLE users ADD COLUMN warehouse_name TEXT; ALTER TABLE users ADD COLUMN site_code TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'assigned';");
const insert=db.prepare("INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,warehouse_name,site_code,manager_scope) VALUES (?,?,?,?,?,'x',0,1,?,?, 'assigned')");
insert.run('dup-a','dup.a','Dup A','agent','g-5','G A','DUPLICATE');
insert.run('dup-b','dup.b','Dup B','agent','g-3','G B',' duplicate ');
insert.run('manager','synthetic.manager','Synthetic Manager','manager',null,null,'');
db.exec("PRAGMA foreign_keys=OFF; INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('synthetic-orphan','missing-user',9999999999999)");
assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
assert.ok(db.prepare('PRAGMA foreign_key_check').get());
const beforeSchema=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
db.close();

const port=3031,root=`http://127.0.0.1:${port}/api/bootstrap`;
const child=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:folder,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production'},stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function health(){try{return await fetch(root);}catch{return null;}}
try {
  let ready=null;
  for(let i=0;i<40&&!ready;i++){ready=await health();if(!ready)await sleep(100);}
  assert.ok(ready,'QA server did not start listening');
  const live=await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(live.status,200,'Liveness is independent of invalid business data');
  assert.deepEqual(await live.json(),{status:'ok',service:'comenzi-distributie'});
  const statuses=[ready.status];
  for(let i=1;i<3;i++)statuses.push((await fetch(root)).status);
  assert.deepEqual(statuses,[500,500,500],'Invalid startup must remain unhealthy on every request');
  let verify=new DatabaseSync(dbPath);
  assert.deepEqual(verify.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),beforeSchema,'FK rejection precedes every schema migration');
  assert.equal(verify.prepare("SELECT manager_scope FROM users WHERE id='manager'").get().manager_scope,'assigned','FK rejection precedes user normalization');
  verify.exec("DELETE FROM sessions WHERE token_hash='synthetic-orphan'");verify.close();
  assert.equal((await fetch(root)).status,500,'after FK repair the separate duplicate constraint still fails closed');
  verify=new DatabaseSync(dbPath);
  assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='users_active_site_code_unique'").get(),undefined,'Unique SiteCode index must not appear after failed initialization');
  verify.prepare("UPDATE users SET site_code='' WHERE id='dup-b'").run();verify.close();

  const recovered=await fetch(root);
  assert.equal(recovered.status,200,'Corrected data should allow a later full initialization');
  verify=new DatabaseSync(dbPath);
  assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='users_active_site_code_unique'").get(),'Successful initialization creates the integrity index');
  assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_subscriptions'").get(),'Successful initialization creates push subscription storage');
  assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_push_subscriptions_user'").get(),'Successful initialization creates push subscription index');
  verify.close();
  assert.equal(verify.isOpen,false);
  console.log('PASS: existing orphan rejected before writes; repaired clean DB initializes.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2000)]);
  if(child.exitCode===null)child.kill('SIGKILL');
}

const fresh=resolve(folder,'fresh');
const freshChild=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:fresh,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production'},stdio:'ignore'});
try{
 let response;for(let i=0;i<40;i++){try{response=await fetch(root);break;}catch{await sleep(100);}}
 assert.equal(response?.status,200,'brand-new DB initializes before connection publication');
 const verify=new DatabaseSync(resolve(fresh,'mobiup.sqlite'));
 assert.equal(verify.prepare('PRAGMA quick_check(1)').get().quick_check,'ok');assert.equal(verify.prepare('PRAGMA foreign_key_check').get(),undefined);verify.close();
 console.log('PASS: brand-new runtime database is structurally and referentially valid.');
}finally{freshChild.kill('SIGTERM');await Promise.race([new Promise(resolve=>freshChild.once('exit',resolve)),sleep(2000)]);if(freshChild.exitCode===null)freshChild.kill('SIGKILL');}


// Starting several web processes must not count as an order or a portfolio change.
async function openInAnotherProcess() {
 const reservation=createServer();
 await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;
 await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['dist/standalone/server.js'],{
   env:{...process.env,MOBIUP_DATA_DIR:folder,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production'},stdio:'ignore',
 });
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try {
  for(let attempt=0;attempt<50;attempt++){
   let response;
   try {response=await fetch(`http://127.0.0.1:${port}/api/bootstrap`);} catch {}
   if(response){assert.equal(response.status,200);return;}
   await sleep(100);
  }
  assert.fail('Second application process did not initialize');
 } finally {
  child.kill('SIGTERM');await Promise.race([exited,sleep(2000)]);
  if(child.exitCode===null) child.kill('SIGKILL');
  await exited;
 }
}

const schema=new DatabaseSync(dbPath);
try {
 const state=()=>({
  schema:schema.prepare('PRAGMA schema_version').get().schema_version,
  scope:schema.prepare('SELECT scope_revision FROM portfolio_revision WHERE id=1').get().scope_revision,
 });
 const canonical=schema.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('order_list_revision_update','portfolio_dirty_customers_update') ORDER BY name");
 const expected=canonical.all(),initial=state();
 assert.equal(expected.length,2);
 await Promise.all([openInAnotherProcess(),openInAnotherProcess()]);
 assert.deepEqual(state(),initial,'Concurrent restarts preserve schema and portfolio cursors');
 schema.exec('DROP TRIGGER order_list_revision_update; CREATE TRIGGER order_list_revision_update AFTER UPDATE ON orders BEGIN SELECT 1; END; DROP TRIGGER portfolio_dirty_customers_update;');
 await Promise.all([openInAnotherProcess(),openInAnotherProcess()]);
 assert.deepEqual(canonical.all(),expected,'Obsolete and missing definitions are restored from the versioned schema');
 const repaired=state();assert.equal(repaired.scope,initial.scope);
 await openInAnotherProcess();
 assert.deepEqual(state(),repaired,'Verified repairs do not repeat on the next startup');
 schema.exec("UPDATE users SET manager_scope='assigned' WHERE id='manager'");
 await openInAnotherProcess();
 assert.equal(schema.prepare("SELECT manager_scope FROM users WHERE id='manager'").get().manager_scope,'global');
 assert.equal(state().scope,repaired.scope+2,'Real scope changes still advance the revision');
 console.log('PASS: concurrent opens preserve cursors; stale triggers and manager scope are repaired.');
} finally {schema.close();}
