import {parentPort} from 'node:worker_threads';
import {readPartnerPage} from './activation-partners-page-node';
import {ActivationPartnerProjectionChanged,type CombinedPartnerRead} from './activation-portfolio';
parentPort?.on('message',({id,input,page}:{id:number;input:CombinedPartnerRead;page:number})=>{
  try{parentPort?.postMessage({id,report:readPartnerPage(input,page)});}
  catch(error){parentPort?.postMessage({id,stale:error instanceof ActivationPartnerProjectionChanged});}
});
