import { parentPort, workerData } from 'node:worker_threads';
import { parseSalesFile } from './sales-file';

const input=workerData as {bytes:ArrayBuffer;filename:string};
try {
  const rows=parseSalesFile(new Uint8Array(input.bytes),input.filename);
  parentPort?.postMessage({ok:true,rows});
} catch(error) {
  parentPort?.postMessage({ok:false,error:error instanceof Error?error.message:'Fișier Excel invalid.'});
}
