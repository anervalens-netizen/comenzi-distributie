import {readVodafoneSim0RankingAsync} from '#mobiup-activation-store';
import {readDistributionRules} from './distribution-config';
import {fail} from './server';
import {authorizedScope,getEvidence} from './vodafone-bonus-api';
import {parseVodafoneBonusEvidence} from './vodafone-bonus-evidence';
import type {User} from './types';


const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});
export async function readManagerAiSim0(params:URLSearchParams,fromMonth:string,toMonth:string,check:()=>Promise<User>) {
  const user=await check();
  const scope=await authorizedScope(user,params);
  const [rules,raw]=await Promise.all([readDistributionRules(),getEvidence()]);
  if (!rules) fail(503,'Lipsește clasificarea produselor Vodafone.');
  const evidence=parseVodafoneBonusEvidence(raw);
  const report=await readVodafoneSim0RankingAsync({kind:'sim0-clients',today:day.format(new Date()),rules,evidence,
    targets:[],month:null,scope,fromMonth,toMonth}).catch(()=>fail(503,'Sursa activărilor SIM 0 Vodafone nu este disponibilă momentan.'));
  const checkAccess=async(current:User)=>{
    if (current.id!==user.id || current.profileVersion!==user.profileVersion || current.managerScope!==user.managerScope ||
        JSON.stringify(scope)!==JSON.stringify(await authorizedScope(current,params))) fail(409,'Accesul la clasamentul SIM 0 s-a modificat.');
  };
  await checkAccess(await check());
  const [updatedRules,updatedEvidence]=await Promise.all([readDistributionRules(),getEvidence()]);
  if (JSON.stringify(rules)!==JSON.stringify(updatedRules) || raw!==updatedEvidence) fail(409,'Sursele SIM 0 s-au modificat. Reia analiza.');
  return {checkAccess,rows:report.rows,coverage:report.coverage.map(row=>({
    source:'Activări SIM 0 Vodafone · firme și puncte identificate',month:row.month,through:row.sourceThrough,
    available:row.reported,revision:report.revision,note:row.reported
      ? [`${row.excludedActivations} activări din selecție excluse.`,Object.entries(row.exclusions).map(([reason,count])=>`${reason} (${count})`).join(', '),'Confirmarea fiscală este o măsură separată.'].filter(Boolean).join(' ')
      : 'Luna nu are acoperire identificată în sursa de activări.',
  }))};
}
