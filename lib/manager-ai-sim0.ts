import {readVodafoneSim0RankingAsync} from '#mobiup-activation-store';
import {readDistributionRules} from './distribution-config';
import {fail} from './server';
import {authorizedScope,getEvidence} from './vodafone-bonus-api';
import {parseVodafoneBonusEvidence} from './vodafone-bonus-evidence';
import type {User} from './types';
import type {Sim0MonthCoverage} from './vodafone-sim0-coverage';

function coverageNote(row:Sim0MonthCoverage) {
  switch(row.status) {
    case 'complete': return 'Importurile operatorului acoperă întreaga lună.';
    case 'current': return 'Lună în curs. Importurile acoperă perioada până la '+row.expectedThrough+' inclusiv.';
    case 'partial': return 'Acoperire parțială. Intervale importate de la operator: '+row.ranges.join(', ')+'. Perioada evaluată se încheie la '+row.expectedThrough+'. Totalurile sunt parțiale.';
    case 'observed': return 'Există activări observate, fără interval certificat al operatorului în această lună. Totalurile sunt parțiale.';
    case 'missing': return 'Lipsesc intervalele certificate și observațiile din selecție. Totalul lunar este necunoscut.';
  }
}
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});
export async function readManagerAiSim0(params:URLSearchParams,fromMonth:string,toMonth:string,check:()=>Promise<User>) {
  const user=await check();
  const scope=await authorizedScope(user,params);
  const [rules,raw]=await Promise.all([readDistributionRules(),getEvidence()]);
  if (!rules) fail(503,'Lipsește clasificarea produselor Vodafone.');
  let evidence;
  try {evidence=parseVodafoneBonusEvidence(raw);} catch {fail(503,'Dovezile fiscale Vodafone necesită verificare.');}
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
    available:row.reported,revision:report.revision,note:[
      coverageNote(row),row.lastObserved?'Ultima activare observată în selecție: '+row.lastObserved+'.':'',
      row.status!=='missing'?`${row.excludedActivations} activări din selecție excluse.`:'',
      Object.entries(row.exclusions).map(([reason,count])=>`${reason} (${count})`).join(', '),
      scope!==null?'Clasamentul însumează doar contribuțiile gestiunilor din selecție, inclusiv pentru firmele și punctele de lucru afișate.':'',
      'Confirmarea fiscală este o măsură separată.',
    ].filter(Boolean).join(' '),
  }))};
}
