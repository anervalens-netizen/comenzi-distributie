import {realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import {parentPort} from 'node:worker_threads';
import {readVodafoneBonus, type VodafoneBonusRead} from './vodafone-bonus-node';

import {readVodafoneSim0Ranking,type VodafoneSim0RankingRead} from './vodafone-activation-ranking-node';

if (!parentPort && process.argv[2]==='--warm-ledger') {
  // The cache namespace is bound to the actual packaged worker, including across release switches.
  process.chdir(dirname(realpathSync(process.argv[1])));
  const started=Date.now();
  try {
    const {warmConfiguredVodafoneLedger}=await import('./vodafone-bonus-warmup-node');
    const status=await warmConfiguredVodafoneLedger();
    console.log(JSON.stringify({vodafoneLedger:status,elapsedMs:Date.now()-started}));
  } catch {
    // Settings and SQLite diagnostics may contain business data.
    console.error('Vodafone ledger warmup failed. Check the configured sources, release, owner and private cache.');
    process.exitCode=1;
  }
}

parentPort?.on('message',(options: VodafoneBonusRead|VodafoneSim0RankingRead)=>{
  try {
    parentPort?.postMessage('kind' in options ? readVodafoneSim0Ranking(options) : readVodafoneBonus(options));
  } catch {
    parentPort?.postMessage(null);
  }
});
