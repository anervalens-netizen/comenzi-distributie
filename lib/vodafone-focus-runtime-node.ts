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
const inFlightDigi = new Map<string, Promise<ActivationReport>>();
const inFlightOverviews = new Map<string, {totals: Promise<ActivationReport>; complete: Promise<ActivationReport>}>();
const focusDeadlineMs = 17_000;
type WorkerMessage = {type: 'overviewBase' | 'report'; report: ActivationReport} | null;

async function runFocus(queue: Queue, month: string, sites: string[] | null, query: ActivationQuery | undefined, onBase?: (report: ActivationReport) => void, provider: ActivationProvider = 'vodafone'): Promise<ActivationReport> {
  const script = ['vodafone-focus-worker.mjs', 'dist/standalone/vodafone-focus-worker.mjs'].map(file => resolve(file)).find(existsSync);
  if (!script && process.env.NODE_ENV === 'development') {
    let partial: ActivationReport | undefined;
    try { return readActivations(month, sites, provider, query, base => { partial = base; onBase?.(base); }); }
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
      if (message?.type === 'overviewBase') { base = message.report; onBase?.(base); }
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

function readBusyOverview(month: string, sites: string[] | null, query: ActivationQuery, onBase: (report: ActivationReport) => void): Promise<ActivationReport> {
  // Start ordinary totals while this selection still has time left. Waiting
  // until Focus expires would leave no budget for a fallback.
  const ordinary = runFocus(baseOverviewQueue, month, sites, {...query, focusSummaries: []})
    .then((report): ActivationReport => ({...report, commissionCoverage: 'unavailable'}));
  void ordinary.then(onBase, () => {});
  if (pendingCount(overviewQueue) >= overviewQueue.limit) return ordinary;
  const fallback = ordinary.catch(() => undefined);
  return runFocus(overviewQueue, month, sites, query, onBase).catch(async error => {
    const report = await fallback;
    if (report) return report;
    throw error;
  });
}

export async function readVodafoneFocus(month: string, sites: string[] | null, query: ActivationQuery, earlyTotals=false): Promise<ActivationReport> {
  if (!query.focusSummaries || query.focusCardsOnly) return runFocus(detailQueue, month, sites, query);
  // Both subscribers share the pinned worker. Each HTTP request revalidates
  // its own session and authorized scope before releasing either response.
  const key = JSON.stringify([month, sites, query]);
  const pending = inFlightOverviews.get(key);
  if (pending) return earlyTotals ? pending.totals : pending.complete;
  let publishBase!: (report: ActivationReport) => void;
  const base = new Promise<ActivationReport>(resolve => { publishBase = resolve; });
  const complete = (!query.focusSummaries.length
    ? runFocus(baseOverviewQueue, month, sites, query)
    : pendingCount(overviewQueue)
      ? readBusyOverview(month, sites, query, publishBase)
      : runFocus(overviewQueue, month, sites, query, publishBase))
    .finally(() => inFlightOverviews.delete(key));
  const totals = Promise.race([base, complete]);
  // A caller may subscribe only to the complete report.
  void totals.catch(() => {});
  inFlightOverviews.set(key, {totals, complete});
  return earlyTotals ? totals : complete;
}

export function readDigiOverview(month: string, sites: string[] | null, query?: ActivationQuery): Promise<ActivationReport> {
  const key = JSON.stringify([month, sites, query]);
  const pending = inFlightDigi.get(key);
  if (pending) return pending;
  const report = runFocus(digiOverviewQueue, month, sites, query, undefined, 'digi')
    .finally(() => inFlightDigi.delete(key));
  inFlightDigi.set(key, report);
  return report;
}
