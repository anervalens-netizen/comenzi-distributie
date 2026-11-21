import {parentPort} from 'node:worker_threads';
import {readVodafoneBonus, type VodafoneBonusRead} from './vodafone-bonus-node';

import {readVodafoneSim0Ranking,type VodafoneSim0RankingRead} from './vodafone-activation-ranking-node';

parentPort?.on('message',(options: VodafoneBonusRead|VodafoneSim0RankingRead)=>{
  try {
    parentPort?.postMessage('kind' in options ? readVodafoneSim0Ranking(options) : readVodafoneBonus(options));
  } catch {
    parentPort?.postMessage(null);
  }
});
