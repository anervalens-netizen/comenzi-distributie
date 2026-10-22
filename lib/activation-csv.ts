import type {ActivationReport} from './activation-types';
type CsvValue=string|number|boolean|null|undefined;
const cell=(v:CsvValue)=>{let text=String(v??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
export function activationCsv(reports:ActivationReport[]){
 const rows:CsvValue[][]=[['Operator','Reper sursă','Data','Tip SIM','Județ','Comisionabilă','Motive']];
 for(const r of reports)for(const d of r.detail?.rows||[])rows.push([r.provider,r.detail?.asOf,d.date,d.handset||d.itemType,d.county,d.eligible===null?'Fără regulă':d.eligible?'Da':'Nu',d.reasons.join('; ')]);
 return '\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
}
