import { readClientsInWorker } from './client-import-worker-client.ts';
export type { ImportClient, ParsedClients } from './client-import-types.ts';
export function readClients(file:File,signal?:AbortSignal) {
  return readClientsInWorker(file,()=>new Worker(new URL('./client-import.worker.ts',import.meta.url),{type:'module'}),signal);
}
