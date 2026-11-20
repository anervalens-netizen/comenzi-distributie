import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';

const {outputFiles} = await build({
  stdin:{resolveDir:process.cwd(),contents:`
    export * from './lib/manager-ai-provider.ts';
    export * from './lib/manager-ai-query.ts';
    export * from './lib/manager-ai.ts';
    export * from './lib/manager-ai-operations.ts';
  `},
  bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'isolated-app-error',setup(build){
    build.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'test'}));
    build.onResolve({filter:/^\.\/(distribution-config|stock-server)$/},args=>({path:args.path.slice(2),namespace:'test'}));
    build.onLoad({filter:/^distribution-config$/,namespace:'test'},()=>({contents:`
      export async function readDistributionRules() { return {products:{SKU1:'vodafone_0',SKU2:'vodafone_5',SKU3:'digi'}}; }
    `}));
    build.onLoad({filter:/^stock-server$/,namespace:'test'},()=>({contents:`
      export async function stockForWarehouses(ids) { return globalThis.syntheticManagerAIStock(ids); }
    `}));
    build.onLoad({filter:/^server$/,namespace:'test'},()=>({contents:`
      export class AppError extends Error { constructor(status,message) { super(message); this.status=status; } }
      export function fail(status,message) { throw new AppError(status,message); }
      export const db = () => ({prepare:sql=>({bind:(...args)=>({all:async()=>({results:globalThis.syntheticManagerAISqlite.prepare(sql).all(...args)})})})});
    `}));
  }}],
});
const {parseManagerAiQuery,makeManagerAiReport,managerAiMonths,runManagerAi,defaultManagerAiModel,managerAiModels,managerAiOperations} =
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

console.log('PASS: authorized operational reads for orders, transfers, inventories and stock.');
console.log('PASS: grouped analyst queries, exact scope fields, null preservation, bounded export, both models, stateless tools, and revocation.');
