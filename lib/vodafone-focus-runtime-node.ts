import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readActivations} from './activation-store-node';
import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport} from './activation-types';

type Queue = {tail: Promise<void>; pending: number; limit: number};
const detailQueue: Queue = {tail: Promise.resolve(), pending: 0, limit: 12};
const overviewQueue: Queue = {tail: Promise.resolve(), pending: 0, limit: 6};
const inFlightOverviews = new Map<string, Promise<ActivationReport>>();

async function runFocus(queue: Queue, month: string, sites: string[] | null, query: ActivationQuery): Promise<ActivationReport> {
  const script = ['vodafone-focus-worker.mjs', 'dist/standalone/vodafone-focus-worker.mjs'].map(file => resolve(file)).find(existsSync);
  if (!script && process.env.NODE_ENV === 'development') return readActivations(month, sites, 'vodafone', query);
  if (!script || queue.pending >= queue.limit) throw new Error('Focus worker unavailable');
  queue.pending++;
  const result = queue.tail.then(() => new Promise<ActivationReport>((accept, reject) => {
    const worker = new Worker(script, {
      workerData: {month, sites, query}, resourceLimits: {maxOldGenerationSizeMb: 224},
    });
    let settled = false;
    const finish = (error?: Error, report?: ActivationReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => error ? reject(error) : accept(report!), reject);
    };
    const timer = setTimeout(() => finish(new Error('Focus calculation timed out')), 15_000);
    worker.once('message', (report: ActivationReport | null) => report ? finish(undefined, report) : finish(new Error('Focus calculation failed')));
    worker.once('error', finish);
    worker.once('exit', code => finish(new Error('Focus worker exited with code ' + code)));
  }));
  queue.tail = result.then(() => undefined, () => undefined);
  try {
    return await result;
  } finally {
    queue.pending--;
  }
}

export async function readVodafoneFocus(month: string, sites: string[] | null, query: ActivationQuery): Promise<ActivationReport> {
  if (!query.focusSummaries) return runFocus(detailQueue, month, sites, query);
  // Share identical in-flight overview reads only. Each waiter still rechecks
  // its own session and current scope in activationReport before responding.
  const key = JSON.stringify([month, sites, query]);
  const pending = inFlightOverviews.get(key);
  if (pending) return pending;
  const result = runFocus(overviewQueue, month, sites, query);
  inFlightOverviews.set(key, result);
  try {
    return await result;
  } finally {
    inFlightOverviews.delete(key);
  }
}
