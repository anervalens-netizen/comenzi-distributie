import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {buildActivitySnapshot} from './partner-activity-snapshot';
import {importRoot,readJob,processIdentity,cleanupStaging} from './client-history-import-jobs';
import type {HistoryPreview} from './client-history-import-types';
const path=process.argv[2],dir=dirname(path);
const root=importRoot(),attempt=process.argv[3];
let job=readJob(root,path);
// Parent persists the PID before this worker can overwrite status. No polling
// request may interpret the short launch handshake as proof of a dead worker.
for(let n=0;job.attempt!==attempt||job.pid!==process.pid;n++){
 if(n>=100)throw Error('Import launch handshake failed.');
 await new Promise(resolve=>setTimeout(resolve,50));job=readJob(root,path);
}
if(!attempt||job.state!=='running')throw Error('Import launch is no longer current.');
function save(){job.pid=process.pid;job.processIdentity=processIdentity(process.pid);job.updatedAt=new Date().toISOString();const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(job),{mode:0o600});renameSync(temp,path);}
async function parse(request:string){
 return new Promise<HistoryPreview>((resolve,reject)=>{
  const child=spawn('python3',[join(import.meta.dirname,'client_history_upload.py'),request],{stdio:['ignore','pipe','ignore']});
  let result:HistoryPreview|undefined,error='',size=0;
  const timer=setTimeout(()=>{error='Procesarea a depășit timpul permis.';child.kill('SIGKILL');},15*60*1000);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
   size+=line.length;if(size>1024*1024){error='Răspunsul procesării este prea mare.';child.kill('SIGKILL');return;}
   try{const message=JSON.parse(line) as {progress?:string;message?:string;result?:HistoryPreview;error?:string};
    if(message.progress){job.phase=message.progress;job.message=message.message||job.message;save();}
    if(message.result)result=message.result;if(message.error)error=message.error;
   }catch{error='Răspuns invalid de la procesarea fișierului.';}
  });
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);lines.close();if(code===0&&result&&!error)resolve(result);else reject(new Error(error||'Procesarea fișierului a eșuat. Reîncarcă același fișier pentru verificare.'));});
 });
}
try{
 const commit=job.operation==='import'?JSON.parse(readFileSync(join(dir,'commit.json'),'utf8')):{};
 const request=join(dir,'request.json');
 writeFileSync(request,JSON.stringify({operation:job.operation,directory:job.directory,source:job.source,filename:job.filename,jobId:job.id,...commit}),{mode:0o600});save();
 const result=await parse(request);
 if(job.operation==='preview'){job.preview=result;job.state='ready';job.phase='preview';job.message='Previzualizarea este pregătită.';save();}
 else{
  job.result=result;job.phase='rebuilding';job.message='Datele au fost aplicate. Se recalculează centralizările…';save();
  buildActivitySnapshot(job.directory);
  job.state='completed';job.phase='done';job.message=result.status==='already_imported'?'Fișierul era deja importat. Centralizările sunt actualizate.':'Vânzările pe clienți și centralizările au fost actualizate.';save();
 }
}catch(error){job.state='failed';job.error=error instanceof Error?error.message:'Importul nu a putut fi finalizat.';save();process.exitCode=1;}

// Staging is dispensable only after the terminal status and durable archive.
try{cleanupStaging(root,job);}catch{/* Retention retries safe cleanup later. */}
