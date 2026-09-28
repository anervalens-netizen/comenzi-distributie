import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';

const db=new DatabaseSync('work/qa/mobiup.sqlite');
const base='http://127.0.0.1:3000/api';
const ids=['mui-global','mui-region-a','mui-region-b','mui-agent-a','mui-agent-b'];
const cookies={},requests=[];
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const sha=value=>createHash('sha256').update(value).digest('hex');
async function call(path,user='mui-global',expected=200){
  const result=await fetch(`${base}/${path}`,{headers:{Cookie:cookies[user]||''}});
  const value=await result.json();assert.equal(result.status,expected,`${path}: ${JSON.stringify(value).slice(0,250)}`);checks++;return value;
}
try {
  for(const id of ids){
    const agent=id.includes('agent'),global=id==='mui-global',warehouse=agent?id.endsWith('-a')?'mui-warehouse-a':'mui-warehouse-b':null;
    db.prepare('INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,password_hash,active,must_change_password) VALUES(?,?,?,?,?,?,?,1,0)').run(id,id,`Synthetic ${id}`,agent?'agent':'manager',global?'global':'assigned',warehouse,'unused-synthetic-hash');
    const token=randomUUID();db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token),id,Date.now()+3600000);cookies[id]=`mobiup_session=${token}`;
  }
  db.prepare('INSERT INTO manager_agents(manager_id,agent_id) VALUES(?,?)').run('mui-region-a','mui-agent-a');
  db.prepare('INSERT INTO manager_agents(manager_id,agent_id) VALUES(?,?)').run('mui-region-b','mui-agent-b');
  for(const [id,warehouse,warehouses,located] of [['mui-only-a','mui-warehouse-a',['mui-warehouse-a'],true],['mui-only-b','mui-warehouse-b',['mui-warehouse-b'],true],['mui-shared','mui-warehouse-a',['mui-warehouse-a','mui-warehouse-b'],true],['mui-missing','mui-warehouse-a',['mui-warehouse-a'],false]]){
    const point={id,name:'Synthetic test store',cui:'SYNTHETIC-SAME-CUI',warehouseId:warehouse,warehouseIds:warehouses,address:'Synthetic street 1',city:'Synthetic city',county:'Synthetic county',route:''};
    db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,warehouse,JSON.stringify(point));
    if(located)db.prepare("INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,address_fingerprint,revision,updated_at) VALUES(?,44.4,26.1,'manual',?,1,?)").run(id,sha(JSON.stringify([point.address,point.city,point.county])),'2026-01-05T10:00:00Z');
  }
  const request=(agent,status,customer,created,confirmed)=>{
    const id=randomUUID();requests.push(id);
    const payload={company:'Synthetic request',location:'Synthetic city',cui:'SYNTHETIC-SAME-CUI',storeType:'Synthetic',contact:'Synthetic Contact',phone:'0700000000',email:'test@example.invalid',address:'Synthetic street 1',county:'Synthetic county'};
    db.prepare('INSERT INTO partner_requests(id,agent_id,warehouse_id,cui_key,status,payload,created_at,updated_at,confirmed_at,customer_id,revision) VALUES(?,?,?,?,?,?,?,?,?,?,1)').run(id,agent,agent.endsWith('-a')?'mui-warehouse-a':'mui-warehouse-b','SYNTHETIC-SAME-CUI',status,JSON.stringify(payload),created,confirmed||created,confirmed,customer);
    return id;
  };
  const oldPending=request('mui-agent-a','requested',null,'2025-12-01T10:00:00Z',null);
  const otherPending=request('mui-agent-b','requested',null,'2025-12-02T10:00:00Z',null);
  request('mui-agent-a','confirmed','mui-shared','2025-12-05T10:00:00Z','2026-01-05T10:00:00Z');
  request('mui-agent-b','confirmed','mui-shared','2025-12-06T10:00:00Z','2026-01-06T10:00:00Z');
  for(const [id,finalizedAt] of [['mui-inventory-jan','2026-01-05T10:00:00Z'],['mui-inventory-feb','2026-02-05T10:00:00Z']])db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(`inventory-v1:${id}`,JSON.stringify({id,createdBy:'mui-agent-a',warehouseId:'mui-warehouse-a',scopeLabel:'Synthetic',status:'finalized',createdAt:'2025-12-01T10:00:00Z',finalizedAt,lines:[]}));

  const global=await call('partner/browse?q=mui-');
  check(global.total===4,'Global scope counts distinct locations, not CUI or memberships');
  check(global.located===3&&global.partners.some(point=>point.id==='mui-missing'),'Unlocated points remain in list');
  const a=await call('partner/browse?q=mui-&agentId=mui-agent-a');
  check(a.total===3&&!a.partners.some(point=>point.id==='mui-only-b'),'Global agent filter narrows portfolio');
  const region=await call('partner/browse?q=mui-&managerId=mui-region-a');
  check(region.total===3,'Global region filter narrows portfolio without duplicates');
  const exact=await call('partner/browse?q=mui-only-a&agentId=mui-agent-a');
  check(exact.total===1&&exact.partners[0].id==='mui-only-a','Search matches point-of-sale code');
  const scoped=await call('partner/browse?q=mui-','mui-region-a');
  check(scoped.total===3,'Regional default remains authoritative');
  await call('partner/browse?agentId=mui-agent-b','mui-region-a',404);
  await call('partner/map?managerId=mui-region-b','mui-region-a',404);
  await call('partner/map?managerId=mui-region-a&agentId=mui-agent-b','mui-global',404);
  await call('partner/browse?agentId=mui-agent-a','mui-agent-a',403);
  await call('partner/portfolio/mui-only-b','mui-region-a',404);
  const map=await call('partner/map?q=mui-&agentId=mui-agent-a&bbox=20,40,30,50');
  check(map.features.length===2&&!map.features.some(point=>point.id==='mui-only-b'),'Map and list use same scoped distinct locations');
  const empty=await call('partner/browse?q=mui-&county=nonexistent&agentId=mui-agent-a');
  check(empty.total===0,'Combined locality/county and agent filters intersect');
  const globalActivity=await call('manager/activity?month=2026-01');
  check(globalActivity.activity.partnerRequests.some(item=>item.id===oldPending),'Pending requests include previous months');
  check(globalActivity.confirmedByAgent['mui-agent-a']===1&&globalActivity.confirmedByAgent['mui-agent-b']===1,'Confirmation event is attributed to actual confirmation month');
  const scopedActivity=await call('manager/activity?month=2026-01&managerId=mui-region-a');
  check(scopedActivity.pending===1&&scopedActivity.confirmed===1,'Regional pending all-time and monthly confirmed location KPIs');
  check(scopedActivity.activity.totals.finalizedInventories===1,'Inventory KPI uses finalizedAt, not createdAt');
  check(scopedActivity.activity.agents.length===1&&!scopedActivity.activity.partnerRequests.some(item=>item.id===otherPending),'Summary and requests exclude other regions');
  const onlyA=await call('manager/activity?month=2026-01&agentId=mui-agent-a','mui-region-a');
  check(onlyA.pendingByAgent['mui-agent-a']===1,'Regional agent selection works');
  await call('manager/activity?month=2026-01&agentId=mui-agent-b','mui-region-a',404);
  await call('manager/activity?month=2026-01','mui-agent-a',403);
  await call('manager/activity?month=2026-99','mui-global',400);
  await call('manager/activity?month=2026-01','anonymous',401);
  await call('sales?month=2026-01&agentId=mui-agent-b','mui-region-a',404);
  const bothRegion='mui-both';
  db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,active,must_change_password) VALUES(?,?,?,'manager','assigned','unused-synthetic-hash',1,0)").run(bothRegion,bothRegion,'Synthetic combined region');ids.push(bothRegion);
  for(const agent of ['mui-agent-a','mui-agent-b'])db.prepare('INSERT INTO manager_agents(manager_id,agent_id) VALUES(?,?)').run(bothRegion,agent);
  const combined=await call('manager/activity?month=2026-01&managerId=mui-both');
  check(combined.confirmed===1&&combined.pending===2,'Shared confirmed location is counted once across agents');
  console.log(`PASS: ${checks} manager workspace scope, location and KPI checks.`);
} finally {
  for(const id of requests)db.prepare('DELETE FROM partner_requests WHERE id=?').run(id);
  for(const id of ['mui-only-a','mui-only-b','mui-shared','mui-missing']){db.prepare('DELETE FROM partner_profiles WHERE customer_id=?').run(id);db.prepare('DELETE FROM customers WHERE id=?').run(id);}
  for(const id of ['mui-inventory-jan','mui-inventory-feb'])db.prepare('DELETE FROM settings WHERE key=?').run(`inventory-v1:${id}`);
  for(const id of ids){db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);db.prepare('DELETE FROM manager_agents WHERE manager_id=? OR agent_id=?').run(id,id);}
  for(const id of ids)db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.close();
}
