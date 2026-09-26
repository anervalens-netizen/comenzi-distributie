import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const folder=resolve('work/runtime-init-qa');
rmSync(folder,{recursive:true,force:true});mkdirSync(folder,{recursive:true});
const dbPath=resolve(folder,'mobiup.sqlite'),db=new DatabaseSync(dbPath);
db.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
db.exec("ALTER TABLE users ADD COLUMN warehouse_name TEXT; ALTER TABLE users ADD COLUMN site_code TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'assigned';");
const insert=db.prepare("INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,warehouse_name,site_code,manager_scope) VALUES (?,?,?,?,?,'x',0,1,?,?, 'assigned')");
insert.run('dup-a','dup.a','Dup A','agent','g-5','G A','DUPLICATE');
insert.run('dup-b','dup.b','Dup B','agent','g-3','G B',' duplicate ');
db.close();

const port=3031,root=`http://127.0.0.1:${port}/api/health`;
const child=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:folder,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production'},stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function health(){try{return await fetch(root);}catch{return null;}}
try {
  let ready=null;
  for(let i=0;i<40&&!ready;i++){ready=await health();if(!ready)await sleep(100);}
  assert.ok(ready,'QA server did not start listening');
  const statuses=[ready.status];
  for(let i=1;i<3;i++)statuses.push((await fetch(root)).status);
  assert.deepEqual(statuses,[500,500,500],'Invalid startup must remain unhealthy on every request');
  let verify=new DatabaseSync(dbPath);
  assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='users_active_site_code_unique'").get(),undefined,'Unique SiteCode index must not appear after failed initialization');
  verify.prepare("UPDATE users SET site_code='' WHERE id='dup-b'").run();verify.close();

  const recovered=await fetch(root);
  assert.equal(recovered.status,200,'Corrected data should allow a later full initialization');
  verify=new DatabaseSync(dbPath);
  assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='users_active_site_code_unique'").get(),'Successful initialization creates the integrity index');
  assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_subscriptions'").get(),'Successful initialization creates push subscription storage');
  assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_push_subscriptions_user'").get(),'Successful initialization creates push subscription index');
  verify.close();
  console.log('PASS: runtime initialization remains fail-closed until all integrity checks succeed.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2000)]);
  if(child.exitCode===null)child.kill('SIGKILL');
}
