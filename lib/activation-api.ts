import {canViewActivations} from './activation-access';
import {readActivations} from '#mobiup-activation-store';
import {db,fail} from './server';
import {managerFilter} from './manager-scope';
import {bucharestMonthKey} from './bucharest-month';
import type {User} from './types';
export async function activationReport(user:User,params:URLSearchParams){
  if(!canViewActivations(user))fail(403,'Secțiunea Activări nu este disponibilă pentru acest cont.');
  const month=params.get('month')||bucharestMonthKey(new Date());
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))fail(400,'Alege o lună validă.');
  let sites:string[]|null;
  if(user.role==='manager')sites=(await managerFilter(user,params))?.siteCodes??null;
  else {
    if(params.has('agentId')||params.has('managerId')||params.has('siteCode'))fail(403,'Filtrul nu este disponibil pentru acest cont.');
    // A current site may be shared or reassigned: never guess which account owns it.
    const code=user.siteCode?.trim();
    const owners=code?(await db().prepare("SELECT id FROM users WHERE role='agent' AND UPPER(TRIM(site_code))=UPPER(?)").bind(code).all<{id:string}>()).results:[];
    sites=code&&owners.length===1&&owners[0].id===user.id?[code]:[];
  }
  try{return readActivations(month,sites);}catch{fail(503,'Activările nu sunt disponibile momentan. Încearcă din nou mai târziu.');}
}
