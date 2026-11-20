import {parentPort} from 'node:worker_threads';
import {readVodafoneBonus, type VodafoneBonusRead} from './vodafone-bonus-node';

parentPort?.on('message',(options: VodafoneBonusRead)=>{
  try {
    parentPort?.postMessage(readVodafoneBonus(options));
  } catch {
    parentPort?.postMessage(null);
  }
});
