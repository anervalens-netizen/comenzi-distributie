import { lstatSync } from 'node:fs';
import { extname } from 'node:path';
import type { ManagerAiCell } from './manager-ai';
import type { ManagerAiPreparedArtifact } from './manager-ai-media-contract';
import { normalizeManagerAiSandboxArtifact } from './manager-ai-sandbox-artifacts';
import { executeLocalSandbox, localSandboxAvailable, maxArtifactBytes, maxFiles, SandboxFailure, type ManagerAiSandboxRequest } from './manager-ai-sandbox-execution';
import { executeBrokerSandbox } from './manager-ai-sandbox-broker';
import { fail } from './server';
export type { ManagerAiSandboxRequest } from './manager-ai-sandbox-execution';

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
const artifactType={
  '.csv':'text/csv',
  '.tsv':'text/tab-separated-values',
  '.json':'application/json',
  '.txt':'text/plain',
  '.md':'text/markdown',
  '.png':'image/png',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
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


export function managerAiSandboxAvailable():boolean {
  if(process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED!=='1')return false;
  const socket=process.env.MOBIUP_MANAGER_AI_SANDBOX_SOCKET;
  if(!socket)return localSandboxAvailable();
  try { return lstatSync(socket).isSocket(); } catch { return false; }
}

let occupied=false;

export async function runManagerAiSandbox(request:ManagerAiSandboxRequest):Promise<ManagerAiSandboxResult> {
  request.signal.throwIfAborted();
  if(process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED!=='1')fail(503,'Execuția izolată este indisponibilă.');
  if(occupied)fail(429,'O analiză SQL/Python rulează deja. Încearcă din nou după terminarea ei.');
  occupied=true;
  try {
    const socket=process.env.MOBIUP_MANAGER_AI_SANDBOX_SOCKET;
    const raw=socket?await executeBrokerSandbox(socket,request):await executeLocalSandbox(request);
    request.signal.throwIfAborted();
    return parseResult(raw);
  } catch(error) {
    if(error instanceof SandboxFailure)fail(error.status,error.message);
    throw error;
  } finally { occupied=false; }
}
