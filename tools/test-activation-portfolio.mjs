import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

// Exercise activationReport's actual SQL with synthetic SQLite data. Only its
// database adapter and the unrelated activation ledger reader are substituted.
const database=new DatabaseSync(':memory:'),queries=[];
const fixture={
  database,
  prepare(sql){
    const prepare=(args=[])=>({
      bind(...values){return prepare(values);},
      async all(){queries.push({sql,args});return {results:database.prepare(sql).all(...args)};},
      async first(){return database.prepare(sql).get(...args)||null;},
    });
    return prepare();
  },
};
globalThis.__activationPortfolioFixture=fixture;
const environmentKeys=['MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID','MOBIUP_ACTIVATIONS_PILOT_AGENT_ID','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS','MOBIUP_ACTIVATIONS_VODAFONE_ONLY_MANAGER_IDS'];
const previousEnvironment=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
try{
  const bundled=await build({entryPoints:['lib/activation-api.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{
    name:'synthetic-activation-adapter',
    setup(build){
      build.onResolve({filter:/^(?:\.\/server|#mobiup-activation-store)$/},({path})=>({path,namespace:'synthetic-activation'}));
      build.onLoad({filter:/.*/,namespace:'synthetic-activation'},({path})=>({contents:path==='#mobiup-activation-store'
        ?`import {activationPartnerView} from '${process.cwd()}/lib/activation-partners-node.ts';
          export function readActivations(month,sites,provider,query){const fixture=globalThis.__activationPortfolioFixture;
            if(fixture.ledger){
              const report={provider,latestDate:query.todayWindow.to};
              const allowed=query.rules.assignments.filter(a=>query.projects.includes(a.projectId)&&(sites===null||sites.some(s=>s.toUpperCase()===a.siteCode.toUpperCase()))).map(a=>a.siteCode.toUpperCase());
              const where='provider=? AND site IN (SELECT value FROM json_each(?))';
              activationPartnerView(fixture.database,report,where,[provider,JSON.stringify(allowed)],query);return report;
            }
            return {month,sites,provider,portfolio:query?.portfolio,portfolioRevision:query?.portfolioRevision,partners:{rows:fixture.partnerRows?.[provider]||[]}};}`
        :`import {createHash} from 'node:crypto';
          export const db=()=>globalThis.__activationPortfolioFixture;
          export function fail(status,message){throw Object.assign(new Error(message),{status});}
          export const isGlobalManager=user=>user.role==='manager'&&user.managerScope==='global';
          export const sha256=value=>createHash('sha256').update(value).digest('hex');
          export const textField=(value,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';`,loader:'js',resolveDir:process.cwd()}));
    },
  }]});
  const {activationReport}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  database.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER,warehouse_id TEXT,site_code TEXT,manager_scope TEXT);
    CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
    CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER);`);
  const addUser=database.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)');
  for(const [id,role,active,warehouse,site,scope] of [
    ['global','manager',1,null,'','global'],['regional','manager',1,null,'','assigned'],
    ['north','agent',1,'WN',' n ','assigned'],['south','agent',1,'WS','S','assigned'],
    ['nonexclusive','agent',1,'WX','X','assigned'],['unknown','agent',1,'WU','U','assigned'],
    ['inactive','agent',0,'WI','I','assigned'],['numeric','agent',1,'42','NUM','assigned'],
    ['manager-site','manager',1,'WM','M','assigned'],
  ])addUser.run(id,role,active,warehouse,site,scope);
  database.exec("INSERT INTO manager_agents VALUES('regional','north'),('regional','inactive')");
  const rules={version:1,revision:'synthetic-portfolio',history:'all',products:{},assignments:[
    {userId:'north',siteCode:'N',projectId:'vodafone_nord',territoryId:'nord_a',counties:['CV']},
    {userId:'south',siteCode:'S',projectId:'vodafone_sud',territoryId:'sud',counties:['AG']},
    ...[['nonexclusive','X'],['inactive','I'],['numeric','NUM'],['manager-site','M']].map(([userId,siteCode])=>({userId,siteCode,projectId:'non_exclusiv',territoryId:null,counties:[]})),
  ]};
  database.prepare('INSERT INTO settings VALUES(?,?)').run('distribution-rules-v1',JSON.stringify(rules));
  const addCustomer=database.prepare('INSERT INTO customers VALUES(?,?,?,?)');
  const customer=(id,warehouse,warehouseIds,extra={})=>addCustomer.run(id,warehouse,JSON.stringify({name:'Synthetic '+id,cui:'EXAMPLE',...(warehouseIds===undefined?{}:{warehouseIds}),...extra}),id==='inactive-customer'?0:1);
  customer('north','WN',['WN'],{historyFranchises:[' A ','A'],historyCatalog:{franchiseCode:'B'}});
  customer('south','WS',['WS']);customer('nonexclusive','WX',['WX']);
  customer('shared','WS',['WS','WN','WN']);customer('fallback','WN',undefined);
  customer('null','WN',null);customer('empty','WN',[]);
  customer('inactive-agent','WI',['WI']);customer('inactive-customer','WN',['WN']);
  customer('unknown','WU',['WU']);customer('manager-site','WM',['WM']);
  customer('numeric-json','42',[42]);customer('numeric-text','42',['42']);
  customer('unassigned','missing',['missing']);
  process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID='global';
  process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS='regional';
  process.env.MOBIUP_ACTIVATIONS_PILOT_AGENT_ID='north';
  process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS='south,nonexclusive,unknown,numeric';
  const user=id=>{const row=database.prepare('SELECT * FROM users WHERE id=?').get(id);return {id,role:row.role,active:row.active,warehouseId:row.warehouse_id,siteCode:row.site_code,managerScope:row.manager_scope};};
  const baseline=`EXISTS(SELECT 1 FROM users u JOIN json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w ON w.value=u.warehouse_id WHERE u.role='agent' AND u.active=1 AND UPPER(TRIM(u.site_code)) IN (SELECT value FROM json_each(?)))`;
  async function read(id,filters,expected){
    queries.length=0;
    const report=await activationReport(user(id),new URLSearchParams({month:'2026-10',view:'partners',...filters}));
    assert.deepEqual(report.portfolio.map(row=>row.id),[...expected].sort((a,b)=>a<b?-1:a>b?1:0),id+' '+JSON.stringify(filters));
    const query=queries.find(query=>query.sql.startsWith('SELECT c.id,c.data FROM customers c'));
    assert(query,'the real portfolio query executed');
    const where=query.sql.lastIndexOf(' AND EXISTS(');
    const original=query.sql.slice(0,where)+' AND '+baseline+' ORDER BY c.id';
    assert.deepEqual(database.prepare(query.sql).all(...query.args),database.prepare(original).all(...query.args),'complete source-row parity with the previous membership semantics');
    return {report,query};
  }
  const north=['north','shared','fallback','null'];
  const all=[...north,'south','nonexclusive','numeric-text'];
  await read('global',{},all);
  await read('global',{projects:'vodafone_nord,vodafone_nord'},north);
  await read('global',{projects:''},[]);
  await read('global',{siteCode:'n'},north);
  await read('global',{agentId:'south'},['south','shared']);
  await read('regional',{},north);
  await read('regional',{managerId:'regional',projects:'non_exclusiv'},[]);
  const own=await read('north',{},north);
  assert.deepEqual(own.report.portfolio.find(row=>row.id==='north').codes,['A','B'],'portfolio identity normalization remains intact');
  await read('north',{projects:'vodafone_sud'},[]);
  await read('unknown',{},[]);
  await read('numeric',{},['numeric-text']);
  await assert.rejects(()=>read('north',{siteCode:'S'},[]),error=>error.status===403,'agents cannot supply another site');
  await assert.rejects(()=>read('regional',{agentId:'south'},[]),error=>error.status===404,'regional scope cannot select an unassigned agent');
  // An ambiguous historical owner remains denied for an agent, while inactive
  // owners never make their warehouse part of a manager's current portfolio.
  addUser.run('retired-north','agent',0,'W-OLD','N','assigned');
  await read('north',{},[]);
  await read('global',{},all);
  database.prepare('DELETE FROM users WHERE id=?').run('retired-north');
  // Duplicate active warehouse memberships still produce each customer once.
  addUser.run('north-other','agent',1,'WN','N2','assigned');
  rules.assignments.push({userId:'north-other',siteCode:'N2',projectId:'non_exclusiv',territoryId:null,counties:[]});
  database.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(rules),'distribution-rules-v1');
  await read('global',{projects:'non_exclusiv'},[...north,'nonexclusive','numeric-text']);

  // Bound the query shape rather than a hardware-dependent millisecond limit:
  // the roster scan must belong to an uncorrelated list computed once per read.
  const {query}=await read('global',{},all);
  const plan=database.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args),byId=new Map(plan.map(row=>[row.id,row]));
  const roster=plan.filter(row=>row.detail==='SCAN u');
  assert.equal(roster.length,1,'one permitted-warehouse roster scan');
  const ancestors=[];for(let row=byId.get(roster[0].parent);row;row=byId.get(row.parent))ancestors.push(row.detail);
  assert(ancestors.some(detail=>detail.startsWith('LIST SUBQUERY')),'roster is materialized as an uncorrelated membership list: '+JSON.stringify(plan));
  assert(!ancestors.some(detail=>detail.includes('CORRELATED')),'roster is not scanned again for each customer');
  process.env.MOBIUP_ACTIVATIONS_VODAFONE_ONLY_MANAGER_IDS='regional';
  const combined=id=>activationReport(user(id),new URLSearchParams({provider:'both',view:'partners',month:'2026-10'}));
  assert.equal((await combined('regional')).showDigi,false);
  assert.equal((await combined('north')).showDigi,false,'membership in the configured manager team controls presentation');
  assert.equal((await combined('global')).showDigi,true,'other managers keep Digi even when browsing the same team');
  assert.equal((await combined('south')).showDigi,true,'unrelated agents retain Digi');
  fixture.partnerRows={vodafone:Array.from({length:60},(_,i)=>({key:String(i),company:'Example',clientCode:String(i),pointCode:String(i),label:'Point '+i,kind:'point',total:i,recentToday:60-i,recent:{},lastDate:'2026-10-01'})),digi:[{key:'0',company:'Example',clientCode:'0',pointCode:'0',label:'Point 0',kind:'point',total:2,recentToday:2,recent:{},lastDate:'2026-10-02'}]};
  const sorted=await activationReport(user('global'),new URLSearchParams({provider:'both',view:'partners',month:'2026-10',sort:'recentToday',direction:'desc'}));
  assert.equal(sorted.partners.rows[0].recentToday,62,'combined current window sums the two provider quantities once');
  assert.equal(sorted.partners.rows[0].key,'0');assert.equal(sorted.partners.rows.length,50);
  const second=await activationReport(user('global'),new URLSearchParams({provider:'both',view:'partners',month:'2026-10',sort:'recentToday',direction:'desc',page:'1'}));
  assert.equal(second.partners.rows[0].key,'50','sorting precedes pagination');
  for(const filters of [{sort:'unknown'},{direction:'invalid'}])await assert.rejects(()=>activationReport(user('global'),new URLSearchParams({provider:'both',view:'partners',...filters})),e=>e.status===400);
  // Use the real per-provider SQL projection and API merge. Reporting January
  // leaves today's activations recent-only, independent of the test run date.
  database.exec('CREATE TABLE details(company,provider,is_tr,month,activation_date,point_key,client_code,point_code,label,site)');
  fixture.ledger=true;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const addActivation=database.prepare('INSERT INTO details VALUES(?,?,?,?,?,?,?,?,?,?)');
  const key=JSON.stringify(['Example','EXAMPLE','A']);
  const add=(provider,date)=>addActivation.run('Example',provider,1,date.slice(0,7),date,key,'EXAMPLE','A','Synthetic north','N');
  const report=filters=>activationReport(user('global'),new URLSearchParams({provider:'both',view:'partners',month:'2024-01',siteCode:'N',...filters}));
  for(const provider of ['vodafone','digi']){
    database.exec('DELETE FROM details');
    add(provider,today);
    const result=await report({});
    assert.equal(result.partners.total,north.length,'recent-only '+provider+' must suppress the opposite-provider placeholder');
    const rows=result.partners.rows.filter(row=>row.portfolioId==='north');
    assert.equal(rows.length,1,'exactly one real recent-only row');
    assert.equal(rows[0].key,key,'retain source identity for detail/export');
    assert.equal(rows[0].recentToday,1);assert.equal(rows[0].total,0);
    assert.equal(rows[0].vodafone,0);assert.equal(rows[0].digi,0);
    assert.equal(result.partners.realPointCount,north.length);
    for(const id of north.filter(id=>id!=='north')){
      const empty=result.partners.rows.filter(row=>row.portfolioId===id);
      assert.equal(empty.length,1);assert.equal(empty[0].key,'portfolio:'+id);
      assert.equal(empty[0].total,0);assert.equal(empty[0].recentToday,0);
    }
    const filtered=await report({q:'north',projects:'vodafone_nord'});
    assert.equal(filtered.partners.total,1);assert.equal(filtered.partners.rows[0].key,key);
    assert.equal((await report({q:'no-match'})).partners.total,0);
    assert.equal((await report({projects:'vodafone_sud'})).partners.total,0,'project scope is applied before merging');
  }
  add('vodafone','2024-01-02');add('digi','2024-01-03');add('vodafone',today);
  const both=await report({});
  const real=both.partners.rows.find(row=>row.key===key);
  assert.equal(both.partners.total,north.length);
  assert.equal(real.total,2);assert.equal(real.vodafone,1);assert.equal(real.digi,1);
  assert.equal(real.recentToday,2,'both provider recent counts are summed once');
  // One point may have distinct company/source identities; retain those rows.
  addActivation.run('Other','vodafone',1,today.slice(0,7),today,JSON.stringify(['Other','EXAMPLE','A']),'EXAMPLE','A','Synthetic north','N');
  assert.equal((await report({q:'north'})).partners.total,2,'distinct source identities are not collapsed by portfolio id');
  database.exec('DELETE FROM details');
  for(let i=0;i<103;i++){
    const id='page-'+String(i).padStart(3,'0'),code='PAGE'+i;
    customer(id,'WN',['WN'],{historyFranchises:[code]});
    addActivation.run('Example',i%2?'digi':'vodafone',1,today.slice(0,7),today,JSON.stringify(['Example','EXAMPLE',code]),'EXAMPLE',code,'Synthetic '+id,'N');
  }
  for(const direction of ['asc','desc']){
    const pages=[];
    for(let page=0;page<3;page++){
      const result=await report({q:'page-',sort:'label',direction,page:String(page)});
      assert.equal(result.partners.total,103);assert.equal(result.partners.realPointCount,103);
      assert.equal(result.partners.rows.length,page<2?50:3);assert.equal(result.partners.hasMore,page<2);
      pages.push(...result.partners.rows);
    }
    assert.equal(new Set(pages.map(row=>row.portfolioId)).size,103);
    assert(pages.every(row=>!row.key.startsWith('portfolio:')&&row.recentToday===1&&row.total===0));
    const expected=Array.from({length:103},(_,i)=>'page-'+String(i).padStart(3,'0'));
    assert.deepEqual(pages.map(row=>row.portfolioId),direction==='asc'?expected:expected.reverse());
  }
  for(const page of ['3','999999']){
    const result=await report({q:'page-',page});
    assert.equal(result.partners.total,103);assert.equal(result.partners.rows.length,0);assert.equal(result.partners.hasMore,false);
  }
  for(const page of ['-1','1.5','1000000','abc'])await assert.rejects(()=>report({page}),e=>e.status===400);
  const revision=(await report({q:'page-'})).revision;
  await assert.rejects(()=>report({q:'page-',sort:'label',revision}),e=>e.status===409);
  console.log('PASS: recent-only for either provider, empty points, both providers, source identities, filters, summary counts, sorting, 103 points across pages, page limits and revision.');
  console.log('PASS: activation portfolio scopes, current-window merge, full-list sorting, validated inputs and manager/team-specific Digi presentation.');
}finally{
  database.close();delete globalThis.__activationPortfolioFixture;
  for(const key of environmentKeys){if(previousEnvironment[key]===undefined)delete process.env[key];else process.env[key]=previousEnvironment[key];}
}
