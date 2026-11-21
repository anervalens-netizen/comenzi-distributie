import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

// Exercise activationReport's actual SQL with synthetic SQLite data. Only its
// database adapter and the unrelated activation ledger reader are substituted.
const initialDirectory=process.cwd(),temporary=mkdtempSync(join(tmpdir(),'activation-portfolio-'));
const database=new DatabaseSync(join(temporary,'mobiup.sqlite')),queries=[];
database.exec('PRAGMA journal_mode=WAL');
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
const environmentKeys=['MOBIUP_DATA_DIR','MOBIUP_ACTIVATIONS_DIR','MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID','MOBIUP_ACTIVATIONS_PILOT_AGENT_ID','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS','MOBIUP_ACTIVATIONS_VODAFONE_ONLY_MANAGER_IDS'];
const previousEnvironment=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
try{
  const bundled=await build({entryPoints:['lib/activation-api.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{
    name:'synthetic-activation-adapter',
    setup(build){
      build.onResolve({filter:/^(?:\.\/server|#mobiup-activation-store)$/},({path})=>({path,namespace:'synthetic-activation'}));
      build.onLoad({filter:/.*/,namespace:'synthetic-activation'},({path})=>({contents:path==='#mobiup-activation-store'
        ?`import {activationPartnerView} from '${process.cwd()}/lib/activation-partners-node.ts';
          import {activationPublicationVersion} from '${process.cwd()}/lib/activation-publication-node.ts';
          export {activationPublicationVersion};
          export async function readDigiOverview(){return {publication:activationPublicationVersion('digi'),...await globalThis.__activationPortfolioFixture.digiOverview()};}
          import {combinePartnerReports} from '${process.cwd()}/lib/combined-activation-partners.ts';
          import {portfolioSelection,portfolioPoint} from '${process.cwd()}/lib/activation-portfolio.ts';
          import {readCombinedActivationPartners as workerRead} from '${process.cwd()}/lib/activation-partners-runtime-node.ts';
          export async function readCombinedActivationPartners(input,page){
            const fixture=globalThis.__activationPortfolioFixture;
            if(fixture.worker){fixture.beforeWorker?.();return workerRead(input,page);}
            const selection=portfolioSelection(input.scope);
            const all=combinePartnerReports(input,fixture.database.prepare(selection.sql).all(...selection.args).map(portfolioPoint),readActivations);
            const {rows}=all.partners;
            if(fixture.duringRead)fixture.duringRead();
            return {...all,partners:{...all.partners,rows:rows.slice(page*50,(page+1)*50),page,hasMore:(page+1)*50<rows.length}};
          }
          export async function readVodafoneFocus(){return {publication:activationPublicationVersion('vodafone'),...await globalThis.__activationPortfolioFixture.focusRead()};}
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
          export class AppError extends Error {constructor(status,message,currentRevision){super(message);Object.assign(this,{status,currentRevision});}}
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
  database.exec(readFileSync('drizzle/0015_activation_portfolio_memberships.sql','utf8'));
  database.exec('CREATE TABLE crm_directory_revision(id INTEGER PRIMARY KEY, revision INTEGER);INSERT INTO crm_directory_revision VALUES(1,1);');
  customer('replaced','WN',['WN']);
  database.prepare('INSERT OR REPLACE INTO customers VALUES(?,?,?,1)').run('replaced','WS',JSON.stringify({warehouseIds:['WS']}));
  assert.deepEqual(database.prepare("SELECT warehouse_id FROM activation_portfolio_memberships WHERE customer_id='replaced'").all().map(r=>r.warehouse_id),['WS']);
  database.prepare("UPDATE customers SET active=0 WHERE id='replaced'").run();
  assert.equal(database.prepare("SELECT COUNT(*) n FROM activation_portfolio_memberships WHERE customer_id='replaced'").get().n,0);
  database.exec("DELETE FROM customers WHERE id='replaced'");
  process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID='global';
  process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS='regional';
  process.env.MOBIUP_ACTIVATIONS_PILOT_AGENT_ID='north';
  process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS='south,nonexclusive,unknown,numeric';
  const user=id=>{const row=database.prepare('SELECT * FROM users WHERE id=?').get(id);return {id,role:row.role,active:row.active,warehouseId:row.warehouse_id,siteCode:row.site_code,managerScope:row.manager_scope};};
  const digiParams=new URLSearchParams({provider:'digi',month:'2026-10'});
  fixture.digiOverview=async()=>({provider:'digi',available:true});
  assert.equal((await activationReport(user('regional'),digiParams,{revalidateFocus:async()=>user('regional')})).provider,'digi');
  await assert.rejects(()=>activationReport(user('regional'),digiParams,{
    revalidateFocus:async()=>user('global'),
  }),error=>error.status===409);
  const focusParams=new URLSearchParams({month:'2026-10',view:'focus'});
  fixture.focusRead=async()=>({provider:'vodafone',focus:{revision:'synthetic'}});
  assert.equal((await activationReport(user('south'),focusParams,{revalidateFocus:async()=>user('south')})).focus.revision,'synthetic');
  await assert.rejects(()=>activationReport(user('south'),focusParams,{revalidateFocus:async()=>{
    throw Object.assign(new Error('Synthetic expired session'),{status:401});
  }}), error=>error.status===401);
  // Publish between the worker result and the final session/scope check. Each phase must
  // reject the old source even when the user, permissions and selection remain identical.
  const sourceRoot=join(temporary,'publication');
  process.env.MOBIUP_ACTIVATIONS_DIR=sourceRoot;
  for(const provider of ['vodafone','digi']){
    const store=provider==='vodafone'?sourceRoot:join(sourceRoot,'digi');
    for(const version of ['one','two']){
      const dir=join(store,'generations',version);mkdirSync(dir,{recursive:true});
      for(const file of ['activation-report.sqlite','activations.sqlite'])writeFileSync(join(dir,file),version);
    }
    const publish=version=>{symlinkSync('generations/'+version,join(store,'next'));renameSync(join(store,'next'),join(store,'current'));};
    const params=new URLSearchParams({provider,month:'2026-10'});
    for(const phase of provider==='vodafone'?['totals','panels','cards']:[undefined]){
      publish('one');
      const opts={overviewPhase:phase,returnFocusCards:provider==='vodafone',revalidateFocus:async()=>user('global')};
      const first=await activationReport(user('global'),params,opts);
      await assert.rejects(()=>activationReport(user('global'),params,{...opts,revalidateFocus:async()=>{
        publish('two');return user('global');
      }}),error=>error.status===409&&/^[a-f0-9]{64}$/.test(error.currentRevision));
      const latest=await activationReport(user('global'),params,opts);
      assert.notEqual(latest.publication,first.publication);
    }
  }
  const northFocus=new URLSearchParams({month:'2026-10',view:'focus',focusTerritory:'nord_a'});
  fixture.focusRead=async()=>{
    database.exec("DELETE FROM manager_agents WHERE manager_id='regional' AND agent_id='north'");
    return {provider:'vodafone',focus:{revision:'synthetic'}};
  };
  await assert.rejects(()=>activationReport(user('regional'),northFocus,{revalidateFocus:async()=>user('regional')}),error=>error.status===409);
  database.exec("INSERT INTO manager_agents VALUES('regional','north')");
  delete fixture.focusRead;
  async function read(id,filters,expected){
    queries.length=0;
    const report=await activationReport(user(id),new URLSearchParams({month:'2026-10',view:'partners',...filters}));
    assert.deepEqual(report.portfolio.map(row=>row.id),[...expected].sort((a,b)=>a<b?-1:a>b?1:0),id+' '+JSON.stringify(filters));
    const query=queries.find(query=>query.sql.includes('FROM activation_portfolio_memberships'));
    assert(query,'the real indexed portfolio query executed');
    const [selected,owned]=query.args.map(JSON.parse);
    const byWarehouse="SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w WHERE w.value IN (SELECT value FROM json_each(?))";
    const oldRows=database.prepare('SELECT c.id FROM customers c WHERE c.active=1 AND EXISTS('+byWarehouse+')'+(owned?' AND EXISTS('+byWarehouse+')':'')+' ORDER BY c.id')
      .all(JSON.stringify(selected),...(owned?[JSON.stringify(owned)]:[])).map(r=>r.id);
    assert.deepEqual(report.portfolio.map(r=>r.id),oldRows,'indexed lookup retains JSON membership semantics');
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
  const plan=database.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args).map(row=>row.detail);
  assert(plan.some(detail=>detail.includes('SEARCH activation_portfolio_memberships USING PRIMARY KEY (warehouse_id=?)')),JSON.stringify(plan));
  assert(!plan.some(detail=>detail.startsWith('SCAN c')),JSON.stringify(plan));
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
  fixture.duringRead=()=>database.prepare('UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1').run();
  await assert.rejects(()=>report({q:'page-'}),error=>error.status===409,'a concurrent change invalidates an in-flight result');
  delete fixture.duringRead;
  const revision=(await report({q:'page-'})).revision;
  await assert.rejects(()=>report({q:'page-',sort:'label',revision}),e=>e.status===409);
  // Exercise the production worker wire. Only the two external operator
  // ledgers are substituted; authorization, CRM snapshots and pagination are real.
  await build({entryPoints:['lib/activation-partners-worker.ts'],outfile:join(temporary,'activation-partners-worker.mjs'),
    bundle:true,platform:'node',format:'esm',plugins:[{name:'synthetic-operators',setup(build){
      build.onResolve({filter:/^\.\/activation-store-node$/},()=>({path:'operators',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:
        'export function readActivations(month,sites,provider,query){return {available:true,revision:query.portfolioRevision,partners:{rows:[]}}}'}));
    }}]});
  process.env.MOBIUP_DATA_DIR=temporary;process.env.MOBIUP_ACTIVATIONS_DIR=sourceRoot;
  process.chdir(temporary);fixture.worker=true;
  const first=await report({});
  assert(first.partners.hasMore,'the worker served a multi-page portfolio');
  const touch=()=>database.exec('UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1');
  let attempts=0;
  fixture.beforeWorker=()=>{attempts++;touch();};
  await assert.rejects(()=>report({page:'1',revision:first.revision}),e=>e.status===409);
  assert.equal(attempts,1,'a pinned page must not restart on a later snapshot');
  attempts=0;
  fixture.beforeWorker=()=>{if(++attempts===1)touch();};
  assert.equal((await report({})).partners.total,first.partners.total);
  assert.equal(attempts,2,'a fresh list retries one transient change');
  attempts=0;
  fixture.beforeWorker=()=>{attempts++;touch();};
  await assert.rejects(()=>report({}),e=>e.status===409);
  assert.equal(attempts,2,'constant writes cannot trigger an unbounded retry');
  attempts=0;
  fixture.beforeWorker=()=>{attempts++;database.exec('DROP TABLE activation_portfolio_memberships');};
  await assert.rejects(()=>report({}),e=>e.status===503);
  assert.equal(attempts,1,'database failures remain unavailable and are not retried');
  console.log('PASS: queued partner page invalidation, bounded first-page retry and worker failure status.');
  console.log('PASS: recent-only for either provider, empty points, both providers, source identities, filters, summary counts, sorting, 103 points across pages, page limits and revision.');
  console.log('PASS: activation portfolio scopes, current-window merge, full-list sorting, validated inputs and manager/team-specific Digi presentation.');
}finally{
  process.chdir(initialDirectory);database.close();rmSync(temporary,{recursive:true,force:true});
  delete globalThis.__activationPortfolioFixture;
  for(const key of environmentKeys){if(previousEnvironment[key]===undefined)delete process.env[key];else process.env[key]=previousEnvironment[key];}
}
