import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readVodafoneBonus,type VodafoneBonusRead} from './vodafone-bonus-node';
import type {VodafoneBonusReport} from './vodafone-bonus-types';
import {readVodafoneSim0Ranking,type VodafoneSim0Ranking,type VodafoneSim0RankingRead} from './vodafone-activation-ranking-node';

type Read = VodafoneBonusRead | VodafoneSim0RankingRead;
type Result = VodafoneBonusReport | VodafoneSim0Ranking;
type Job = {key:string;ranking:boolean;script:string;options:Read;promise:Promise<Result>;resumed:boolean;expired:boolean;
  accept:(result:Result)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
const jobs=new Map<string,Job>();
const paused=new Error('Foreground Vodafone report requested');
const registerDeadlineMs=42_000;
const rankingDeadlineMs=75_000;
const foregroundGraceMs=2_000;
let current:Job|undefined;
let service:Worker|undefined;
let interrupt:((error:Error)=>void)|undefined;
let grace:ReturnType<typeof setTimeout>|undefined;

function workerFor(script:string) {
  if (service) return service;
  const worker=new Worker(script,{resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:24}});
  service=worker;
  worker.once('exit',()=>{if (service===worker) service=undefined;});
  return worker;
}
function run(job:Job):Promise<Result> {
  return new Promise((accept,reject)=>{
    const worker=workerFor(job.script);
    worker.ref();
    function detach() {
      worker.off('message',onMessage);
      worker.off('error',stop);
      worker.off('exit',onExit);
      interrupt=undefined;
    }
    function stop(error:Error) {
      detach();
      service=undefined;
      // Retain the only execution slot until SQLite and the old worker have exited.
      void worker.terminate().then(()=>reject(error),reject);
    }
    function onExit(){stop(new Error('Vodafone bonus worker exited'));}
    function onMessage(result:Result|null) {
      if (!result) {stop(new Error('Vodafone bonus sources are unavailable'));return;}
      detach();
      worker.unref();
      accept(result);
    }
    interrupt=stop;
    worker.once('message',onMessage);
    worker.once('error',stop);
    worker.once('exit',onExit);
    try {worker.postMessage(job.options);} catch (error) {stop(error as Error);}
  });
}

function release(job:Job) {
  clearTimeout(job.timer);
  jobs.delete(job.key);
}
function next() {
  if (current) return;
  const waiting=[...jobs.values()].filter(job=>!job.expired);
  const job=waiting.find(item=>!item.ranking)??waiting[0];
  if (!job) return;
  current=job;
  void run(job).then(result=>{
    release(job);
    job.accept(result);
  },(error:Error)=>{
    if (error===paused && !job.resumed && !job.expired) {job.resumed=true;return;}
    release(job);
    job.reject(error);
  }).finally(()=>{
    clearTimeout(grace);
    grace=undefined;
    current=undefined;
    next();
  });
}

async function requestWorker(options:Read):Promise<Result> {
  const script=['vodafone-bonus-worker.mjs','dist/standalone/vodafone-bonus-worker.mjs'].map(path=>resolve(path)).find(existsSync);
  const ranking='kind' in options;
  if (!script && process.env.NODE_ENV==='development') return ranking ? readVodafoneSim0Ranking(options) : readVodafoneBonus(options);
  if (!script) throw new Error('Vodafone bonus worker is unavailable');
  const key=createHash('sha256').update(JSON.stringify(options)).digest('hex');
  const existing=jobs.get(key);
  if (existing) return existing.promise;
  if (jobs.size>=4 || ranking && [...jobs.values()].filter(job=>job.ranking).length>=2) throw new Error('Vodafone bonus worker queue is full');
  let accept!:Job['accept'],reject!:Job['reject'];
  const promise=new Promise<Result>((resolve,rejectPromise)=>{accept=resolve;reject=rejectPromise;});
  const timer=setTimeout(()=>{
    const error=new Error('Vodafone calculation timed out');
    job.expired=true;
    reject(error);
    if (current===job) interrupt?.(error); else release(job);
  },ranking?rankingDeadlineMs:registerDeadlineMs);
  const job:Job={key,ranking,script,options,promise,accept,reject,timer,resumed:false,expired:false};
  jobs.set(key,job);
  if (!ranking && current?.ranking && !grace) {
    const annual=current;
    grace=setTimeout(()=>{
      if (current===annual && [...jobs.values()].some(item=>!item.ranking&&!item.expired)) interrupt?.(paused);
    },foregroundGraceMs);
  }
  next();
  return promise;
}

export async function readVodafoneBonusAsync(options: VodafoneBonusRead):Promise<VodafoneBonusReport> {
  const result=await requestWorker(options);
  if (!('points' in result)) throw new Error('Unexpected Vodafone bonus response');
  return result;
}

export async function readVodafoneSim0RankingAsync(options: VodafoneSim0RankingRead):Promise<VodafoneSim0Ranking> {
  const result=await requestWorker(options);
  if (!('rows' in result)) throw new Error('Unexpected Vodafone activation ranking response');
  return result;
}
