import { Buffer } from 'node:buffer';
import { createConnection, type Socket } from 'node:net';
import { executeLocalSandbox, inputBytes, maxArtifactBytes, maxCodeBytes, maxDatabaseBytes, maxFiles, maxWorkerBytes, SandboxFailure, type ManagerAiSandboxRequest } from './manager-ai-sandbox-execution';

const decoder=new TextDecoder();
const headerLimit=64*1024;
const requestLimit=4+headerLimit+maxDatabaseBytes+inputBytes;
const responseLimit=2+maxWorkerBytes;
const lifetimeMs=30_000;
const unavailable=()=>new SandboxFailure(503,'Serviciul de analiză izolată este indisponibil.');
const invalid=()=>new SandboxFailure(400,'Cererea de analiză izolată este invalidă.');
const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const sized=(n:unknown,maximum:number):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=maximum;

function uint32(value:number) {
  const bytes=Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

// Fixed length framing permits cancellation by closing the connection after sending the request.
// Stage up to one bounded frame and reject trailing input instead of queuing a second job.
function readFrame(socket:Socket,maximum:number):Promise<Uint8Array> {
  return new Promise((resolve,reject)=>{
    const prefix=Buffer.alloc(4);
    let received=0,payload:Uint8Array|undefined;
    function finish(error?:Error) {
      socket.off('data',receive);
      socket.off('error',failed);
      socket.off('end',failed);
      socket.off('close',failed);
      if(error||!payload)reject(error??unavailable());
      else resolve(payload);
    }
    function failed(){finish(unavailable());}
    function receive(chunk:Uint8Array) {
      if(!payload) {
        const copied=Math.min(chunk.length,4-received);
        prefix.set(chunk.subarray(0,copied),received);
        received+=copied;
        if(received<4)return;
        const length=new DataView(prefix.buffer,prefix.byteOffset,4).getUint32(0);
        if(length<1||length>maximum){finish(invalid());return;}
        payload=new Uint8Array(length);
        received=0;
        chunk=chunk.subarray(copied);
      }
      if(chunk.length>payload.length-received){finish(invalid());return;}
      payload.set(chunk,received);
      received+=chunk.length;
      if(received===payload.length)finish();
    }
    socket.on('data',receive);
    socket.once('error',failed);
    socket.once('end',failed);
    socket.once('close',failed);
  });
}

function encodeRequest(request:ManagerAiSandboxRequest) {
  const {language,code,database,inputs=[]}=request;
  if((language!=='sql'&&language!=='python')||!code.trim()||Buffer.byteLength(code)>maxCodeBytes||
    code.includes('\0')||inputs.length>maxFiles||inputs.some(f=>f.kind!=='input'||typeof f.filename!=='string'||
      f.filename.length>160||!f.filename.length||f.bytes.length>maxArtifactBytes)||
    inputs.reduce((n,f)=>n+f.bytes.length,0)>inputBytes||(database?.length??0)>maxDatabaseBytes)throw invalid();
  const header=Buffer.from(JSON.stringify({version:1,language,code,database:database?.length??0,
    files:inputs.map(f=>({name:f.filename,size:f.bytes.length}))}));
  if(header.length>headerLimit)throw invalid();
  const pieces:Uint8Array[]=[uint32(header.length),header];
  if(database)pieces.push(database);
  for(const f of inputs)pieces.push(f.bytes);
  return pieces;
}

function decodeRequest(frame:Uint8Array,signal:AbortSignal):ManagerAiSandboxRequest {
  if(frame.length<4)throw invalid();
  const size=new DataView(frame.buffer,frame.byteOffset,4).getUint32(0);
  if(!size||size>headerLimit||size>frame.length-4)throw invalid();
  let h:unknown;
  try { h=JSON.parse(decoder.decode(frame.subarray(4,4+size))); } catch { throw invalid(); }
  if(!isRecord(h)||Object.keys(h).some(k=>!['version','language','code','database','files'].includes(k))||h.version!==1||(h.language!=='python'&&h.language!=='sql')||
    typeof h.code!=='string'||!h.code.trim()||Buffer.byteLength(h.code)>maxCodeBytes||h.code.includes('\0')||
    !sized(h.database,maxDatabaseBytes)||!Array.isArray(h.files)||h.files.length>maxFiles)throw invalid();
  let offset=4+size;
  function part(bytes:number) {
    if(bytes>frame.length-offset)throw invalid();
    const value=frame.subarray(offset,offset+bytes);
    offset+=bytes;
    return value;
  }
  const database=h.database?part(h.database):undefined;
  let fileBytes=0;
  const inputs=h.files.map((f:unknown)=>{
    if(!isRecord(f)||Object.keys(f).some(k=>k!=='name'&&k!=='size')||typeof f.name!=='string'||!f.name.length||f.name.length>160||!sized(f.size,maxArtifactBytes))throw invalid();
    fileBytes+=f.size;
    if(fileBytes>inputBytes)throw invalid();
    return {kind:'input' as const,filename:f.name,mime_type:'application/octet-stream',bytes:part(f.size)};
  });
  if(offset!==frame.length)throw invalid();
  return {language:h.language,code:h.code,database,inputs,signal};
}

function writeFrame(socket:Socket,parts:readonly Uint8Array[]) {
  socket.write(uint32(parts.reduce((n,part)=>n+part.length,0)));
  for(const part of parts)if(part.length)socket.write(part);
}

export async function executeBrokerSandbox(path:string,request:ManagerAiSandboxRequest):Promise<string> {
  request.signal.throwIfAborted();
  const parts=encodeRequest(request);
  const socket=createConnection(path);
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(lifetimeMs)]);
  const stop=()=>socket.destroy();
  socket.on('error',stop);
  signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted)stop();
  try {
    const response=readFrame(socket,responseLimit);
    writeFrame(socket,parts);
    const data=await response;
    if(data.length<2)throw unavailable();
    const status=new DataView(data.buffer,data.byteOffset,2).getUint16(0),body=decoder.decode(data.subarray(2));
    if(status!==200) {
      if(status<400||status>599||!body||body.length>512)throw unavailable();
      throw new SandboxFailure(status,body);
    }
    return body;
  } catch(error) {
    request.signal.throwIfAborted();
    if(signal.aborted)throw new SandboxFailure(504,'Execuția izolată a depășit timpul disponibil.');
    if(error instanceof SandboxFailure)throw error;
    throw unavailable();
  } finally {
    signal.removeEventListener('abort',stop);
    socket.destroy();
  }
}

// systemd hands the broker a single connected AF_UNIX socket. A disconnected caller
// cancels the computation, including its Bubblewrap process group.
export async function serveSandboxConnection(socket:Socket,execute=executeLocalSandbox) {
  const controller=new AbortController();
  const stop=()=>controller.abort();
  const deadline=setTimeout(()=>{stop();socket.destroy();},lifetimeMs);
  socket.on('error',stop);
  socket.on('end',stop);
  socket.on('close',stop);
  try {
    const frame=await readFrame(socket,requestLimit);
    socket.on('data',()=>{stop();socket.destroy();});
    const request=decodeRequest(frame,controller.signal);
    controller.signal.throwIfAborted();
    const output=Buffer.from(await execute(request),'utf8');
    if(output.length>maxWorkerBytes)throw unavailable();
    controller.signal.throwIfAborted();
    writeFrame(socket,[Uint8Array.of(0,200),output]);
  } catch(error) {
    if(!controller.signal.aborted&&!socket.destroyed) {
      const problem=error instanceof SandboxFailure?error:unavailable();
      const code=Buffer.alloc(2);
      code.writeUInt16BE(problem.status);
      writeFrame(socket,[code,Buffer.from(problem.message.slice(0,512))]);
    }
  } finally {
    clearTimeout(deadline);
    socket.end();
  }
}
