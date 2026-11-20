import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {build} from 'esbuild';

const {outputFiles} = await build({
  entryPoints: ['lib/vodafone-focus-runtime-node.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const {readVodafoneFocus} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const cwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'focus-worker-deadline-'));
const realTimeout = globalThis.setTimeout;
let testDeadlineMs = 1_500;
try {
  process.chdir(root);
  writeFileSync(join(root, 'vodafone-focus-worker.mjs'), `
    import {parentPort,workerData} from 'node:worker_threads';
    import {appendFileSync} from 'node:fs';
    const {month,query} = workerData;
    appendFileSync('started', month+'\\n');
    if (query.focusSummaries?.length) parentPort.postMessage({
      type:'overviewBase',report:{month, totals:{total:50}, commissionCoverage:'unavailable'},
    });
    if (month === 'failure') parentPort.postMessage(null);
    else if (!month.startsWith('slow') && month !== 'detail') parentPort.postMessage({
      type:'report',report:{month, totals:{total:50,...(query.focusSummaries?.length ? {eligible:20} : {})}},
    });
    else await new Promise(resolve=>setTimeout(resolve,20_000));
  `);
  const overview = {focusSummaries: [{}]};
  assert.equal((await readVodafoneFocus('success', null, overview)).totals.eligible, 20);
  const fallback = await readVodafoneFocus('failure', null, overview);
  assert.equal(fallback.commissionCoverage, 'unavailable');
  assert.equal(fallback.totals.total, 50);
  assert.equal(fallback.totals.eligible, undefined);

  globalThis.setTimeout = (run, ms, ...args) => realTimeout(run, ms === 17_000 ? testDeadlineMs : ms, ...args);
  const slow = readVodafoneFocus('slow', null, overview);
  const detail = readVodafoneFocus('detail', null, {});
  const rejected = assert.rejects(detail, /timed out/);
  testDeadlineMs = 100;
  const queued = assert.rejects(readVodafoneFocus('obsolete', null, overview), /timed out/);
  testDeadlineMs = 1_500;
  // Independently scheduled application work remains responsive during report calculation.
  assert.equal(await Promise.race([wait(25, 'responsive'), slow]), 'responsive');
  assert.equal((await slow).commissionCoverage, 'unavailable');
  await Promise.all([queued, rejected]);
  assert.equal((await readVodafoneFocus('recovered', null, overview)).totals.eligible, 20);
  assert.ok(!readFileSync('started', 'utf8').split('\n').includes('obsolete'));

  const saturated = Promise.allSettled(Array.from({length:6}, (_, i) => readVodafoneFocus('slow-'+i,null,overview)));
  const ordinary = await readVodafoneFocus('ordinary', null, overview);
  assert.equal(ordinary.totals.total, 50);
  assert.equal(ordinary.totals.eligible, undefined);
  assert.equal(ordinary.commissionCoverage, 'unavailable');
  await saturated;
  console.log('Vodafone worker returns certified results or the ordinary totals by its deadline and recovers for the next request.');
} finally {
  globalThis.setTimeout = realTimeout;
  process.chdir(cwd);
  rmSync(root, {recursive:true, force:true, maxRetries:3});
}
