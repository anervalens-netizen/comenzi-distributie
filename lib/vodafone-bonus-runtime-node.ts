import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readVodafoneBonus,type VodafoneBonusRead} from './vodafone-bonus-node';
import type {VodafoneBonusReport} from './vodafone-bonus-types';

const active = new Map<string,Promise<VodafoneBonusReport>>();
let tail = Promise.resolve();
let service: Worker | undefined;
const limit = 4;
const deadlineMs = 42_000;

function workerFor(script: string) {
  if (service) return service;
  const worker = new Worker(script,{resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:24}});
  service = worker;
  worker.once('exit',()=>{
    if (service===worker) service=undefined;
  });
  return worker;
}
export async function readVodafoneBonusAsync(options: VodafoneBonusRead): Promise<VodafoneBonusReport> {
  const script = ['vodafone-bonus-worker.mjs','dist/standalone/vodafone-bonus-worker.mjs'].map(path=>resolve(path)).find(existsSync);
  if (!script && process.env.NODE_ENV==='development') return readVodafoneBonus(options);
  if (!script) throw new Error('Vodafone bonus worker is unavailable');
  const key = createHash('sha256').update(JSON.stringify(options)).digest('hex');
  const existing = active.get(key);
  if (existing) return existing;
  if (active.size>=limit) throw new Error('Vodafone bonus worker queue is full');
  const timeout = new Error('Vodafone bonus calculation timed out');
  let expired = false;
  let abort: (()=>void)|undefined;
  const run = tail.then(()=>new Promise<VodafoneBonusReport>((done,reject)=>{
    if (expired) { reject(timeout); return; }
    const worker = workerFor(script);
    worker.ref();
    const finish = (error: Error|null, result?: VodafoneBonusReport) => {
      worker.off('message',onMessage);
      worker.off('error',onError);
      worker.off('exit',onExit);
      abort=undefined;
      if (error) {
        if (service===worker) service=undefined;
        void worker.terminate().then(()=>reject(error),reject);
      } else {
        worker.unref();
        done(result!);
      }
    };
    const onMessage=(message: VodafoneBonusReport|null)=>{
      if (message) finish(null,message);
      else finish(new Error('Vodafone bonus sources are unavailable'));
    };
    const onError=(error: Error)=>finish(error);
    const onExit=()=>finish(new Error('Vodafone bonus worker exited'));
    abort=()=>finish(timeout);
    worker.once('message',onMessage);
    worker.once('error',onError);
    worker.once('exit',onExit);
    worker.postMessage(options);
  }));
  // A native SQLite statement may delay termination. Retain the occupied queue
  // slot until the worker exits even if HTTP has timed out.
  const release = ()=>{active.delete(key);};
  tail = run.then(release,release);
  let timer: ReturnType<typeof setTimeout>|undefined;
  const deadline = new Promise<never>((_done,reject)=>{
    timer = setTimeout(()=>{expired=true;abort?.();reject(timeout);},deadlineMs);
  });
  const result = Promise.race([run,deadline]).finally(()=>clearTimeout(timer));
  active.set(key,result);
  return result;
}
