// Wholly synthetic immutable-reference identity evidence. No production files.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
const t=await clientSalesTestRuntime(),{root,partners,module:m}=t;
try{
 const file=join(root,'client-history/client-sales-history.sqlite');
 const c=new DatabaseSync(file);
 c.exec("ALTER TABLE history_references ADD COLUMN partners_json TEXT; ALTER TABLE history_allocations ADD COLUMN reason TEXT NOT NULL DEFAULT ''; ALTER TABLE history_identities ADD COLUMN franchise_code TEXT NOT NULL DEFAULT '';");
 c.prepare('UPDATE history_references SET partners_json=?').run(JSON.stringify({partners:partners.map(p=>({...p,historyFranchises:[p.id==='monthly-a'?'exact-franchise':'franchise-'+p.id]}))}));
 const identity=c.prepare('INSERT INTO history_identities VALUES(?,?,?)'),allocation=c.prepare("INSERT INTO history_allocations VALUES(?,'ref',?,?,?,?)"),row=c.prepare("INSERT INTO history_rows VALUES(1,?,'2026-09-27','site',?, ?,1000000,'Synthetic seller','x','Synthetic item',?)");
 const samples=[
  [31001,'','exact-franchise','direct_code',[],[],1234,'Explicit franchise code'],
  [31002,'NOT-A-MASTER-ALIAS','','single_partner',['monthly-a'],[],2345,'Unique identified Partner'],
  [31003,'','', 'reconcile',[],['monthly-a'],99000,'Unresolved address'],
  [31004,'200','exact-franchise','direct_code',['monthly-a'],[],88000,'Explicit franchise code'],
  [31005,'','', 'single_partner',['monthly-a','monthly-repeat'],[],77000,'Ambiguous contradictory reference'],
 ];
 for(const [id,code,franchise,status,ids,candidates,value,reason] of samples){identity.run(id,code,franchise);allocation.run(id,status,JSON.stringify(ids),JSON.stringify(candidates),reason);row.run(id,'DOC-'+id,value,id);}
 c.close();
 const source=m.openCompanyLinkSource(file);const links=m.historyCompanyLinks(source,'ref');source.close();
 assert.equal(links.links['31001'],'100','blank client code resolves through one immutable franchise owner');
 assert.equal(links.links['31002'],'100','non-master alias resolves through its allocated immutable point');
 for(const id of ['31003','31004','31005'])assert.equal(links.links[id],undefined,'unresolved, conflicting or multiple-company evidence must remain excluded: '+id);
 assert(links.incomplete.has('100')&&links.incomplete.has('200'),'conflicting evidence remains explicit for every implicated company');
 // Isolate valid points for public monthly/detail parity. The above conflicts were
 // proven independently; they must not mask the positive resolved-point contract.
 const edit=new DatabaseSync(file);edit.exec('DELETE FROM history_rows WHERE identity_id>=31003;DELETE FROM history_allocations WHERE identity_id>=31003;DELETE FROM history_identities WHERE id>=31003');edit.close();
 m.buildActivitySnapshot(root,'2026-09-30');
 const monthly=await m.readClientSalesAsync(partners,'2026-09',root,'2026-09-30');assert.equal(monthly.state,'ready');
 const company=monthly.rows.find(r=>r.key==='company:100');assert(company?.identityComplete&&company?.linked);assert.equal(company.metrics.valueCents,3200+1234+2345);
 const detail=await m.readPartnerSalesAsync('monthly-a','100',new URLSearchParams('scope=company&from=2026-09-01&to=2026-09-30'),root);assert.equal(detail.state,'ready');assert.equal(detail.totals.valueCents,company.metrics.valueCents);
 const auto=await m.readPartnerSalesAsync('monthly-a','100',new URLSearchParams('from=2026-09-01&to=2026-09-30'),root);assert.equal(auto.state,'ready');assert.equal(auto.totals.valueCents,company.metrics.valueCents);
 console.log('PASS: resolved immutable point/franchise ownership without aliases; reconcile/mismatch/multi-company exclusions; monthly and explicit/automatic detail parity.');
}finally{t.cleanup();}
