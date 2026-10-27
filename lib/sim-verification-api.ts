import {verifySim} from '#mobiup-activation-store';
import {db,fail} from './server';
import type {User} from './types';
export async function simVerificationAccess(user:User){
 if(!['agent','manager'].includes(user.role)||user.active===0)fail(403,'Verificarea SIM nu este disponibilă pentru acest cont.');
 const ids=(process.env.MOBIUP_ACTIVATIONS_VODAFONE_ONLY_MANAGER_IDS||'').split(',').map(id=>id.trim()).filter(Boolean);
 const excluded=user.role==='agent'&&ids.length>0&&!!await db().prepare('SELECT 1 FROM manager_agents WHERE agent_id=? AND manager_id IN (SELECT value FROM json_each(?)) LIMIT 1').bind(user.id,JSON.stringify(ids)).first();
 return {vodafone:true,digi:!excluded};
}
export async function simVerification(user:User,body:Record<string,unknown>){
 const access=await simVerificationAccess(user),provider=body.provider??'vodafone';
 if(Object.keys(body).some(key=>!['serial','provider'].includes(key))||(provider!=='vodafone'&&provider!=='digi'))fail(400,'Alege un operator valid.');
 if(provider==='digi'&&!access.digi)fail(403,'Verificarea Digi nu este disponibilă pentru acest cont.');
 const pattern=provider==='digi'?/^\s*[0-9]{19}\s*$/:/^\s*[0-9]{18,22}\s*$/;
 if(typeof body.serial!=='string'||!pattern.test(body.serial))fail(400,provider==='digi'?'Scanează sau introdu o serie Digi validă (19 cifre).':'Scanează sau introdu o serie SIM validă (18–22 cifre).');
 try{return verifySim((body.serial as string).trim(),provider as 'vodafone'|'digi');}catch{fail(503,'Verificarea SIM nu este disponibilă momentan. Încearcă din nou.');}
}
