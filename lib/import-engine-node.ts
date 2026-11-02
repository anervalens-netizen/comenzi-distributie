import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,open,readFile,rename,rm,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {importAuthorization,withImportAuthorization} from './import-write-authorization';
import {fail,jsonBody,requireManager,response} from './server';
import {importCatalog} from './import-catalog';
import type {User} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const date=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
function config(){
 const root=process.env.MOBIUP_DATA_DIR?.trim(),base=process.env.IMPORT_ENGINE_URL?.trim();
 if(!root||!base)fail(503,'Serviciul de import nu este configurat.');
 let url:URL;try{url=new URL(base);}catch{return fail(503,'Serviciul de import nu este configurat.');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)fail(503,'Serviciul de import nu este configurat.');
 return {root:resolve(root),base:url.origin};
}
async function engine(path:string,method='GET',body?:unknown){
 const {base}=config();let key=process.env.IMPORT_ENGINE_KEY?.trim();
 if(!key&&process.env.IMPORT_ENGINE_KEY_FILE)try{key=(await readFile(process.env.IMPORT_ENGINE_KEY_FILE,'utf8')).trim();}catch{/* unavailable */}
 if(!key)fail(503,'Serviciul de import nu este configurat.');
 const headers={Authorization:`Bearer ${key}`,...(body?{'Content-Type':'application/json'}:{})};
 let res:Response;try{res=await fetch(base+path,method==='GET'?{headers,signal:AbortSignal.timeout(15000)}:{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});}catch{fail(503,'Serviciul de import nu răspunde. Verifică jurnalul folosind același ID.');}
 let data:unknown;try{data=await res.json();}catch{fail(502,'Răspuns invalid de la serviciul de import.');}
 if(!res.ok)fail(res.status>=400&&res.status<500?res.status:503,'Serviciul de import a refuzat cererea. Verifică jurnalul.');
 return data as {job?:EngineJob;jobs?:EngineJob[];next_cursor?:string};
}
type EngineJob={actor?:{id?:string};kind?:string;[key:string]:unknown};
function actor(user:User){return {id:user.id,label:user.name,type:process.env.MOBIUP_EVA_USER_ID===user.id?'service' as const:'human' as const};}
function canSee(user:User,job:EngineJob){return user.managerScope==='global'||job.actor?.id===user.id;}
function sourceHeader(req:Request,name:string){return (req.headers.get('X-Import-'+name)||'').trim();}
async function lockAdmission(folder:string){
 const lock=join(folder,'.admission.lock');
 try{const entry=await lstat(lock);if(!entry.isFile()||entry.isSymbolicLink())fail(503,'Blocarea importului nu este validă.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const child=spawn('/usr/bin/flock',['--exclusive','--nonblock','--conflict-exit-code','75','--no-fork',lock,process.execPath,'-e',"process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],{stdio:['pipe','pipe','ignore']});
 let stopped=false;const exited=new Promise<number|null>((resolveExit,reject)=>{child.once('error',reject);child.once('exit',code=>{stopped=true;resolveExit(code);});});
 child.stdin.on('error',()=>{});
 const ready=await Promise.race([new Promise<boolean>(resolveReady=>child.stdout.once('data',data=>resolveReady(String(data).trim()==='ready'))),exited.then(()=>false)]);
 if(!ready){child.stdin.end();await exited.catch(()=>{});fail(423,'Un alt fișier este în curs de încărcare. Reîncearcă după finalizare.');}
 return async()=>{if(!stopped)child.stdin.end();await exited.catch(()=>{});};
}
export async function importsCatalog(_req:Request,user:User){requireManager(user);return response({version:1,application:'comenzi',kinds:importCatalog});}
export async function importsJobs(req:Request,user:User){
 requireManager(user);
 if(req.method==='GET'){
  const query=new URL(req.url).searchParams;const allowed=new URLSearchParams();for(const k of ['limit','before','kind'])if(query.has(k))allowed.set(k,query.get(k)!);
  const data=await engine('/v1/jobs?'+allowed.toString());return response({...data,jobs:(data.jobs||[]).filter(j=>canSee(user,j))});
 }
 const id=sourceHeader(req,'Id').toLowerCase(),kind=sourceHeader(req,'Kind'),entry=importCatalog.find(x=>x.id===kind);
 if(!uuid.test(id)||!entry)fail(400,'ID sau tip de import invalid.');
 if(kind.startsWith('sim_')&&user.managerScope!=='global')fail(403,'Importul SIM necesită acces de manager global.');
 let filename='';try{filename=decodeURIComponent(sourceHeader(req,'Filename'));}catch{fail(400,'Nume de fișier invalid.');}
 if(!filename||filename.length>250||/[\\/]/.test(filename)||filename.split('').some(c=>c.charCodeAt(0)<32)||!entry.extensions.some(ext=>filename.toLowerCase().endsWith(ext)))fail(400,'Nume sau extensie de fișier invalidă.');
 const extension=entry.extensions.find(ext=>filename.toLowerCase().endsWith(ext))!;
 const hash=sourceHeader(req,'Sha256'),start=sourceHeader(req,'Date-Start'),end=sourceHeader(req,'Date-End'),sourceAt=sourceHeader(req,'Source-At'),company=sourceHeader(req,'Company');
 if(!/^[0-9a-f]{64}$/.test(hash)||!date(start)||!date(end)||start>end||sourceAt&&!date(sourceAt)||('requires_source_at' in entry&&!sourceAt)||('requires_company' in entry&&!company)||company.length>200)fail(400,'Metadate de import invalide.');
 const channel=sourceHeader(req,'Channel')||'browser';if(channel!=='browser'&&(channel!=='eva'||!process.env.MOBIUP_EVA_USER_ID||user.id!==process.env.MOBIUP_EVA_USER_ID))fail(403,'Canal de import neautorizat.');
 const {root}=config(),folder=join(root,'import-engine-spool');await mkdir(folder,{recursive:true,mode:0o700});
 if(!(await lstat(folder)).isDirectory()||(await lstat(folder)).isSymbolicLink())fail(503,'Directorul pentru importuri nu este valid.');
 const unlock=await lockAdmission(folder);
 try{
 const disk=await statfs(folder,{bigint:true});
 if(disk.bavail*disk.bsize<BigInt(40*1024**3+entry.max_bytes))fail(503,'Spațiul disponibil nu păstrează rezerva necesară pentru import.');
 const temporary=join(folder,'.'+randomUUID()),target=join(folder,id);await mkdir(temporary,{mode:0o700});
 try{
  const file=await open(join(temporary,'source'+extension), 'wx',0o600);let size=0;const digest=createHash('sha256');
  try{
   const reader=req.body?.getReader();if(!reader)fail(400,'Fișierul este gol.');
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>entry.max_bytes){await reader.cancel();fail(413,'Fișierul depășește limita permisă.');}digest.update(value);await file.writeFile(value);}
   await file.sync();
  }finally{await file.close();}
  if(!size||digest.digest('hex')!==hash)fail(400,'Hashul fișierului nu corespunde.');
  await chmod(join(temporary,'source'+extension),0o400);
  const source={filename,sha256:hash,size,date_start:start,date_end:end,...(sourceAt?{source_at:sourceAt}:{})};
  const authorization=importAuthorization(req,user);const frozen={id,kind,actor:actor(user),channel,source,payload:{source_path:join(target,'source'+extension),authorization,company},action:'preview'};
  const requestFile=await open(join(temporary,'request.json'),'wx',0o600);
  try{await requestFile.writeFile(JSON.stringify(frozen));await requestFile.sync();}finally{await requestFile.close();}
  const staging=await open(temporary,'r');try{await staging.sync();}finally{await staging.close();}
  withImportAuthorization(req,user,()=>{});
  try{await rename(temporary,target);}catch(error){
   if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code||''))throw error;
   const previous=JSON.parse(await readFile(join(target,'request.json'),'utf8'));
   if(JSON.stringify({...previous,payload:{...previous.payload,authorization:null}})!==JSON.stringify({...frozen,payload:{...frozen.payload,authorization:null}}))fail(409,'ID-ul este deja folosit pentru alt import.');
   return response(await engine('/v1/jobs','POST',previous),202);
  }
  const spool=await open(folder,'r');try{await spool.sync();}finally{await spool.close();}
  return response(await engine('/v1/jobs','POST',frozen),202);
 }finally{await rm(temporary,{recursive:true,force:true});}
 }finally{await unlock();}
}
export async function importsJob(req:Request,user:User,id:string,part?:string){
 requireManager(user);if(!uuid.test(id))fail(400,'Import invalid.');const current=await engine('/v1/jobs/'+id);const job=current.job;
 if(!job||!canSee(user,job))fail(404,'Importul nu a fost găsit.');
 if(req.method==='GET'&&(!part||part==='preview'))return response(current);
 if(req.method==='POST'&&part==='preview'){
  if(job.actor?.id!==user.id)fail(403,'Previzualizarea poate fi modificată doar de autor.');
  if(String(job.kind).startsWith('sim_')&&user.managerScope!=='global')fail(403,'Importul SIM necesită acces de manager global.');
  const body=await jsonBody(req);
  if(typeof body.request_id!=='string'||!uuid.test(body.request_id)||typeof body.preview_hash!=='string'||!body.options||typeof body.options!=='object'||Array.isArray(body.options))fail(400,'Previzualizare invalidă.');
  withImportAuthorization(req,user,()=>{});
  return response(await engine('/v1/jobs/'+id+'/preview','POST',{request_id:body.request_id,preview_hash:body.preview_hash,options:body.options,actor:actor(user),authorization:importAuthorization(req,user)}),202);
 }
 if(req.method==='POST'&&part==='commit'){
  if(job.actor?.id!==user.id)fail(403,'Importul poate fi confirmat doar de autor.');
  if(String(job.kind).startsWith('sim_')&&user.managerScope!=='global')fail(403,'Importul SIM necesită acces de manager global.');
  const body=await jsonBody(req);if(typeof body.preview_hash!=='string'||!body.options||typeof body.options!=='object'||Array.isArray(body.options))fail(400,'Confirmare invalidă.');
  withImportAuthorization(req,user,()=>{});
  return response(await engine('/v1/jobs/'+id+'/commit','POST',{preview_hash:body.preview_hash,options:body.options,actor:actor(user),authorization:importAuthorization(req,user)}),202);
 }
 return fail(404,'Importul nu a fost găsit.');
}
