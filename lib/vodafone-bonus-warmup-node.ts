import {statSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseDistributionRules,rulesSetting} from './distribution-rules';
import {parseVodafoneBonusEvidence,vodafoneBonusEvidenceSetting} from './vodafone-bonus-evidence';
import {warmVodafoneBonusLedger} from './vodafone-bonus-node';
import {readVodafoneTopLocationsFile} from './vodafone-top-locations-file';

const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});

async function configuration(path:string) {
  const app=new DatabaseSync(path,{readOnly:true,timeout:500});
  let raw:Map<string,string>;
  try {
    const rows=app.prepare('SELECT key,value FROM settings WHERE key IN (?,?)').all(rulesSetting,vodafoneBonusEvidenceSetting);
    raw=new Map(rows.map(row=>[String(row.key),String(row.value)]));
  } finally {app.close();}
  return {today:calendar.format(new Date()),rules:parseDistributionRules(raw.get(rulesSetting)),
    evidence:parseVodafoneBonusEvidence(raw.get(vodafoneBonusEvidenceSetting)),targets:await readVodafoneTopLocationsFile()};
}

export async function warmConfiguredVodafoneLedger() {
  const directory=process.env.MOBIUP_DATA_DIR,activationDirectory=process.env.MOBIUP_ACTIVATIONS_DIR;
  if (!directory || !isAbsolute(directory) || !activationDirectory || !isAbsolute(activationDirectory)) {
    throw new Error('Configure absolute application and activation data directories');
  }
  const path=join(directory,'mobiup.sqlite'),uid=process.getuid?.();
  if (!uid || statSync(path).uid!==uid) throw new Error('Run as the application database owner');
  const config=await configuration(path);
  const status=warmVodafoneBonusLedger({...config,directory,activationDirectory,scope:null,month:null});
  if (JSON.stringify(config)!==JSON.stringify(await configuration(path))) throw new Error('Vodafone configuration changed during warmup');
  return status;
}
