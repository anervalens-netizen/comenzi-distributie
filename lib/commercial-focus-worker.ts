import {parentPort, workerData} from 'node:worker_threads';
import {readFocusSales} from './commercial-focus-store';

const data = workerData as Parameters<typeof readFocusSales>;
try {
  parentPort?.postMessage({ok: true, result: readFocusSales(...data)});
} catch {
  parentPort?.postMessage({ok: false});
}
