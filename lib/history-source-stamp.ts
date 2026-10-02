import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {historyStamp,historyStampSteps} from './partner-activity-snapshot';
import {salesYield} from './client-sales-cooperative';
import {historyFileGeneration,fileGeneration} from './history-source-generation';
export {fileGeneration} from './history-source-generation';
export const clientSalesCacheStats={hits:0,builds:0,bytes:0,stampBuilds:0};
export type VerifiedHistoryStamp=ReturnType<typeof historyStamp>&{sourceGeneration:string;generation:string};
type Stamp=VerifiedHistoryStamp|undefined;
let lastStamp:{key:string;value:Stamp}|undefined;
const stampFlights=new Map<string,Promise<Stamp>>();
export async function cooperativeStamp(directory:string,generation:string):Promise<Stamp>{
  const key=directory+'|'+generation;
  if(lastStamp?.key===key&&generation===fileGeneration(directory))return lastStamp.value;
  let flight=stampFlights.get(key);
  if(!flight){
    flight=(async()=>{
      clientSalesCacheStats.stampBuilds++;
      const openedGeneration=fileGeneration(directory),sourceGeneration=historyFileGeneration(resolve(directory,'client-history','client-sales-history.sqlite'));
      if(!sourceGeneration||generation!==openedGeneration)return undefined;
      const c=new DatabaseSync(resolve(directory,'client-history','client-sales-history.sqlite'),{readOnly:true});
      const steps=historyStampSteps(c);
      try{
        c.exec('BEGIN');let step;
        do{step=steps.next();if(!step.done)await salesYield();}while(!step.done);
        if(generation!==fileGeneration(directory))return undefined;
        const value={...step.value,sourceGeneration,generation};
        lastStamp={key,value};
        return value;
      }finally{steps.return(undefined as never);c.close();}
    })().finally(()=>{stampFlights.delete(key);});
    stampFlights.set(key,flight);
  }
  return flight;
}
