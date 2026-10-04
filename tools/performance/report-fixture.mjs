import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
// Add to the semantic fixture (returns, unknown, zero, shared companies).
export function seedReportScale(t,n){
 const c=new DatabaseSync(join(t.root,'client-history/client-sales-history.sqlite'));
 const customer=t.sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)'),identity=c.prepare('INSERT INTO history_identities VALUES(?,?)'),allocation=c.prepare("INSERT INTO history_allocations VALUES(?,'ref','single_partner',?,'[]')"),row=c.prepare("INSERT INTO history_rows VALUES(1,?,?, 'synthetic-site',?,?,1000000,'Synthetic seller','x','Synthetic item',?)");
 c.exec('CREATE UNIQUE INDEX history_identity_key ON history_identities(id); CREATE UNIQUE INDEX history_import_key ON history_imports(id); CREATE UNIQUE INDEX history_allocation_key ON history_allocations(identity_id,reference_id); CREATE INDEX history_rows_identity_date ON history_rows(identity_id,date,import_id); CREATE INDEX history_rows_date ON history_rows(date,import_id); CREATE INDEX history_allocations_reference ON history_allocations(reference_id,identity_id);');
 t.sql.exec('BEGIN');c.exec('BEGIN');
 for(let i=0;i<n;i++){
  const id='scale-'+String(i).padStart(5,'0'),cui=String(1000000+i),owner=i%10?'g-3':'g-5';
  customer.run(id,owner,JSON.stringify({id,cui,warehouseId:owner,warehouseIds:[owner],name:'Synthetic Știință '+id,city:'Oraș sintetic',county:i%2?'Iași':'RO-IS',address:'Synthetic address',route:i%2?'1, 11':'11, 1',notes:'Synthetic unused CRM field '.repeat(40)}));identity.run(30000+i,cui);allocation.run(30000+i,JSON.stringify([id]));
  for(const [day,date] of ['2026-05-01','2026-06-05','2026-07-05','2026-08-01','2026-08-20','2026-09-05','2026-09-28'].entries())row.run(30000+i,date,'document-'+day,1000+i,day);
 }
 c.exec("UPDATE history_imports SET sha256='synthetic-scale',row_count=(SELECT COUNT(*) FROM history_rows);COMMIT;");t.sql.exec('COMMIT');const historyRows=c.prepare('SELECT COUNT(*) n FROM history_rows').get().n;c.close();
 console.log('LAB: synthetic source seeded; building activity snapshot');
 t.module.buildActivitySnapshot(t.root,'2026-09-30');
 console.log('LAB: snapshot ready');
 return {customers:t.sql.prepare('SELECT COUNT(*) n FROM customers').get().n,addedCompanies:n,historyRows};
}
