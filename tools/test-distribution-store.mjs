import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,renameSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'distribution-'));
const result=spawnSync('python3',['tools/distribution-fixture.py',root],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
process.env.MOBIUP_ACTIVATIONS_DIR=root;
const bundle=await build({entryPoints:['lib/activation-store-node.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {readActivations}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const rules=JSON.parse(readFileSync(join(root,'rules.json'))),projects=['vodafone_nord','vodafone_sud','non_exclusiv'];
const read=(sites,policy='manager',extra={})=>readActivations('2026-10',sites,'vodafone',{rules,months:['2026-10'],projects,policy,...extra});
try{
 const semanticSource=new DatabaseSync(join(root,'activations.sqlite')),semanticReport=new DatabaseSync(join(root,'activation-report.sqlite'));
 try{
  semanticSource.prepare("UPDATE activation_meta SET value='1' WHERE key='facts_version'").run();
  assert.throws(()=>read(null),/semantic rebuild/,'new readers reject stale derived facts even with matching source generation');
  semanticSource.prepare("UPDATE activation_meta SET value='2' WHERE key='facts_version'").run();
  semanticReport.prepare("UPDATE report_meta SET value='1' WHERE key='factsVersion'").run();
  assert.throws(()=>read(null),/semantic rebuild/,'fresh facts cannot certify a projection built with old semantics');
  semanticReport.prepare("UPDATE report_meta SET value='2' WHERE key='factsVersion'").run();
 }finally{semanticSource.close();semanticReport.close();}
 const manager=read(null);assert.equal(manager.totals.total,8);assert.equal(manager.totals.eligible,5);assert.equal(manager.totals.ineligible,3);assert.equal(manager.totals.total,manager.totals.eligible+manager.totals.ineligible);assert.equal(manager.totals.eligible,manager.totals.ownRegion+manager.totals.otherRegion+manager.totals.unknownRegion);
 assert.equal(manager.reconciliation,1,'non-distribution observations stay in the separately aggregated reconciliation count');
 const north=read(['N'],'north');assert.equal(north.totals.total,3);assert.equal(north.totals.eligible,2);assert.equal(north.totals.ineligible,1);assert.equal(north.sites.length,1);
 const south=read(['S'],'south');assert.equal(south.totals.total,1);assert.equal(south.totals.eligible,1);assert.equal(south.totals.ineligible||0,0);
 assert.equal(read(['X'],'nonexclusive').totals.total,0);assert.equal(read([],'north').totals.total,0);
 assert.equal(read(null,'manager',{months:['2026-09','2026-10']}).totals.total,9);
 assert.equal(read(null,'manager',{projects:['vodafone_sud','vodafone_nord']}).totals.total,7);
 assert.equal(read(null,'manager',{projects:[]}).totals.total,0);assert.equal(read(null,'manager',{projects:[]}).totals.eligible,0,'empty selections retain explicit eligibility zero');assert.equal(read(null,'manager',{months:[]}).totals.total,0);
 const revisedRules={...rules,revision:'changed'};
 const revised=read(null,'manager',{rules:revisedRules});
 assert.deepEqual(revised.totals,manager.totals);assert.deepEqual(revised.history,manager.history,'rules revision alone does not change activation history');
 assert.equal(revised.rulesRevision,'changed');assert.notEqual(revised.revision,manager.revision,'current rules revision invalidates selection identity');
 const productRules={...rules,products:{...rules.products,ZERO:'accessories',CREDIT:'vodafone_0'}};
 const productReport=read(null,'manager',{rules:productRules});
 assert.deepEqual(productReport.totals,manager.totals);assert.deepEqual(productReport.history,manager.history,'product remapping never changes distinct activation facts or eligibility');
 assert.notEqual(productReport.revision,manager.revision,'product-only changes invalidate selections even without a rules revision change');
 assert.deepEqual(read(null,'manager',{months:['2026-08','2026-10']}).simZero,{distributed:2,activated:1,withoutReportedActivation:1});
 assert.deepEqual(read(null,'manager',{months:['2026-08','2026-10'],rules:productRules}).simZero,{distributed:8,activated:8,withoutReportedActivation:0},'SIM0 cohort grouping uses current product codes without rebuilding raw cohorts');
 for(const changed of [
  {...rules,assignments:rules.assignments.map((a,i)=>i===0?{...a,territoryId:'nord_b'}:a)},
  {...rules,futureStructure:{version:1}},
  {...rules,version:2},
  {...rules,history:'recent'},
  {...rules,products:null},
  {...rules,products:{...rules.products,CREDIT:'invalid-group'}},
 ])assert.throws(()=>read(null,'manager',{rules:changed}),/Stale distribution/,'structural and malformed rule changes still fail closed');
 const partners=read(['N'],'north',{view:'partners',portfolio:[{id:'zero-point',client:'EXAMPLE',codes:['C'],name:'Synthetic zero point'}]});assert.equal(partners.partners.rows.reduce((n,r)=>n+r.total,0),3);assert.equal(partners.partners.rows.at(-1).total,0);
 const point=partners.partners.rows[0];assert.equal(read(['N'],'north',{view:'detail',point:point.key}).detail.total,point.total);
 const detailRevision=read(['N'],'north',{view:'detail',point:point.key}).revision;
 for(const changedRules of [revisedRules,productRules])for(const view of ['detail','export'])assert.throws(()=>read(['N'],'north',{view,point:point.key,revision:detailRevision,rules:changedRules}),/Stale activation selection/,'detail/export tokens bind the complete current rules');
 assert.equal(read(['S'],'south',{view:'detail',point:point.key}).detail.total,1,'same workpoint still intersects the authenticated seller');
 assert.equal(read(['N'],'north',{view:'detail',point:'foreign'}).detail.total,0);
 assert.equal(read(['N'],'north',{view:'export',company:JSON.stringify(['ExampleCo','EXAMPLE'])}).detail.total,3);
 const drillBundle=await build({entryPoints:['lib/activation-distribution-node.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const {distributionReport}=await import('data:text/javascript;base64,'+Buffer.from(drillBundle.outputFiles[0].text).toString('base64'));
 const database=new DatabaseSync(join(root,'activation-report.sqlite'));
 try{
  const meta=Object.fromEntries(database.prepare('SELECT key,value FROM report_meta').all().map(r=>[r.key,r.value]));
  for(const invalid of ['', '{',JSON.stringify({...rules,version:2}),JSON.stringify({...rules,products:{CREDIT:'invalid-group'}})])assert.throws(()=>distributionReport(database,manager,{...meta,rules:invalid},null,{rules,months:['2026-10'],projects,policy:'manager'}),/Stale distribution/,'missing or malformed projection rules fail closed');
  assert.throws(()=>distributionReport(database,manager,{...meta,rules:JSON.stringify({...rules,futureStructure:{version:1}})},null,{rules,months:['2026-10'],projects,policy:'manager'}),/Stale distribution/,'unknown stored structural fields cannot be silently discarded');
  const plans=[];
  let planIdentity=point.key;
  const traced={function:(...args)=>database.function(...args),prepare(sql){
   const statement=database.prepare(sql),call=(method,args)=>{
    if(sql.includes('FROM details')&&args.includes(planIdentity))plans.push(...database.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(p=>p.detail));
    return statement[method](...args);
   };
   return {get:(...args)=>call('get',args),all:(...args)=>call('all',args)};
  }};
  const drill=extra=>distributionReport(traced,manager,meta,null,{rules,months:['2026-10'],projects,policy:'manager',view:'detail',...extra});
  assert.equal(drill({point:point.key}).detail.total,5);
  assert(plans.length>=3&&plans.every(p=>!p.startsWith('SEARCH details')||p.includes('detail_point')),'every point detail/recent/export read seeks the exact indexed point: '+plans.join('; '));
  assert(plans.filter(p=>p.startsWith('SEARCH details')).length>=3);
  assert(plans.filter(p=>p.includes('COVERING INDEX detail_point')).length>=2,'point period/recent aggregates do not fetch unrelated history rows');
  plans.length=0;planIdentity='EXAMPLE';assert.equal(drill({company:JSON.stringify(['ExampleCo','EXAMPLE'])}).detail.total,8);
  assert(plans.filter(p=>p.startsWith('SEARCH details')).length>=3&&plans.every(p=>!p.startsWith('SEARCH details')||p.includes('detail_company_scope')),'company aggregates use the scoped covering index');
  assert(plans.filter(p=>p.includes('COVERING INDEX detail_company_scope')).length>=2);
  const unresolved=database.prepare("SELECT id FROM details WHERE month='2026-10' LIMIT 1").get().id;
  database.prepare("UPDATE details SET point_key='' WHERE id=?").run(unresolved);
  plans.length=0;planIdentity=unresolved;assert.equal(drill({point:'unresolved:'+unresolved}).detail.total,1);
  assert(plans.filter(p=>p.startsWith('SEARCH details')).length>=3&&plans.some(p=>p.includes('sqlite_autoindex_details_1')),'unresolved identities seek the primary key');
  assert.equal(drill({point:'portfolio:synthetic-zero'}).detail.total,0);
  database.exec('DROP INDEX detail_company_scope');
  assert.throws(()=>drill({company:JSON.stringify(['ExampleCo','EXAMPLE'])}),/index requires rebuild/,'older projections never fall back to an unbounded company scan');
 }finally{database.close();}
 assert.throws(()=>readActivations('2026-10',null,'vodafone'),/rules required/,'a configured projection cannot downgrade to legacy policy');
 const generation=join(root,'generations','synthetic');mkdirSync(generation,{recursive:true});for(const name of ['activations.sqlite','activation-report.sqlite'])renameSync(join(root,name),join(generation,name));
 symlinkSync('generations/synthetic',join(root,'current'),'dir');assert.equal(read(null).totals.total,8,'published generation is pinned');
 unlinkSync(join(root,'current'));symlinkSync('generations/missing',join(root,'current'),'dir');assert.throws(()=>read(null),/ENOENT/,'dangling pointer fails closed');
 console.log('PASS: indexed projections, live product grouping with structural compatibility, selection revision fences, exact scoped counts and point/company/detail/export.');
}finally{rmSync(root,{recursive:true,force:true});}
