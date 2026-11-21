import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {build} from 'esbuild';

const {outputFiles} = await build({
  stdin: {resolveDir: process.cwd(), contents: "export * from './lib/vodafone-focus-runtime-node'; export {activationPublicationVersion} from './lib/activation-publication-node';"},
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const {activationPublicationVersion,readDigiOverview,readVodafoneFocus} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const cwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'focus-worker-deadline-'));
const realTimeout = globalThis.setTimeout;
let testDeadlineMs = 1_500;
try {
  process.chdir(root);
  const stores=join(root,'sources');
  process.env.MOBIUP_ACTIVATIONS_DIR=stores;
  for(const store of [stores,join(stores,'digi')]){
    for(const generation of ['one','two']){
      const destination=join(store,'generations',generation);
      mkdirSync(destination,{recursive:true});
      for(const file of ['activation-report.sqlite','activations.sqlite'])writeFileSync(join(destination,file),generation);
    }
    symlinkSync('generations/one',join(store,'current'));
  }
  writeFileSync(join(root, 'vodafone-focus-worker.mjs'), `
    import {parentPort,workerData} from 'node:worker_threads';
    import {appendFileSync,existsSync,readFileSync} from 'node:fs';
    import {join} from 'node:path';
    const {month,query,provider,sites} = workerData;
    if (month.startsWith('cache-')) {
      appendFileSync('cache-starts', 'x');
      const publication = readFileSync('worker-publication', 'utf8');
      const base = {publication, available: true, totals: {total: 7}, commissionCoverage: 'unavailable'};
      parentPort.postMessage({type: 'overviewBase', report: base});
      if (month === 'cache-race') {
        while (!existsSync('release-race')) await new Promise(resolve => setTimeout(resolve, 10));
      }
      const focusCards = query.focusSummaries.map(focus => ({territory: focus.territory}));
      const complete = {...base, focusCards, commissionCoverage: 'partial', totals: {total: 7, eligible: 5}};
      if (month === 'cache-failure') complete.focusUnavailable = ['sud'];
      parentPort.postMessage({type: 'report', report: complete});
    } else if(month.startsWith('ordinary-phase-')){
      const waitForRelease=async name=>{
        while(!existsSync('release-'+name))await new Promise(resolve=>setTimeout(resolve,10));
      };
      const core={month,available:true,selectedMonths:['2026-01'],coveredMonths:['2026-01'],
        totals:{total:50},history:[{month:'2026-01',total:50}],sites:[{site:'TEST',total:50}]};
      if(query.progressiveTotals)parentPort.postMessage({type:'overviewBase',report:{...core,commissionCoverage:'unavailable'}});
      await waitForRelease(month);
      parentPort.postMessage({type:'report',report:{...core,productBreakdown:{zero:10},
        commissionCoverage:query.focusSummaries.length?'complete':'outside_scope'}});
    } else if(month==='publish-generation'){
      const store=join(process.env.MOBIUP_ACTIVATIONS_DIR,provider==='digi'?'digi':'');
      const generation=readFileSync(join(store,'current','activation-report.sqlite'),'utf8');
      appendFileSync('opened-'+provider,generation+'\\n');
      await new Promise(resolve=>setTimeout(resolve,250));
      parentPort.postMessage({type:'report',report:{generation}});
    } else {
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
    }
  `);
  for(const provider of ['digi','vodafone']){
    const store=provider==='digi'?join(stores,'digi'):stores;
    const read=()=>provider==='digi'?readDigiOverview('publish-generation',null):readVodafoneFocus('publish-generation',null,{focusSummaries:[]});
    const earlier=read();
    let opened=false;
    for(let i=0;i<100&&!opened;i++){await wait(10);try{opened=readFileSync('opened-'+provider,'utf8').includes('one');}catch{}}
    assert(opened,'first worker pinned the earlier publication');
    symlinkSync('generations/two',join(store,'next'));
    renameSync(join(store,'next'),join(store,'current'));
    const later=read();
    assert.equal((await earlier).generation,'one');
    assert.equal((await later).generation,'two',provider+' read after publication must not share previous-generation work');
  }
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
  // Both ordinary lanes must publish authorized totals before optional product work finishes.
  const hold='ordinary-phase-hold';
  const occupied=readVodafoneFocus(hold,null,{...overview,progressiveTotals:true});
  try{
    for(const [month,focused] of [['ordinary-phase-busy',true],['ordinary-phase-alone',false]]){
      const query={focusSummaries:focused?[{}]:[],progressiveTotals:true};
      const totals=readVodafoneFocus(month,null,query,true);
      const panels=readVodafoneFocus(month,null,query);
      let completed=false;
      void panels.then(()=>{completed=true;});
      const first=await Promise.race([totals,wait(2_000,null)]);
      assert.ok(first,'ordinary worker should deliver totals before the product query can finish');
      assert.equal(first.available,true);
      assert.equal(first.totals.total,50);
      assert.equal(first.totals.eligible,undefined);
      assert.equal(first.sites[0].total,50);
      assert.equal(first.history[0].total,50);
      assert.deepEqual(first.coveredMonths,first.selectedMonths);
      assert.equal(first.productBreakdown,undefined);
      assert.equal(completed,false);
      writeFileSync('release-'+month,'');
      if(focused)writeFileSync('release-'+hold,'');
      const full=await panels;
      assert.deepEqual(full.totals,first.totals);
      assert.equal(full.productBreakdown.zero,10);
      assert.equal(full.commissionCoverage,focused?'complete':'outside_scope');
    }
  }finally{
    for(const month of [hold,'ordinary-phase-busy','ordinary-phase-alone'])writeFileSync('release-'+month,'');
    await occupied;
  }
  const fallback = await readVodafoneFocus('failure', null, overview);
  assert.equal(fallback.commissionCoverage, 'unavailable');
  assert.equal(fallback.totals.total, 50);
  assert.equal(fallback.totals.eligible, undefined);
  const missingCards=await readVodafoneFocus('failure',null,{focusSummaries:[{territory:'sud'}],returnFocusCards:true});
  assert.deepEqual(missingCards.focusUnavailable,['sud']);
  assert.equal(missingCards.totals.eligible,undefined);

  // A repeat UI selection may reuse only a fully resolved pair from the same
  // activation publication, slip database and requested authorization scope.
  process.env.MOBIUP_DATA_DIR = root;
  writeFileSync(join(root, 'mobiup.sqlite'), 'slips');
  const setPublication = () => writeFileSync('worker-publication', activationPublicationVersion('vodafone'));
  setPublication();
  const cachedQuery = {focusSummaries: [{territory: 'sud'}], progressiveTotals: true, returnFocusCards: true};
  const cachedRead = (month = 'cache-panel', sites = null, query = cachedQuery, totals = false) =>
    readVodafoneFocus(month, sites, query, totals);
  const calls = () => readFileSync('cache-starts', 'utf8').length;
  const full = await cachedRead();
  full.totals.total = 42;
  assert.deepEqual((await cachedRead()).totals, {total: 7, eligible: 5});
  assert.deepEqual((await cachedRead('cache-panel', null, cachedQuery, true)).totals, {total: 7});
  assert.equal(calls(), 1, 'cached phases preserve the original totals response and caller isolation');
  await cachedRead('cache-panel', ['A']);
  await cachedRead('cache-panel', null, {...cachedQuery, policy:'north'});
  assert.equal(calls(), 3, 'different sites and policies cannot share results');
  writeFileSync(join(root, 'mobiup.sqlite-wal'), 'finalized order');
  await cachedRead();
  assert.equal(calls(), 4, 'slip changes invalidate completed attribution');
  writeFileSync(join(stores, 'current', 'activation-report.sqlite-wal'), 'updated projection');
  setPublication();
  await cachedRead();
  assert.equal(calls(), 5, 'activation changes invalidate completed attribution');
  for (let i=0; i<2; i++) await cachedRead('cache-failure');
  assert.equal(calls(), 7, 'failure of any territory remains retryable');
  const pendingTotals = cachedRead('cache-race', null, cachedQuery, true);
  const pendingComplete = cachedRead('cache-race');
  await pendingTotals;
  writeFileSync(join(root, 'mobiup.sqlite-wal'), 'changed while calculating');
  writeFileSync('release-race', '');
  await pendingComplete;
  await cachedRead('cache-race');
  assert.equal(calls(), 9, 'in-flight source changes leave no reusable result');
  const detailQuery = {...cachedQuery, focusSummaries:[{territory:'sud', detail:'attributed'}]};
  for (let i=0; i<2; i++) await cachedRead('cache-detail',null,detailQuery);
  assert.equal(calls(), 11, 'serial-bearing detail is never retained');

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
