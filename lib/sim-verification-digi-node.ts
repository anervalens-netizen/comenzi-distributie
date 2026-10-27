import {DatabaseSync} from 'node:sqlite';
import {resolve,dirname} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
import type {SimSale,SimVerification} from './sim-verification-types';
type Movement={movement_id:number;company:string;imei:string;movement_date:string|null;is_tr:number;item_code:string;quantity:number|null;raw_json:string;conflict:number};
export function verifyDigiSim(serial:string):SimVerification{
 if(!/^[0-9]{19}$/.test(serial))throw new Error('Invalid Digi serial');
 const base=resolve(process.env.MOBIUP_ACTIVATIONS_DIR||process.env.MOBIUP_DATA_DIR||'./work/server-data','digi');
 let directory=base;const pointer=resolve(base,'current'),info=lstatSync(pointer,{throwIfNoEntry:false});
 if(info){if(!info.isSymbolicLink())throw new Error('Invalid generation pointer');directory=realpathSync(pointer);if(dirname(directory)!==resolve(base,'generations'))throw new Error('Invalid generation location');}
 const db=new DatabaseSync(resolve(directory,'activations.sqlite'),{readOnly:true});
 try{
  if(String(db.prepare("SELECT value FROM activation_meta WHERE key='schema_version'").get()?.value)!=='3')throw new Error('Unsupported ledger');
  const meta=db.prepare("SELECT MAX(imported_at) importedAt,MAX(source_at) sourceDate,COUNT(*) count FROM activation_imports WHERE status='complete' AND operator='digi' AND source_kind='internal'").get();
  if(!meta?.count)throw new Error('Sales source unavailable');
  const latest=db.prepare("SELECT MAX(movement_date) date FROM activation_effective_movements WHERE provider='digi'").get();
  const result:SimVerification={provider:'digi',serial,status:'not_found',importedAt:String(meta.importedAt||''),sourceDate:String(meta.sourceDate||latest?.date||''),sale:null,history:[]};
  const ids:number[]=[];
  for(const company of ['MobiUp','MobiCell','MobiUpInv','MobiCellInv']){
   const matches=db.prepare("SELECT id FROM activation_movements WHERE company=? AND provider='digi' AND imei=? LIMIT 101").all(company,serial);ids.push(...matches.map(r=>Number(r.id)));
  }
  if(ids.length>100)throw new Error('Too many movements');
  if(!ids.length)return result;
  const marks=ids.map(()=>'?').join(',');
  const rows=db.prepare(`SELECT e.*,EXISTS(SELECT 1 FROM activation_meta WHERE key='conflict:'||m.movement_key) conflict FROM activation_effective_movements e JOIN activation_movements m ON m.id=e.movement_id WHERE e.movement_id IN (${marks}) AND e.provider='digi' ORDER BY e.movement_date,e.movement_id`).all(...ids) as Movement[];
  if(!rows.length)return result;
  const raw=(row:Movement)=>JSON.parse(row.raw_json) as Record<string,unknown>;
  const field=(row:Movement,key:string)=>{const value=raw(row)[key];return typeof value==='string'?value:'';};
  const inventory=(row:Movement)=>row.company.endsWith('Inv');
  const present=(row:Movement):SimSale=>({company:row.company,serial:row.imei,seller:field(row,'Magazin')||'Nespecificat',kind:inventory(row)?'inventory':row.is_tr?'agent':'store',date:row.movement_date,receipt:'',quantity:row.quantity});
  result.history=rows.map(present);
  const commercial=rows.filter(r=>!inventory(r));
  if(!commercial.length){result.status='recorded';return result;}
  // Repeated indistinguishable source observations cannot establish one sale.
  const duplicate=db.prepare(`SELECT 1 FROM activation_occurrences o INDEXED BY activation_occurrences_movement JOIN activation_movements m ON m.id=o.movement_id WHERE o.movement_id IN (${marks}) AND m.company IN ('MobiUp','MobiCell') GROUP BY o.import_id,o.movement_id HAVING COUNT(*)>1 LIMIT 1`).get(...ids);
  let uncertain=!!duplicate||commercial.some(r=>r.conflict||!r.movement_date||![1,-1].includes(r.quantity as number));
  const customer=(r:Movement)=>field(r,'Denumire Client').normalize('NFKC').trim().toUpperCase();
  const outstanding:Movement[]=[];
  for(const row of commercial){
   if(row.quantity===1)outstanding.push(row);
   if(row.quantity===-1){const key=customer(row),matches=outstanding.filter(s=>s.company===row.company&&s.item_code===row.item_code&&!!key&&customer(s)===key&&!!s.movement_date&&!!row.movement_date&&s.movement_date<row.movement_date);
    if(matches.length===1)outstanding.splice(outstanding.indexOf(matches[0]),1);else uncertain=true;
   }
  }
  if(uncertain||outstanding.length>1)result.status='ambiguous';
  else if(outstanding.length===1){result.status='sold';result.sale=present(outstanding[0]);}
  else result.status=commercial.some(r=>r.quantity===1)?'returned':'recorded';
  return result;
 }finally{db.close();}
}
