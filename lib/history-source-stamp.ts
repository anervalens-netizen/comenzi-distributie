import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {historyStamp,historyStampSteps} from './partner-activity-snapshot';
import {salesYield} from './client-sales-cooperative';
import {fileGeneration} from './history-source-generation';
export {fileGeneration} from './history-source-generation';
export const clientSalesCacheStats={hits:0,builds:0,bytes:0,stampBuilds:0};
type Stamp=ReturnType<typeof historyStamp>;
let lastStamp:{key:string;value:Stamp}|undefined;
const stampFlights=new Map<string,Promise<Stamp>>();
export async function cooperativeStamp(directory:string,generation:string):Promise<Stamp>{
  const key=directory+'|'+generation;
  if(lastStamp?.key===key)return lastStamp.value;
  let flight=stampFlights.get(key);
  if(!flight){
    flight=(async()=>{
      clientSalesCacheStats.stampBuilds++;
      const openedGeneration=fileGeneration(directory);
      const c=new DatabaseSync(resolve(directory,'client-history','client-sales-history.sqlite'),{readOnly:true});
      const steps=historyStampSteps(c);
      try{
        c.exec('BEGIN');let step;
        do{step=steps.next();if(!step.done)await salesYield();}while(!step.done);
        if(generation===openedGeneration&&generation===fileGeneration(directory))lastStamp={key,value:step.value};
        return step.value;
      }finally{steps.return(undefined as never);c.close();}
    })().finally(()=>{stampFlights.delete(key);});
    stampFlights.set(key,flight);
  }
  return flight;
}
