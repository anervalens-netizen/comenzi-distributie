// Importer-only integration checks. No network, shared dist, application DB or real resources.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,symlinkSync,renameSync,utimesSync,openSync,ftruncateSync,closeSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
const repo=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'history-import-')),root=join(temp,'data'),originalCwd=process.cwd(),originalRoot=process.env.MOBIUP_DATA_DIR;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const serverStub={name:'isolated-request-context',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
 export function fail(status,message){throw Object.assign(new Error(message),{status});}
 export function requireManager(user){if(user.role!=='manager')fail(403,'Manager required');}
 export const response=(value,status=200)=>Response.json(value,{status});
 export const jsonBody=request=>request.json();
 export async function readLimited(request,max){const bytes=Buffer.from(await request.arrayBuffer());if(bytes.length>max)fail(413,'Too large');return bytes;}
 `}));}};
const activityStub={name:'isolated-rebuild-boundary',setup(b){b.onResolve({filter:/^\.\/partner-activity-incremental$/},()=>({path:'incremental',namespace:'test'}));b.onResolve({filter:/^\.\/partner-activity-snapshot$/},()=>({path:'rebuild',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},args=>args.path==='incremental'?{contents:'export const refreshActivitySnapshotMonth=()=>null;'}:({contents:`
 import {readdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
 export function buildActivitySnapshot(root){
  const base=join(root,'client-history','import-jobs');
  const running=readdirSync(base).filter(id=>existsSync(join(base,id,'status.json'))).map(id=>JSON.parse(readFileSync(join(base,id,'status.json'),'utf8'))).find(j=>j.state==='running'&&j.operation==='import');
  if(!running||!existsSync(running.source)||!existsSync(join(root,'client-history','client-sales-originals',running.result.fileHash+'.xlsx')))throw Error('Staging/archive missing during rebuild');
  writeFileSync(join(root,'rebuild-checked'),'ok');
 }
 `}));}};
const manager={id:'synthetic-manager',role:'manager'};
let children=[];
try{
 await build({entryPoints:[join(repo,'lib/client-history-import-jobs.ts')],outfile:join(temp,'jobs.mjs'),bundle:true,platform:'node',format:'esm'});
 await build({entryPoints:[join(repo,'lib/client-history-import-node.ts')],outfile:join(temp,'api.mjs'),bundle:true,platform:'node',format:'esm',plugins:[serverStub]});
 await build({entryPoints:[join(repo,'lib/client-history-import-worker.ts')],outfile:join(temp,'client-history-import-worker.mjs'),bundle:true,platform:'node',format:'esm',plugins:[activityStub]});
 // Also compile the real worker dependency graph, without executing the unrelated rebuild.
 await build({entryPoints:[join(repo,'lib/client-history-import-worker.ts')],outfile:join(temp,'worker-real.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'});
 for(const name of ['client_history_upload.py','client_sales_history.py'])copyFileSync(join(repo,'tools',name),join(temp,name));
 const jobs=await import(pathToFileURL(join(temp,'jobs.mjs'))),api=await import(pathToFileURL(join(temp,'api.mjs')));
 process.chdir(temp);
 const status=id=>api.historyImportStatus(new Request('http://local.invalid/status'+(id?'?job='+id:'')),manager);
 const preview=()=>api.historyImportPreview(new Request('http://local.invalid/preview',{method:'POST',headers:{'X-Client-Sales-Filename':'synthetic.xlsx'},body:'synthetic'}),manager);
 const commit=id=>api.historyImportCommit(new Request('http://local.invalid/import',{method:'POST',body:JSON.stringify({jobId:id,allowRegression:true})}),manager);
 delete process.env.MOBIUP_DATA_DIR;
 for(const action of [()=>status(),preview,()=>commit(randomUUID())])await assert.rejects(action,{status:503});
 await assert.rejects(()=>api.historyImportStatus(new Request('http://local.invalid/status'),{id:'agent',role:'agent'}),{status:403});
 assert(!existsSync(join(temp,'work')),'No implicit persistent directory');
 process.env.MOBIUP_DATA_DIR=join(temp,'does-not-exist');await assert.rejects(()=>status(),{status:503});assert(!existsSync(process.env.MOBIUP_DATA_DIR));
 mkdirSync(root);process.env.MOBIUP_DATA_DIR=root;
 await assert.rejects(()=>status(),{status:503});assert.deepEqual(readdirSync(root),[],'Uninitialized root must stay untouched');
 const setup=spawnSync('python3',['-c',`
import sys,pathlib,json
sys.path.insert(0,sys.argv[1]+'/tools')
import client_sales_history as h
from test_client_sales_history import fixture,row
root=pathlib.Path(sys.argv[2]);folder=root/'client-history';folder.mkdir()
p=root/'partners.json';m=root/'master.json'
p.write_text(json.dumps({'partners':[{'id':'synthetic','cui':'123','county':'County','city':'City','address':'Street 1'}]}));m.write_text('[]')
c=h.connect(folder/'client-sales-history.sqlite')
f=root/'initial.xlsx';fixture(f,[row(Data='01.02.2024')],'2024-02-01','2024-02-29');h.import_file(c,f,p,m);c.close()
fixture(root/'upload.xlsx',[row(Data='01.02.2024'),row(Data='02.02.2024')],'2024-02-01','2024-02-29')
fixture(root/'empty.xlsx',[],'2024-02-01','2024-02-29')
`,repo,root],{encoding:'utf8'});assert.equal(setup.status,0,setup.stderr);
 assert.equal(jobs.importRoot(),root);
 const base=jobs.jobFolder(root),old=Date.now()-jobs.RETENTION.ttlMs-1000;
 function makeJob(state='failed',options={}){
  const id=randomUUID(),dir=jobs.jobLocation(root,id);mkdirSync(dir);
  const job={id,directory:root,userId:manager.id,source:join(dir,'input.xlsx'),filename:'synthetic.xlsx',operation:'preview',state,phase:'test',message:'test',createdAt:new Date(old).toISOString(),updatedAt:new Date(old).toISOString(),...options};
  writeFileSync(job.source,'synthetic');writeFileSync(join(dir,'status.json'),JSON.stringify(job));return job;
 }
 const save=job=>writeFileSync(join(base,job.id,'status.json'),JSON.stringify(job));
 const retainedReady=makeJob('ready'),retainedRunning=makeJob('running',{pid:process.pid,processIdentity:jobs.processIdentity(process.pid),attempt:randomUUID()}),liveTerminal=makeJob('completed',{pid:process.pid,processIdentity:jobs.processIdentity(process.pid)}),oldFailed=makeJob();
 const current=makeJob();writeFileSync(join(base,'owner-'+createHash('sha256').update('another-user').digest('hex')+'.json'),JSON.stringify({id:current.id}));
 writeFileSync(join(base,'owner-'+createHash('sha256').update('ready-owner').digest('hex')+'.json'),JSON.stringify({id:retainedReady.id}));
 const abandonedReady=makeJob('ready'),recentReady=makeJob('ready',{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 const failedImport=makeJob('failed',{operation:'import'});
 const hash=createHash('sha256').update('synthetic').digest('hex'),archive=join(root,'client-history','client-sales-originals',hash+'.xlsx');writeFileSync(archive,'synthetic');
 const done=makeJob('completed',{operation:'import',result:{fileHash:hash,status:'imported'},updatedAt:new Date().toISOString()});
 const expiredDone=makeJob('completed',{operation:'import',result:{fileHash:hash,status:'imported'}});
 const orphan=join(base,randomUUID());mkdirSync(orphan);writeFileSync(join(orphan,'input.xlsx'),'abandoned');writeFileSync(join(orphan,'status.json.'+randomUUID()+'.tmp'),'interrupted atomic save');utimesSync(orphan,old/1000,old/1000);
 const recentOrphan=join(base,randomUUID());mkdirSync(recentOrphan);writeFileSync(join(recentOrphan,'input.xlsx'),'creating');
 const outside=join(temp,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),'private synthetic');
 const linked=join(base,randomUUID());symlinkSync(outside,linked);
 const forged=makeJob();forged.source=join(outside,'keep');save(forged);
 const linkedInput=makeJob();rmSync(linkedInput.source);symlinkSync(join(outside,'keep'),linkedInput.source);
 const originalArchive=readFileSync(archive);
 jobs.retainJobs(root);
 for(const job of [retainedReady,retainedRunning,liveTerminal,failedImport,forged,linkedInput])assert(existsSync(join(base,job.id)),job.id);
 assert(existsSync(retainedReady.source));assert(existsSync(retainedRunning.source));assert(existsSync(failedImport.source));assert(existsSync(liveTerminal.source));
 assert(!existsSync(join(base,oldFailed.id)));assert(!existsSync(join(base,expiredDone.id)));assert(!existsSync(join(base,abandonedReady.id)),'Unpinned expired ready preview is pruned');assert(existsSync(join(base,recentReady.id)),'Recent unpinned ready preview remains within retention');assert(!existsSync(orphan));assert(existsSync(recentOrphan));
 assert(existsSync(join(base,current.id,'status.json')));assert(!existsSync(current.source),'Current status retained after failed preview staging cleanup');
 assert(existsSync(join(base,done.id,'status.json')));assert(!existsSync(done.source),'Completed status retained for idempotence');
 assert(existsSync(linked));assert.equal(readFileSync(join(outside,'keep'),'utf8'),'private synthetic');assert.deepEqual(readFileSync(archive),originalArchive);
 // Managed-parent symlink and status/directory escape are rejected without traversal.
 renameSync(base,base+'-saved');symlinkSync(outside,base);assert.throws(()=>jobs.jobFolder(root));rmSync(base);renameSync(base+'-saved',base);
 assert.throws(()=>jobs.readJob(root,join(outside,'status.json')));
 // Count and byte pressure remove only disposable terminal/orphan jobs.
 const counted=[];for(let n=0;n<jobs.RETENTION.terminalCount+4;n++)counted.push(makeJob('failed',{updatedAt:new Date().toISOString()}));
 jobs.retainJobs(root);
 assert.equal([...counted,done].filter(job=>existsSync(join(base,job.id,'status.json'))).length,jobs.RETENTION.terminalCount);
 const oversized=makeJob('failed',{updatedAt:new Date().toISOString()});
 const fd=openSync(join(base,oversized.id,'request.json'),'w');ftruncateSync(fd,jobs.RETENTION.terminalBytes+1);closeSync(fd);
 jobs.retainJobs(root);assert(!existsSync(join(base,oversized.id)),'Byte bound applies even before TTL expiry');
 assert.equal([...counted,done].filter(job=>existsSync(join(base,job.id,'status.json'))).length,jobs.RETENTION.terminalCount,'Removing oversized job must not evict other retained jobs');
 // Remove deliberately unsafe test directories before capacity scanning.
 rmSync(linked);rmSync(join(base,forged.id),{recursive:true});rmSync(join(base,linkedInput.id),{recursive:true});
 const quota=makeJob('ready',{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});const qfd=openSync(quota.source,'w');ftruncateSync(qfd,jobs.RETENTION.totalBytes);closeSync(qfd);
 assert.throws(()=>jobs.checkUploadCapacity(root,1),/Spațiul/);jobs.retainJobs(root);assert(!existsSync(join(base,quota.id)),'Unpinned ready preview is eligible for byte-pressure pruning');assert.doesNotThrow(()=>jobs.checkUploadCapacity(root,1));
 // Alive beyond 20 minutes, EPERM, PID-less prelaunch, reused PID, and true death.
 const live=makeJob('running',{pid:process.pid,processIdentity:jobs.processIdentity(process.pid)});
 assert.equal((await (await status(live.id)).json()).job.state,'running');
 const kill=Reflect.get(process,'kill');
 try{process.kill=()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});};assert.equal(jobs.workerAlive(live),undefined);assert.equal((await (await status(live.id)).json()).job.state,'running');}finally{process.kill=kill;}
 assert.equal((await (await status(retainedRunning.id)).json()).job.state,'running','Known live worker remains running');
 const prelaunch=makeJob('running');assert.equal((await (await status(prelaunch.id)).json()).job.state,'failed','PID-less prelaunch record is recovered after the grace period');
 const attemptOnly=makeJob('running',{attempt:randomUUID()});assert.equal((await (await status(attemptOnly.id)).json()).job.state,'failed','A launch attempt without any recorded PID is also recovered after the grace period');
 const invalidPid=makeJob('running',{pid:-1});assert.equal((await (await status(invalidPid.id)).json()).job.state,'failed');jobs.retainJobs(root);assert(!existsSync(invalidPid.source),'Invalid PID terminal job releases staged upload instead of being treated as live');
 const reused=makeJob('running',{pid:process.pid,processIdentity:'previous-boot:1'});assert.equal((await (await status(reused.id)).json()).job.state,'failed');
 const exited=spawnSync(process.execPath,['-e','']);const dead=makeJob('running',{pid:exited.pid});assert.equal((await (await status(dead.id)).json()).job.state,'failed');
 // Worker saves terminal success between status read and the ESRCH check.
 const racing=makeJob('running',{pid:exited.pid});
 try{
  process.kill=(pid,signal)=>{if(pid===racing.pid){save({...racing,state:'completed',updatedAt:new Date().toISOString()});throw Object.assign(new Error('exited'),{code:'ESRCH'});}return kill(pid,signal);};
  assert.equal((await (await status(racing.id)).json()).job.state,'completed','Terminal success must not be overwritten by death recovery');
 }finally{process.kill=kill;}
 // Missing env is rejected by the actual worker before it reads/writes a job.
 const workerEnv={...process.env};delete workerEnv.MOBIUP_DATA_DIR;
 const stopped=spawnSync(process.execPath,[join(temp,'client-history-import-worker.mjs'),join(base,retainedReady.id,'status.json'),'attempt'],{env:workerEnv,encoding:'utf8'});
 assert.notEqual(stopped.status,0);assert.match(stopped.stderr,/MOBIUP_DATA_DIR/);assert(existsSync(retainedReady.source));
 const staleReady=makeJob('ready',{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}),newerReady=makeJob('ready',{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 writeFileSync(join(base,'owner-'+createHash('sha256').update(manager.id).digest('hex')+'.json'),JSON.stringify({id:newerReady.id}));
 await assert.rejects(()=>commit(staleReady.id),{status:409},'Only the current ready preview can enter import; unpinned previews stay disposable');
 async function poll(id){for(let n=0;n<250;n++){const job=(await (await status(id)).json()).job;if(job.state!=='running')return job;await sleep(20);}throw Error('Job timeout');}
 async function upload(name){
  const response=await api.historyImportPreview(new Request('http://local.invalid/preview',{method:'POST',headers:{'X-Client-Sales-Filename':name},body:readFileSync(join(root,name))}),manager);assert.equal(response.status,202);
  const {job}=await response.json(),stored=jobs.readJob(root,join(base,job.id,'status.json'));
  assert(stored.pid>0,'PID persisted before returning to caller');assert(stored.processIdentity);assert(stored.attempt);
  return poll(job.id);
 }
 let ready=await upload('upload.xlsx');assert.equal(ready.state,'ready',ready.error);assert(existsSync(join(base,ready.id,'input.xlsx')));
 // Commit immediately: launch must handle the preview's exiting flock.
 assert.equal((await commit(ready.id)).status,202);
 let completed=await poll(ready.id);assert.equal(completed.state,'completed',completed.error);await sleep(30);
 assert(existsSync(join(root,'rebuild-checked')));assert(!existsSync(join(base,ready.id,'input.xlsx')));assert.equal((await commit(ready.id)).status,200);
 ready=await upload('empty.xlsx');assert.equal(ready.state,'ready',ready.error);assert.equal(ready.preview.rows,0);assert.equal(ready.preview.removedOccurrences,2);assert(ready.preview.requiresAcknowledgement);
 await commit(ready.id);completed=await poll(ready.id);assert.equal(completed.state,'completed',completed.error);assert.equal(completed.result.valueCents,0);assert.equal((await commit(ready.id)).status,200);
 for(let n=0;n<100;n++){const stored=jobs.readJob(root,join(base,ready.id,'status.json'));if(jobs.workerAlive(stored)===false)break;await sleep(20);}
 // Global flock still rejects a second worker and its failed preview is disposable.
 const holder=spawn('flock',['-n','--no-fork',join(root,'client-history','.upload-process.lock'),process.execPath,'-e',"process.stdout.write('locked');setTimeout(()=>{},10000)"],{stdio:['ignore','pipe','pipe']});children.push(holder);await once(holder.stdout,'data');
 const blocked=await upload('upload.xlsx');assert.equal(blocked.state,'failed');
 holder.kill();await once(holder,'exit');children=[];
 console.log('PASS: isolated importer root guards, retention TTL/count/bytes, symlink/outside protection, liveness/EPERM/PID reuse, persisted launch handshake, global flock, cumulative and empty commits, archive-before-cleanup and completed idempotence.');
}finally{
 for(const child of children)child.kill();
 process.chdir(originalCwd);if(originalRoot===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=originalRoot;
 rmSync(temp,{recursive:true,force:true});
}
