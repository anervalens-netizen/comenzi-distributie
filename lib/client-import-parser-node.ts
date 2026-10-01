import { Worker } from 'node:worker_threads';
import { readClientsInWorker, type ImportWorker } from './client-import-worker-client.ts';
export function readClientsNode(file:File,signal?:AbortSignal) {
  return readClientsInWorker(file,()=>{
    let worker:Worker|null=null;
    const adapter:ImportWorker={onmessage:null,onerror:null,onmessageerror:null,
      terminate:()=>worker?.terminate(),
      postMessage:input=>{
        worker=new Worker(new URL('./client-import-node-worker.ts',import.meta.url),{workerData:input,execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type')),resourceLimits:{maxOldGenerationSizeMb:128}});
        worker.on('message',data=>adapter.onmessage?.({data} as MessageEvent));
        worker.on('error',error=>adapter.onerror?.({message:error.message} as ErrorEvent));
        worker.on('exit',code=>{if(adapter.onerror)adapter.onerror({message:`Parserul Excel s-a oprit cu codul ${code}.`} as ErrorEvent);});
      },
    };
    return adapter;
  },signal);
}
