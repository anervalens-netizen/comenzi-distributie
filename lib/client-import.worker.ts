import { clientImportJob, type ClientImportInput } from './client-import-worker-job.ts';
const scope=globalThis as unknown as {onmessage:(event:MessageEvent<ClientImportInput>)=>void;postMessage:(message:unknown)=>void};
scope.onmessage=event=>{void clientImportJob(event.data).then(result=>scope.postMessage(result));};
