import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import workerSource from '../tools/run-manager-ai-sandbox.py?raw';
import type { ManagerAiPreparedArtifact } from './manager-ai-media-contract';
export class SandboxFailure extends Error {
  constructor(readonly status:number,message:string) {super(message);}
}
function fail(status:number,message:string):never {throw new SandboxFailure(status,message);}

export type ManagerAiSandboxRequest = {
  language:'python'|'sql';
  code:string;
  database?:Uint8Array;
  inputs?:readonly ManagerAiPreparedArtifact[];
  signal:AbortSignal;
};
const bubblewrap='/usr/bin/bwrap';
const runtime='/opt/mobiup-analysis-runtime';
const python=runtime+'/bin/python';
const libraryDirectory='/usr/lib/x86_64-linux-gnu';
const shellTimeoutMs=20_000;
export const maxCodeBytes=24*1024;
export const maxDatabaseBytes=32*1024*1024;
export const maxArtifactBytes=2*1024*1024;
export const maxWorkerBytes=6*1024*1024;
const maxStderrBytes=32*1024;
export const inputBytes=3*1024*1024;
export const maxFiles=4;
let occupied=false;

function rootManaged(path:string,directory=false) {
  const info=statSync(path);
  return info.uid===0&&(info.mode&0o022)===0&&(directory?info.isDirectory():info.isFile());
}

function workerBase():string|null {
  if(process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED!=='1'||process.platform!=='linux'||process.arch!=='x64')return null;
  try {
    const base=dirname(dirname(realpathSync(python)));
    if(!/^\/opt\/runtimes\/python\/cpython-[^/]+-linux-x86_64-gnu$/.test(base)||
      !rootManaged(runtime,true)||!rootManaged(runtime+'/.sandbox-runtime-v1')||
      !rootManaged(base,true)||!rootManaged(bubblewrap)||!rootManaged(libraryDirectory+'/libseccomp.so.2'))return null;
    accessSync(python,constants.X_OK);
    accessSync(bubblewrap,constants.X_OK);
    return base;
  } catch { /* A missing or writable sandbox dependency disables the feature. */ }
  return null;
}

export function localSandboxAvailable():boolean {
  return workerBase()!==null;
}

function sandboxArguments(base:string,dir:string,language:ManagerAiSandboxRequest['language']) {
  return [
    '--unshare-all','--unshare-user','--disable-userns','--as-pid-1',
    '--die-with-parent','--cap-drop','ALL',
    '--clearenv','--setenv','LC_ALL','C.UTF-8','--setenv','TMPDIR','/tmp',
    '--setenv','OPENBLAS_NUM_THREADS','1','--setenv','OMP_NUM_THREADS','1',
    '--setenv','MKL_NUM_THREADS','1','--setenv','NUMEXPR_NUM_THREADS','1','--setenv','MPLBACKEND','Agg',
    '--ro-bind',runtime,runtime,'--ro-bind',base,base,
    '--ro-bind',libraryDirectory,libraryDirectory,'--ro-bind','/usr/lib64','/usr/lib64',
    '--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
    '--ro-bind',dir,'/input','--ro-bind-data','3','/worker.py',
    '--proc','/proc','--remount-ro','/proc','--dev','/dev',
    '--size',String(16*1024*1024),'--tmpfs','/tmp',
    '--size',String(8*1024*1024),'--tmpfs','/output',
    '--chdir','/output','--',python,'-IB','/worker.py',language,
  ];
}

async function stageInputs(dir:string,request:ManagerAiSandboxRequest) {
  const {language,code,database,inputs=[]}=request;
  if(!code.trim()||Buffer.byteLength(code)>maxCodeBytes||code.includes('\0'))fail(400,'Programul este gol sau depășește limita de 24 KiB.');
  if(database&&(database.byteLength>maxDatabaseBytes||Buffer.from(database.subarray(0,16)).toString('binary')!=='SQLite format 3\0')){
    fail(413,'Setul de analiză SQLite este invalid sau depășește 32 MiB.');
  }
  if(language==='sql'&&!database)fail(400,'Alege seturile de date înainte de interogarea SQL.');
  if(inputs.length>maxFiles||inputs.some(item=>item.kind!=='input'||item.bytes.byteLength>maxArtifactBytes)||
    inputs.reduce((sum,item)=>sum+item.bytes.byteLength,0)>inputBytes)fail(413,'Atașamentele pentru analiză depășesc limita admisă.');
  await writeFile(join(dir,language==='sql'?'program.sql':'program.py'),code,{mode:0o600,flag:'wx'});
  if(database)await writeFile(join(dir,'data.sqlite'),database,{mode:0o600,flag:'wx'});
  await mkdir(join(dir,'files'),{mode:0o700});
  for(const [index,file] of inputs.entries()) {
    const clean=basename(file.filename).normalize('NFC').replace(/[^\p{L}\p{N} ._()-]/gu,'_').slice(0,112);
    await writeFile(join(dir,'files',String(index+1)+'-'+clean),file.bytes,{mode:0o600,flag:'wx'});
  }
}

function killGroup(pid:number|undefined) {
  if(!pid)return;
  try{process.kill(-pid,'SIGKILL');}catch {
    try{process.kill(pid,'SIGKILL');}catch { /* Closing stdin independently stops the namespace worker. */ }
  }
}

async function execute(base:string,directory:string,language:ManagerAiSandboxRequest['language'],external:AbortSignal) {
  const timer=AbortSignal.timeout(shellTimeoutMs);
  const signal=AbortSignal.any([external,timer]);
  signal.throwIfAborted();
  const child=spawn(bubblewrap,sandboxArguments(base,directory,language),{
    // A detached launcher has no controlling terminal and retains one killable group.
    cwd:directory,env:{LC_ALL:'C.UTF-8',NODE_ENV:'production',APP_NAME:'Mobiup'},detached:true,stdio:['pipe','pipe','pipe','pipe'],
  });
  const closed=once(child,'close');
  const abort=()=>{
    child.stdin?.destroy();
    if(child.exitCode===null&&child.signalCode===null)killGroup(child.pid);
  };
  const source=child.stdio[3];
  // The reviewed supervisor arrives via an anonymous FD from this exact build.
  // Its path cannot be replaced by the caller or a stale installation file.
  if(source&&'end' in source) {
    source.on('error',abort);
    source.end(workerSource,'utf8');
  } else abort();
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  let written=0,diagnostics=0,overflow=false;
  const stdout:Buffer[]=[];
  child.stdout?.on('data',(part:Buffer)=>{
    written+=part.length;
    if(written>maxWorkerBytes){overflow=true;abort();return;}
    stdout.push(part);
  });
  child.stderr?.on('data',(part:Buffer)=>{
    diagnostics+=part.length;
    if(diagnostics>maxStderrBytes){overflow=true;abort();}
  });
  try {
    const [code]=await closed;
    external.throwIfAborted();
    if(timer.aborted)fail(504,'Execuția izolată a depășit timpul disponibil.');
    if(overflow)fail(413,'Rezultatul execuției izolate depășește limita.');
    if(code!==0)fail(503,'Runtime-ul de analiză izolat nu a putut porni sau a întrerupt execuția.');
    return Buffer.concat(stdout,written).toString('utf8');
  } finally {
    signal.removeEventListener('abort',abort);
  }
}

export async function executeLocalSandbox(request:ManagerAiSandboxRequest):Promise<string> {
  request.signal.throwIfAborted();
  const base=workerBase();
  if(!base)fail(503,'Execuția SQL/Python izolată nu este configurată pentru această instanță.');
  if(occupied)fail(429,'O analiză SQL/Python rulează deja. Încearcă din nou după terminarea ei.');
  occupied=true;
  let directory:string|undefined;
  try {
    directory=await mkdtemp(join(tmpdir(),'manager-ai-analysis-'));
    await stageInputs(directory,request);
    const raw=await execute(base,directory,request.language,request.signal);
    request.signal.throwIfAborted();
    return raw;
  } finally {
    try { if(directory)await rm(directory,{recursive:true,force:true}); }
    finally {occupied=false;}
  }
}
