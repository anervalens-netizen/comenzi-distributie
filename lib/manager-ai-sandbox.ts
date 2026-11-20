import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { ManagerAiCell } from './manager-ai';
import type { ManagerAiPreparedArtifact } from './manager-ai-media-contract';
import { normalizeManagerAiSandboxArtifact } from './manager-ai-sandbox-artifacts';
import { fail } from './server';

export type ManagerAiSandboxRequest = {
  language:'python'|'sql';
  code:string;
  database?:Uint8Array;
  inputs?:readonly ManagerAiPreparedArtifact[];
  signal:AbortSignal;
};
type ResultRows = {
  columns:string[];
  rows:ManagerAiCell[][];
  truncated:boolean;
  exportTruncated:boolean;
  exportedRows:number;
};
export type ManagerAiSandboxResult = {
  exitCode:number;
  stdout:string;
  stderr:string;
  rows?:ResultRows;
  artifacts:ManagerAiPreparedArtifact[];
  skippedArtifacts:number;
};
type WorkerPaths = {base:string; script:string};

const bubblewrap='/usr/bin/bwrap';
const runtime='/opt/mobiup-analysis-runtime';
const python=runtime+'/bin/python';
const libraryDirectory='/usr/lib/x86_64-linux-gnu';
const shellTimeoutMs=20_000;
const maxCodeBytes=24*1024;
const maxDatabaseBytes=32*1024*1024;
const maxArtifactBytes=2*1024*1024;
const maxWorkerBytes=6*1024*1024;
const maxStderrBytes=32*1024;
const inputBytes=3*1024*1024;
const maxFiles=4;
const artifactType={
  '.csv':'text/csv',
  '.tsv':'text/tab-separated-values',
  '.json':'application/json',
  '.txt':'text/plain',
  '.md':'text/markdown',
  '.png':'image/png',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
let occupied=false;

function rootManaged(path:string,directory=false) {
  const info=statSync(path);
  return info.uid===0&&(info.mode&0o022)===0&&(directory?info.isDirectory():info.isFile());
}

function workerPaths():WorkerPaths|null {
  if(process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED!=='1'||process.platform!=='linux'||process.arch!=='x64')return null;
  try {
    const base=dirname(dirname(realpathSync(python)));
    if(!/^\/opt\/runtimes\/python\/cpython-[^/]+-linux-x86_64-gnu$/.test(base)||
      !rootManaged(runtime,true)||!rootManaged(runtime+'/.sandbox-runtime-v1')||
      !rootManaged(base,true)||!rootManaged(bubblewrap)||!rootManaged(libraryDirectory+'/libseccomp.so.2'))return null;
    accessSync(python,constants.X_OK);
    accessSync(bubblewrap,constants.X_OK);
    const script=join(dirname(resolve(process.argv[1]??'.')),'run-manager-ai-sandbox.py');
    if(statSync(script).isFile())return {base,script};
  } catch { /* A missing or writable sandbox dependency disables the feature. */ }
  return null;
}

export function managerAiSandboxAvailable():boolean {
  return workerPaths()!==null;
}

function sandboxArguments(paths:WorkerPaths,dir:string,language:ManagerAiSandboxRequest['language']) {
  return [
    '--unshare-all','--unshare-user','--disable-userns','--as-pid-1',
    '--die-with-parent','--cap-drop','ALL',
    '--clearenv','--setenv','LC_ALL','C.UTF-8','--setenv','TMPDIR','/tmp',
    '--setenv','OPENBLAS_NUM_THREADS','1','--setenv','OMP_NUM_THREADS','1',
    '--setenv','MKL_NUM_THREADS','1','--setenv','NUMEXPR_NUM_THREADS','1','--setenv','MPLBACKEND','Agg',
    '--ro-bind',runtime,runtime,'--ro-bind',paths.base,paths.base,
    '--ro-bind',libraryDirectory,libraryDirectory,'--ro-bind','/usr/lib64','/usr/lib64',
    '--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
    '--ro-bind',dir,'/input','--ro-bind',paths.script,'/worker.py',
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
  if(inputs.length>maxFiles||inputs.some(item=>item.kind!=='input'||item.bytes.byteLength>1024*1024)||
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
  try{process.kill(-pid,'SIGKILL');}catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;
  }
}

async function execute(paths:WorkerPaths,directory:string,language:ManagerAiSandboxRequest['language'],external:AbortSignal) {
  const timer=AbortSignal.timeout(shellTimeoutMs);
  const signal=AbortSignal.any([external,timer]);
  signal.throwIfAborted();
  const child=spawn(bubblewrap,sandboxArguments(paths,directory,language),{
    // A detached launcher has no controlling terminal and retains one killable group.
    cwd:directory,env:{LC_ALL:'C.UTF-8',NODE_ENV:'production',APP_NAME:'Mobiup'},detached:true,stdio:['ignore','pipe','pipe'],
  });
  const abort=()=>killGroup(child.pid);
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  let written=0,diagnostics=0,overflow=false;
  const stdout:Buffer[]=[];
  child.stdout.on('data',(part:Buffer)=>{
    written+=part.length;
    if(written>maxWorkerBytes){overflow=true;abort();return;}
    stdout.push(part);
  });
  child.stderr.on('data',(part:Buffer)=>{
    diagnostics+=part.length;
    if(diagnostics>maxStderrBytes){overflow=true;abort();}
  });
  try {
    const [code]=await once(child,'close');
    external.throwIfAborted();
    if(timer.aborted)fail(504,'Execuția izolată a depășit timpul disponibil.');
    if(overflow)fail(413,'Rezultatul execuției izolate depășește limita.');
    if(code!==0)fail(503,'Runtime-ul de analiză izolat nu a putut porni sau a întrerupt execuția.');
    return Buffer.concat(stdout,written).toString('utf8');
  } finally {
    signal.removeEventListener('abort',abort);
  }
}

function safePng(bytes:Uint8Array) {
  if(bytes.length<45||![137,80,78,71,13,10,26,10].every((byte,index)=>byte===bytes[index]))return false;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const typeAt=(index:number)=>String.fromCharCode(bytes[index],bytes[index+1],bytes[index+2],bytes[index+3]);
  if(view.getUint32(8)!==13||typeAt(12)!=='IHDR')return false;
  const width=view.getUint32(16),height=view.getUint32(20);
  if(!width||!height||width>4096||height>4096||width*height>4_000_000)return false;
  let cursor=8,data=false;
  while(cursor+12<=bytes.length) {
    const size=view.getUint32(cursor),type=typeAt(cursor+4);
    const end=cursor+12+size;
    if(end>bytes.length||!/^[A-Za-z]{4}$/.test(type)||['acTL','fcTL','fdAT'].includes(type))return false;
    if(type==='IDAT')data=true;
    if(type==='IEND')return data&&size===0&&end===bytes.length;
    cursor=end;
  }
  return false;
}

const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
function messageRows(input:unknown):ResultRows|undefined {
  if(input===undefined)return undefined;
  if(!record(input)||!Array.isArray(input.columns)||!input.columns.length||input.columns.length>64||
    !input.columns.every(item=>typeof item==='string'&&item.length<=128)||
    !Array.isArray(input.rows)||input.rows.length>60||!input.rows.every(row=>Array.isArray(row)&&
      row.length===(input.columns as string[]).length&&row.every(value=>value===null||typeof value==='string'||Number.isFinite(value)))||
    typeof input.truncated!=='boolean'||typeof input.exportTruncated!=='boolean'||typeof input.exportedRows!=='number'||!Number.isSafeInteger(input.exportedRows)||
    input.exportedRows<input.rows.length||input.exportedRows>2000) fail(502,'Rezultatul SQL izolat este invalid.');
  return {columns:input.columns as string[],rows:input.rows as ManagerAiCell[][],truncated:input.truncated,exportTruncated:input.exportTruncated,exportedRows:input.exportedRows};
}

function parseArtifact(input:unknown):ManagerAiPreparedArtifact|null {
  if(!record(input)||typeof input.filename!=='string'||typeof input.data!=='string')return null;
  const filename=input.filename;
  if(!/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,111}$/u.test(filename)||input.data.length>Math.ceil(maxArtifactBytes/3)*4||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))return null;
  const extension=extname(filename).toLowerCase() as keyof typeof artifactType;
  if(!Object.hasOwn(artifactType,extension))return null;
  const bytes=Buffer.from(input.data,'base64');
  if(!bytes.length||bytes.length>maxArtifactBytes)return null;
  if(extension==='.png'&&!safePng(bytes))return null;
  if(extension==='.xlsx'&&bytes.subarray(0,4).toString('hex')!=='504b0304')return null;
  if(extension!=='.png'&&extension!=='.xlsx') {
    const contents=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    for(const character of contents) {
      const code=character.charCodeAt(0);
      if(code===127||code<32&&code!==9&&code!==10&&code!==13)return null;
    }
    if(extension==='.json')JSON.parse(contents);
  }
  return normalizeManagerAiSandboxArtifact({filename,mime_type:artifactType[extension],kind:'output',bytes});
}

function parseResult(raw:string):ManagerAiSandboxResult {
  let input:unknown;
  try { input=JSON.parse(raw); } catch { fail(502,'Rezultatul execuției izolate este invalid.'); }
  if(!record(input)||typeof input.exitCode!=='number'||!Number.isInteger(input.exitCode)||Math.abs(input.exitCode)>255||
    typeof input.stdout!=='string'||typeof input.stderr!=='string'||input.stdout.length>16_384||input.stderr.length>16_384||
    !Array.isArray(input.artifacts)||input.artifacts.length>maxFiles||typeof input.skippedArtifacts!=='number'||
    !Number.isSafeInteger(input.skippedArtifacts)||input.skippedArtifacts<0) fail(502,'Rezultatul execuției izolate este invalid.');
  const files:ManagerAiPreparedArtifact[]=[];
  let size=0,skipped=input.skippedArtifacts;
  for(const artifact of input.artifacts) {
    let file:ManagerAiPreparedArtifact|null=null;
    try{file=parseArtifact(artifact);}catch{ /* A malformed artifact must not discard the analysis. */ }
    if(!file||file.bytes.byteLength>maxArtifactBytes||size+file.bytes.byteLength>4*1024*1024){skipped++;continue;}
    files.push(file);
    size+=file.bytes.byteLength;
  }
  return {exitCode:input.exitCode,stdout:input.stdout,stderr:input.stderr,rows:messageRows(input.rows),artifacts:files,skippedArtifacts:skipped};
}

export async function runManagerAiSandbox(request:ManagerAiSandboxRequest):Promise<ManagerAiSandboxResult> {
  request.signal.throwIfAborted();
  const paths=workerPaths();
  if(!paths)fail(503,'Execuția SQL/Python izolată nu este configurată pentru această instanță.');
  if(occupied)fail(429,'O analiză SQL/Python rulează deja. Încearcă din nou după terminarea ei.');
  occupied=true;
  let directory:string|undefined;
  try {
    directory=await mkdtemp(join(tmpdir(),'manager-ai-analysis-'));
    await stageInputs(directory,request);
    const raw=await execute(paths,directory,request.language,request.signal);
    request.signal.throwIfAborted();
    return parseResult(raw);
  } finally {
    try { if(directory)await rm(directory,{recursive:true,force:true}); }
    finally {occupied=false;}
  }
}
