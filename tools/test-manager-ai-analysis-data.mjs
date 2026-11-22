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
  const activationApi=join(root,'activation-store.ts');
  writeFileSync(activationApi,`export * from ${JSON.stringify(resolve('lib/activation-store-node.ts'))};
    export const readVodafoneSim0RankingAsync=options=>globalThis.syntheticAnalysisSim0(options);`);
  await build({
    stdin:{resolveDir:process.cwd(),contents:`
      export * from './lib/manager-ai-analysis-data';
      export * from './lib/manager-ai-analysis-database';
      export {managerAiScope} from './lib/manager-ai-data';
      export {importSalesRows} from './lib/sales-store';
      export {scanManagerAiAnalysisSales} from './lib/manager-ai-analysis-sales';
      export {selectedSql} from './lib/portfolio-read-model';
    `},
    bundle:true,platform:'node',format:'esm',outfile:modulePath,
    alias:{
      '#mobiup-activation-store':activationApi,
      '#mobiup-import-engine':resolve('lib/import-engine-node.ts'),
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
  sql.exec(readFileSync('drizzle/0015_activation_portfolio_memberships.sql','utf8'));
  sql.exec(`ALTER TABLE users ADD COLUMN site_code TEXT;
    ALTER TABLE users ADD COLUMN warehouse_name TEXT;
    ALTER TABLE users ADD COLUMN manager_scope TEXT;
    CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
    CREATE TABLE partner_visits(customer_id TEXT,visited_at TEXT);
    CREATE TABLE portfolio_revision(id INTEGER,data_revision INTEGER,scope_revision INTEGER);
    INSERT INTO portfolio_revision VALUES(1,1,1);
    CREATE TABLE portfolio_read_rows(id TEXT PRIMARY KEY);
    INSERT INTO portfolio_read_rows VALUES('private-point-id-a'),('private-point-id-b');
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
  sql.prepare('INSERT INTO settings VALUES (?,?)').run('agent-stock-v1',JSON.stringify({warehouses:{
    'warehouse-a':{warehouseId:'warehouse-a',importedAt:'2026-08-20T08:00:00Z',rows:[
      {code:'UNKNOWN-STOCK',name:'Unclassified stock',quantity:8},
      {code:'SIM-B',name:'Digi stock',quantity:2},
    ]},
  },mappings:{},history:[]}));
  const insertPartner=sql.prepare('INSERT INTO customers(id,warehouse_id,data) VALUES (?,?,?)');
  insertPartner.run('private-point-id-a','warehouse-a',JSON.stringify({
    name:'Synthetic Partner A secret@example.invalid',historyCatalog:{franchiseCode:' f-01 '},historyFranchises:['f-old'],county:'Iași',city:'Iași',
    address:'Private address marker',cui:'9876543210000',contact:'Private contact marker',phone:'0700000000',email:'secret@example.invalid',
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

  addOrder.run('order-stand','opaque-source-stand','agent-a','warehouse-a','stand_client',JSON.stringify({
    warehouseName:'TR Example A',items:[{code:'STAND',name:'Synthetic stand',quantity:3}],client:{name:'Synthetic Partner A'},
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
      (1,'2026-08-05','TR Example A','ERP-A','ACCESSORY','Overlapping history','Example','Cabluri','Accesorii',1000000,777777,4);
    ALTER TABLE history_imports ADD COLUMN sha256 TEXT DEFAULT 'synthetic';
    ALTER TABLE history_rows ADD COLUMN identity_id INTEGER;
    ALTER TABLE history_rows ADD COLUMN document_number TEXT DEFAULT 'synthetic billing document';
    ALTER TABLE history_rows ADD COLUMN customer_name TEXT DEFAULT 'Synthetic fiscal label';
    ALTER TABLE history_rows ADD COLUMN sheet TEXT DEFAULT 'Sheet';
    UPDATE history_rows SET identity_id=CASE source_row WHEN 3 THEN 2 ELSE 1 END;
    CREATE TABLE history_meta(key TEXT,value TEXT);
    INSERT INTO history_meta VALUES('current_reference','reference');
    CREATE TABLE history_identities(id INTEGER,client_code TEXT,franchise_code TEXT);
    INSERT INTO history_identities VALUES(1,'9876543210000','F-OLD'),(2,'1234567890000','F-02');
    CREATE TABLE history_allocations(reference_id TEXT,identity_id INTEGER,status TEXT,point_key TEXT,partner_ids_json TEXT);
    INSERT INTO history_allocations VALUES
      ('reference',1,'direct_code','franchise:F-OLD','["private-point-id-a"]'),
      ('reference',2,'direct_code','franchise:F-02','["private-point-id-b"]');`);
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
        handset TEXT,contradictory INTEGER,is_tr INTEGER,serial TEXT,client_code TEXT,company TEXT,point_key TEXT,point_code TEXT,label TEXT);
      CREATE TABLE cohorts(provider TEXT,site TEXT,distribution_month TEXT,item_code TEXT,activated INTEGER);
      INSERT INTO sites VALUES('SITE-A','Synthetic TR A'),('SITE-B','Synthetic TR B');`);
    const meta=projected.prepare('INSERT INTO report_meta VALUES (?,?)');
    for(const [key,value] of Object.entries({version:'4',builtAt:'2026-08-20',latestDate:'2026-08-20',importedAt:'2026-08-20',
      rules:JSON.stringify(rules),sourceImports:JSON.stringify([['synthetic',provider,2,1]]),
      sourcePeriods:'[{"from":"2026-08-01","to":"2026-08-20"}]'}))meta.run(key,value);
    for(const site of ['SITE-A','SITE-B']){
      projected.prepare('INSERT INTO dimension_monthly VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        provider,'2026-08',site,'SIM','Iași','synthetic channel',0,1,1,'2026-08-20');
      projected.prepare('INSERT INTO details VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(provider,'2026-08',site,'2026-08-20',
        provider==='digi'?'SIM-B':'SIM-A','SIM','Iași','synthetic channel',0,1,'000000000000000003',
        site==='SITE-A'?'9876543210000':'activation-tax-marker','synthetic source',
        site==='SITE-A'?'franchise:F-OLD':'',site==='SITE-A'?'F-OLD':'','Synthetic activation label');
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
  const teamSales=await read('sales_team_monthly','2026-07','2026-09');
  const rows=data(teamSales);
  const august=rows.find(row=>row.month==='2026-08'&&row.product_group==='accessories');
  assert.equal(august.agent,'Synthetic Agent A');
  assert.equal(august.manager,'Synthetic Manager');
  assert.equal(august.project_id,'non_exclusiv');
  assert.equal(august.units,2);
  assert.equal(august.value_cents,24099);
  assert.equal(august.agent_last_sale,'2026-08-14');
  assert.equal(august.source_through,'2026-08-14');
  assert.equal(rows.find(row=>row.month==='2026-07'&&row.product_group==='accessories').value_cents,null);
  assert.equal(rows.find(row=>row.month==='2026-08'&&row.product_group==='vodafone_5').units,0);
  assert.equal(rows.find(row=>row.month==='2026-09'&&row.product_group==='accessories').units,null);
  assert(rows.every(row=>row.agent==='Synthetic Agent A'&&row.manager==='Synthetic Manager'));
  insertUser.run('agent-c','private-c','Synthetic Agent C','agent','warehouse-c','TR Example C','SITE-C','assigned','synthetic-auth-marker');
  sql.prepare('INSERT INTO manager_agents VALUES(?,?)').run('regional','agent-c');
  const largerScope=await m.managerAiScope(manager,new URLSearchParams());
  const enrolled=data(await m.readManagerAiAnalysisTable(largerScope,{table:'sales_team_monthly',fromMonth:'2026-08',toMonth:'2026-08'},async()=>manager));
  const eligible=enrolled.filter(row=>row.product_group==='accessories');
  assert.equal(new Set(eligible.map(row=>row.agent_ref)).size,2);
  assert.equal(eligible.reduce((sum,row)=>sum+row.value_cents,0)/eligible.length,12049.5);
  insertUser.run('second-region','private-m','Second Manager','manager',null,null,'','assigned','synthetic-auth-marker');
  sql.prepare('INSERT INTO manager_agents VALUES(?,?)').run('second-region','agent-a');
  const sharedScope=await m.managerAiScope(globals,new URLSearchParams({agentId:'agent-a'}));
  const shared=data(await m.readManagerAiAnalysisTable(sharedScope,{table:'sales_team_monthly',fromMonth:'2026-08',toMonth:'2026-08'},async()=>globals));
  const sharedSales=shared.filter(row=>row.product_group==='accessories');
  assert.deepEqual(sharedSales.map(row=>row.manager),['Synthetic Manager','Second Manager']);
  assert.equal(new Set(sharedSales.map(row=>row.agent_ref)).size,1);
  assert.equal(new Set(sharedSales.map(row=>row.manager_ref)).size,2);
  const regionalRows=data(await m.readManagerAiAnalysisTable(largerScope,{table:'sales_team_monthly',fromMonth:'2026-08',toMonth:'2026-08'},async()=>manager));
  assert(regionalRows.every(row=>row.manager==='Synthetic Manager'));
  sql.prepare('DELETE FROM manager_agents WHERE manager_id=?').run('second-region');
  sql.prepare('DELETE FROM users WHERE id=?').run('second-region');
  sql.prepare('DELETE FROM manager_agents WHERE agent_id=?').run('agent-c');
  sql.prepare('DELETE FROM users WHERE id=?').run('agent-c');
  const allTeams=await m.managerAiScope(globals,new URLSearchParams());
  const teamRequest={table:'sales_team_monthly',fromMonth:'2026-08',toMonth:'2026-08'};
  const national=data(await m.readManagerAiAnalysisTable(allTeams,teamRequest,async()=>globals));
  const unassigned=national.find(row=>row.agent==='Synthetic Agent B'&&row.product_group==='accessories');
  assert.equal(unassigned.manager,null);
  assert.equal(unassigned.manager_ref,null);
  assert.equal(unassigned.value_cents,999999);
  let checks=0;
  await assert.rejects(m.readManagerAiAnalysisTable(allTeams,teamRequest,async()=>{
    if(++checks===3) sql.prepare('INSERT INTO manager_agents VALUES(?,?)').run('regional','agent-b');
    return globals;
  }),{status:409});
  sql.prepare('DELETE FROM manager_agents WHERE agent_id=?').run('agent-b');
  sql.prepare('UPDATE users SET warehouse_name=?,site_code=? WHERE id=?').run('TR Current A','CURRENT-A','agent-a');
  sql.prepare('INSERT INTO settings VALUES(?,?)').run('sales-agent-aliases-v1',JSON.stringify([
    {userId:'agent-a',siteCode:'SITE-A',warehouseName:'TR Example A'},
  ]));
  const renamed=await m.managerAiScope(manager,new URLSearchParams());
  const historicalAlias=data(await m.readManagerAiAnalysisTable(renamed,teamRequest,async()=>manager))
    .find(row=>row.agent==='Synthetic Agent A'&&row.product_group==='accessories');
  assert.equal(historicalAlias.value_cents,24099);
  sql.prepare('DELETE FROM settings WHERE key=?').run('sales-agent-aliases-v1');
  sql.prepare('UPDATE users SET warehouse_name=?,site_code=? WHERE id=?').run('TR Example A','SITE-A','agent-a');
  const partners=await read('partners');
  assert.deepEqual(data(partners).map(row=>[row.partner,row.franchise_code,row.last_visit_date]),
    [['Synthetic Partner A [contact]','F-01','2026-07-21']]);
  const membership=m.selectedSql(manager,new URLSearchParams(),scope.filter.warehouseIds);
  assert.deepEqual(sql.prepare(`SELECT m.id FROM ${membership.from} WHERE ${membership.where}`).all(...membership.args).map(row=>row.id),['private-point-id-a']);
  const orders=await read('orders'), stands=await read('stands'), stock=await read('stock');
  assert.deepEqual(data(orders).map(row=>[row.kind,row.units,row.sim_zero_units,row.product_group]),[
    ['sim',null,2,'vodafone_0'],['accessories',4,null,'accessories'],
  ]);
  assert.deepEqual(data(stands).map(row=>[row.sku,row.units]),[['STAND',3]]);
  assert.deepEqual(data(stock).map(row=>[row.sku,row.product_group]),[['UNKNOWN-STOCK','unmapped'],['SIM-B','digi']]);
  assert.match(stock.coverage[0].note,/toate categoriile/);
  const billing=await read('sales_partner_lines','2026-07'), activationPartners=await read('activation_partners');
  const point=data(partners)[0].point_ref;
  assert.deepEqual(data(billing).map(row=>[row.point_ref,row.franchise_code]),[[point,'F-OLD'],[point,'F-OLD']]);
  assert.deepEqual(data(activationPartners).map(row=>[row.point_ref,row.franchise_code]),[[point,'F-OLD'],[point,'F-OLD']]);
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

  let sim0Reads=0;
  globalThis.syntheticAnalysisSim0=async options=>{
    assert.deepEqual(options.scope,['SITE-A']);
    assert.deepEqual([options.fromMonth,options.toMonth],['2026-01','2026-02']);
    sim0Reads++;
    return {revision:'fixture',rows:[
      {month:'2026-01',cui:'8000014',partner:'Firma fictivă',franchise:'F-01',activations:3,confirmedActivations:1},
      {month:'2026-02',cui:'8000014',partner:'Firma fictivă',franchise:'F-02',activations:2,confirmedActivations:0}],
      coverage:[
        {month:'2026-01',sourceThrough:'2026-01-31',status:'complete',reported:true,excludedActivations:2,exclusions:{'punct neidentificat':2}},
        {month:'2026-02',sourceThrough:'2026-02-19',status:'partial',expectedThrough:'2026-02-28',ranges:['2026-02-01–2026-02-19'],reported:false,excludedActivations:1,exclusions:{'CUI nevalid':1}}]};
  };
  const sim0=await read('activation_sim0_clients','2026-01','2026-02');
  assert.equal(sim0Reads,1);
  assert.equal(sim0.coverage[1].through,'2026-02-19');
  assert.match(sim0.coverage[0].note,/doar contribuțiile/);
  assert.equal(sim0.coverage[1].available,false);
  const allowedPilot=process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID;
  delete process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID;
  const denied=await read('activation_sim0_clients','2026-01','2026-02');
  assert.deepEqual(denied.rows,[]);
  assert.deepEqual(denied.coverage.map(c=>[c.month,c.available]),[['2026-01',false],['2026-02',false]]);
  assert.match(denied.coverage[0].note,/acestui cont/);
  process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID=allowedPilot;
  globalThis.syntheticAnalysisSim0=async()=>{throw Error('unavailable');};
  const unavailable=await read('activation_sim0_clients');
  assert.deepEqual(unavailable.rows,[]);
  assert.match(unavailable.coverage[0].note,/momentan indisponibilă/);
  delete globalThis.syntheticAnalysisSim0;
  const sim0file=join(root,'sim0.sqlite');
  writeFileSync(sim0file,await m.materializeManagerAiDatabase([sim0]));
  const sim0db=new DatabaseSync(sim0file,{readOnly:true});
  try {
    const totals=sim0db.prepare('SELECT cui,SUM(activations),COUNT(DISTINCT franchise_code),SUM(confirmed_activations) FROM activation_sim0_clients GROUP BY cui').get();
    assert.deepEqual(Object.values(totals),['8000014',5,2,1]);
  } finally {sim0db.close();}
  const file=join(root,'export.sqlite');
  const bytes=await m.materializeManagerAiDatabase([sales,partners,orders,activations,billing,activationPartners]);
  const text=Buffer.from(bytes).toString();
  for(const privateValue of ['secret@example.invalid','0700000000','Private address marker','Private contact marker','synthetic-auth-marker',
    'Private raw company','Private order tax marker','Private ERP reference','opaque-source-document-a','000000000000000001','000000000000000003',
    'private-point-id-a','Outside Product','Outside Partner','activation-tax-marker','9876543210000',root])assert(!text.includes(privateValue),privateValue);
  writeFileSync(file,bytes);
  const extract=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(extract.prepare("SELECT SUM(value_cents) cents FROM sales_lines WHERE sku='ACCESSORY'").get().cents,12049);
    assert.equal(extract.prepare("SELECT COUNT(*) rows FROM _coverage WHERE available=0").get().rows,1);
    assert.equal(extract.prepare("SELECT row_count FROM _datasets WHERE table_name='activation_detail'").get().row_count,2);
    assert.equal(extract.prepare(`SELECT COUNT(*) n FROM sales_partner_lines b JOIN partners p USING(point_ref)
      JOIN activation_partners a USING(point_ref) WHERE a.provider='vodafone' AND p.franchise_code='F-01' AND b.franchise_code='F-OLD'`).get().n,2);
    assert.deepEqual(extract.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(item=>item.name),
      ['_coverage','_datasets','activation_detail','activation_partners','orders','partners','sales_lines','sales_partner_lines']);
  }finally{extract.close();}

  const bulk={...partners,rows:Array(m.managerAiAnalysisLimits.rows+1).fill(partners.rows[0])};
  await assert.rejects(()=>m.materializeManagerAiDatabase([bulk]),{status:413});
  const abort=new AbortController();
  const building=m.materializeManagerAiDatabase([{...partners,rows:Array(3_000).fill(partners.rows[0])}],abort.signal);
  abort.abort();
  await assert.rejects(building,{name:'AbortError'});
  const replacement=new DatabaseSync(join(root,'client-history','client-sales-history.sqlite'));
  try {
    replacement.exec('PRAGMA journal_mode=WAL');
    let changed=false;
    await assert.rejects(()=>m.scanManagerAiAnalysisSales('2026-07',undefined,()=>{
      if(changed)return;
      changed=true;
      replacement.exec('UPDATE history_rows SET value_cents=12 WHERE source_row=1');
    }),{status:409,message:'Sursele vânzărilor s-au modificat. Reia analiza.'});
    assert(changed,'the source changed during the pinned read');
  } finally {replacement.close();}
  console.log('PASS: manager analytical sales precedence, historical nulls/returns, scope, Digi permissions, SIM counts, private-field omission and bounded SQLite materialization.');
}finally{
  sql.close();
  delete globalThis.syntheticManagerAnalysisDb;
  rmSync(root,{recursive:true,force:true});
}
