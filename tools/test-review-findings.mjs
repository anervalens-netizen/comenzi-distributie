import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clientSalesTestRuntime} from './client-sales-test-runtime.mjs';
const t=await clientSalesTestRuntime();
try {
 const {sql,module:m}=t;
 sql.exec(readFileSync('drizzle/0011_partner_visit_follow_up.sql','utf8'));
 const insert=sql.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)');
 const visit=sql.prepare("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at,follow_up_date,next_step) VALUES(?,?,?,'Synthetic','2026-01-01T12:00:00Z','','2026-01-01T12:00:00Z','2020-01-01','Synthetic follow-up')");
 for(let i=0;i<51;i++) {const id='review-'+String(i).padStart(3,'0'),other=i===50;insert.run(id,other?'g-3':'g-5',JSON.stringify({id,name:'ReviewSynthetic '+i,warehouseIds:[other?'g-3':'g-5']}));visit.run('v-'+id,id,other?'other':'agent');}
 for(const [role,total] of [['agent',50],['manager',51]]) {
  const seen=[];let cursor=null;
  do {const page=await m.duePartnerFollowUps(t.user(role),new URLSearchParams(cursor?{cursor}:{}));assert.ok(page.followUps.length<=20);seen.push(...page.followUps);cursor=page.nextCursor;}while(cursor!==null);
  assert.equal(seen.length,total);assert.equal(new Set(seen.map(row=>row.visitId)).size,total);
 }
 await assert.rejects(()=>m.duePartnerFollowUps(t.user('agent'),new URLSearchParams({cursor:'[]'})),e=>e.status===400);
 const first=await m.duePartnerFollowUps(t.user('agent'));
 assert.equal(first.followUps.length,20);
 // Retire a row before the boundary while another user is paging.
 sql.exec("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) VALUES('new-review-000','review-000','agent','Synthetic','2026-02-01T12:00:00Z','','2026-02-01T12:00:00Z')");
 const remaining=[];let after=first.nextCursor;
 while(after){const page=await m.duePartnerFollowUps(t.user('agent'),new URLSearchParams({cursor:after}));remaining.push(...page.followUps);after=page.nextCursor;}
 assert.equal(remaining.length,30);assert.equal(remaining[0].customerId,'review-020');
 assert.equal(new Set([...first.followUps,...remaining].map(row=>row.visitId)).size,50);
 const adapter=globalThis.__clientSalesDb,prepare=adapter.prepare;let changed=false;
 adapter.prepare=function(query){const stmt=prepare(query);if(query.startsWith('SELECT m.summary FROM')){const all=stmt.all;stmt.all=async function(){const result=await all.call(this);if(!changed){changed=true;sql.exec("UPDATE customers SET data=json_set(data,'$.name','ReviewSynthetic changed') WHERE id='review-000'");}return result;};}return stmt;};
 const page=await m.pagedBrowse(t.user('agent'),new URLSearchParams({q:'ReviewSynthetic'}),undefined,0,20);
 assert.ok(changed);assert.equal(page.total,50);assert.ok(page.revision);
 adapter.prepare=prepare;
 sql.exec("UPDATE customers SET data=json_set(data,'$.name','ReviewSynthetic again') WHERE id='review-000'");
 await assert.rejects(()=>m.pagedBrowse(t.user('agent'),new URLSearchParams({q:'ReviewSynthetic',revision:page.revision}),undefined,20,20),e=>e.status===409);
 console.log('PASS: follow-up pagination preserves scope and completeness; first-page mutation retries; explicit stale revision remains rejected.');
} finally {t.cleanup();}
