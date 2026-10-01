import { validateClientFile, type ParsedClients } from './client-import-types.ts';
import type { ClientImportInput, ClientImportResult } from './client-import-worker-job.ts';
export type ImportWorker={postMessage:(input:ClientImportInput)=>void;terminate:()=>unknown;onmessage:((event:MessageEvent<ClientImportResult>)=>void)|null;onerror:((event:ErrorEvent)=>void)|null;onmessageerror:((event:MessageEvent)=>void)|null};
const cancelled=()=>new DOMException('Citirea fișierului a fost anulată.','AbortError');
export function readClientsInWorker(file:File,createWorker:()=>ImportWorker,signal?:AbortSignal):Promise<ParsedClients> {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(cancelled());return;}
    try{validateClientFile(file.name,file.size);}catch(error){reject(error);return;}
    let worker:ImportWorker;
    try{worker=createWorker();}catch(error){reject(error);return;}
    let settled=false;
    const finish=(result?:ParsedClients,error?:unknown)=>{
      if(settled)return;settled=true;
      signal?.removeEventListener('abort',abort);
      worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();
      if(error)reject(error);else resolve(result!);
    };
    const abort=()=>finish(undefined,cancelled());
    worker.onmessage=event=>{const message=event.data;if(message.ok)finish(message.result);else finish(undefined,new Error(message.error));};
    worker.onerror=event=>finish(undefined,new Error(event.message||'Parserul Excel nu este disponibil.'));
    worker.onmessageerror=()=>finish(undefined,new Error('Rezultatul fișierului Excel nu poate fi citit.'));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{worker.postMessage({file,filename:file.name});}catch(error){finish(undefined,error);}
  });
}
