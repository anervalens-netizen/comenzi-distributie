import { parentPort, workerData } from 'node:worker_threads';
import { parseStockFile } from './stock-file';

const input=workerData as {bytes:ArrayBuffer;filename:string};
try {
  const groups=parseStockFile(new Uint8Array(input.bytes),input.filename);
  parentPort?.postMessage({ok:true,groups});
} catch(error) {
  parentPort?.postMessage({ok:false,error:error instanceof Error?error.message:'Fișier Excel invalid.'});
}
