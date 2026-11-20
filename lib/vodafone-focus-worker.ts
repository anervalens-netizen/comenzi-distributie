import {parentPort, workerData} from 'node:worker_threads';
import {readActivations} from './activation-store-node';
import type {ActivationQuery} from './activation-distribution';

const {month, sites, query, provider = 'vodafone'} = workerData as {
  month: string; sites: string[] | null; query?: ActivationQuery; provider?: 'vodafone' | 'digi';
};
try {
  const report = readActivations(month, sites, provider, query, base => {
    parentPort?.postMessage({type: 'overviewBase', report: base});
  });
  parentPort?.postMessage({type: 'report', report});
} catch {
  parentPort?.postMessage(null);
}
