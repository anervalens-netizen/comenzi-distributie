import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),'vodafone-scheduler-'));
try {
  const modulePath=join(dir,'runtime.mjs');
  const code=readFileSync('lib/vodafone-bonus-runtime-node.ts','utf8')
    .replace('registerDeadlineMs=11*60_000','registerDeadlineMs=1200')
    .replace('rankingDeadlineMs=75_000','rankingDeadlineMs=2400')
    .replace('foregroundGraceMs=2_000','foregroundGraceMs=60');
  await build({stdin:{resolveDir:join(cwd,'lib'),contents:code,loader:'ts'},bundle:true,format:'esm',platform:'node',outfile:modulePath});
  process.chdir(dir);
  writeFileSync('events','');
  writeFileSync('vodafone-bonus-worker.mjs',`
    import {parentPort,threadId} from 'node:worker_threads';
    import {appendFileSync,readFileSync} from 'node:fs';
    parentPort.on('message',job=>{
      const tag=job.scope[0];
      const duplicate=readFileSync('events','utf8').includes('start '+tag+' ');
      appendFileSync('events','start '+tag+' '+threadId+'\\n');
      const delay=tag==='cold'?220:tag==='hung'||tag==='twice'||(tag==='ranking'&&!duplicate)?9000:10;
      setTimeout(()=>{
        appendFileSync('events','done '+tag+' '+threadId+'\\n');
        parentPort.postMessage('kind' in job?{rows:[tag]}:{points:[tag]});
      },delay);
    });`);
  const {readVodafoneBonusAsync:readUi,readVodafoneSim0RankingAsync:readRank}=await import(pathToFileURL(modulePath).href);
  const rank=site=>({kind:'sim0-clients',scope:[site]});
  const ui=site=>({scope:[site]});
  const events=()=>readFileSync('events','utf8').trim().split('\n');
  async function starts(tag,n=1) {
    const until=Date.now()+2000;
    while (events().filter(s=>s.startsWith('start '+tag+' ')).length<n) {
      if (Date.now()>until) throw Error('Worker did not start '+tag);
      await wait(5);
    }
  }

  const cold=readUi(ui('cold'));await starts('cold');
  const pending=join(dir,'pending.mjs');
  await build({entryPoints:[join(cwd,'lib/vodafone-bonus-preparing.ts')],platform:'node',format:'esm',outfile:pending});
  const {observeVodafoneBonus,VodafoneBonusPreparing}=await import(pathToFileURL(pending));
  await assert.rejects(observeVodafoneBonus(cold,5),VodafoneBonusPreparing);
  assert.deepEqual(await readUi(ui('cold')),{points:['cold']});assert.deepEqual(await cold,{points:['cold']});
  assert.equal(events().filter(line=>line.startsWith('start cold ')).length,1,'polling joins the unexpired foreground job');
  writeFileSync('events','');
  const ranking=readRank(rank('ranking')),sameRanking=readRank(rank('ranking'));
  await starts('ranking');
  const other=readRank(rank('alternate'));
  await assert.rejects(readRank(rank('extra')),/queue is full/);
  const screen=readUi(ui('screen')),sameScreen=readUi(ui('screen')),otherScreen=readUi(ui('other-screen'));
  assert.deepEqual(await Promise.all([screen,sameScreen,otherScreen]),[{points:['screen']},{points:['screen']},{points:['other-screen']}]);
  assert.deepEqual(await Promise.all([ranking,sameRanking,other]),[{rows:['ranking']},{rows:['ranking']},{rows:['alternate']}]);
  assert.deepEqual(events().map(line=>line.split(' ').slice(0,2).join(' ')),[
    'start ranking','start screen','done screen','start other-screen','done other-screen','start ranking','done ranking','start alternate','done alternate']);
  assert.notEqual(events()[0].split(' ')[2],events()[1].split(' ')[2]);

  const twice=assert.rejects(readRank(rank('twice')),/Foreground Vodafone/);
  await starts('twice');
  await readUi(ui('priority1'));
  await starts('twice',2);
  await readUi(ui('priority2'));
  await twice;

  const hung=assert.rejects(readUi(ui('hung')),/timed out/);
  await starts('hung');
  const later=readRank(rank('after-timeout'));
  await hung;
  assert.deepEqual(await later,{rows:['after-timeout']});
  console.log('PASS: bounded Vodafone reads, foreground priority, retry, deduplication, scope separation and timeout recovery.');
} finally {
  process.chdir(cwd);
  rmSync(dir,{recursive:true,force:true});
}
