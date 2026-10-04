import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

mkdirSync('work',{recursive:true});
const root=mkdtempSync(resolve('work/operational-http-'));
const data=join(root,'data');mkdirSync(data);
let child, origin, output='';
async function start(runtime,directory) {
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  origin=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,[join(runtime,'server.js')],{cwd:runtime,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),MOBIUP_DATA_DIR:directory,NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  for(let i=0;i<100;i++){
    try{if((await fetch(origin+'/api/health')).ok)return;}catch{}
    if(child.exitCode!==null)break;await delay(100);
  }
  throw new Error('Isolated server failed to start: '+output);
}
async function stop() {
  if(!child||child.exitCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();
  await Promise.race([exited,delay(3000)]);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
  child=undefined;
}
const get=(path,cookie)=>fetch(origin+'/api/'+path,{headers:cookie?{Cookie:cookie}:{}});
try {
  await start(resolve('dist/standalone'),data);
  assert.deepEqual(await (await get('health')).json(),{status:'ok',service:'comenzi-distributie'});
  assert.equal(existsSync(join(data,'mobiup.sqlite')),false,'Liveness must not create a database');
  assert.equal((await get('bootstrap')).status,200);
  const cookies={};let db=new DatabaseSync(join(data,'mobiup.sqlite'));
  for(const [id,role,scope] of [['global','manager','global'],['regional','manager','assigned'],['agent','agent','assigned']]){
    db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active) VALUES(?,?,?,?,?,'synthetic-disabled',0,1)").run(id,id,'Synthetic '+id,role,scope);
    const token=randomUUID();cookies[id]='mobiup_session='+token;
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
  }
  db.close();
  assert.equal((await get('admin/status')).status,401);
  assert.equal((await get('admin/status',cookies.agent)).status,403);
  assert.equal((await get('admin/status',cookies.regional)).status,403);
  const historyRoot=join(data,'client-history');mkdirSync(join(historyRoot,'client-sales-originals'),{recursive:true});
  const original=Buffer.from('synthetic history original');writeFileSync(join(historyRoot,'client-sales-originals/example.xlsx'),original);
  db=new DatabaseSync(join(historyRoot,'client-sales-history.sqlite'));
  db.exec('CREATE TABLE history_imports(sha256,original_path,state,imported_at,period_start,period_end)');
  db.prepare('INSERT INTO history_imports VALUES(?,?,?,?,?,?)').run(createHash('sha256').update(original).digest('hex'),'client-sales-originals/example.xlsx','active','2026-01-03T12:00:00Z','2026-01-01','2026-01-02');db.close();
  const response=await get('admin/status',cookies.global);assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  const status=await response.json();assert.equal(status.history.through,'2026-01-02');
  assert.equal(status.portfolio.state,'uninitialized');
  assert.doesNotMatch(JSON.stringify(status),/example.xlsx|client-sales-originals|synthetic|mobiup.sqlite/);
  assert.equal((await get('health')).status,200,'Old history and uninitialized projection do not affect liveness');
  await stop();

  // Archive the built runtime and exclusively synthetic data/resources. The
  // private classification here exercises validation, never release activation.
  const runtime=join(root,'runtime');cpSync(resolve('dist/standalone'),runtime,{recursive:true});
  const resources=join(root,'resources');cpSync(resolve('resources'),resources,{recursive:true});
  const names=['seed.json','initial-users.json','accesorii.xlsx','standuri.xlsx','templates.json','template-hashes.json','mail-defaults.json'];
  const sha256=Object.fromEntries(names.map(name=>[name,createHash('sha256').update(readFileSync(join(resources,name))).digest('hex')]));
  writeFileSync(join(resources,'resource-mode.json'),JSON.stringify({schema:1,mode:'private',sha256}));
  writeFileSync(join(runtime,'RELEASE.json'),JSON.stringify({sha:'a'.repeat(40),resourceMode:'private',resourceDigest:createHash('sha256').update(JSON.stringify(sha256)).digest('hex')}));
  const products=join(root,'products');mkdirSync(products);writeFileSync(join(products,'example.png'),'synthetic asset');
  const isolated=join(root,'restored');
  const result=spawnSync('python3',['-c',`
import contextlib, importlib.util, io, json, pathlib, sqlite3, sys, time
from unittest.mock import patch
root, source = map(pathlib.Path, sys.argv[1:])
def load(name):
    spec=importlib.util.spec_from_file_location(name,source/'deploy'/(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
backup,restore=load('backup'),load('restore')
started=time.monotonic()
with patch.object(backup.os.path,'ismount',return_value=True),contextlib.redirect_stdout(io.StringIO()):
    archive=backup.run_backup(data=root/'data',local=root/'local',nas=root/'nas',nas_mount=root/'nas',release=root/'runtime/RELEASE.json',recovery={name:root/name for name in ('runtime','resources','products')})
saved=time.monotonic()
with contextlib.closing(sqlite3.connect(root/'data/mobiup.sqlite')) as db:
    db.execute("INSERT INTO settings VALUES('synthetic-after-backup','preserve-source')");db.commit()
result=restore.restore(archive,root/'restored')
for directory,expected in [('data',1),('restored',0)]:
    with contextlib.closing(sqlite3.connect(root/directory/'mobiup.sqlite')) as db:
        assert db.execute("SELECT COUNT(*) FROM settings WHERE key='synthetic-after-backup'").fetchone()[0]==expected
print(json.dumps({'status':result['status'],'backupMs':round((saved-started)*1000),'restoreMs':round((time.monotonic()-saved)*1000),'postSnapshotWritesExcluded':1}))
`,root,process.cwd()],{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stderr);
  const recovery=JSON.parse(result.stdout);assert.equal(recovery.status,'restored_not_started');
  assert.deepEqual(readFileSync(join(isolated,'client-history/client-sales-originals/example.xlsx')),original);
  await start(join(isolated,'recovery/runtime'),isolated);
  assert.equal((await get('bootstrap',cookies.global)).status,200);
  const restoredStatus=await (await get('admin/status',cookies.global)).json();
  assert.deepEqual(restoredStatus.history,status.history);
  assert.equal((await get('partner/browse',cookies.global)).status,200);
  assert.equal((await get('admin/status',cookies.agent)).status,403);
  console.log('PASS: HTTP liveness/auth/privacy and isolated restored runtime health/bootstrap/portfolio; '+JSON.stringify(recovery));
} finally {await stop();rmSync(root,{recursive:true,force:true});}
