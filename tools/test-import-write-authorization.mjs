import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const dir=mkdtempSync(join(tmpdir(),'import-auth-'));
process.env.MOBIUP_DATA_DIR=dir;
const app=new DatabaseSync(join(dir,'mobiup.sqlite'));
const ledger=new DatabaseSync(join(dir,'sales.sqlite'));
try {
 app.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER,must_change_password INTEGER,profile_revision INTEGER,manager_scope TEXT);
 CREATE TABLE sessions(token_hash TEXT,user_id TEXT,expires_at INTEGER);
 CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
 CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);`);
 ledger.exec('CREATE TABLE imports(value TEXT)');
 const token='synthetic-token',hash=createHash('sha256').update(token).digest('hex');
 app.prepare("INSERT INTO users VALUES('manager','manager',1,0,1,'assigned')").run();
 app.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash,'manager',Date.now()+60000);
 await build({entryPoints:['lib/import-write-authorization.ts','lib/operational-write-guard.ts'],outdir:dir,bundle:true,platform:'node',format:'esm',plugins:[{name:'stub-server',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:`import {createHash} from 'node:crypto'; export const sha256=x=>createHash('sha256').update(x).digest('hex'); export const sessionToken=r=>r.headers.get('Cookie')?.match(/(?:^|;\\s*)mobiup_session=([^;]+)/)?.[1]||''; export function fail(status,message){const e=new Error(message);e.status=status;throw e;}`,loader:'js'}));}}]});
 const {withImportAuthorization}=await import(pathToFileURL(join(dir,'import-write-authorization.js')));
 const {operationalWriteGuard}=await import(pathToFileURL(join(dir,'operational-write-guard.js')));
 const req=new Request('http://localhost/',{headers:{Cookie:`mobiup_session=${token}`}});
 const user={id:'manager',role:'manager',profileVersion:'1',managerScope:'assigned'};
 const apply=()=>withImportAuthorization(req,user,check=>{
   ledger.exec('BEGIN IMMEDIATE');
   try{ledger.prepare('INSERT INTO imports VALUES(?)').run('ok');check();ledger.exec('COMMIT');}
   catch(e){ledger.exec('ROLLBACK');throw e;}
 });
 const guard=operationalWriteGuard(req,user);
 const stock=()=>app.prepare(`INSERT OR IGNORE INTO settings SELECT 'stock','ok' WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='manager' AND manager_scope=?)`).run(...guard.args,user.id,user.managerScope).changes;
 assert.equal(stock(),1);apply();
 app.exec("DELETE FROM settings");
 const cases=[
  ["DELETE FROM sessions",()=>app.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash,'manager',Date.now()+60000)],
  ["UPDATE sessions SET expires_at=0",()=>app.prepare('UPDATE sessions SET expires_at=?').run(Date.now()+60000)],
  ["UPDATE users SET active=0",()=>app.exec('UPDATE users SET active=1')],
  ["UPDATE users SET role='agent'",()=>app.exec("UPDATE users SET role='manager'")],
  ["UPDATE users SET profile_revision=2",()=>app.exec('UPDATE users SET profile_revision=1')],
  ["UPDATE users SET manager_scope='global'",()=>app.exec("UPDATE users SET manager_scope='assigned'")],
  ["UPDATE users SET must_change_password=1",()=>app.exec('UPDATE users SET must_change_password=0')],
 ];
 for(const [mutation,reset] of cases){app.exec(mutation);assert.equal(stock(),0,mutation);assert.throws(apply,e=>e.status===401,mutation);reset();}
 assert.equal(ledger.prepare('SELECT count(*) n FROM imports').get().n,1);
 // Another process attempting logout cannot write while the separate ledger commits.
 withImportAuthorization(req,user,check=>{
  const child=spawnSync(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=50');try{d.exec('DELETE FROM sessions');process.exit(0)}catch(e){process.exit(3)}`,join(dir,'mobiup.sqlite')]);
  assert.equal(child.status,3,'logout must serialize behind the authorization lock');check();
 });
 app.prepare('UPDATE sessions SET expires_at=?').run(Date.now()+40);
 assert.throws(()=>withImportAuthorization(req,user,check=>{
  ledger.exec('BEGIN IMMEDIATE');try{ledger.exec("INSERT INTO imports VALUES('expired')");const end=Date.now()+70;while(Date.now()<end){}check();ledger.exec('COMMIT');}catch(e){ledger.exec('ROLLBACK');throw e;}
 }),e=>e.status===401);
 assert.equal(ledger.prepare('SELECT count(*) n FROM imports').get().n,1,'expiry during write rolls back ledger');
 console.log('PASS: stock guarded CAS, sales authorization, revocation/profile/expiry, and cross-process write serialization.');
} finally {app.close();ledger.close();rmSync(dir,{recursive:true,force:true});}
