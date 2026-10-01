// Wholly synthetic fixture shared by monthly tests. Never load external resources.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
export function createClientSalesFixture(root,existingApp=false){
  mkdirSync(join(root,'client-history'),{recursive:true});
  const app=new DatabaseSync(join(root,'mobiup.sqlite'));
  if(!existingApp)app.exec('CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER)');
  const partners=[];
  const add=(id,cui,warehouses=['g-5'])=>{const p={id,name:'Client sintetic '+id,cui,city:'Oraș test',county:'Județ test',address:'Adresă sintetică',warehouseId:warehouses[0],warehouseIds:warehouses,route:'',latitude:null,longitude:null,positionSource:'',positionQuality:'',lastVisitedAt:null};partners.push(p);app.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,warehouses[0],JSON.stringify(p));};
  add('monthly-a','100');add('monthly-sibling','RO100',['g-3','g-5']);add('monthly-repeat','200');add('monthly-waiting','300');add('monthly-overdue','400');add('monthly-return','500');add('monthly-unlinked','600');add('monthly-hidden','700',['g-3']);add('monthly-unknown','800');add('monthly-reactivated','900');add('monthly-three','1000');add('monthly-same-day','1100');
  for(let i=0;i<55;i++)add('monthly-page-'+String(i).padStart(2,'0'),String(2000+i));
  app.close();
  const c=new DatabaseSync(join(root,'client-history','client-sales-history.sqlite'));
  c.exec(`CREATE TABLE history_meta(key TEXT,value TEXT); INSERT INTO history_meta VALUES('current_reference','ref');
    CREATE TABLE history_imports(id INTEGER,sha256 TEXT,state TEXT,period_start TEXT,period_end TEXT,row_count INTEGER,imported_at TEXT);
    INSERT INTO history_imports VALUES(1,'synthetic-hash','active','2025-01-01','2026-09-30',1,'2026-09-29T09:00:00Z');
    CREATE TABLE history_references(id TEXT,master_json TEXT); INSERT INTO history_references VALUES('ref','[{"CIF":"100","PartnerCode":"alias"}]');
    CREATE TABLE history_identities(id INTEGER,client_code TEXT);
    CREATE TABLE history_allocations(identity_id INTEGER,reference_id TEXT,status TEXT,partner_ids_json TEXT,candidates_json TEXT);
    CREATE TABLE history_rows(import_id INTEGER,identity_id INTEGER,date TEXT,site_id TEXT,document_number TEXT,value_cents INTEGER,quantity_micros INTEGER,tr TEXT,item_code TEXT,item_name TEXT,source_row INTEGER);
  `);
  const identities=new Map();let serial=0;
  for(const p of partners){if(['monthly-unlinked','monthly-sibling'].includes(p.id))continue;const id=++serial;identities.set(p.id,id);c.prepare('INSERT INTO history_identities VALUES(?,?)').run(id,p.cui);c.prepare("INSERT INTO history_allocations VALUES(?,'ref','direct_code',?,'[]')").run(id,JSON.stringify([p.id,p.id]));}
  const alias=++serial;c.prepare("INSERT INTO history_identities VALUES(?,'alias')").run(alias);c.prepare("INSERT INTO history_allocations VALUES(?,'ref','reconcile','[]','[]')").run(alias);
  let line=0;
  function bill(id,date,value=1000,doc='bill-'+(++line),quantity=1000000){c.prepare("INSERT INTO history_rows VALUES(1,?,?, 'shared-site',?,?,?,'Vânzător sursă sintetic','item','Produs sintetic',?)").run(typeof id==='number'?id:identities.get(id),date,doc,value,quantity,line);}
  bill('monthly-a','2026-08-05',5000);bill('monthly-a','2026-09-10',1000,'joint');bill(alias,'2026-09-10',2000,'joint');
  bill('monthly-a','2026-09-11',500,'cancel');bill('monthly-a','2026-09-11',-500,'cancel',-1000000);
  bill('monthly-a','2026-09-12',0,'free');bill('monthly-a','2026-09-13',500,'');bill('monthly-a','2026-09-14',-300,'return',-1000000);
  bill('monthly-repeat','2026-09-01');bill('monthly-repeat','2026-09-03');
  bill('monthly-waiting','2026-09-25');bill('monthly-overdue','2026-08-20');
  bill('monthly-return','2026-08-04',1000);bill('monthly-return','2026-09-15',-1000,'return',-1000000);
  bill('monthly-hidden','2026-09-28',900000);bill('monthly-unknown','2026-09-02',null,'missing');
  bill('monthly-reactivated','2026-04-01');bill('monthly-reactivated','2026-09-26');bill('monthly-three','2026-06-10');
  bill('monthly-same-day','2026-09-05',1000,'one');bill('monthly-same-day','2026-09-05',1000,'two');
  for(let i=0;i<55;i++)bill('monthly-page-'+String(i).padStart(2,'0'),'2026-09-20',10000+i);
  c.prepare('UPDATE history_imports SET row_count=(SELECT COUNT(*) FROM history_rows)').run();
  c.close();return {partners};
}
