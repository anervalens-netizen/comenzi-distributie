import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { partnerPointKey } from '../lib/partner-identity.ts';

// Fixed loopback + fixed synthetic DB: never point this destructive fixture at production.
const origin='http://127.0.0.1:3000';
const db=new DatabaseSync('work/qa/mobiup.sqlite');
const {password}=JSON.parse(readFileSync('../tools/qa/credentials.json','utf8'));
const salt=randomBytes(16).toString('hex');
const hash=`scrypt:${salt}:${scryptSync(password,salt,32,{N:32768,r:8,p:3,maxmem:40*1024*1024}).toString('hex')}`;
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function call(path,method='GET',body,cookie,expected=200){
  const r=await fetch(`${origin}/api/${path}`,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);checks++;
  return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const login=async username=>(await call('auth/login','POST',{username,password})).cookie;
const clients=async(cookie,warehouseId)=>(await call(`clients?warehouseId=${warehouseId}`,'GET',null,cookie)).data.clients;
const importClients=(cookie,warehouseId,rows,expected=200)=>call('admin/import-clients','POST',{warehouseId,clients:rows},cookie,expected);
try {
  for(const [id,role,scope,warehouse] of [['reg-global','manager','global',null],['reg-manager','manager','assigned',null],['reg-a','agent','assigned','g-5'],['reg-b','agent','assigned','g-3'],['reg-race','agent','assigned','g-5']]){
    db.prepare('INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,active) VALUES(?,?,?,?,?,?,?,0,1)').run(id,id,id,role,scope,warehouse,hash);
  }
  db.prepare('INSERT INTO manager_agents(manager_id,agent_id) VALUES(?,?)').run('reg-manager','reg-a');
  db.exec('UPDATE customers SET active=0');
  const manager=await login('reg-global'),regional=await login('reg-manager'),a=await login('reg-a'),b=await login('reg-b');
  await call('admin/manager-mail','PUT',{partner:'regression@example.invalid'},regional);
  const point={name:'REGRESSION POINT',cui:'9900172026',city:'București',county:'București',address:'Strada Test 1-3',route:'1'};
  await importClients(regional,'g-5',[point]);
  const original=(await clients(manager,'g-5'))[0];
  const moved=(await call(`admin/clients/${original.id}`,'PUT',{...original,agentIds:['reg-b']},manager)).data.client;
  await call('clients?warehouseId=g-3','GET',null,regional,404);
  const beforeA=JSON.stringify(await clients(a,'g-5')),beforeB=JSON.stringify(await clients(b,'g-3'));
  await importClients(regional,'g-5',[{...point,cui:'9900172027'},point],409);
  check(JSON.stringify(await clients(a,'g-5'))===beforeA,'Rejected reimport leaves entire source portfolio unchanged');
  check(JSON.stringify(await clients(b,'g-3'))===beforeB,'Rejected reimport cannot seize transferred client');
  check(moved.id===original.id,'Authorized transfer preserves customer identity');

  const distinct=['1-3','13','1/2','12'].map(address=>({...point,cui:'9900172028',address:`Strada Test ${address}`}));
  const imported=await importClients(regional,'g-5',[...distinct,{...distinct[0],city:' BUCURESTI ',county:'bucuresti',address:' Strada  Test 1-3 '}]);
  check(imported.data.count===4,'Significant address separators preserved; whitespace/case/accents still normalized');
  const four=await clients(manager,'g-5');
  await importClients(regional,'g-5',distinct);
  check(JSON.stringify((await clients(a,'g-5')).map(c=>c.id).sort())===JSON.stringify(four.map(c=>c.id).sort()),'Reimport preserves active IDs after normalization change');
  // Force a transfer between preflight and UPSERT inside the same transaction.
  // A NOT NULL guard must roll back the *whole* import, including deactivation.
  const atomicBefore=JSON.stringify(db.prepare('SELECT * FROM customers ORDER BY id').all());
  db.exec(`CREATE TRIGGER force_transfer BEFORE UPDATE OF active ON customers WHEN OLD.id='${four[0].id}' BEGIN UPDATE customers SET warehouse_id='g-3' WHERE id=OLD.id; END`);
  try{await importClients(regional,'g-5',distinct,409);}finally{db.exec('DROP TRIGGER force_transfer');}
  check(JSON.stringify(db.prepare('SELECT * FROM customers ORDER BY id').all())===atomicBefore,'SQL ownership guard rolls back all rows if transfer happens after preflight');
  check(partnerPointKey('București','București','1-3')!==partnerPointKey('Bucuresti','Bucuresti','13'),'Identity helper keeps range distinct');
  await importClients(manager,'g-3',[distinct[0]]);
  check((await clients(b,'g-3'))[0].id!==four.find(c=>c.address===distinct[0].address).id,'Same firm and point can exist in independent portfolios without stealing ownership');

  const sharedSource=four.find(c=>c.address.endsWith('13'));
  const shared=(await call(`admin/clients/${sharedSource.id}`,'PUT',{...sharedSource,agentIds:['reg-a','reg-b']},manager)).data.client;
  check((await clients(a,'g-5')).some(c=>c.id===shared.id)&&(await clients(b,'g-3')).some(c=>c.id===shared.id),'Shared point visible to both agents');
  const regionalEdit=(await call(`admin/clients/${shared.id}`,'PUT',{...shared,sourceWarehouseId:'g-5',agentIds:['reg-a']},regional)).data.client;
  check(regionalEdit.warehouseIds.includes('g-3'),'Regional edit preserves other manager portfolio association');
  await importClients(regional,'g-5',distinct,409);
  check((await clients(b,'g-3')).some(c=>c.id===shared.id),'Legacy replacement import cannot erase shared assignment');
  const notes=await Promise.all([[a,'reg-a','89400000000009170001'],[b,'reg-b','89400000000009170002']].map(async([cookie,agentId,serial])=>{
    let order=(await call('orders','POST',{id:randomUUID(),kind:'sim',agentId},cookie,201)).data.order;
    order=(await call(`orders/${order.id}`,'PUT',{revision:order.revision,items:[],clientId:shared.id,serials:[serial],notes:''},cookie)).data.order;
    return (await call(`orders/${order.id}/finalize`,'POST',{revision:order.revision},cookie)).data.order;
  }));
  check(notes.every(o=>o.status==='finalized')&&new Set(notes.map(o=>o.warehouseId)).size===2,'Both agents finalize shared-client notes in parallel in own warehouses');
  await call(`admin/clients/${shared.id}`,'PUT',{...regionalEdit,agentIds:['reg-b']},manager);
  check(!(await clients(a,'g-5')).some(c=>c.id===shared.id)&&(await clients(b,'g-3')).some(c=>c.id===shared.id),'Ending temporary coverage removes only the selected assignment');
  check((await call(`orders/${notes[0].id}`,'GET',null,a)).data.order.status==='finalized','Historical finalized note survives ending coverage');

  // With address 1-3 present, confirming 13 must create/select 13, never merge with 1-3.
  const partner={requestId:randomUUID(),company:'REG PARTNER',cui:distinct[0].cui,location:point.city,county:point.county,address:'Strada Test 13',storeType:'MAGAZIN',contact:'QA',phone:'0700000000',email:''};
  const request=(await call('partner/mail','POST',partner,a)).data.request;
  const confirmed=(await call(`partner/requests/${request.id}/confirm`,'POST',{revision:request.revision},regional)).data.request;
  check(confirmed.customerId===shared.id&&(await clients(a,'g-5')).find(c=>c.id===confirmed.customerId)?.address===partner.address,'Confirmation chooses 13, not the existing 1-3 locations, and restores shared coverage');

  const casId=randomUUID(),casBase={...partner,requestId:casId,company:'PARTNER CAS INITIAL',cui:'9900172099',address:'Strada CAS 1'};
  const casInitial=(await call('partner/mail','POST',casBase,a)).data.request;
  const casA=(await call('partner/mail','POST',{...casBase,revision:casInitial.revision,company:'PARTNER CAS EDIT A'},a)).data.request;
  await call('partner/mail','POST',{...casBase,revision:casInitial.revision,company:'PARTNER CAS STALE B'},a,409);
  const casCurrent=(await call(`partner/requests?month=${casA.createdAt.slice(0,7)}`,'GET',null,a)).data.requests.find(item=>item.id===casId);
  check(casCurrent?.company==='PARTNER CAS EDIT A'&&casCurrent.revision===casA.revision,'Stale partner form cannot overwrite a newer revision');
  const casRetry=(await call('partner/mail','POST',{...casBase,revision:casInitial.revision,company:'PARTNER CAS EDIT A'},a)).data.request;
  check(casRetry.revision===casA.revision,'Retrying the same partner payload is idempotent after a lost response');

  for(const mutation of ['password','deactivate','profile']){
    db.prepare('UPDATE users SET active=1,password_hash=?,profile_revision=profile_revision+1 WHERE id=?').run(hash,'reg-race');
    db.prepare('DELETE FROM login_attempts WHERE key=?').run('account:reg-race');
    const pending=fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'reg-race',password})});
    let started=false;
    for(let i=0;i<100;i++){if(db.prepare('SELECT 1 FROM login_attempts WHERE key=?').get('account:reg-race')){started=true;break;}await sleep(2);}
    check(started,`${mutation}: login reached password verification`);
    await sleep(10);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run('reg-race');
    if(mutation==='password')db.prepare('UPDATE users SET password_hash=?,profile_revision=profile_revision+1 WHERE id=?').run(hash.replace('scrypt:','scrypt:changed'),'reg-race');
    else if(mutation==='deactivate')db.prepare('UPDATE users SET active=0,profile_revision=profile_revision+1 WHERE id=?').run('reg-race');
    else db.prepare('UPDATE users SET profile_revision=profile_revision+1 WHERE id=?').run('reg-race');
    db.exec('COMMIT');
    const result=await pending;
    check(result.status===401&&!result.headers.get('set-cookie'),`${mutation}: stale login emits neither session nor cookie`);
    check(db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id=?').get('reg-race').count===0,`${mutation}: no post-revocation session survives`);
  }
  console.log(`PASS: ${checks} audit regressions: portfolio ownership, shared coverage, address identity, partner CAS, login revocation.`);
} finally {db.close();}
