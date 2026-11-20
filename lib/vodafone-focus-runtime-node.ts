import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readActivations} from './activation-store-node';
import type {ActivationQuery} from './activation-distribution';
import type {ActivationProvider, ActivationReport} from './activation-types';

type Lane = {tail: Promise<void>; pending: number};
type Queue = {lanes: Lane[]; limit: number};
const createQueue = (workers: number, limit: number): Queue => ({
  lanes: Array.from({length: workers}, () => ({tail: Promise.resolve(), pending: 0})), limit,
});
const pendingCount = (queue: Queue) => queue.lanes.reduce((total, lane) => total + lane.pending, 0);
const detailQueue = createQueue(1, 12);
const overviewQueue = createQueue(1, 6);
const baseOverviewQueue = createQueue(3, 24);
const digiOverviewQueue = createQueue(2, 12);
const inFlightOverviews = new Map<string, Promise<ActivationReport>>();
const focusDeadlineMs = 17_000;
type WorkerMessage = {type: 'overviewBase' | 'report'; report: ActivationReport} | null;

async function runFocus(queue: Queue, month: string, sites: string[] | null, query: ActivationQuery | undefined, provider: ActivationProvider = 'vodafone'): Promise<ActivationReport> {
  const script = ['vodafone-focus-worker.mjs', 'dist/standalone/vodafone-focus-worker.mjs'].map(file => resolve(file)).find(existsSync);
  if (!script && process.env.NODE_ENV === 'development') {
    let partial: ActivationReport | undefined;
    try { return readActivations(month, sites, provider, query, base => { partial = base; }); }
    catch (error) { if (partial) return partial; throw error; }
  }
  if (!script || pendingCount(queue) >= queue.limit) throw new Error('Focus worker unavailable');
  const lane = queue.lanes.reduce((shortest, item) => item.pending < shortest.pending ? item : shortest);
  lane.pending++;
  let expired = false;
  let base: ActivationReport | undefined;
  let abortCalculation: (() => void) | undefined;
  const timeoutError = new Error('Focus calculation timed out');
  const result = lane.tail.then(() => new Promise<ActivationReport>((accept, reject) => {
    if (expired) { reject(timeoutError); return; }
    const worker = new Worker(script, {
      workerData: {month, sites, query, provider}, resourceLimits: {maxOldGenerationSizeMb: 224},
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
  const release = () => { lane.pending--; };
  lane.tail = result.then(release, release);
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

function readBusyOverview(month: string, sites: string[] | null, query: ActivationQuery): Promise<ActivationReport> {
  // Start ordinary totals while this selection still has time left. Waiting
  // until Focus expires would leave no budget for a fallback.
  const ordinary = runFocus(baseOverviewQueue, month, sites, {...query, focusSummaries: []})
    .then((report): ActivationReport => ({...report, commissionCoverage: 'unavailable'}));
  if (pendingCount(overviewQueue) >= overviewQueue.limit) return ordinary;
  const fallback = ordinary.catch(() => undefined);
  return runFocus(overviewQueue, month, sites, query).catch(async error => {
    const report = await fallback;
    if (report) return report;
    throw error;
  });
}

async function shareOverview(key: string, start: () => Promise<ActivationReport>): Promise<ActivationReport> {
  const pending = inFlightOverviews.get(key);
  if (pending) return pending;
  const result = start();
  inFlightOverviews.set(key, result);
  try {
    return await result;
  } finally {
    inFlightOverviews.delete(key);
  }
}

export async function readVodafoneFocus(month: string, sites: string[] | null, query: ActivationQuery): Promise<ActivationReport> {
  const summaries = query.focusSummaries;
  if (!summaries) return runFocus(detailQueue, month, sites, query);
  // Only in-flight requests share work. Each HTTP waiter rechecks its own access.
  return shareOverview(JSON.stringify(['vodafone', month, sites, query]), () => {
    if (!summaries.length) return runFocus(baseOverviewQueue, month, sites, query);
    if (pendingCount(overviewQueue)) return readBusyOverview(month, sites, query);
    return runFocus(overviewQueue, month, sites, query);
  });
}

export function readDigiOverview(month: string, sites: string[] | null, query?: ActivationQuery): Promise<ActivationReport> {
  return shareOverview(JSON.stringify(['digi', month, sites, query]), () =>
    runFocus(digiOverviewQueue, month, sites, query, 'digi'));
}
