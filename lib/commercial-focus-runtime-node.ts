import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {readFocusSales, type FocusSales} from './commercial-focus-store';

const active = new Map<string, Promise<FocusSales | null>>();
let tail = Promise.resolve();

export async function readFocusSalesAsync(...input: Parameters<typeof readFocusSales>) {
  const script = ['commercial-focus-worker.mjs', 'dist/standalone/commercial-focus-worker.mjs']
    .map(path => resolve(path)).find(existsSync);
  if (!script && process.env.NODE_ENV === 'development') return readFocusSales(...input);
  if (!script) throw new Error('Commercial Focus worker unavailable');
  const key = JSON.stringify([input[0], input[1], input[2], [...input[3]], input[4]]);
  const current = active.get(key);
  if (current) return current;
  if (active.size >= 8) throw new Error('Commercial Focus queue full');

  const timeout = new Error('Commercial Focus timeout');
  let expired = false;
  let stop: (() => void) | undefined;
  const run = tail.then(() => new Promise<FocusSales | null>((accept, reject) => {
    if (expired) { reject(timeout); return; }
    const worker = new Worker(script, {workerData: input, resourceLimits: {maxOldGenerationSizeMb: 160}});
    let settled = false;
    const finish = (error: Error | null, result: FocusSales | null = null) => {
      if (settled) return;
      settled = true;
      void worker.terminate().then(() => error ? reject(error) : accept(result), reject);
    };
    stop = () => finish(timeout);
    worker.once('message', (message: {ok: boolean; result?: FocusSales | null}) => {
      if (message?.ok) finish(null, message.result);
      else finish(new Error('Commercial Focus sources unavailable'));
    });
    worker.once('error', finish);
    worker.once('exit', () => finish(new Error('Commercial Focus worker exited')));
  }));
  // Release the slot when the native statement and worker have actually stopped.
  const release = () => { active.delete(key); };
  tail = run.then(release, release);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_accept, reject) => {
    timer = setTimeout(() => { expired = true; stop?.(); reject(timeout); }, 10_000);
  });
  const result = Promise.race([run, deadline]).finally(() => clearTimeout(timer));
  active.set(key, result);
  return result;
}
