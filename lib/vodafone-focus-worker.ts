import {parentPort, workerData} from 'node:worker_threads';
import {readActivations} from './activation-store-node';
import type {ActivationQuery} from './activation-distribution';

const {month, sites, query, provider = 'vodafone', captureSlipRevision} = workerData as {
  month: string; sites: string[] | null; query?: ActivationQuery; provider?: 'vodafone' | 'digi'; captureSlipRevision?: boolean;
};
try {
  let slipRevision: string|null|undefined;
  const report = readActivations(month, sites, provider, query, base => {
    parentPort?.postMessage({type: 'overviewBase', report: base});
  }, captureSlipRevision ? value=>{slipRevision=value;} : undefined);
  parentPort?.postMessage({type: 'report', report, slipRevision});
} catch {
  parentPort?.postMessage(null);
}
