import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readPartnerPage} from './activation-partners-page-node';
import type {CombinedPartnerRead} from './activation-portfolio';
import type {CombinedActivationPartners} from './activation-types';

type Pending={accept:(result:CombinedActivationPartners)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Service={worker:Worker;pending:Map<number,Pending>;stopping:boolean};
let service:Service|undefined;
let nextId=0;
function stop(entry:Service) {
  if(entry.stopping)return;
  entry.stopping=true;
  for(const waiter of entry.pending.values()){
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Partner report worker stopped'));
  }
  entry.pending.clear();
  // Keep the slot occupied until native SQLite has stopped the worker.
  void entry.worker.terminate().catch(()=>{});
}
function start(file:string):Service {
  const worker=new Worker(file,{resourceLimits:{maxOldGenerationSizeMb:384,maxYoungGenerationSizeMb:32}});
  const entry:Service={worker,pending:new Map(),stopping:false};
  worker.on('message',({id,report}:{id:number;report?:CombinedActivationPartners})=>{
    const waiter=entry.pending.get(id);
    if(!waiter)return;
    entry.pending.delete(id);clearTimeout(waiter.timer);
    if(report)waiter.accept(report);else waiter.reject(new Error('Partner report unavailable'));
    if(!entry.pending.size)worker.unref();
  });
  worker.on('error',()=>stop(entry));
  worker.once('exit',()=>{
    if(service===entry)service=undefined;
    for(const waiter of entry.pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('Partner report worker exited'));}
    entry.pending.clear();
  });
  return entry;
}
export async function readCombinedActivationPartners(input:CombinedPartnerRead,page:number):Promise<CombinedActivationPartners>{
  const file=['activation-partners-worker.mjs','dist/standalone/activation-partners-worker.mjs'].map(f=>resolve(f)).find(existsSync);
  if(!file&&process.env.NODE_ENV==='development')return readPartnerPage(input,page);
  if(!file)throw new Error('Partner report worker missing');
  const entry=service??=start(file);
  if(entry.stopping||entry.pending.size>=12)throw new Error('Partner report queue full');
  const id=++nextId;
  return new Promise((accept,reject)=>{
    const timer=setTimeout(()=>stop(entry),25_000);
    entry.pending.set(id,{accept,reject,timer});
    entry.worker.ref();
    try{entry.worker.postMessage({id,input,page});}
    catch{stop(entry);}
  });
}
