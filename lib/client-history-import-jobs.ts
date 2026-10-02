// Host-only importer storage and lifecycle invariants. Never trust paths in status JSON.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmdirSync,unlinkSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import type {HistoryJob} from './client-history-import-types';
export type ImportJob=HistoryJob&{userId:string;directory:string;source:string;pid?:number;processIdentity?:string;attempt?:string};
export const JOB_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const RETENTION={ttlMs:7*24*60*60*1000,terminalCount:128,terminalBytes:256*1024*1024,totalBytes:1024*1024*1024};
const managedFiles=new Set(['input.xlsx','status.json','request.json','commit.json','reference-partners.json','reference-master.json']);
function managedFile(name:string){return managedFiles.has(name)||(name.startsWith('status.json.')&&name.endsWith('.tmp')&&JOB_ID.test(name.slice(12,-4)));}
function ordinary(path:string,kind:'file'|'directory'){
 const stat=lstatSync(path);if(stat.isSymbolicLink()||!(kind==='file'?stat.isFile():stat.isDirectory()))throw Error('Calea importului nu este validă.');return stat;
}
export function importRoot(){
 const configured=process.env.MOBIUP_DATA_DIR?.trim();
 if(!configured)throw Error('Importul necesită MOBIUP_DATA_DIR configurat explicit.');
 const root=realpathSync(resolve(configured));ordinary(root,'directory');
 const history=join(root,'client-history');ordinary(history,'directory');
 const path=join(history,'client-sales-history.sqlite');ordinary(path,'file');
 const c=new DatabaseSync(path,{readOnly:true});
 try{
  c.exec('PRAGMA busy_timeout=5000');
  if(c.prepare("SELECT value FROM history_meta WHERE key='schema_version'").get()?.value!=='1'||!c.prepare("SELECT r.id FROM history_references r JOIN history_meta m ON m.key='current_reference' AND m.value=r.id").get())throw Error('Istoricul pe clienți nu este încă inițializat.');
  for(const table of ['history_imports','history_rows','history_identities','history_allocations'])c.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
 }finally{c.close();}
 return root;
}
export function jobFolder(root:string){
 const path=join(root,'client-history','import-jobs');
 if(!existsSync(path))mkdirSync(path,{mode:0o700});
 ordinary(path,'directory');return path;
}
export function jobLocation(root:string,id:string){
 if(!JOB_ID.test(id))throw Error('Import invalid.');
 const path=join(jobFolder(root),id);if(existsSync(path))ordinary(path,'directory');return path;
}
export function readJob(root:string,path:string){
 const id=basename(dirname(path));
 if(path!==join(jobLocation(root,id),'status.json'))throw Error('Calea importului nu este validă.');
 ordinary(path,'file');const job=JSON.parse(readFileSync(path,'utf8')) as ImportJob;
 if(job.id!==id||job.directory!==root||job.source!==join(dirname(path),'input.xlsx'))throw Error('Calea importului nu este validă.');
 if(existsSync(job.source))ordinary(job.source,'file');
 return job;
}
export function processIdentity(pid:number){
 try{
  const raw=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
  return readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fields[19];
 }catch{return undefined;}
}
export function workerAlive(job:Pick<ImportJob,'pid'|'processIdentity'>):boolean|undefined{
 if(!job.pid||!Number.isInteger(job.pid)||job.pid<=0)return undefined;
 try{process.kill(job.pid,0);}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'?false:undefined;}
 const identity=processIdentity(job.pid);
 if(job.processIdentity&&identity&&job.processIdentity!==identity)return false;
 // Missing identity/EPERM is uncertainty, never evidence that an import died.
 return true;
}
export function recoverDeadWorker(root:string,path:string,job:ImportJob){
 if(job.state!=='running'||Date.now()-Date.parse(job.updatedAt)<=5000||workerAlive(job)!==false)return job;
 // Read again AFTER proving death, since the worker may have saved success
 // immediately before exiting. A missing PID or EPERM can never enter here.
 const current=readJob(root,path);
 if(current.state!=='running'||current.attempt!==job.attempt||current.pid!==job.pid||current.updatedAt!==job.updatedAt)return current;
 current.state='failed';current.error='Procesarea a fost întreruptă. Reîncarcă același fișier; datele deja aplicate nu se dublează.';current.updatedAt=new Date().toISOString();
 const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(current),{mode:0o600});renameSync(temp,path);
 return current;
}
function archiveSafe(root:string,job:ImportJob){
 const hash=job.result?.fileHash;
 if(!hash||!/^([0-9a-f]{64})$/.test(hash)||!['imported','already_imported'].includes(job.result?.status||''))return false;
 try{
  const folder=join(root,'client-history','client-sales-originals');ordinary(folder,'directory');
  const path=join(folder,hash+'.xlsx');ordinary(path,'file');
  return createHash('sha256').update(readFileSync(path)).digest('hex')===hash;
 }catch{return false;}
}
export function cleanupStaging(root:string,job:ImportJob){
 // Called only after terminal status was persisted. A failed post-import rebuild
 // still has a verified result/archive; a failed preview cannot be resumed.
 if(!['completed','failed'].includes(job.state))return false;
 const path=join(jobLocation(root,job.id),'status.json'),current=readJob(root,path);
 if(current.state!==job.state||current.attempt!==job.attempt)return false;
 const input=join(dirname(path),'input.xlsx');
 if(!existsSync(input))return true;
 if(!(job.state==='failed'&&job.operation==='preview')&&!archiveSafe(root,job))return false;
 if(existsSync(input)){ordinary(input,'file');unlinkSync(input);}
 return true;
}
export function retainJobs(root:string,now=Date.now()){
 const folder=jobFolder(root),pinned=new Set<string>();
 for(const name of readdirSync(folder)){
  if(!/^owner-[0-9a-f]{64}\.json$/.test(name))continue;
  // A malformed pointer makes pruning conservative; never remove another user's current job.
  try{ordinary(join(folder,name),'file');const id=JSON.parse(readFileSync(join(folder,name),'utf8')).id;if(!JOB_ID.test(id))return;pinned.add(id);}catch{return;}
 }
 const candidates:{id:string;path:string;time:number;bytes:number;job?:ImportJob}[]=[];
 for(const id of readdirSync(folder)){
  if(!JOB_ID.test(id))continue;
  try{
   const path=jobLocation(root,id),files=readdirSync(path);
   // Do not traverse symlinks, unknown contents, or paths supplied by a status.
   if(files.some(name=>!managedFile(name)))continue;
   let bytes=0;for(const name of files)bytes+=ordinary(join(path,name),'file').size;
   const status=join(path,'status.json');let job=existsSync(status)?readJob(root,status):undefined;
   if(job)job=recoverDeadWorker(root,status,job);
   if(job&&(job.state==='ready'||job.state==='running'||(job.pid&&workerAlive(job)!==false)))continue;
   if(job&&!['failed','completed'].includes(job.state))continue;
   const time=job?Date.parse(job.updatedAt):lstatSync(path).mtimeMs;if(!Number.isFinite(time))continue;
   if(!job&&now-time<RETENTION.ttlMs)continue;
   if(job){
    if(!cleanupStaging(root,job)&&existsSync(join(path,'input.xlsx')))continue;
    bytes=0;for(const name of readdirSync(path))bytes+=ordinary(join(path,name),'file').size;
   }
   if(pinned.has(id))continue;
   candidates.push({id,path,time,bytes,job});
  }catch{/* Unrecognized/in-use filesystem state is retained. */}
 }
 candidates.sort((a,b)=>b.time-a.time);
 let keptBytes=0,keptCount=0;
 for(const item of candidates){
  if(now-item.time<RETENTION.ttlMs&&keptCount<RETENTION.terminalCount&&keptBytes+item.bytes<=RETENTION.terminalBytes){keptCount++;keptBytes+=item.bytes;continue;}
  try{
   // A status appearing in an abandoned directory makes it a new/live job.
   if(!item.job&&existsSync(join(item.path,'status.json')))continue;
   // Failed imports without a verified archive retain their source for recovery.
   if(item.job&&existsSync(join(item.path,'input.xlsx'))&&!cleanupStaging(root,item.job))continue;
   for(const name of readdirSync(item.path)){if(!managedFile(name))throw Error('Unknown file');ordinary(join(item.path,name),'file');}
   for(const name of readdirSync(item.path))unlinkSync(join(item.path,name));
   rmdirSync(item.path);
  }catch{/* Another request may be inspecting or completing this job. */}
 }
}
export function checkUploadCapacity(root:string,incoming:number){
 // Protected ready/running/current jobs are never evicted to meet a quota.
 // Refuse new uploads at the hard staging bound instead.
 let bytes=0;
 const folder=jobFolder(root);
 for(const id of readdirSync(folder)){
  if(!JOB_ID.test(id))continue;
  const path=jobLocation(root,id);
  for(const name of readdirSync(path))bytes+=ordinary(join(path,name),'file').size;
 }
 if(bytes+incoming>RETENTION.totalBytes)throw Error('Spațiul rezervat importurilor este ocupat. Finalizează importurile pregătite.');
}
