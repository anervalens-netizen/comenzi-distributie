import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { SalesCatalogEntry } from './sales-classification';
import type { SalesView } from './sales-types';
import { salesLocationKey, type SalesScope } from './sales-location.ts';

function workerPath() {
  const candidates = [resolve(process.cwd(), 'sales-view-worker.mjs'), resolve(process.cwd(), 'dist/standalone/sales-view-worker.mjs')];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Workerul de agregare a vânzărilor nu este disponibil.');
  return found;
}
type Input = { month: string; siteCode?: SalesScope; fromMonth: string; toMonth: string; catalog: readonly SalesCatalogEntry[] };
type Identity = { revision: number; dataPath: string };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
// Match SQLite's built-in UPPER(TRIM()) exactly (ASCII case, space trimming).
const siteKey = (text: string) => text.trim().replace(/[a-z]/g, char => char.toUpperCase());

/** Instance factory provides deterministic worker/clock hooks without changing the public runtime API. */
export function createSalesViewRuntime(options: {
  identity: () => Identity;
  createWorker?: (input: Input, identity: Identity) => Worker;
  now?: () => number;
  timeoutMs?: number;
}) {
  const now = options.now || Date.now;
  const pending = new Map<string, Promise<string>>();
  const cache = new Map<string, { json: string; bytes: number; expires: number }>();
  const queue: (() => void)[] = [];
  const maxBytes = 8 * 1024 * 1024;
  let active = false, cacheBytes = 0, generation = '';
  function remove(key: string) { const item = cache.get(key); if (item) cacheBytes -= item.bytes; cache.delete(key); }
  function pump() { if (!active && queue.length) { active = true; queue.shift()!(); } }
  function calculate(input: Input, identity: Identity): Promise<SalesView> {
    return new Promise((accept, reject) => {
      let worker: Worker;
      try {
        worker = options.createWorker ? options.createWorker(input, identity) : new Worker(pathToFileURL(workerPath()), {
          workerData: input, env: { ...process.env, MOBIUP_DATA_DIR: dirname(identity.dataPath) },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
      } catch (error) { reject(error); return; }
      let settled = false;
      const finish = (error?: Error, view?: SalesView) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // Release the concurrency slot only after the worker has stopped, even after a message.
        void worker.terminate().then(() => { if (error) reject(error); else accept(view!); }, reject);
      };
      const timer = setTimeout(() => finish(new Error('Calculul raportului de vânzări a expirat.')), options.timeoutMs ?? 60_000);
      worker.once('message', (message: { ok: boolean; view?: SalesView; error?: string } | null) => {
        if (message?.ok && message.view) finish(undefined, message.view);
        else finish(new Error(message?.error || 'Raportul de vânzări nu a putut fi calculat.'));
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => finish(new Error(`Workerul de vânzări s-a oprit cu codul ${code}.`)));
    });
  }
  return function getSalesViewRuntime(month: string, siteCode: SalesScope | undefined, fromMonth: string, toMonth: string, catalog: readonly SalesCatalogEntry[]): Promise<SalesView> {
    try {
      const identity = options.identity();
      const unique = (values: string[], key: (value: string) => string) => [...new Set(values.map(key).filter(Boolean))].sort();
      const scope = siteCode && typeof siteCode === 'object' && !Array.isArray(siteCode)
        ? {
          warehouseNames: unique(siteCode.warehouseNames, salesLocationKey),
          warehouseSites: [...new Map((siteCode.warehouseSites || []).map(pair => {
            const normalized = { warehouseName: salesLocationKey(pair.warehouseName), siteCode: siteKey(pair.siteCode) };
            return [JSON.stringify(normalized), normalized] as const;
          })).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair),
          siteCodes: unique(siteCode.siteCodes, siteKey), excludedWarehouseNames: unique(siteCode.excludedWarehouseNames, salesLocationKey), siteCode: siteCode.siteCode ? siteKey(siteCode.siteCode) : undefined,
        }
        : Array.isArray(siteCode) ? [...new Set(siteCode.map(siteKey).filter(Boolean))].sort()
        : siteCode?.trim() ? [siteKey(siteCode)] : undefined;
      const catalogJson = JSON.stringify(catalog);
      const inputJson = JSON.stringify({ month, siteCode: scope, fromMonth, toMonth, catalog: JSON.parse(catalogJson) });
      if (Buffer.byteLength(inputJson) > maxBytes) throw new Error('Cererea raportului de vânzări este prea mare.');
      const currentGeneration = JSON.stringify([identity.dataPath, identity.revision, digest(catalogJson)]);
      if (generation !== currentGeneration) { cache.clear(); cacheBytes = 0; generation = currentGeneration; }
      for (const [key, item] of cache) if (item.expires <= now()) remove(key);
      const key = digest(JSON.stringify([currentGeneration, month, fromMonth, toMonth, scope ?? null]));
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(JSON.parse(hit.json)); }
      const flight = pending.get(key);
      if (flight) return flight.then(json => JSON.parse(json));
      // One active worker and at most 16 queued distinct reports. Identical reads consume no queue slot.
      if (pending.size >= 17) throw new Error('Prea multe rapoarte de vânzări în așteptare. Reîncearcă.');
      const input: Input = JSON.parse(inputJson);
      const result = new Promise<string>((accept, reject) => {
        queue.push(() => {
          void calculate(input, identity).then(view => {
            const json = JSON.stringify(view), bytes = Buffer.byteLength(json);
            // An import during a worker snapshot must never publish a stale cache entry.
            const latest = options.identity();
            if (generation === currentGeneration && latest.revision === identity.revision && latest.dataPath === identity.dataPath && bytes <= maxBytes) {
              while (cache.size >= 16 || cacheBytes + bytes > maxBytes) remove(cache.keys().next().value!);
              cache.set(key, { json, bytes, expires: now() + 5_000 }); cacheBytes += bytes;
            }
            return json;
          }).then(json => {
            pending.delete(key); active = false; pump(); accept(json);
          }, error => {
            pending.delete(key); active = false; pump(); reject(error);
          });
        });
      });
      pending.set(key, result); pump();
      // Each caller owns its result; downstream decoration/mutation cannot contaminate another scope/read.
      return result.then(json => JSON.parse(json));
    } catch (error) { return Promise.reject(error); }
  };
}
// Read the committed revision from the actual database on every request. Opening read-only
// avoids schema/index work on the event loop and also observes database file replacement.
const salesDatabasePath = resolve(process.env.MOBIUP_DATA_DIR || './work/server-data', 'sales.sqlite');
function runtimeIdentity(): Identity {
  if (!existsSync(salesDatabasePath)) return { revision: 0, dataPath: salesDatabasePath };
  const db = new DatabaseSync(salesDatabasePath, { readOnly: true });
  try {
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales_meta'").get();
    const revision = hasMeta ? Number(db.prepare("SELECT value FROM sales_meta WHERE key='revision'").get()?.value || 0) : 0;
    return { revision, dataPath: salesDatabasePath };
  } finally { db.close(); }
}
export const getSalesViewRuntime = createSalesViewRuntime({ identity: runtimeIdentity });
