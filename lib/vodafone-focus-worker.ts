import {parentPort, workerData} from 'node:worker_threads';
import {readActivations} from './activation-store-node';
import type {ActivationQuery} from './activation-distribution';

const {month, sites, query} = workerData as {month: string; sites: string[] | null; query: ActivationQuery};
try {
  parentPort?.postMessage(readActivations(month, sites, 'vodafone', query));
} catch {
  parentPort?.postMessage(null);
}
