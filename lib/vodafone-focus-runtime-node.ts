import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readActivations} from './activation-store-node';
import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport} from './activation-types';

let active: Promise<unknown> = Promise.resolve();
let requests = 0;
// Allow overlapping loads of the three territory panels and their drill-downs.
const maxRequests = 12;

export async function readVodafoneFocus(month: string, sites: string[] | null, query: ActivationQuery): Promise<ActivationReport> {
  const script = ['vodafone-focus-worker.mjs', 'dist/standalone/vodafone-focus-worker.mjs'].map(file => resolve(file)).find(existsSync);
  if (!script && process.env.NODE_ENV === 'development') return readActivations(month, sites, 'vodafone', query);
  if (!script || requests >= maxRequests) throw new Error('Focus worker unavailable');
  requests++;
  const result = active.then(() => new Promise<ActivationReport>((accept, reject) => {
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
  active = result.then(() => undefined, () => undefined);
  try {
    return await result;
  } finally {
    requests--;
  }
}
