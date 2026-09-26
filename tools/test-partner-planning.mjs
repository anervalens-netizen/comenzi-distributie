import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
const db=new DatabaseSync('work/qa/mobiup.sqlite'),root='http://127.0.0.1:3000/api/partner/planning',sessions={};
for(const id of ['qa-agent1','qa-agent2','qa-manager']){const token=randomUUID();db.prepare('UPDATE users SET active=1,must_change_password=0 WHERE id=?').run(id);db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);sessions[id]=token;}
let checks=0;
async function call(user,method='GET',body,expected=200,week='2026-10-19'){
const r=await fetch(root+(method==='GET'?'?week='+week:''),{method,headers:{Cookie:'mobiup_session='+sessions[user],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const d=await r.json();assert.equal(r.status,expected,JSON.stringify(d));checks++;return d;
}
try {
 db.prepare("DELETE FROM partner_day_plans WHERE agent_id IN ('qa-agent1','qa-agent2')").run();
 const p={date:'2026-10-19',stops:['ph-one','ph-shared'],revision:0};
 await call('qa-agent1','PUT',{...p,stops:['ph-other']},409);
 await call('qa-agent1','PUT',{...p,stops:['ph-one','ph-one']},400);
 await call('qa-agent1','PUT',{...p,date:'2026-02-30'},400);
 await call('qa-agent1','PUT',{...p,date:'2026-10-25'},400);
 await call('qa-manager','GET',null,403);
 await call('qa-agent1','PUT',p);
 await call('qa-agent1','PUT',p,409);
 const first=await call('qa-agent1');assert.deepEqual(first.plans[0].stops,p.stops);
 assert.equal((await call('qa-agent2')).plans.length,0);
 await call('qa-agent2','PUT',{...p,stops:['ph-shared']});
 await call('qa-agent1','PUT',{...p,revision:1,stops:['ph-shared','ph-one']});
 await call('qa-agent1','PUT',{...p,revision:1},409);
 assert.deepEqual((await call('qa-agent1')).plans[0].stops,['ph-shared','ph-one']);
 const add=db.prepare("INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) VALUES(?,?,?,'QA',?,'',?)");
 const ids=[];
 for(const [cust,agent,t] of [['ph-shared','qa-agent1','2026-10-25T21:59:00.000Z'],['ph-shared','qa-agent1','2026-10-25T22:01:00.000Z'],['ph-shared','qa-agent2','2026-10-24T12:00:00.000Z'],['ph-other','qa-agent1','2026-10-24T12:00:00.000Z']]){const id=randomUUID();ids.push(id);add.run(id,cust,agent,t,t)}
 const visits=(await call('qa-agent1')).visits;assert(visits.some(v=>v.id===ids[0]&&v.date==='2026-10-25'));assert(!visits.some(v=>ids.slice(1).includes(v.id)));
 db.prepare("UPDATE customers SET active=0 WHERE id='ph-one'").run();
 assert.deepEqual((await call('qa-agent1')).plans[0].stops,['ph-shared']);
 await call('qa-agent1','PUT',{...p,revision:2},409);
 db.prepare("UPDATE customers SET active=1 WHERE id='ph-one'").run();
 await call('qa-agent1','PUT',{...p,revision:2,stops:[]});
 assert.equal((await call('qa-agent1')).plans[0].stops.length,0);
 for(const id of ids)db.prepare('DELETE FROM partner_visits WHERE id=?').run(id);
 console.log('PASS: '+checks+' planning HTTP checks; CAS,scope,shared points,ordering,dates,DST,actual visits and empty plans.');
}finally{for(const token of Object.values(sessions))db.prepare('DELETE FROM sessions WHERE token_hash=?').run(createHash('sha256').update(token).digest('hex'));db.close();}
