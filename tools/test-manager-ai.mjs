import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const {outputFiles} = await build({
  stdin:{resolveDir:process.cwd(),contents:`
    export * from './lib/manager-ai-provider.ts';
    export * from './lib/manager-ai-query.ts';
    export * from './lib/manager-ai.ts';
    export * from './lib/manager-ai-operations.ts';
    export * from './lib/manager-ai-data.ts';
    export * from './lib/manager-ai-billing.ts';
  `},
  bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'isolated-app-error',setup(build){
    build.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'test'}));
    const mocks = {
      'activation-api':'activationReport',
      'commercial-focus-api':'commercialFocus',
      'vodafone-bonus-api':'readVodafoneBonusForManager',
      'vodafone-activation-targets':'applyVodafoneActivationTargets',
      'manager-scope':'managerFilter',
    };
    build.onResolve({filter:/^\.\/(distribution-config|stock-server|sales-server|activation-api|commercial-focus-api|client-sales-portfolio|vodafone-bonus-api|vodafone-activation-targets|manager-scope|partner-portfolio|client-sales-store)$/},
      args=>({path:args.path.slice(2),namespace:'test'}));
    build.onLoad({filter:/^client-sales-portfolio$/,namespace:'test'},()=>({contents:`
      export async function clientPortfolioVersion() { return globalThis.syntheticManagerAIPortfolioRevision; }
      export async function clientSalesPortfolio() { throw Error('Unexpected dataset'); }
    `}));
    build.onLoad({filter:/^partner-portfolio$/,namespace:'test'},()=>({contents:`
      export const partnerScope = user => ({sql:'c.warehouse_id=?',args:[user.warehouseId]});
    `}));
    build.onLoad({filter:/^client-sales-store$/,namespace:'test'},()=>({contents:`
      export function monthEnd(month) {
        return new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
      }
    `}));
    build.onLoad({filter:/^sales-server$/,namespace:'test'},()=>({contents:`
      export async function salesView(request,user) { return Response.json(globalThis.syntheticManagerAISales(request,user)); }
    `}));
    build.onLoad({filter:/^(activation-api|commercial-focus-api|vodafone-bonus-api|vodafone-activation-targets|manager-scope)$/,namespace:'test'},
      args=>({contents:`export function ${mocks[args.path]}() { throw Error('Unexpected dataset'); }`}));
    build.onLoad({filter:/^distribution-config$/,namespace:'test'},()=>({contents:`
      export async function readDistributionRules() { return {products:{SKU1:'vodafone_0',SKU2:'vodafone_5',SKU3:'digi'}}; }
    `}));
    build.onLoad({filter:/^stock-server$/,namespace:'test'},()=>({contents:`
      export async function stockForWarehouses(ids) { return globalThis.syntheticManagerAIStock(ids); }
    `}));
    build.onLoad({filter:/^server$/,namespace:'test'},()=>({contents:`
      export class AppError extends Error { constructor(status,message) { super(message); this.status=status; } }
      export function fail(status,message) { throw new AppError(status,message); }
      export const isGlobalManager = user => user.managerScope === 'global';
      export const db = () => ({prepare:sql=>({bind:(...args)=>({all:async()=>({results:globalThis.syntheticManagerAISqlite.prepare(sql).all(...args)})})})});
    `}));
  }}],
});
const {parseManagerAiQuery,makeManagerAiReport,managerAiMonths,runManagerAi,defaultManagerAiModel,managerAiModels,managerAiOperations,managerAiReader,managerAiBillingPoints} =
  await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));

const query = {dataset:'bonuses',fromMonth:'2026-06',toMonth:'2026-09',site:'',groupBy:['franchise'],
  filters:[{field:'partner',op:'contains',value:'piata'},{field:'activations',op:'gte',value:4}],orderBy:'activations',descending:true,limit:1};
const override = changes=>JSON.stringify({...query,...changes});
const raw = override({});
const validated = parseManagerAiQuery(raw,'2026-11');
assert.deepEqual(managerAiMonths(validated.fromMonth,validated.toMonth),['2026-06','2026-07','2026-08','2026-09']);
assert.throws(()=>parseManagerAiQuery(override({dataset:'constructor'}),'2026-11'),{status:400});
assert.throws(()=>parseManagerAiQuery(override({fromMonth:'2023-01'}),'2026-11'),{status:400});
assert.throws(()=>parseManagerAiQuery(override({site:'outside-scope'}),'2026-11'),{status:400});
assert.throws(()=>parseManagerAiQuery(override({filters:[{field:'customer_secret',op:'eq',value:'test'}]}),'2026-11'),{status:400});
assert.throws(()=>parseManagerAiQuery(override({limit:100_000}),'2026-11'),{status:400});

const source = {
  rows:[
    {month:'2026-06',franchise:'F-1',partner:'Piața exemplu',activations:3,settled:1,balance:2},
    {month:'2026-07',franchise:'F-1',partner:'Piața exemplu',activations:7,settled:null,balance:null},
    {month:'2026-07',franchise:'F-2',partner:'Piața exemplu',activations:5,settled:1,balance:0},
    {month:'2026-07',franchise:'F-3',partner:'Piața exemplu',activations:2,settled:1,balance:0},
  ],
  coverage:[{month:'2026-07',source:'Synthetic',available:true,through:'2026-07-31',revision:'example'}],
};
const report=makeManagerAiReport(validated,source,'R1');
assert.equal(report.totalRows,2);
assert.equal(report.rows.length,1);
const first=Object.fromEntries(report.columns.map((name,i)=>[name,report.rows[0][i]]));
assert.equal(first.franchise,'F-1');
assert.equal(first.activations,10);
assert.equal(first.settled,null);
assert.equal(first.balance,null);
assert.equal(defaultManagerAiModel,'gpt-6.1-terra');
assert.deepEqual(managerAiModels,['gpt-6.1-terra','gpt-6.2-sol']);

for (const model of managerAiModels) {
  const calls=[];
  let authorizationChecks=0;
  const result=await runManagerAi({
    model,key:'fixture',turns:[{role:'user',content:'Raport'}],
    signal:new AbortController().signal,check:async()=>{authorizationChecks++},
    readSource:async q=>{assert.deepEqual(q,validated);return source},
    send:async (url,options)=>{
      assert.equal(new URL(url).hostname,'api.openai.com');
      assert.equal(options.redirect,'error');
      const request=JSON.parse(options.body);
      assert.equal(request.model,model);
      assert.equal(request.store,false);
      assert.equal(request.reasoning.effort,'low');
      calls.push(request);
      return Response.json({model,status:'completed',output:calls.length===1 ? [
        {type:'reasoning',id:'reasoning-1',encrypted_content:'encrypted'},
        {type:'function_call',name:'read_report',call_id:'test-1',arguments:raw},
      ] : [{type:'message',role:'assistant',content:[{type:'output_text',text:'10 activări în R1.'}]}]});
    },
  });
  assert.equal(calls.length,2);
  assert.equal(calls[1].input.at(-2).call_id,'test-1');
  assert.equal(calls[1].input.at(-1).call_id,'test-1');
  assert.equal(calls[1].input.at(-3).encrypted_content,'encrypted');
  assert.equal(result.model,model);
  assert.deepEqual(result.reports,[report]);
  assert.ok(authorizationChecks>=4);
}

let checks=0;
await assert.rejects(()=>runManagerAi({
  model:defaultManagerAiModel,key:'fixture',turns:[{role:'user',content:'Raport'}],
  signal:new AbortController().signal,
  check:async()=>{if(++checks>=3)throw new Error('revoked');},
  readSource:async()=>source,
  send:async()=>Response.json({model:defaultManagerAiModel,status:'completed',output:[
    {type:'function_call',name:'read_report',call_id:'test-2',arguments:raw},
  ]}),
}),/revoked/);
await assert.rejects(()=>runManagerAi({
  model:defaultManagerAiModel,key:'fixture',turns:[{role:'user',content:'Raport'}],
  signal:new AbortController().signal,check:async()=>{},readSource:async()=>source,
  send:async()=>Response.json({model:'wrong-model',status:'completed',output:[]}),
}),{status:502});
const db=new DatabaseSync(':memory:');
globalThis.syntheticManagerAISqlite=db;
try {
  db.exec(`CREATE TABLE users(id TEXT,role TEXT,active INTEGER,warehouse_id TEXT,warehouse_name TEXT,site_code TEXT);
    CREATE TABLE orders(number TEXT,user_id TEXT,kind TEXT,status TEXT,created_at TEXT,finalized_at TEXT,payload TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO users VALUES ('A','agent',1,'WH-A','Zona A','SITE-A'),('B','agent',1,'WH-B','Zona B','SITE-B');`);
  const addOrder=db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?)');
  const addSetting=db.prepare('INSERT INTO settings VALUES(?,?)');
  const stamp='2026-08-03T12:30:00.000Z';
  const item=(code,quantity)=>({code,name:'Produs '+code,quantity});
  for (const agent of ['A','B']) {
    const warehouse='Zona '+agent, warehouseId='WH-'+agent;
    addOrder.run('O-'+agent,agent,'combined','finalized',stamp,stamp,JSON.stringify({warehouseName:warehouse,
      items:[item('SKU1',3),item('SKU3',100)],standItems:[item('SKU2',1)]}));
    addSetting.run('inventory-v1:'+agent,JSON.stringify({warehouseId,status:'finalized',finalizedAt:stamp,
      lines:[{...item('SKU1',2),expected:3,counted:2},{...item('SKU2',3),expected:8,counted:null}]}));
    addSetting.run('transfer-v1:'+agent,JSON.stringify({number:'T-'+agent,status:'finalized',finalizedAt:stamp,
      source:{agentId:agent,warehouseId,warehouseName:warehouse},
      destination:{agentId:'B',warehouseId:'WH-B',warehouseName:'Zona B'},lines:[item('SKU2',4),item('SKU3',99)]}));
  }
  globalThis.syntheticManagerAIStock=async ids=>{
    assert.deepEqual(ids,['WH-A']);
    return new Map([['WH-A',{warehouseId:'WH-A',importedAt:stamp,rows:[item('SKU1',8),item('SKU3',100)],
      depot:{SKU1:100000}}]]);
  };
  const scope={params:new URLSearchParams(),filter:{agentIds:['A'],warehouseIds:['WH-A'],siteCodes:['SITE-A']},signature:'test'};
  const orders=await managerAiOperations('orders','2026-08',scope);
  assert.deepEqual(orders.rows.map(r=>[r.document,r.sku,r.units]),[['O-A','SKU1',3],['O-A','SKU2',1]]);
  const inventory=await managerAiOperations('inventories','2026-08',scope);
  assert.deepEqual(inventory.rows.map(r=>[r.warehouse,r.sku,r.difference]),[['Zona A','SKU1',-1],['Zona A','SKU2',null]]);
  const transfer=await managerAiOperations('transfers','2026-08',scope);
  assert.deepEqual(transfer.rows.map(r=>[r.document,r.sku,r.units,r.destination]),[['T-A','SKU2',4,null]]);
  const stock=await managerAiOperations('stock','2026-08',scope);
  assert.deepEqual(stock.rows.map(r=>[r.warehouse,r.sku,r.units]),[['Zona A','SKU1',8]]);
} finally {
  db.close();
  delete globalThis.syntheticManagerAISqlite;
  delete globalThis.syntheticManagerAIStock;
}

const salesScope = {params:new URLSearchParams({managerId:'M',agentId:'T'}),filter:{agentIds:['T'],warehouseIds:['WH-A'],siteCodes:['A','B']},signature:'test'};
const scopedUser={id:'M',role:'manager',managerScope:'assigned'};
const salesChecks=[],salesCalls=[];
const fact=(itemCode,rows,quantity,value,missingValueRows=0)=>({itemCode,itemName:itemCode,brand:'Synthetic',category:'test',subCategory:'other',rows,quantity,value,missingValueRows});
function salesFixture(sites,products) {
  return {source:'client-history',revision:3,importedAt:'2026-11-01',fileHash:null,sites:sites.map(([siteCode,rows])=>({siteCode,rows})),
    summary:{rows:sites.reduce((sum,[,count])=>sum+count,0)},daily:[{date:'2026-10-25'}],products};
}
const salesSourceViews = {
  '':salesFixture([['a',2],['A ',1],['B',1],['HISTORY:8',2]],[fact('SKU1',5,14,110,1),fact('SKU3',1,10,80)]),
  A:salesFixture([['A',3]],[fact('SKU1',2,5,50),fact('SKU3',1,10,80)]),
  B:salesFixture([['B',1]],[fact('SKU1',1,3,30)]),
  DENIED:salesFixture([],[]),
};
globalThis.syntheticManagerAISales=(req,user)=>{
  assert.equal(user,scopedUser);
  const params=new URL(req.url).searchParams;
  assert.equal(params.get('managerId'),'M');
  assert.equal(params.get('agentId'),'T');
  assert.equal(params.get('month'),'2026-10');
  const site=params.get('siteCode')||'';
  salesCalls.push(site);
  return salesSourceViews[site];
};
const readSales=managerAiReader(new Request('https://example.com/api/manager-ai'),salesScope,async()=>{salesChecks.push(true);return scopedUser;});
const salesQuery = {dataset:'sales',fromMonth:'2026-10',toMonth:'2026-10',site:'',groupBy:['month'],filters:[],orderBy:'units',descending:true,limit:50};
const executeSales = async query => makeManagerAiReport(query,await readSales(query),'S1');
const saleTotals=await executeSales(salesQuery);
assert.deepEqual(saleTotals.rows,[['2026-10',5,14,null]]);
assert.deepEqual(salesCalls,['']);
const siteGroups=await executeSales({...salesQuery,groupBy:['site']});
assert.deepEqual(siteGroups.rows,[[null,2,6,null],['A',2,5,50],['B',1,3,30]]);
assert.deepEqual(salesCalls.splice(0),['','','A','B']);
const siteFiltered=await executeSales({...salesQuery,filters:[{field:'site',op:'contains',value:'b'}]});
assert.deepEqual(siteFiltered.rows,[['2026-10',1,3,30]]);
assert.deepEqual(salesCalls.splice(0),['','B']);
const blockedFilter=await executeSales({...salesQuery,filters:[{field:'site',op:'eq',value:'denied'}]});
assert.deepEqual(blockedFilter.rows,[]);
assert.deepEqual(salesCalls.splice(0),['']);
const blockedExact=await executeSales({...salesQuery,site:'denied'});
assert.deepEqual(blockedExact.rows,[]);
assert.deepEqual(salesCalls.splice(0),['DENIED']);
assert.ok(salesChecks.length>=salesCalls.length+8);
delete globalThis.syntheticManagerAISales;
const billingRoot=mkdtempSync(join(tmpdir(),'manager-ai-billing-')),priorDataDir=process.env.MOBIUP_DATA_DIR;
const billingApp=new DatabaseSync(':memory:');
process.env.MOBIUP_DATA_DIR=billingRoot;
globalThis.syntheticManagerAISqlite=billingApp;
globalThis.syntheticManagerAIPortfolioRevision='test-state-1';
try {
  billingApp.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY,data TEXT NOT NULL,active INTEGER,warehouse_id TEXT);`);
  const insert=billingApp.prepare('INSERT INTO customers VALUES(?,?,1,?)');
  for (const [id,cui,franchise,warehouse] of [
    ['OWN','RO1234567','FR-A','WH-A'],['PEER','1234567','FR-B','WH-B'],
    ['DUP1','2222222','FR-C','WH-A'],['DUP2','2222222','FR-C','WH-B'],
    ['GEN','CLIENT GENERIC','FR-G','WH-A'],
  ]) insert.run(id,JSON.stringify({cui,name:'Fictional '+id,historyFranchises:[franchise],warehouseIds:[warehouse]}),warehouse);
  const billingUser={id:'M',role:'manager',managerScope:'assigned',warehouseId:'WH-A'};
  const points=await managerAiBillingPoints(billingUser,['WH-A']);
  assert.deepEqual([...points.keys()],['OWN'],'a duplicate point claimed outside the selected portfolio is ambiguous');
  assert.equal((await managerAiBillingPoints(billingUser,['WH-B'])).size,0,'a requested warehouse cannot widen the signed authority');

  mkdirSync(join(billingRoot,'client-history'));
  const billingHistory=new DatabaseSync(join(billingRoot,'client-history','client-sales-history.sqlite'));
  try {
    billingHistory.exec(`
      CREATE TABLE history_meta(key TEXT,value TEXT);
      INSERT INTO history_meta VALUES('current_reference','LIVE');
      CREATE TABLE history_imports(id INTEGER,sha256 TEXT,state TEXT,period_start TEXT,period_end TEXT);
      INSERT INTO history_imports VALUES(1,'active','active','2026-10-01','2026-10-18'),
        (2,'superseded','superseded','2026-10-01','2026-10-31');
      CREATE TABLE history_allocations(identity_id INTEGER,reference_id TEXT,status TEXT,point_key TEXT,partner_ids_json TEXT);
      CREATE TABLE history_identities(id INTEGER,client_code TEXT,franchise_code TEXT);
      CREATE TABLE history_rows(import_id INTEGER,date TEXT,identity_id INTEGER,site_id TEXT,sheet TEXT,source_row INTEGER,tr TEXT,document_number TEXT,
        item_code TEXT,item_name TEXT,quantity_micros INTEGER,value_cents INTEGER,customer_name TEXT);
    `);
    const ident=billingHistory.prepare('INSERT INTO history_identities VALUES(?,?,?)');
    const allocation=billingHistory.prepare('INSERT INTO history_allocations VALUES(?,?,?,?,?)');
    const movement=billingHistory.prepare('INSERT INTO history_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [id,code,point,owner,cui,status,revision] of [
      [1,'FR-A','FR-A',['OWN'],'1234567','direct_code','LIVE'],
      [2,'FR-B','FR-B',['PEER'],'1234567','direct_code','LIVE'],
      [3,'FR-A','FR-A',['OWN','PEER'],'1234567','direct_code','LIVE'],
      [4,'FR-A','FR-B',['OWN'],'1234567','direct_code','LIVE'],
      [5,'FR-A','FR-A',['OWN'],'9999999','direct_code','LIVE'],
      [6,'FR-A','FR-A',['OWN'],'1234567','reconcile','LIVE'],
      [7,'FR-A','FR-A',['OWN'],'1234567','direct_code','STALE'],
      [8,'FR-C','FR-C',['DUP1'],'2222222','direct_code','LIVE'],
      [9,'','FR-A',['OWN'],'1234567','single_partner','LIVE'],
    ]) {
      ident.run(id,cui,code);
      allocation.run(id,revision,status,'franchise:'+point,JSON.stringify(owner));
      if (id!==1) movement.run(1,'2026-10-12',id,'ERP-1','File',id,'TR Fictional','D-10','SKU1','Fictional SIM',99_000_000,99000,'Fictional company');
    }
    for (const [row,day,doc,sku,qty,value,importId,customer='Fictional company'] of [
      [11,12,'D-10','SKU1',3,300,1], [12,12,'D-10','SKU2',4,400,1],
      [13,12,'D-10','SKU3',99,9900,1], [14,12,'D-11','SKU2',-1,-100,1],
      [15,12,'D-12','SKU1',1,null,1], [16,12,'D-10','SKU1',99,99000,2],
      [17,25,'D-13','SKU1',99,99000,1], [18,13,'','SKU1',1,0,1],
      [19,13,'BON DE CONSUM D-10','SKU2',99,9900,1], [20,13,'D-10','SKU2',99,9900,1,'CLIENT GENERIC'],
      [21,14,'D-10','SKU2',2,200,1],
    ]) movement.run(importId,'2026-10-'+day,1,'ERP-1','File',row,'TR Fictional',doc,sku,'Fictional SIM',qty*1e6,value,customer);
  } finally { billingHistory.close(); }

  const readBilling=managerAiReader(new Request('https://example.com/api/manager-ai'),salesScope,async()=>billingUser);
  const billingQuery={dataset:'salesByPoint',fromMonth:'2026-10',toMonth:'2026-10',site:'',groupBy:[],filters:[],orderBy:'units',descending:true,limit:500};
  const fullSource=await readBilling(billingQuery);
  assert.equal(fullSource.rows.length,6,'same-CUI external sales and ambiguous/stale identities stay excluded');
  assert(fullSource.rows.every(row=>row.franchise==='FR-A'));
  assert.equal(fullSource.coverage[0].through,'2026-10-18');
  assert.match(fullSource.coverage[0].note,/parțială/);
  assert.match(fullSource.coverage[0].note,/nu certifică tipul fiscal sau emitentul/);
  const filteredQuery=parseManagerAiQuery(JSON.stringify({...billingQuery,groupBy:['franchise'],filters:[
    {field:'date',op:'gte',value:'2026-10-12'},{field:'date',op:'lte',value:'2026-10-13'},
    {field:'document',op:'eq',value:'D-10'},{field:'sku',op:'eq',value:'SKU1'},
  ]}),'2026-11');
  assert.deepEqual(makeManagerAiReport(filteredQuery,fullSource,'Bill').rows,[['FR-A',3,3,1,0]]);
  assert.throws(()=>parseManagerAiQuery(JSON.stringify({...billingQuery,filters:[{field:'date',op:'gte',value:'2026-02-31'}]})),{status:400});
  const documentSource=await readBilling({...billingQuery,dataset:'billingDocuments'});
  assert.deepEqual(documentSource.rows.map(row=>[row.document,row.status,row.valueLei,row.lines]),[
    ['D-10','pozitiv net',7,2],['D-11','retur/corecție',-1,1],['D-12','valoare necunoscută',null,1],
    ['D-10','pozitiv net',2,1],
  ]);
  assert.equal((await readBilling({...billingQuery,fromMonth:'2026-09',toMonth:'2026-09'})).coverage[0].available,false);
  globalThis.syntheticManagerAIPortfolioRevision='test-state-2';
  await assert.rejects(()=>readBilling.checkBillingScope(),{status:409});
} finally {
  billingApp.close();
  delete globalThis.syntheticManagerAISqlite;
  delete globalThis.syntheticManagerAIPortfolioRevision;
  if (priorDataDir===undefined) delete process.env.MOBIUP_DATA_DIR;
  else process.env.MOBIUP_DATA_DIR=priorDataDir;
  rmSync(billingRoot,{recursive:true,force:true});
}
console.log('PASS: billing intervals, exact commercial scope, document groups and invoice point safety.');

console.log('PASS: products grouped and filtered by authorized SiteCode without altering sales totals.');

console.log('PASS: authorized operational reads for orders, transfers, inventories and stock.');
console.log('PASS: grouped analyst queries, exact scope fields, null preservation, bounded export, both models, stateless tools, and revocation.');
