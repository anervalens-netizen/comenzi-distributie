import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SalesCatalogEntry } from './sales-classification';
import type { SalesView } from './sales-types';

let queue:Promise<void>=Promise.resolve();
function workerPath(){
  const candidates=[resolve(process.cwd(),'sales-view-worker.mjs'),resolve(process.cwd(),'dist/standalone/sales-view-worker.mjs')];
  const found=candidates.find(existsSync);
  if(!found)throw new Error('Workerul de agregare a vânzărilor nu este disponibil.');
  return found;
}
function calculate(month:string,siteCode:string|string[]|undefined,fromMonth:string,toMonth:string,catalog:readonly SalesCatalogEntry[]):Promise<SalesView>{
  return new Promise((resolveView,reject)=>{
    const worker=new Worker(pathToFileURL(workerPath()),{workerData:{month,siteCode,fromMonth,toMonth,catalog:[...catalog]},resourceLimits:{maxOldGenerationSizeMb:256}});
    let settled=false;
    worker.once('message',(message:{ok:boolean;view?:SalesView;error?:string})=>{settled=true;if(message.ok&&message.view)resolveView(message.view);else reject(new Error(message.error||'Raportul de vânzări nu a putut fi calculat.'));});
    worker.once('error',error=>{settled=true;reject(error);});
    worker.once('exit',code=>{if(!settled)reject(new Error(`Workerul de vânzări s-a oprit cu codul ${code}.`));});
  });
}
export function getSalesViewRuntime(month:string,siteCode:string|string[]|undefined,fromMonth:string,toMonth:string,catalog:readonly SalesCatalogEntry[]):Promise<SalesView>{
  const task=()=>calculate(month,siteCode,fromMonth,toMonth,catalog);
  const result=queue.then(task,task);
  queue=result.then(()=>undefined,()=>undefined);
  return result;
}
