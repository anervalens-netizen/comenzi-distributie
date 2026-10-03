import type {DatabaseSync} from 'node:sqlite';
import type {CompanyLinks} from './partner-company-links';

/** Batch-only raw scan, using the same immutable legal-identity decisions as company totals. */
export function buildRevenueReconciliation(source:DatabaseSync,out:DatabaseSync,reference:string,index:CompanyLinks){
  out.exec(`CREATE TABLE revenue_daily(date TEXT NOT NULL,identity_id INTEGER NOT NULL,category TEXT NOT NULL,company_id TEXT,client_code TEXT NOT NULL,reason TEXT NOT NULL,value_cents INTEGER,missing_values INTEGER NOT NULL,row_count INTEGER NOT NULL,PRIMARY KEY(date,identity_id));`);
  const unresolved=new Map(index.unresolved.map(r=>[r.identityId,r.reason]));
  const insert=out.prepare('INSERT INTO revenue_daily VALUES(?,?,?,?,?,?,?,?,?)');
  for(const r of source.prepare(`SELECT r.date,r.identity_id,i.client_code,a.status,SUM(r.value_cents) cents,SUM(r.value_cents IS NULL) missing,COUNT(*) rows FROM history_rows r JOIN history_imports b ON b.id=r.import_id AND b.state='active' JOIN history_identities i ON i.id=r.identity_id LEFT JOIN history_allocations a ON a.identity_id=r.identity_id AND a.reference_id=? GROUP BY r.date,r.identity_id`).iterate(reference)){
    const id=Number(r.identity_id),company=index.links[String(id)]||null,category=r.status==='consumer'?'consumer':company?'company':'identity';
    insert.run(r.date,id,category,company,String(r.client_code||''),category==='identity'?unresolved.get(id)||'No reliable company association':'',r.cents,r.missing,r.rows);
  }
}
