import { parentPort, workerData } from 'node:worker_threads';
import { clientImportJob, type ClientImportInput } from './client-import-worker-job.ts';
void clientImportJob(workerData as ClientImportInput).then(result=>parentPort?.postMessage(result));
