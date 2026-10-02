import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {copyFileSync,renameSync} from 'node:fs';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
const t=await clientSalesTestRuntime(),{root,sql,partners,module:m,call}=t;
const history=join(root,'client-history/client-sales-history.sqlite'),snapshot=join(root,'client-history/partner-activity.sqlite');
const get=(result,id)=>result.rows.find(r=>r.id===id);
try{
 const c=new DatabaseSync(history);
 c.exec("ALTER TABLE history_references ADD COLUMN partners_json TEXT; ALTER TABLE history_allocations ADD COLUMN reason TEXT NOT NULL DEFAULT ''; ALTER TABLE history_identities ADD COLUMN franchise_code TEXT NOT NULL DEFAULT '';");
 c.prepare('UPDATE history_references SET partners_json=?').run(JSON.stringify({partners,historySourceIdentities:[{client_code:'400',franchise_code:'wrong-franchise'}]}));
 c.exec(`INSERT INTO history_identities VALUES(20000,'400','wrong-franchise'),(20001,'100',''),(20002,'77777','');
 INSERT INTO history_allocations VALUES(20000,'ref','reconcile','[]','["monthly-repeat"]','Franchise/client mismatch'),(20001,'ref','reconcile','[]','["monthly-a","monthly-sibling"]','Multiple or incomplete known work-point addresses'),(20002,'ref','reconcile','[]','[]','Client absent from Partners');
 INSERT INTO history_rows VALUES(1,20000,'2026-09-27','site','disputed',900000,1000000,'Synthetic seller','x','Synthetic item',20000),(1,20001,'2026-09-10','shared-site','joint',700,1000000,'Synthetic seller','x','Synthetic item',20001),(1,20002,'2026-08-20','site','historic',3210,1000000,'Synthetic seller','x','Synthetic item',20002);
 UPDATE history_imports SET sha256='conflict-fixture';`);
 c.close();m.buildActivitySnapshot(root,'2026-09-30');
 // Eligible, fresh partial month: an undisputed control really would be overdue.
 const control=m.readClientSales(partners,'2026-09',root,'2026-09-30');
 const conflict=get(control,'monthly-overdue');assert.equal(conflict.identityComplete,false);assert.equal(conflict.metrics.valueCents,null,'disputed-only period is unknown, not a proven zero');assert.equal(conflict.metrics.documents,null);assert.equal(conflict.health.status,'uncertain');assert(!conflict.flags.includes('overdue'));assert(!conflict.flags.includes('new'));assert(!conflict.flags.includes('unbilled'));
 assert.equal(get(control,'monthly-repeat').identityComplete,false,'the other candidate firm is incomplete too');
 assert.equal(get(control,'monthly-a').identityComplete,true,'same-company multi-point uncertainty is safe');assert.equal(get(control,'monthly-a').metrics.valueCents,3900);assert.equal(get(control,'monthly-a').metrics.documents,1,'one document across aliases/points');
 const old=m.readActivitySnapshot(partners,root,'2026-09-30',{period:'year:2026',scope:'company'});assert.equal(old.rows.get('monthly-overdue').coverageComplete,false);assert.equal(old.rows.get('monthly-overdue').activity.isNew,false);assert.equal(old.metrics.get('monthly-overdue').valueCents,1000,'only undisputed August history');
 const detail=m.readPartnerSales('monthly-overdue','400',new URLSearchParams('scope=company&from=2026-09-01&to=2026-09-30'),root);assert.equal(detail.state,'ready');assert.equal(detail.coverageComplete,false);assert.equal(detail.unresolvedCompanyIdentities,1);assert.equal(detail.documents.count,0);assert.equal(detail.activity.isNew,false);
 assert.equal(m.readPartnerSales('monthly-a','100',new URLSearchParams('scope=company&from=2026-09-01&to=2026-09-30'),root).totals.valueCents,3900);
 const linkHits=m.companyLinkCacheStats.hits,linkBuilds=m.companyLinkCacheStats.builds;
 m.readPartnerSales('monthly-a','100',new URLSearchParams('scope=company'),root);
 m.readPartnerSales('monthly-repeat','200',new URLSearchParams('scope=company'),root);
 assert.equal(m.companyLinkCacheStats.builds,linkBuilds,'detail reuses an immutable index rather than rebuilding the national reference');assert(m.companyLinkCacheStats.hits>=linkHits+2);
 const derived=new DatabaseSync(snapshot,{readOnly:true});assert.equal(derived.prepare('SELECT COUNT(*) n FROM company_unresolved').get().n,1);derived.close();
 // Addition, edit, merge and split without rebuilding historical facts.
 const historic={...partners[0],id:'historic-card',cui:'77777',name:'Synthetic historic'};
 sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(historic.id,'g-5',JSON.stringify(historic));
 let result=await call('q=Synthetic+historic');assert.equal(result.state,'ready');assert.equal(result.rows[0].previous.valueCents,3210);assert(result.rows[0].linked);
 sql.prepare("UPDATE customers SET data=json_set(data,'$.cui','100') WHERE id=?").run(historic.id);
 result=await call('q=Synthetic+historic');assert.equal(result.rows[0].key,'company:100');assert.equal(result.rows[0].pointCount,3);assert.equal(result.rows[0].metrics.valueCents,3900);
 sql.prepare("UPDATE customers SET data=json_set(data,'$.cui','77777') WHERE id=?").run(historic.id);
 assert.equal((await call('q=Synthetic+historic')).rows[0].previous.valueCents,3210);
 sql.prepare("UPDATE customers SET data=json_set(data,'$.cui','no-known-history') WHERE id=?").run(historic.id);
 result=await call('q=Synthetic+historic');assert.equal(result.rows[0].linked,false);assert.equal(result.rows[0].metrics.documents,null);
 // API equivalence, defensive copies, current portfolio/actor and fresh visits.
 const first=await call(),again=await call();assert.deepEqual(again,first);first.rows[0].flags.push('visited');first.rows[0].metrics.valueCents=-999;assert.deepEqual(await call(),again);
 const raw=await m.readClientSalesAsync(partners,'2026-09',root,'2026-09-30');raw.rows[0].points[0].name='mutated';raw.source.coverage[0].start='mutated';raw.comparisonMetrics.values().next().value[0].documents=999;
 assert.deepEqual(await m.readClientSalesAsync(partners,'2026-09',root,'2026-09-30'),m.readClientSales(partners,'2026-09',root,'2026-09-30'));
 sql.prepare("INSERT INTO partner_day_plans VALUES('agent','2026-09-30',?,1,'2026-09-30T10:00:00Z')").run(JSON.stringify(['monthly-waiting']));
 assert.equal((await call()).totals.visits,0,'plans are not performed visits');
 const visit=sql.prepare("INSERT INTO partner_visits VALUES(?,?,?,'Synthetic agent',?,'',?)");
 for(const [id,actor,date] of [['v1','agent','2026-09-30T10:00:00.000Z'],['v2','other','2026-09-20T10:00:00.000Z'],['future','agent','2026-09-30T13:00:00.000Z'],['boundary','agent','2026-08-31T20:59:59.000Z']])visit.run(id,'monthly-a',actor,date,date);
 result=await call('filter=visited');assert.equal(result.totals.visits,1);assert.equal(result.comparisons[0].visits,1);assert.equal(result.rows[0].visits,1);assert.equal((await call('filter=visited','manager')).totals.visits,2);
 const national=await call('','manager'),agent=await call();assert.equal(national.totals.valueCents-agent.totals.valueCents,900000);assert(!JSON.stringify(agent).includes('monthly-hidden'));
 sql.prepare("UPDATE customers SET warehouse_id='g-3',data=json_set(data,'$.warehouseIds',json('[\"g-3\"]')) WHERE id IN ('monthly-a','monthly-sibling')").run();
 result=await call('filter=visited');assert.equal(result.totals.visits,0);assert.equal(result.total,0);assert.equal((await call('q=monthly-a')).total,0);
 const second=await call('page=1');assert.equal(second.page,1);assert.deepEqual(second.totals,(await call()).totals);
 const racing=call();await new Promise(resolve=>setImmediate(resolve));sql.prepare("UPDATE customers SET active=0 WHERE id='monthly-waiting'").run();await assert.rejects(racing,e=>e.status===503,'revision fence rejects a mixed ACL generation');
 assert.equal((await call('q=monthly-waiting')).total,0);sql.prepare("UPDATE customers SET active=1 WHERE id='monthly-waiting'").run();
 // Day one defaults to reporting month, but accepts current calendar month.
 for(const [instant,current,defaultMonth,future] of [['2026-09-30T21:00:00Z','2026-10','2026-09','2026-11'],['2026-12-31T22:00:00Z','2027-01','2026-12','2027-02'],['2026-03-31T21:00:00Z','2026-04','2026-03','2026-05']]){
  const date=new Date(instant);assert.equal(m.clientSalesParams(new URLSearchParams(),date).month,defaultMonth);assert.equal(m.clientSalesParams(new URLSearchParams({month:current}),date).month,current);assert.throws(()=>m.clientSalesParams(new URLSearchParams({month:future}),date),e=>e.status===400);
 }
 assert.throws(()=>m.clientSalesParams(new URLSearchParams('month=2026-10'),new Date('2026-09-30T20:59:59Z')),e=>e.status===400);
 const missing=await m.clientSalesOverview(t.user('manager'),new URLSearchParams('month=2026-10'),new Date('2026-10-01T10:00:00Z'));assert.equal(missing.window.imported,false);assert.equal(missing.visitRange.to,'2026-10-01','visit range ends at the observed day, not future month end');assert.equal(missing.comparisons[0].valueCents,national.totals.valueCents);assert.equal(missing.counts.absentPrevious,0);
 // Source writes, WAL, same-path replacement, reference edits, atomic derived replacement.
 const edit=new DatabaseSync(history);edit.exec("PRAGMA journal_mode=WAL;UPDATE history_imports SET sha256='reimport'");assert.equal((await call()).state,'unavailable');edit.close();m.buildActivitySnapshot(root,'2026-09-30');assert.equal((await call()).state,'ready');
 const changed=new DatabaseSync(history);changed.exec("UPDATE history_references SET master_json='[]'");changed.close();assert.equal((await call()).state,'unavailable','same reference content change invalidates');m.buildActivitySnapshot(root,'2026-09-30');
 const beforeReplacement=await call();copyFileSync(history,history+'.replacement');const replacement=new DatabaseSync(history+'.replacement');replacement.exec("UPDATE history_imports SET sha256='replacement'");replacement.close();renameSync(history+'.replacement',history);assert.equal((await call()).state,'unavailable');m.buildActivitySnapshot(root,'2026-09-30');assert.deepEqual((await call()).totals,beforeReplacement.totals);
 // Fresh control after removing the disputed identity (not a stale partial month).
 const cleanup=new DatabaseSync(history);cleanup.exec("DELETE FROM history_rows WHERE identity_id=20000;DELETE FROM history_allocations WHERE identity_id=20000;UPDATE history_imports SET sha256='resolved'");cleanup.close();m.buildActivitySnapshot(root,'2026-09-30');assert.equal(get(m.readClientSales(partners,'2026-09',root,'2026-09-30'),'monthly-overdue').health.status,'overdue','fresh eligible control proves the regression gate');
 // The resolver's ambiguous-master reason can describe two addresses of ONE firm.
 const refs=new DatabaseSync(history);
 refs.prepare('UPDATE history_references SET master_json=?').run(JSON.stringify([{CIF:'100',PartnerCode:'alias',Cod_Franciza:'same'},{CIF:'100',Cod_Franciza:'same'}]));
 refs.exec(`INSERT INTO history_identities VALUES(21000,'100','same');INSERT INTO history_allocations VALUES(21000,'ref','reconcile','[]','["same"]','Conflicting master entries for franchise');INSERT INTO history_rows VALUES(1,21000,'2026-09-15','site','same-company',222,1000000,'Synthetic seller','x','Synthetic item',21000);UPDATE history_imports SET sha256='same-company-master';`);refs.close();
 m.buildActivitySnapshot(root,'2026-09-30');let firm=get(m.readClientSales(partners,'2026-09',root,'2026-09-30'),'monthly-a');assert.equal(firm.identityComplete,true);assert.equal(firm.metrics.valueCents,4122);
 const competing=new DatabaseSync(history);competing.prepare('UPDATE history_references SET master_json=?').run(JSON.stringify([{CIF:'100',PartnerCode:'alias',Cod_Franciza:'same'},{CIF:'200',Cod_Franciza:'same'}]));competing.close();m.buildActivitySnapshot(root,'2026-09-30');
 firm=get(m.readClientSales(partners,'2026-09',root,'2026-09-30'),'monthly-a');assert.equal(firm.identityComplete,false);assert.equal(firm.metrics.valueCents,3900,'changing candidate company excludes the disputed amount');assert(firm.flags.includes('billed'),'known undisputed bills still count on explicitly partial firms');assert(!firm.flags.includes('new'));
 // Broken derived data never poisons the single-flight cache; replacement can recover.
 const saved=join(root,'saved-snapshot.sqlite');copyFileSync(snapshot,saved);const invalid=new DatabaseSync(snapshot);invalid.exec("UPDATE meta SET value='{' WHERE key='snapshot'");invalid.close();await assert.rejects(call());renameSync(saved,snapshot);assert.equal((await call()).state,'ready');
 console.log('PASS: C1 conflict/same-company/detail, C2 historic additions/edit/merge/split, cache isolation/reimport/reference/replacement, ACL/actors/live visits, C3 day-one/year/DST rollover and missing month.');
}finally{t.cleanup();}
