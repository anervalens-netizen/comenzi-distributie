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
const {readDigiOverview,readVodafoneFocus} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const cwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'focus-worker-deadline-'));
const realTimeout = globalThis.setTimeout;
let testDeadlineMs = 1_500;
try {
  process.chdir(root);
  writeFileSync(join(root, 'vodafone-focus-worker.mjs'), `
    import {parentPort,workerData} from 'node:worker_threads';
    import {appendFileSync} from 'node:fs';
    const {month,query,provider,sites} = workerData;
    const focus = !!query?.focusSummaries?.length;
    appendFileSync('started', month+(focus ? ':focus' : ':ordinary')+'\\n');
    if (!focus && month.startsWith('slow-')) await new Promise(resolve=>setTimeout(resolve,350));
    if (focus) parentPort.postMessage({
      type:'overviewBase',report:{month, totals:{total:50}, commissionCoverage:'unavailable'},
    });
    if (month === 'staged') await new Promise(resolve=>setTimeout(resolve,180));
    if (provider==='digi') {
      await new Promise(resolve=>setTimeout(resolve,100));
      parentPort.postMessage({type:'report',report:{month,provider,sites,totals:{total:6}}});
    } else if (month === 'failure') parentPort.postMessage(null);
    else if (!(focus && month.startsWith('slow')) && month !== 'detail') parentPort.postMessage({
      type:'report',report:{month, totals:{total:50,...(focus ? {eligible:20} : {})}},
    });
    else await new Promise(resolve=>setTimeout(resolve,20_000));
  `);
  const readDigi=()=>readDigiOverview('digi-month',['synthetic-site']);
  const digi=readDigi(),otherWaiter=readDigi();
  assert.equal(await Promise.race([wait(10,'responsive'),digi]),'responsive');
  assert.deepEqual(await digi,{month:'digi-month',provider:'digi',sites:['synthetic-site'],totals:{total:6}});
  assert.deepEqual(await otherWaiter,await digi);
  assert.equal(readFileSync('started','utf8').split('digi-month:ordinary').length-1,1,'identical Digi requests share work');
  const overview = {focusSummaries: [{}]};
  assert.equal((await readVodafoneFocus('success', null, overview)).totals.eligible, 20);
  const phasedTotals = readVodafoneFocus('staged', null, overview, true);
  let panelsReady = false;
  const phasedPanels = readVodafoneFocus('staged', null, overview).then(report => { panelsReady=true; return report; });
  const first = await phasedTotals;
  assert.equal(first.totals.total, 50);
  assert.equal(first.totals.eligible, undefined);
  assert.equal(panelsReady, false);
  assert.equal((await phasedPanels).totals.eligible, 20);
  assert.equal(readFileSync('started','utf8').split('\n').filter(line=>line==='staged:focus').length, 1);
  const fallback = await readVodafoneFocus('failure', null, overview);
  assert.equal(fallback.commissionCoverage, 'unavailable');
  assert.equal(fallback.totals.total, 50);
  assert.equal(fallback.totals.eligible, undefined);

  globalThis.setTimeout = (run, ms, ...args) => realTimeout(run, ms === 17_000 ? testDeadlineMs : ms, ...args);
  const slow = readVodafoneFocus('slow', null, overview);
  const detail = readVodafoneFocus('detail', null, {});
  const rejected = assert.rejects(detail, /timed out/);
  testDeadlineMs = 500;
  const queued = readVodafoneFocus('obsolete', null, overview);
  testDeadlineMs = 1_500;
  // Independently scheduled application work remains responsive during report calculation.
  assert.equal(await Promise.race([wait(25, 'responsive'), slow]), 'responsive');
  assert.equal((await slow).commissionCoverage, 'unavailable');
  await rejected;
  assert.equal((await queued).commissionCoverage, 'unavailable');
  assert.equal((await readVodafoneFocus('recovered', null, overview)).totals.eligible, 20);
  assert.ok(!readFileSync('started', 'utf8').split('\n').includes('obsolete:focus'));

  testDeadlineMs = 4_000;
  const saturated = await Promise.all(Array.from({length:20}, (_, i) => readVodafoneFocus('slow-'+i,null,overview)));
  for (const ordinary of saturated) {
    assert.equal(ordinary.totals.total, 50);
    assert.equal(ordinary.totals.eligible, undefined);
    assert.equal(ordinary.commissionCoverage, 'unavailable');
  }
  console.log('Vodafone worker returns certified results or the ordinary totals by its deadline and recovers for the next request.');
} finally {
  globalThis.setTimeout = realTimeout;
  process.chdir(cwd);
  rmSync(root, {recursive:true, force:true, maxRetries:3});
}
