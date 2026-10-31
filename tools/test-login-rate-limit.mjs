// Real login route and Node SQLite adapter; isolated, wholly synthetic data.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

mkdirSync('work',{recursive:true});
const directory=mkdtempSync(resolve('work/login-rate-limit-'));
const previous=Object.fromEntries(['MOBIUP_DATA_DIR','MOBIUP_USAGE_DISABLED'].map(key=>[key,process.env[key]]));
process.env.MOBIUP_DATA_DIR=join(directory,'data');process.env.MOBIUP_USAGE_DISABLED='1';
let sql,worker,checks=0;
try{
  const file=join(directory,'route.mjs');
  await build({stdin:{contents:"export * from './app/api/[...path]/route';export {env} from './lib/runtime';export {hashPassword} from './lib/server';",loader:'ts',resolveDir:resolve('.')},outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'actual-node-runtime',setup(build){
    build.onResolve({filter:/^#mobiup-/},args=>({path:resolve('lib/'+args.path.slice('#mobiup-'.length)+'-node.ts')}));
    build.onResolve({filter:/\.sql\?raw$/},args=>({path:resolve(args.path.replace(/^@\//,'').replace(/\?raw$/,'')),namespace:'raw'}));
    build.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));
  }}]});
  const route=await import(pathToFileURL(file));
  await route.env.DB.prepare('SELECT 1').first();
  sql=new DatabaseSync(join(process.env.MOBIUP_DATA_DIR,'mobiup.sqlite'));sql.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');
  sql.prepare("INSERT OR IGNORE INTO settings VALUES('seed-v1','1')").run();
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const ipKey=value=>'ip:'+digest(value),accountKey=value=>'account:'+value;
  const valid='synthetic-valid',password='synthetic-valid-password';
  const validHash=await route.hashPassword(password);
  function addUser(id,hash='synthetic-unusable-hash'){
    sql.prepare("INSERT INTO users(id,username,name,role,password_hash,must_change_password,active) VALUES(?,?,?,'agent',?,0,1)").run(id,id,'Synthetic account',hash);
  }
  function reset(){sql.exec('DELETE FROM sessions;DELETE FROM users;DELETE FROM login_attempts;');addUser(valid,validHash);}
  function attempt(key,attempts,resetAt=Date.now()+3600000){sql.prepare('INSERT INTO login_attempts VALUES(?,?,?)').run(key,attempts,resetAt);}
  const row=key=>sql.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
  const count=()=>sql.prepare('SELECT COUNT(*) n FROM login_attempts').get().n;
  const login=(username,ip,password='synthetic-wrong-password')=>route.POST(new Request('http://synthetic.invalid/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify({username,password})}));

  // Reuse the route's exact prepared SQL in native workerd D1 below.
  let limiterBatch;
  const originalBatch=route.env.DB.batch.bind(route.env.DB);
  route.env.DB.batch=async statements=>{limiterBatch??=statements;return originalBatch(statements);};
  reset();const blocked='192.0.2.1';attempt(ipKey(blocked),80);
  const before=row(ipKey(blocked));
  const randomResults=await Promise.all(Array.from({length:20},(_,i)=>login('synthetic-unknown-'+i,blocked)));
  route.env.DB.batch=originalBatch;
  assert(randomResults.every(response=>response.status===429),'already blocked IP rejects random account names');
  assert.equal(count(),1,'already blocked IP creates no account keys');assert.deepEqual(row(ipKey(blocked)),before,'blocked counter is capped');checks++;

  attempt(accountKey(valid),3);const accountBefore=row(accountKey(valid));
  const targeted=await Promise.all(Array.from({length:11},()=>login(valid,blocked,password)));
  assert(targeted.every(response=>response.status===429));assert.deepEqual(row(accountKey(valid)),accountBefore,'blocked IP cannot consume an existing account allowance');checks++;
  const allowed=await login(valid,'192.0.2.2',password);
  assert.equal(allowed.status,200,'fresh IP still logs into the targeted account');assert(allowed.headers.get('Set-Cookie')?.includes('mobiup_session='));
  assert.equal(row(accountKey(valid)),undefined,'successful login clears the account counter');assert.equal(row(ipKey('192.0.2.2')).attempts,1,'successful login retains IP protection');checks++;

  reset();const shared='192.0.2.3';
  for(let i=0;i<100;i++)addUser('synthetic-concurrent-'+i);
  const concurrent=await Promise.all(Array.from({length:100},(_,i)=>login('synthetic-concurrent-'+i,shared)));
  assert.equal(concurrent.filter(response=>response.status===401).length,80,'exactly 80 concurrent IP admissions');
  assert.equal(concurrent.filter(response=>response.status===429).length,20,'remaining concurrent requests are blocked');
  assert.equal(row(ipKey(shared)).attempts,80);assert.equal(sql.prepare("SELECT COUNT(*) n FROM login_attempts WHERE key LIKE 'account:%'").get().n,80,'only admitted requests create account keys');checks++;

  reset();addUser('synthetic-protected');
  const accountLimited=await Promise.all(Array.from({length:20},(_,i)=>login('synthetic-protected','198.51.100.'+(i+1))));
  assert.equal(accountLimited.filter(response=>response.status===401).length,10,'account allows ten attempts across IPs');
  assert.equal(accountLimited.filter(response=>response.status===429).length,10,'account still blocks later attempts across IPs');checks++;

  reset();attempt(ipKey(blocked),80);attempt(accountKey(valid),4);attempt('ip:synthetic-live',7);
  const live=sql.prepare('SELECT * FROM login_attempts ORDER BY key').all();
  for(let i=0;i<251;i++)attempt('account:synthetic-expired-'+i,11,1);
  assert.equal((await login('synthetic-blocked-cleanup',blocked)).status,429);
  assert.equal(count(),live.length+151,'each request removes at most 100 expired keys');
  assert.deepEqual(sql.prepare('SELECT * FROM login_attempts WHERE reset_at>1 ORDER BY key').all(),live,'cleanup preserves all nonexpired IP and account counters');
  for(let i=0;i<2;i++)assert.equal((await login('synthetic-blocked-cleanup',blocked)).status,429);
  assert.deepEqual(sql.prepare('SELECT * FROM login_attempts ORDER BY key').all(),live,'bounded cleanup eventually removes expired keys without creating blocked account keys');checks++;

  reset();attempt(ipKey('203.0.113.1'),80,1);attempt(accountKey(valid),11,1);
  assert.equal((await login(valid,'203.0.113.1',password)).status,200,'expired IP/account limits renew');
  assert.equal(row(ipKey('203.0.113.1')).attempts,1);assert.equal(row(accountKey(valid)),undefined);checks++;

  const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
  worker=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('synthetic');}}",compatibilityDate:'2026-05-22',d1Databases:{DB:'synthetic-login-limiter'}}));
  const d1=await worker.getD1Database('DB');
  await d1.exec('CREATE TABLE login_attempts(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL)');
  const resetAt=limiterBatch[1].parameters[1];
  await d1.prepare('INSERT INTO login_attempts VALUES(?,80,?)').bind(ipKey(blocked),resetAt).run();
  const d1Batch=account=>d1.batch(limiterBatch.map((statement,index)=>d1.prepare(statement.sql).bind(...(index===2?[account,...statement.parameters.slice(1)]:statement.parameters))));
  const rejected=await d1Batch(accountKey('synthetic-d1-blocked'));
  assert.equal(rejected[1].results.length,0,'native D1 reports no IP reservation for blocked requests');
  assert.equal(rejected[2].results.length,0,'native D1 changes() guard skips account writes after blocked IP');
  assert.equal((await d1.prepare('SELECT COUNT(*) n FROM login_attempts').first()).n,1);checks++;
  await d1.prepare('UPDATE login_attempts SET attempts=77').run();
  const d1Concurrent=await Promise.all(Array.from({length:5},(_,i)=>d1Batch(accountKey('synthetic-d1-concurrent-'+i))));
  assert.equal(d1Concurrent.filter(results=>results[1].results.length===1&&results[2].results.length===1).length,3,'native D1 transactions admit only remaining IP allowance');
  assert.equal((await d1.prepare('SELECT attempts FROM login_attempts WHERE key=?').bind(ipKey(blocked)).first()).attempts,80);
  assert.equal((await d1.prepare('SELECT COUNT(*) n FROM login_attempts').first()).n,4,'native D1 blocked transactions create no account keys');checks++;
  await worker.dispose();worker=null;

  console.log(`PASS: ${checks} login limiter checks with actual route, Node SQLite and native workerd D1 batches.`);
}finally{
  await worker?.dispose();
  sql?.close();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(directory,{recursive:true,force:true});
}
