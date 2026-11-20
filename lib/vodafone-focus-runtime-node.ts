import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readActivations} from './activation-store-node';
import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport} from './activation-types';

type Queue = {tail: Promise<void>; pending: number; limit: number};
const detailQueue: Queue = {tail: Promise.resolve(), pending: 0, limit: 12};
const overviewQueue: Queue = {tail: Promise.resolve(), pending: 0, limit: 6};
const baseOverviewQueue: Queue = {tail: Promise.resolve(), pending: 0, limit: 12};
const inFlightOverviews = new Map<string, Promise<ActivationReport>>();
const focusDeadlineMs = 17_000;
type WorkerMessage = {type: 'overviewBase' | 'report'; report: ActivationReport} | null;

async function runFocus(queue: Queue, month: string, sites: string[] | null, query: ActivationQuery): Promise<ActivationReport> {
  const script = ['vodafone-focus-worker.mjs', 'dist/standalone/vodafone-focus-worker.mjs'].map(file => resolve(file)).find(existsSync);
  if (!script && process.env.NODE_ENV === 'development') {
    let partial: ActivationReport | undefined;
    try { return readActivations(month, sites, 'vodafone', query, base => { partial = base; }); }
    catch (error) { if (partial) return partial; throw error; }
  }
  if (!script || queue.pending >= queue.limit) throw new Error('Focus worker unavailable');
  queue.pending++;
  let expired = false;
  let base: ActivationReport | undefined;
  let abortCalculation: (() => void) | undefined;
  const timeoutError = new Error('Focus calculation timed out');
  const result = queue.tail.then(() => new Promise<ActivationReport>((accept, reject) => {
    if (expired) { reject(timeoutError); return; }
    const worker = new Worker(script, {
      workerData: {month, sites, query}, resourceLimits: {maxOldGenerationSizeMb: 224},
    });
    let settled = false;
    const finish = (error?: Error, report?: ActivationReport) => {
      if (settled) return;
      settled = true;
      void worker.terminate().then(() => error ? reject(error) : accept(report!), reject);
    };
    abortCalculation = () => finish(timeoutError);
    worker.on('message', (message: WorkerMessage) => {
      if (message?.type === 'overviewBase') base = message.report;
      else if (message?.type === 'report') finish(undefined, message.report);
      else finish(new Error('Focus calculation failed'));
    });
    worker.once('error', finish);
    worker.once('exit', code => finish(new Error('Focus worker exited with code ' + code)));
  }));
  const release = () => { queue.pending--; };
  queue.tail = result.then(release, release);
  // The HTTP deadline includes time spent waiting to start. A native SQLite
  // call can delay worker termination, so keep its slot until the real exit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      abortCalculation?.();
      reject(timeoutError);
    }, focusDeadlineMs);
  });
  try {
    return await Promise.race([result, deadline]);
  } catch (error) {
    if (base) return base;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readVodafoneFocus(month: string, sites: string[] | null, query: ActivationQuery): Promise<ActivationReport> {
  if (!query.focusSummaries) return runFocus(detailQueue, month, sites, query);
  // Share identical in-flight overview reads only. Each waiter still rechecks
  // its own session and current scope in activationReport before responding.
  const key = JSON.stringify([month, sites, query]);
  const pending = inFlightOverviews.get(key);
  if (pending) return pending;
  const requiresFocus = query.focusSummaries.length > 0;
  const focusBusy = requiresFocus && overviewQueue.pending >= overviewQueue.limit;
  // Keep ordinary totals available if the certified calculation queue is full.
  // This separate lane stays bounded and also runs off the request thread.
  const result = focusBusy
    ? runFocus(baseOverviewQueue, month, sites, {...query, focusSummaries: []})
       .then((report): ActivationReport => ({...report, commissionCoverage: 'unavailable'}))
    : runFocus(requiresFocus ? overviewQueue : baseOverviewQueue, month, sites, query);
  inFlightOverviews.set(key, result);
  try {
    return await result;
  } finally {
    inFlightOverviews.delete(key);
  }
}
