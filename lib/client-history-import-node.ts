import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fail,jsonBody,readLimited,requireManager,response} from './server';
import type {User} from './types';
import type {HistoryJob,HistoryImportStatus} from './client-history-import-types';
import {importRoot,jobFolder,jobLocation,readJob,processIdentity,recoverDeadWorker,cleanupStaging,retainJobs,checkUploadCapacity,type ImportJob as InternalJob} from './client-history-import-jobs';
function root(){try{return importRoot();}catch{fail(503,'Importul necesită un director MOBIUP_DATA_DIR configurat și un istoric inițializat.');}}
function folder(){return jobFolder(root());}
function pointer(user:User){return join(folder(),'owner-'+createHash('sha256').update(user.id).digest('hex')+'.json');}
function atomic(path:string,data:unknown){const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(data),{mode:0o600});renameSync(temp,path);}
function location(id:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))fail(400,'Import invalid.');return jobLocation(root(),id);}
function load(user:User,id:string):InternalJob{
 const path=join(location(id),'status.json');if(!existsSync(path))fail(404,'Importul nu a fost găsit.');
 const job=readJob(root(),path);
 if(job.userId!==user.id)fail(404,'Importul nu a fost găsit.');
 return recoverDeadWorker(root(),path,job);
}
function exposed(job:InternalJob):HistoryJob{const {id,operation,state,phase,message,filename,createdAt,updatedAt,preview,result,error}=job;return {id,operation,state,phase,message,filename,createdAt,updatedAt,preview,result,error};}
function worker(){const found=[resolve(process.cwd(),'client-history-import-worker.mjs'),resolve(process.cwd(),'dist/standalone/client-history-import-worker.mjs')].find(existsSync);if(!found)fail(503,'Importul izolat nu este disponibil în această versiune.');return realpathSync(found);}
function launch(job:InternalJob){
 const file=worker(),directory=root(),path=join(location(job.id),'status.json');
 job.attempt=randomUUID();
 // --no-fork keeps the persisted PID/start identity across flock -> node exec.
 // A short lock wait lets a just-ready preview finish exiting before commit.
 // The worker waits for this exact attempt/PID to be persisted before saving.
 const child=spawn('flock',['-w','2','--no-fork',join(directory,'client-history','.upload-process.lock'),process.execPath,'--max-old-space-size=512',file,path,job.attempt],{detached:true,stdio:'ignore',env:{...process.env,MOBIUP_DATA_DIR:directory}});
 job.pid=child.pid;job.processIdentity=child.pid?processIdentity(child.pid):undefined;
 atomic(path,job);
 const failed=(message:string)=>{
  try{
   const current=readJob(directory,path);
   if(current.state==='running'&&current.attempt===job.attempt){current.state='failed';current.error=message;current.updatedAt=new Date().toISOString();atomic(path,current);cleanupStaging(directory,current);}
  }catch{/* A removed/invalid terminal record must not crash the HTTP process. */}
 };
 child.on('error',()=>failed('Procesarea nu a putut porni.'));
 child.once('exit',code=>{if(code!==0)failed('Un alt import este în curs sau procesarea a fost întreruptă. Reîncarcă fișierul după finalizare.');});
 child.unref();return exposed(job);
}
export async function historyImportStatus(req:Request,user:User){
 requireManager(user);retainJobs(root());const id=new URL(req.url).searchParams.get('job');
 if(id)return response({job:exposed(load(user,id))});
 const history=join(root(),'client-history','client-sales-history.sqlite');let latest:HistoryImportStatus['latest']=null;
 if(existsSync(history)){const c=new DatabaseSync(history,{readOnly:true});try{c.exec('PRAGMA busy_timeout=5000');const r=c.prepare("SELECT filename,period_start,period_end,row_count,imported_at FROM history_imports WHERE state='active' AND original_path LIKE '%.xlsx' ORDER BY imported_at DESC,id DESC LIMIT 1").get();if(r)latest={filename:String(r.filename),from:String(r.period_start),through:String(r.period_end),rows:Number(r.row_count),importedAt:String(r.imported_at)};}finally{c.close();}}
 let job:HistoryJob|null=null;
 if(existsSync(pointer(user))){const saved=JSON.parse(readFileSync(pointer(user),'utf8'));try{job=exposed(load(user,saved.id));}catch{job=null;}}
 return response({latest,job} satisfies HistoryImportStatus);
}
export async function historyImportPreview(req:Request,user:User){
 requireManager(user);const directory=root();worker();retainJobs(directory);
 let filename='';try{filename=decodeURIComponent(req.headers.get('X-Client-Sales-Filename')||'');}catch{fail(400,'Nume de fișier invalid.');}
 if(!filename||filename.length>250||!filename.toLowerCase().endsWith('.xlsx')||(/[\\/]/.test(filename)||filename.split('').some(char=>char.charCodeAt(0)<32)))fail(400,'Alege un fișier .xlsx valid.');
 if(!existsSync(join(root(),'client-history','client-sales-history.sqlite')))fail(409,'Istoricul pe clienți nu este încă inițializat.');
 if(existsSync(pointer(user))){const prior=JSON.parse(readFileSync(pointer(user),'utf8'));if(load(user,prior.id).state==='running')fail(409,'Ai deja un import în curs.');}
 const bytes=await readLimited(req,32*1024*1024);if(!bytes.length)fail(400,'Fișierul este gol.');
 try{checkUploadCapacity(directory,bytes.length);}catch{fail(503,'Spațiul rezervat importurilor este ocupat sau indisponibil. Finalizează importurile pregătite.');}
 const id=randomUUID(),dir=location(id),now=new Date().toISOString();mkdirSync(dir,{mode:0o700});
 const source=join(dir,'input.xlsx');writeFileSync(source,bytes,{mode:0o600});
 const job:InternalJob={id,userId:user.id,directory:root(),source,filename,operation:'preview',state:'running',phase:'parsing',message:'Se verifică fișierul cumulativ…',createdAt:now,updatedAt:now};
 atomic(join(dir,'status.json'),job);atomic(pointer(user),{id});return response({job:launch(job)},202);
}
export async function historyImportCommit(req:Request,user:User){
 requireManager(user);root();const body=await jsonBody(req);
 if(typeof body.jobId!=='string')fail(400,'Import invalid.');
 const job=load(user,body.jobId),dir=location(job.id);
 if(job.operation==='import'&&(job.state==='running'||job.state==='completed'))return response({job:exposed(job)},job.state==='running'?202:200);
 const owner=existsSync(pointer(user))?JSON.parse(readFileSync(pointer(user),'utf8')):null;
 if(owner?.id!==job.id)fail(409,'Previzualizarea nu mai este curentă. Reîncarcă fișierul.');
 if(job.state!=='ready'||!job.preview)fail(409,'Reia previzualizarea fișierului.');
 if(job.preview.requiresAcknowledgement&&!job.preview.alreadyImported&&body.allowRegression!==true)fail(409,'Confirmă corecțiile din previzualizare.');
 worker();
 try{writeFileSync(join(dir,'commit.json'),JSON.stringify({revision:job.preview.revision,fileHash:job.preview.fileHash,allowRegression:body.allowRegression===true}),{flag:'wx',mode:0o600});}
 catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')fail(409,'Confirmarea acestui import a fost deja transmisă. Verifică progresul.');throw error;}
 job.operation='import';job.state='running';job.phase='import';job.message='Se actualizează luna curentă…';job.updatedAt=new Date().toISOString();delete job.pid;delete job.processIdentity;delete job.attempt;
 atomic(join(dir,'status.json'),job);return response({job:launch(job)},202);
}
