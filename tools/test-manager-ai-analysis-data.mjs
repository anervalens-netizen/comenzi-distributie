import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const root=mkdtempSync(join(tmpdir(),'manager-ai-analysis-data-'));
process.env.MOBIUP_DATA_DIR=root;
process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID='regional';
process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS='global';
const sql=new DatabaseSync(join(root,'mobiup.sqlite'));
globalThis.syntheticManagerAnalysisDb={
  prepare(query){
    const statement=sql.prepare(query);
    function bound(args=[]){
      return {bind:(...values)=>bound(values),all:async()=>({results:statement.all(...args)}),
        first:async()=>statement.get(...args)??null};
    }
    return bound();
  },
  portfolioReadVersion:async()=>'synthetic-revision',
};
const modulePath=join(root,'fixture.mjs');
try {
  await build({
    stdin:{resolveDir:process.cwd(),contents:`
      export * from './lib/manager-ai-analysis-data';
      export * from './lib/manager-ai-analysis-database';
      export {managerAiScope} from './lib/manager-ai-data';
      export {importSalesRows} from './lib/sales-store';
    `},
    bundle:true,platform:'node',format:'esm',outfile:modulePath,
    alias:{
      '#mobiup-activation-store':resolve('lib/activation-store-node.ts'),
      '#mobiup-sales-parser':resolve('lib/sales-parser-node.ts'),
      '#mobiup-sales-view':resolve('lib/sales-view-direct.ts'),
      '#mobiup-commercial-focus-runtime':resolve('lib/commercial-focus-runtime-node.ts'),
      '#mobiup-stock-parser':resolve('lib/stock-parser-node.ts'),
    },
    plugins:[{name:'read-only-fixture',setup(plugin){
      plugin.onResolve({filter:/^(?:@\/lib\/runtime|#mobiup-runtime)$/},()=>({path:'runtime',namespace:'fixture'}));
      plugin.onResolve({filter:/^\.\/error-reporting$/},()=>({path:'error-reporting',namespace:'fixture'}));
      plugin.onLoad({filter:/^runtime$/,namespace:'fixture'},()=>({contents:`
        export const env={DB:globalThis.syntheticManagerAnalysisDb};
        export const runtimeKind='node';
        export function getRequestEnv(){return env;}
      `}));
      plugin.onLoad({filter:/^error-reporting$/,namespace:'fixture'},()=>({contents:`
        export function captureError(){throw Error('Unexpected fixture error');}
      `}));
    }}],
  });
  const m=await import(pathToFileURL(modulePath));
  sql.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
  sql.exec(`ALTER TABLE users ADD COLUMN site_code TEXT;
    ALTER TABLE users ADD COLUMN warehouse_name TEXT;
    ALTER TABLE users ADD COLUMN manager_scope TEXT;
    CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
    CREATE TABLE partner_visits(customer_id TEXT,visited_at TEXT);
    INSERT INTO manager_agents VALUES('regional','agent-a');`);
  const insertUser=sql.prepare(`INSERT INTO users
    (id,username,name,role,warehouse_id,warehouse_name,site_code,manager_scope,password_hash)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  insertUser.run('agent-a','private-a','Synthetic Agent A','agent','warehouse-a','TR Example A','SITE-A','assigned','synthetic-auth-marker');
  insertUser.run('agent-b','private-b','Synthetic Agent B','agent','warehouse-b','TR Example B','SITE-B','assigned','synthetic-auth-marker');
  insertUser.run('regional','private-region','Synthetic Manager','manager',null,null,'','assigned','synthetic-auth-marker');
  const rules={version:1,revision:'synthetic',history:'all',products:{'SIM-A':'vodafone_0','ACCESSORY':'accessories','SIM-B':'digi'},
    assignments:[{userId:'agent-a',siteCode:'SITE-A',projectId:'non_exclusiv',territoryId:null,counties:[]},
      {userId:'agent-b',siteCode:'SITE-B',projectId:'non_exclusiv',territoryId:null,counties:[]}]};
  sql.prepare('INSERT INTO settings VALUES(?,?)').run('distribution-rules-v1',JSON.stringify(rules));
  const insertPartner=sql.prepare('INSERT INTO customers(id,warehouse_id,data) VALUES (?,?,?)');
  insertPartner.run('private-point-id-a','warehouse-a',JSON.stringify({
    name:'Synthetic Partner A secret@example.invalid',historyCatalog:{franchiseCode:'F-01'},county:'Iași',city:'Iași',
    address:'Private address marker',cui:'Synthetic tax marker',contact:'Private contact marker',phone:'0700000000',email:'secret@example.invalid',
  }));
  insertPartner.run('private-point-id-b','warehouse-b',JSON.stringify({name:'Outside Partner',historyCatalog:{franchiseCode:'F-02'}}));
  sql.prepare('INSERT INTO partner_visits VALUES (?,?)').run('private-point-id-a','2026-07-21T12:00:00Z');
  const addOrder=sql.prepare(`INSERT INTO orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at)
    VALUES(?,?,?,?,?,'finalized',?,'2026-08-09T12:00:00Z','2026-08-10T12:00:00Z')`);
  addOrder.run('order-a','opaque-source-document-a','agent-a','warehouse-a','sim',JSON.stringify({
    warehouseName:'TR Example A',serials:['000000000000000001','000000000000000002'],
    client:{name:'Synthetic Partner A',cui:'Private order tax marker'},
  }));
  addOrder.run('order-product','opaque-source-product','agent-a','warehouse-a','accessories',JSON.stringify({
    warehouseName:'TR Example A',items:[{code:'ACCESSORY',name:'Synthetic non-Vodafone product',quantity:4}],
  }));
  addOrder.run('order-b','opaque-source-document-b','agent-b','warehouse-b','accessories',JSON.stringify({
    warehouseName:'TR Example B',items:[{code:'ACCESSORY',name:'Outside Product',quantity:99}],
  }));

  const current={rowNumber:1,date:'2026-08-14',month:'2026-08',siteCode:'SITE-A',itemCode:'ACCESSORY',itemName:'Synthetic cable',
    quantity:2,valueCents:24099,priceCents:12050,brand:'Example',location:'TR Example A',company:'Private raw company',
    asm:'Private manager',regional:'Private zone',orderNumber:'Private ERP reference',category:'Cabluri',subCategory:'',agent:'Private source person'};
  m.importSalesRows({rows:[current,{...current,rowNumber:2,siteCode:'SITE-B',location:'TR Example B',valueCents:999999}],
    month:current.month,fileHash:'synthetic',filename:'synthetic.xlsx',importedBy:'synthetic',originalPath:'synthetic.xlsx',
    expectedRevision:0,expectedMappingHash:'same',currentMappingHash:'same',historicalAcknowledged:true});
  mkdirSync(join(root,'client-history'));
  const history=new DatabaseSync(join(root,'client-history','client-sales-history.sqlite'));
  history.exec(`CREATE TABLE history_imports(id INTEGER PRIMARY KEY,period_start TEXT,period_end TEXT,imported_at TEXT,state TEXT);
    CREATE TABLE history_rows(import_id INTEGER,date TEXT,tr TEXT,site_id TEXT,item_code TEXT,item_name TEXT,brand TEXT,category TEXT,
      article_type TEXT,quantity_micros INTEGER,value_cents INTEGER,source_row INTEGER);
    INSERT INTO history_imports VALUES(1,'2026-07-01','2026-08-31','2026-09-01','active');
    INSERT INTO history_rows VALUES
      (1,'2026-07-05','TR Example A','ERP-A','ACCESSORY','Synthetic cable','Example','Cabluri','Accesorii',1000000,NULL,1),
      (1,'2026-07-06','TR Example A','ERP-A','ACCESSORY','Synthetic cable','Example','Cabluri','Accesorii',-1000000,-12050,2),
      (1,'2026-07-07','TR Example B','ERP-B','ACCESSORY','Outside Product','Example','Cabluri','Accesorii',1000000,888888,3),
      (1,'2026-08-05','TR Example A','ERP-A','ACCESSORY','Overlapping history','Example','Cabluri','Accesorii',1000000,777777,4);`);
  history.close();

  for(const provider of ['vodafone','digi']){
    const directory=provider==='vodafone'?root:join(root,'digi');
    if(provider==='digi')mkdirSync(directory);
    const source=new DatabaseSync(join(directory,'activations.sqlite'));
    source.exec(`CREATE TABLE activation_meta(key TEXT,value TEXT);
      INSERT INTO activation_meta VALUES('schema_version','2');
      CREATE TABLE activation_imports(sha256 TEXT,operator TEXT,row_count INTEGER,parser_version INTEGER,status TEXT);
      INSERT INTO activation_imports VALUES('synthetic','${provider}',2,1,'complete');`);
    source.close();
    const projected=new DatabaseSync(join(directory,'activation-report.sqlite'));
    projected.exec(`CREATE TABLE report_meta(key TEXT,value TEXT);
      CREATE TABLE sites(site TEXT,label TEXT);
      CREATE TABLE dimension_monthly(provider TEXT,month TEXT,site TEXT,item_type TEXT,county TEXT,handset TEXT,
        contradictory INTEGER,is_tr INTEGER,count INTEGER,last_date TEXT);
      CREATE TABLE details(provider TEXT,month TEXT,site TEXT,activation_date TEXT,item_code TEXT,item_type TEXT,county TEXT,
        handset TEXT,contradictory INTEGER,is_tr INTEGER,serial TEXT,client_code TEXT);
      CREATE TABLE cohorts(provider TEXT,site TEXT,distribution_month TEXT,item_code TEXT,activated INTEGER);
      INSERT INTO sites VALUES('SITE-A','Synthetic TR A'),('SITE-B','Synthetic TR B');`);
    const meta=projected.prepare('INSERT INTO report_meta VALUES (?,?)');
    for(const [key,value] of Object.entries({version:'4',builtAt:'2026-08-20',latestDate:'2026-08-20',importedAt:'2026-08-20',
      rules:JSON.stringify(rules),sourceImports:JSON.stringify([['synthetic',provider,2,1]]),
      sourcePeriods:'[{"from":"2026-08-01","to":"2026-08-20"}]'}))meta.run(key,value);
    for(const site of ['SITE-A','SITE-B']){
      projected.prepare('INSERT INTO dimension_monthly VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        provider,'2026-08',site,'SIM','Iași','synthetic channel',0,1,1,'2026-08-20');
      projected.prepare('INSERT INTO details VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(provider,'2026-08',site,'2026-08-20',
        provider==='digi'?'SIM-B':'SIM-A','SIM','Iași','synthetic channel',0,1,'000000000000000003','activation-tax-marker');
    }
    projected.close();
  }

  const manager={id:'regional',role:'manager',active:1,managerScope:'assigned',profileVersion:'1'};
  const globals={...manager,id:'global',managerScope:'global'};
  const scope=await m.managerAiScope(manager,new URLSearchParams());
  const read=(table,fromMonth='2026-08',toMonth=fromMonth)=>m.readManagerAiAnalysisTable(scope,{table,fromMonth,toMonth},async()=>manager);
  const data=value=>value.rows.map(r=>Object.fromEntries(value.columns.map((column,i)=>[column.name,r[i]])));
  const sales=await read('sales_lines','2026-07','2026-09');
  assert.deepEqual(data(sales).map(row=>[row.site_code,row.value_cents,row.source]),[
    ['SITE-A',null,'client_history'],['SITE-A',-12050,'client_history'],['SITE-A',24099,'monthly_import'],
  ]);
  assert.deepEqual(sales.coverage.map(row=>[row.month,row.available,row.through??null]),
    [['2026-07',true,'2026-07-31'],['2026-08',true,'2026-08-14'],['2026-09',false,null]]);
  const partners=await read('partners');
  assert.deepEqual(data(partners).map(row=>[row.partner,row.franchise_code,row.last_visit_date]),
    [['Synthetic Partner A [contact]','F-01','2026-07-21']]);
  const orders=await read('orders');
  assert.deepEqual(data(orders).map(row=>[row.kind,row.units,row.product_group]),[
    ['sim',2,'vodafone_0'],['accessories',4,'accessories'],
  ]);
  const activations=await read('activation_detail');
  assert.deepEqual(data(activations).map(row=>[row.provider,row.site_code,row.sku,row.activations]),[
    ['vodafone','SITE-A','SIM-A',1],['digi','SITE-A','SIM-B',1],
  ]);
  process.env.MOBIUP_ACTIVATIONS_VODAFONE_ONLY_MANAGER_IDS='regional';
  const monthly=await read('activation_monthly');
  assert.deepEqual(data(monthly).map(row=>row.provider),['vodafone']);
  assert.equal(monthly.coverage[1].available,false);
  const elected=await m.managerAiScope(globals,new URLSearchParams({agentId:'agent-b'}));
  const siteB=await m.readManagerAiAnalysisTable(elected,{table:'sales_lines',fromMonth:'2026-08',toMonth:'2026-08'},async()=>globals);
  assert.deepEqual(data(siteB).map(row=>row.site_code),['SITE-B']);
  await assert.rejects(()=>m.readManagerAiAnalysisTable(scope,{table:'partners',fromMonth:'2026-08',toMonth:'2026-08'},async()=>globals),{status:409});
  await assert.rejects(()=>read('unknown'),{status:400});
  await assert.rejects(()=>read('sales_lines','2025-06','2026-08'),{status:400});

  const file=join(root,'export.sqlite');
  const bytes=await m.materializeManagerAiDatabase([sales,partners,orders,activations]);
  const text=Buffer.from(bytes).toString();
  for(const privateValue of ['secret@example.invalid','0700000000','Private address marker','Private contact marker','synthetic-auth-marker',
    'Private raw company','Private order tax marker','Private ERP reference','opaque-source-document-a','000000000000000001','000000000000000003',
    'private-point-id-a','Outside Product','Outside Partner','activation-tax-marker',root])assert(!text.includes(privateValue),privateValue);
  writeFileSync(file,bytes);
  const extract=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(extract.prepare("SELECT SUM(value_cents) cents FROM sales_lines WHERE sku='ACCESSORY'").get().cents,12049);
    assert.equal(extract.prepare("SELECT COUNT(*) rows FROM _coverage WHERE available=0").get().rows,1);
    assert.equal(extract.prepare("SELECT row_count FROM _datasets WHERE table_name='activation_detail'").get().row_count,2);
    assert.deepEqual(extract.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(item=>item.name),
      ['_coverage','_datasets','activation_detail','orders','partners','sales_lines']);
  }finally{extract.close();}

  const bulk={...partners,rows:Array(m.managerAiAnalysisLimits.rows+1).fill(partners.rows[0])};
  await assert.rejects(()=>m.materializeManagerAiDatabase([bulk]),{status:413});
  const abort=new AbortController();
  const building=m.materializeManagerAiDatabase([{...partners,rows:Array(3_000).fill(partners.rows[0])}],abort.signal);
  abort.abort();
  await assert.rejects(building,{name:'AbortError'});
  console.log('PASS: manager analytical sales precedence, historical nulls/returns, scope, Digi permissions, SIM counts, private-field omission and bounded SQLite materialization.');
}finally{
  sql.close();
  delete globalThis.syntheticManagerAnalysisDb;
  rmSync(root,{recursive:true,force:true});
}
