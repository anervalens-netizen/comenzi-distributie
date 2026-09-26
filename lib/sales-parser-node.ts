import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SalesRow } from './sales-types';

let queue:Promise<void>=Promise.resolve();
function workerPath() {
  const candidates=[resolve(process.cwd(),'sales-parser-worker.mjs'),resolve(process.cwd(),'dist/standalone/sales-parser-worker.mjs')];
  const found=candidates.find(existsSync);
  if(!found)throw new Error('Parserul izolat de vânzări nu este disponibil.');
  return found;
}
function parseInWorker(bytes:Uint8Array,filename:string):Promise<SalesRow[]> {
  const copy=bytes.slice();
  return new Promise((resolveRows,reject)=>{
    const worker=new Worker(pathToFileURL(workerPath()),{workerData:{bytes:copy.buffer,filename},transferList:[copy.buffer],resourceLimits:{maxOldGenerationSizeMb:384}});
    let settled=false;
    worker.once('message',(message:{ok:boolean;rows?:SalesRow[];error?:string})=>{settled=true;if(message.ok&&message.rows)resolveRows(message.rows);else reject(new Error(message.error||'Fișier Excel invalid.'));});
    worker.once('error',error=>{settled=true;reject(error);});
    worker.once('exit',code=>{if(!settled&&code!==0)reject(new Error(`Parserul Excel s-a oprit cu codul ${code}.`));});
  });
}
export function parseSalesFileRuntime(bytes:Uint8Array,filename:string):Promise<SalesRow[]> {
  const task=()=>parseInWorker(bytes,filename);
  const result=queue.then(task,task);
  queue=result.then(()=>undefined,()=>undefined);
  return result;
}
