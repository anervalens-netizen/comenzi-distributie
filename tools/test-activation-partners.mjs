import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const bundle=await build({stdin:{contents:"export {activationPartnerView} from './lib/activation-partners-node';export {activationPartnerSummary} from './lib/activation-partner-summary';export {distributionReport} from './lib/activation-distribution-node';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {activationPartnerView,activationPartnerSummary,distributionReport}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const db=new DatabaseSync(':memory:');
try{
 db.exec(`CREATE TABLE details(id TEXT PRIMARY KEY,company TEXT,provider TEXT,is_tr INTEGER,month TEXT,activation_date TEXT,point_key TEXT,client_code TEXT,point_code TEXT,label TEXT,site TEXT,item_type TEXT,county TEXT,handset TEXT,contradictory INTEGER,reasons TEXT);
 CREATE INDEX detail_point ON details(point_key,provider,is_tr,month,site,activation_date);
 CREATE INDEX detail_company_scope ON details(provider,company,client_code,is_tr,month,site,activation_date);`);
 let next=0;
 const add=(changes={})=>{
  const row={id:String(++next),company:'ExampleCo',provider:'vodafone',is_tr:1,month:'2026-10',activation_date:'2026-10-20',point_key:'',client_code:'EXAMPLE',point_code:'',label:'Synthetic source label',site:'N',item_type:'SIM',county:'CV',handset:'SIM with initial credit >= 3 EUR',contradictory:0,reasons:'[]',...changes};
  db.prepare('INSERT INTO details VALUES('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
 };
 add({point_key:'["ExampleCo","EXAMPLE","P1"]',point_code:'P1'});
 add({point_key:'["ExampleCo","EXAMPLE","P1"]',point_code:'P1'});
 add({client_code:'CLIENTGEN'});add({client_code:'CLIENTGEN'});
 // An ERP code on CLIENTGEN does not create a real commercial work point.
 add({client_code:'CLIENTGEN',point_code:'PERSONAL',point_key:'["ExampleCo","CLIENTGEN","PERSONAL"]'});
 add();add();add({client_code:''});
 add({client_code:'CLIENTGEN',site:'S'}); // excluded by the authenticated scope
 add({client_code:'CLIENTGEN',company:'OtherCo'});
 add({client_code:'CLIENTGEN',month:'2026-09',activation_date:'2026-09-30'});
 const rules={assignments:[]};
 const read=(extra={})=>{
  const result={provider:'vodafone',latestDate:'2026-10-20'};
  activationPartnerView(db,result,'provider=? AND is_tr=1 AND site=?',['vodafone','N'],{months:['2026-10'],rules,policy:'manager',projects:[],view:'partners',...extra});
  return result;
 };
 const portfolio=[{id:'mapped',name:'Identified synthetic point',client:'EXAMPLE',codes:['P1']},{id:'zero',name:'Zero synthetic point',client:'ZERO',codes:[]},{id:'generic-placeholder',name:'Generic account',client:'CLIENTGEN',codes:[]}];
 const report=read({portfolio}).partners;
 assert.equal(report.realPointCount,2,'only an identified source point and the known zero-activation portfolio point enter the denominator');
 assert.equal(report.genericActivations,4);assert.equal(report.unresolvedActivations,3);assert.equal(report.unassignedActivations,7);
 assert.equal(report.rows.reduce((n,r)=>n+r.total,0),9,'every authorized activation remains represented');
 assert.equal(report.total,6,'browse row count describes grouped identities, not a point denominator');
 assert.equal(report.rows.filter(r=>r.kind==='generic').length,2,'generic personal sales group by company and authorized seller');
 const personal=report.rows.find(r=>r.kind==='generic'&&r.company==='ExampleCo');
 assert.equal(personal.total,3);assert.equal(personal.recent['30'],4,'recent window includes authorized previous-month records');
 assert.equal(personal.portfolioId,undefined);assert.equal(personal.pointCode,'');
 const plans=[];
 const traced={prepare(sql){
  const statement=db.prepare(sql);
  return Object.fromEntries(['get','all'].map(method=>[method,(...args)=>{
   if(sql.includes('FROM details'))plans.push(...db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail));
   return statement[method](...args);
  }]));
 }};
 for(const identity of [personal,report.rows.find(row=>row.kind==='unresolved')]){
  plans.length=0;
  const selected={provider:'vodafone',latestDate:'2026-10-20'};
  activationPartnerView(traced,selected,'provider=? AND is_tr=1 AND site=?',['vodafone','N'],{months:['2026-10'],rules,policy:'manager',projects:[],view:'export',point:identity.key});
  assert.equal(selected.detail.total,identity.total);
  const searches=plans.filter(plan=>plan.startsWith('SEARCH details'));
  assert.equal(searches.length,3,'selected period/recent/export all seek the group identity');
  assert(searches.every(plan=>plan.includes('detail_company_scope')&&plan.includes('company=?')&&plan.includes('client_code=?')),'groups use the existing scoped company index: '+plans.join('; '));
  assert(plans.every(plan=>!plan.startsWith('SCAN details')),'group detail never scans unrelated partners');
 }
 for(const row of report.rows){
  const detail=read({view:'detail',point:row.key}).detail;
  const exported=read({view:'export',point:row.key}).detail;
  assert.equal(detail.total,row.total,'group drilldown retains every activation');
  assert.equal(exported.total,row.total,'export and displayed totals share exact scope');
 }
 assert.equal(read({view:'detail',point:'generic:'+JSON.stringify(['ExampleCo','S'])}).detail.total,0,'forged personal-sales group never broadens authenticated seller access');
 assert.equal(read({view:'detail',point:'unassigned:'+JSON.stringify(['ExampleCo','EXAMPLE','','S'])}).detail.total,0);
 assert.equal(read({view:'detail',point:'unresolved:6'}).detail.total,1,'previous unresolved bookmark remains supported');
 assert.equal(read({view:'detail',company:JSON.stringify(['ExampleCo','CLIENTGEN'])}).detail.total,3,'company drilldown retains authorized generic sales');
 assert.equal(read({q:'CLIENTGEN',portfolio}).partners.realPointCount,0,'filtered denominators exclude unrelated real points');
 assert.equal(read({q:'CLIENTGEN',portfolio}).partners.genericActivations,4);
 const point=report.rows.find(r=>r.kind==='point'&&r.total);
 assert.equal(activationPartnerSummary([point,{...point,key:'another-historical-code'},personal]).realPointCount,1,'operator/history aliases of the same identified portfolio point count once');
 for(let i=0;i<55;i++)add({client_code:'PAGED',point_code:String(i),point_key:JSON.stringify(['ExampleCo','PAGED',String(i)])});
 const page=read().partners,nextPage=read({page:1}).partners;
 assert.equal(page.realPointCount,56);assert.equal(nextPage.realPointCount,56,'summary spans every page');
 assert.equal(page.rows.length,50);assert(page.hasMore);assert.equal(nextPage.rows.reduce((n,r)=>n+r.total,0)+page.rows.reduce((n,r)=>n+r.total,0),64);
 // Exercise the actual policy builder, not a duplicated approximation of its SQL.
 add({client_code:'CLIENTGEN',site:'S',county:'AG'});
 add({client_code:'CLIENTGEN',site:'S',county:'AG',handset:'-'});
 add({site:'S',county:'AG'});
 db.exec(`CREATE TABLE dimension_monthly AS SELECT provider,month,site,item_type,county,handset,contradictory,is_tr,COUNT(*) count,MAX(activation_date) last_date FROM details GROUP BY provider,month,site,item_type,county,handset,contradictory,is_tr;
 CREATE TABLE sites(site TEXT,label TEXT);
 CREATE TABLE cohorts(provider TEXT,distribution_month TEXT,site TEXT,item_code TEXT,activated INTEGER);`);
 const policyRules={version:1,revision:'synthetic-policies',history:'all',products:{},assignments:[{userId:'north',siteCode:'N',projectId:'vodafone_nord',territoryId:'nord_a',counties:['CV']},{userId:'south',siteCode:'S',projectId:'vodafone_sud',territoryId:'sud',counties:['AG']}]};
 const meta={rules:JSON.stringify(policyRules),sourceImports:JSON.stringify([['synthetic','vodafone']]),latestDate:'2026-10-20',importedAt:'2026-10-20',version:'4'};
 const policyRead=(policy,sites,extra={})=>distributionReport(db,{provider:'vodafone'},meta,sites,{rules:policyRules,months:['2026-10'],projects:['vodafone_nord','vodafone_sud','non_exclusiv'],policy,view:'partners',allPartners:true,...extra});
 for(const [policy,sites,total] of [['manager',null,68],['north',['N'],64],['south',['S'],2]]){
  const list=policyRead(policy,sites);
  assert.equal(list.totals.total,total,policy);
  assert.equal(list.partners.rows.reduce((sum,row)=>sum+row.total,0),total,policy+' preserves all and only authorized activations');
  for(const row of list.partners.rows){
   for(const view of ['detail','export'])assert.equal(policyRead(policy,sites,{view,point:row.key}).detail.total,row.total,policy+' grouped '+view+' respects exact policy');
  }
 }
 assert.equal(policyRead('north',['N'],{view:'detail',point:'generic:'+JSON.stringify(['ExampleCo','S'])}).detail.total,0);
 assert.equal(policyRead('south',['S'],{view:'export',point:'generic:'+JSON.stringify(['ExampleCo','S'])}).detail.total,1,'South retains eligible personal sale and excludes ineligible/cross-region observations within the same group');
 console.log('PASS: real-point denominator, personal-sales grouping, existing indexed detail/export, manager/north/south policy parity, recent windows and pagination.');
}finally{db.close();}
