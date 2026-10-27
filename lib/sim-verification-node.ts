import {DatabaseSync} from 'node:sqlite';
import {resolve,dirname} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
import type {SimSale,SimVerification} from './sim-verification-types';
type Movement={movement_id:number;company:string;imei:string;serial:string;movement_date:string|null;site:string;is_tr:number;item_code:string;customer_key:string;quantity:number|null;raw_json:string;conflict:number};
export function verifySim(serial:string):SimVerification{
 if(!/^[0-9]{18,22}$/.test(serial))throw new Error('Invalid serial');
 const base=resolve(process.env.MOBIUP_ACTIVATIONS_DIR||process.env.MOBIUP_DATA_DIR||'./work/server-data');
 let directory=base;const pointer=resolve(base,'current'),info=lstatSync(pointer,{throwIfNoEntry:false});
 if(info){if(!info.isSymbolicLink())throw new Error('Invalid generation pointer');directory=realpathSync(pointer);if(dirname(directory)!==resolve(base,'generations'))throw new Error('Invalid generation location');}
 const db=new DatabaseSync(resolve(directory,'activations.sqlite'),{readOnly:true});
 try{
  if(String(db.prepare("SELECT value FROM activation_meta WHERE key='schema_version'").get()?.value)!=='3')throw new Error('Unsupported ledger');
  const meta=db.prepare("SELECT MAX(imported_at) importedAt,MAX(source_at) sourceDate,COUNT(*) count FROM activation_imports WHERE status='complete' AND operator='vodafone' AND source_kind='internal'").get();
  if(!meta?.count)throw new Error('Sales source unavailable');
  const result:SimVerification={provider:'vodafone',serial,status:'not_found',importedAt:String(meta.importedAt||''),sourceDate:String(meta.sourceDate||''),sale:null,history:[]};
  // Use the existing compound identity index and effective movement primary key.
  // Exact full ICCIDs never fall back to prefix matching. The 18-digit Vodafone
  // representation can match a 19-digit SIM ICCID; collisions stay ambiguous.
  const ids=new Set<number>();
  const add=(rows:Record<string,unknown>[])=>{for(const row of rows)ids.add(Number(row.id));};
  for(const company of ['MobiUp','MobiCell']){
   add(db.prepare("SELECT id FROM activation_movements WHERE company=? AND provider='vodafone' AND imei=? LIMIT 101").all(company,serial));
   if(serial.length===18){
    add(db.prepare("SELECT id FROM activation_movements WHERE company=? AND provider='vodafone' AND imei>=? AND imei<=? AND item_type='SIM' LIMIT 101").all(company,serial+'0',serial+'9'));
    add(db.prepare("SELECT movement_id id FROM activation_effective_movements WHERE company=? AND provider='vodafone' AND serial=? LIMIT 101").all(company,serial));
   }
  }
  if(ids.size>100)throw new Error('Too many movements');
  if(!ids.size)return result;
  const rows=db.prepare(`SELECT e.*,EXISTS(SELECT 1 FROM activation_meta WHERE key='conflict:'||m.movement_key) conflict FROM activation_effective_movements e JOIN activation_movements m ON m.id=e.movement_id WHERE e.movement_id IN (${[...ids].map(()=>'?').join(',')}) AND m.item_type IN ('SIM','TELSIM') AND e.item_code NOT IN ('V03EVDF','V04EVDF','V05EVDF','V06EVDF') ORDER BY e.movement_date,e.movement_id`).all(...ids) as Movement[];
  if(!rows.length)return result;
  const present=(row:Movement):SimSale=>{const raw=JSON.parse(row.raw_json);return {company:row.company,serial:row.imei,seller:String(raw.TR||row.site||'Nespecificat'),kind:row.is_tr?'agent':row.site==='NOM'||String(raw.TR).toUpperCase()==='SEDIU CENTRAL'?'central':'store',date:row.movement_date,receipt:String(raw.Nr||''),quantity:row.quantity};};
  result.history=rows.map(present);
  const outstanding:Movement[]=[];let uncertain=rows.some(r=>r.conflict||!r.movement_date||![1,-1].includes(r.quantity as number));
  // Match only unambiguous prior sales in the same legal company and product.
  // Same-day and unidentified returns require inspection instead of row-order guesses.
  for(const row of rows){
   if(row.quantity===1)outstanding.push(row);
   if(row.quantity===-1){const matches=outstanding.filter(s=>s.company===row.company&&s.imei===row.imei&&s.item_code===row.item_code&&!!row.customer_key&&s.customer_key===row.customer_key&&!!s.movement_date&&!!row.movement_date&&s.movement_date<row.movement_date);
    if(matches.length===1)outstanding.splice(outstanding.indexOf(matches[0]),1);else uncertain=true;
   }
  }
  const identities=new Set(rows.map(r=>r.company+'|'+r.imei));
  if(uncertain||identities.size>1||outstanding.length>1)result.status='ambiguous';
  else if(outstanding.length===1){const sale=present(outstanding[0]);result.status=sale.kind==='central'?'recorded':'sold';if(result.status==='sold')result.sale=sale;}
  else result.status=rows.some(r=>r.quantity===1)?'returned':'recorded';
  return result;
 }finally{db.close();}
}
