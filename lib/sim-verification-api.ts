import {verifySim} from '#mobiup-activation-store';
import {fail} from './server';
import type {User} from './types';
export function simVerification(user:User,body:Record<string,unknown>){
 if(!['agent','manager'].includes(user.role))fail(403,'Verificarea SIM nu este disponibilă pentru acest cont.');
 if(Object.keys(body).some(key=>key!=='serial')||typeof body.serial!=='string'||!/^\s*[0-9]{18,22}\s*$/.test(body.serial))fail(400,'Scanează sau introdu o serie SIM validă (18–22 cifre).');
 try{return verifySim((body.serial as string).trim());}catch{fail(503,'Verificarea SIM nu este disponibilă momentan. Încearcă din nou.');}
}
