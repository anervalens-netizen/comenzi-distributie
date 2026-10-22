import {db,fail} from './server';
import {parseDistributionRules,rulesSetting,type DistributionRules} from './distribution-rules';
export async function readDistributionRules():Promise<DistributionRules|null>{
 const stored=await db().prepare('SELECT value FROM settings WHERE key=?').bind(rulesSetting).first<{value:string}>();
 if(!stored)return null;
 try{return parseDistributionRules(stored.value);}catch{fail(503,'Configurația proiectelor necesită verificare.');}
}
