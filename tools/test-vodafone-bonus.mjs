import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {deserialize} from 'node:v8';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import XLSX from 'xlsx';

const root=mkdtempSync(join(tmpdir(),'synthetic-vodafone-bonus-'));
try {
  const bundle=join(root,'bonus.mjs');
  await build({stdin:{contents:`
    export * from './lib/vodafone-bonus-rules';
    export * from './lib/vodafone-sim0-coverage';
    export * from './lib/vodafone-bonus-types';
    export * from './lib/vodafone-bonus-ledger';
    export * from './lib/vodafone-bonus-node';
    export * from './lib/vodafone-activation-ranking-node';
    export * from './lib/vodafone-bonus-evidence';
    export * from './lib/vodafone-bonus-export';
  `,resolveDir:process.cwd()},outfile:bundle,bundle:true,format:'esm',platform:'node'});
  const {vodafoneBonusPreview,filterVodafoneBonusRows,bonusProjectSites,isVodafoneGenericPartner,vodafoneDocumentKind,vodafoneSim0Bonus,vodafoneBonusLedger,readVodafoneBonus,parseVodafoneBonusEvidence,vodafoneBonusWorkbook}
    =await import(pathToFileURL(bundle).href);
  const scopedRules={assignments:[{siteCode:'test-n',projectId:'vodafone_nord'},{siteCode:'test-s',projectId:'vodafone_sud'}]};
  const allProjects=new Set(['vodafone_sud','vodafone_nord','non_exclusiv']);
  assert.equal(bonusProjectSites(null,scopedRules,allProjects),null);
  assert.deepEqual(bonusProjectSites(['HISTORICAL-SITE'],scopedRules,allProjects),['HISTORICAL-SITE']);
  assert.deepEqual(bonusProjectSites(null,scopedRules,new Set(['vodafone_nord'])),['TEST-N']);
  assert.deepEqual(bonusProjectSites(['TEST-S'],scopedRules,new Set(['vodafone_nord'])),[]);
  assert.deepEqual(bonusProjectSites(null,scopedRules,new Set()),[]);
  for (const alias of ['clientgeneric','PARTENER  generic', '<Generic partner>', 'CLIENT GEN. 001','PARTENER GENERIC NEIDENTIFICAT',
    '(géneric client default)','Partener client generic','clientul generic','GenericClient','<GENERIC PARTNER>']) assert.equal(isVodafoneGenericPartner(alias),true,alias);
  for (const company of ['Generic Example SRL','Super Generic Partner LLC','Factory Consum SRL','Client Genesis SRL','S.C. PARTENER GENERIC SRL']) {
    assert.equal(isVodafoneGenericPartner(company),false,company);
  }
  for (const type of ['Bon de consum 10', 'REGLARE GESTIUNE', 'Reglare de gestiune', 'Ajustare stoc', 'Corecție de stoc']) {
    assert.equal(vodafoneDocumentKind(['Factură',type]),'excluded');
  }
  assert.equal(vodafoneDocumentKind(['12345']),'unknown');
  assert.equal(vodafoneDocumentKind(['Aviz de însoțire a mărfii'],'payment'),'unknown');
  assert.equal(vodafoneDocumentKind(['Factură 12345'],'payment'),'commercial');
  assert.deepEqual([0,2,3,4,5,9,10,15,19,20,29,30].map(vodafoneSim0Bonus),[0,0,1,1,2,2,5,5,5,10,10,15]);

  const companies={fixture:'SYNTHETIC-A',partner:'Example customer'};
  const act=(month,site,pointCode,reason='commercial')=>({month,site,pointCode,cui:companies.fixture,partner:companies.partner,reason});
  const doc=(date,number,pointCode,quantity,reason='commercial',site='A')=>({date,number,company:'Fictional ERP',siteId:'SYNTHETIC-SITE',sites:[site],pointCode,cui:companies.fixture,partner:companies.partner,reason,quantity});
  const input={
    activation:[
      act('2026-06','A','P1'),act('2026-06','B','P1'),act('2026-06','A','P1'),act('2026-06','A','P2'),act('2026-06','A','P2'),
      ...Array.from({length:5},()=>act('2026-07','A','P1')),
      act('2026-06','A','P2','excluded'),
    ],
    documents:[doc('2026-08-09','doc-2','P1',2),doc('2026-08-08','doc-1','P1',3)],
    coverage:[
      {month:'2026-06',sourceThrough:'2026-06-30',publishedOn:'2026-07-03'},
      {month:'2026-07',sourceThrough:'2026-07-31',publishedOn:'2026-08-04'},
      {month:'2026-08',sourceThrough:'2026-08-17',publishedOn:null},
    ],
    targets:[{pointCode:'P1',month:'2026-06',target:4,bonus:1},{pointCode:'P1',month:'2026-07',target:8,bonus:0}],
    portfolios:[],revision:'synth',
  };
  assert.equal(vodafoneBonusLedger(input,null,null).points.find(x=>x.pointCode==='P2').sim0Bonus,0,'two locations sharing a CUI keep separate thresholds');
  const august=vodafoneBonusLedger(input,null,'2026-08');
  assert.deepEqual(august.documents[0].allocations.filter(x=>x.status==='confirmed'),[
    {month:'2026-06',kind:'SIM 0',quantity:1,status:'confirmed'},
    {month:'2026-06',kind:'Top Locații',quantity:1,status:'confirmed'},
    {month:'2026-07',kind:'SIM 0',quantity:1,status:'confirmed'},
  ]);
  const scoped=vodafoneBonusLedger(input,['A'],'2026-06');
  const shared=scoped.points.find(row=>row.pointCode==='P1');
  assert.equal(shared.activations,2);
  assert.equal(shared.sim0Bonus,null);
  assert.equal(shared.applied,null);
  assert.deepEqual(scoped.documents,[]);
  assert.doesNotMatch(JSON.stringify(scoped),/"site":"B"/);
  const foreignName='Fictional alias from another warehouse';
  const labelInput={...input,activation:[
    {...act('2026-06','B','P1'),partner:foreignName},
    ...input.activation.map(row=>row.site==='B'?{...row,partner:foreignName}:row),
  ]};
  assert.equal(vodafoneBonusLedger(labelInput,['A'],'2026-06').points.find(row=>row.pointCode==='P1').partner,companies.partner);
  assert.ok(!JSON.stringify(vodafoneBonusLedger(labelInput,['A'],'2026-06')).includes(foreignName));
  const supplemental={...input,
    documents:[...input.documents,{...doc('2026-08-10','doc-3','ONLY-INVOICE',1),partner:'Invoice point'}],
    portfolios:[{pointCode:'ONLY-TARGET',cui:companies.fixture,sites:[{site:'B',partner:foreignName},{site:'A',partner:'Target point'}]}],
    targets:[...input.targets,{pointCode:'ONLY-TARGET',month:'2026-06',target:4,bonus:0}],
  };
  const labelRows=vodafoneBonusLedger(supplemental,['A'],null).points;
  assert.equal(labelRows.find(row=>row.pointCode==='ONLY-INVOICE').partner,'Invoice point');
  assert.equal(labelRows.find(row=>row.pointCode==='ONLY-TARGET').partner,'Target point');
  const unknownOldTarget={...input,
    activation:input.activation.filter(row=>row.site!=='B'),
    targets:[{pointCode:'P1',month:'2026-06',target:2,bonus:null},input.targets[1]],
  };
  for (const activation of [unknownOldTarget.activation,unknownOldTarget.activation.filter(row=>row.month!=='2026-06')]) {
    const unresolvedCampaign=vodafoneBonusLedger({...unknownOldTarget,activation},null,null);
    assert.ok(unresolvedCampaign.documents.every(row=>row.allocations.every(allocation=>allocation.status==='simulation')));
    assert.equal(unresolvedCampaign.documents[0].allocations[0].month,'2026-07');
    assert.equal(unresolvedCampaign.points.find(row=>row.month==='2026-07'&&row.pointCode==='P1').remaining,null);
  }
  // Without the earlier campaign statement, a later balance cannot be certified.
  const incompleteCampaign={
    ...input,
    activation:[act('2026-06','A','P1'),...input.activation.filter(row=>row.month==='2026-07')],
    targets:[input.targets[1]],
  };
  const gap=vodafoneBonusLedger(incompleteCampaign,null,null);
  const july=gap.points.find(row=>row.month==='2026-07' && row.pointCode==='P1');
  assert.equal(july.remaining,null,'missing June campaign must keep the July balance unconfirmed');
  assert.equal(july.simulatedApplied,2,'SIM 0 simulation remains available');
  assert.ok(gap.documents.every(row=>row.allocations.every(allocation=>allocation.status==='simulation')));

  const full=vodafoneBonusLedger(input,null,null);
  assert.equal(vodafoneBonusPreview(full),full,'small reports are already complete');
  const expanded={...full,points:Array.from({length:53},(_,i)=>({...full.points[0],pointCode:'sample-'+i,topBonus:i===52?null:3,partial:i===52}))};
  const preview=vodafoneBonusPreview(expanded);
  assert.equal(preview.points.length,50);
  assert.deepEqual(preview.months,full.months);
  assert.equal(preview.preview.counts.points,53);
  assert.equal(preview.preview.hasPartialPoints,true);
  assert.equal(preview.preview.hasUnknownTopBonus,true);
  assert.equal(filterVodafoneBonusRows(expanded,' sample-52 ').points.length,1);
  const filteredBook=XLSX.read(vodafoneBonusWorkbook(expanded,' SAMPLE-52 '),{type:'base64'});
  const workbookRows=name=>XLSX.utils.sheet_to_json(filteredBook.Sheets[name],{header:1}).slice(1);
  assert.deepEqual(workbookRows('Registru pe punct').map(row=>row[1]),['sample-52']);
  assert.equal(workbookRows('Documente').length,0);
  assert.equal(workbookRows('Stingeri FIFO').length,0);
  assert.equal(workbookRows('Luni').length,input.coverage.length);

  const provisional={...input,documents:[doc('2026-08-08','pending','P1',3,'document-unknown')],coverage:input.coverage.map(m=>({...m,publishedOn:null}))};
  const p=vodafoneBonusLedger(provisional,null,null);
  assert.equal(p.fiscalKindsComplete,false);
  assert.equal(p.points.find(r=>r.month==='2026-06'&&r.pointCode==='P1').applied,null);
  assert.ok(p.documents[0].allocations.every(row=>row.status==='simulation'));
  assert.equal(vodafoneBonusLedger({...input,documents:[doc('2026-08-08','mixed','P1',3,'mixed')]},null,null).documents[0].allocations.length,0);
  assert.equal(vodafoneBonusLedger(input,[],null).points.length,0);
  assert.equal(vodafoneBonusLedger({...input,documents:[doc('2026-09-08','return','P1',-1,'return'),...input.documents]},null,null).points.find(r=>r.month==='2026-06'&&r.pointCode==='P1').applied,null);

  // Read the actual join path against wholly synthetic copies of the sources.
  const db=(name,sql)=>{
    const database=new DatabaseSync(join(root,name));
    database.exec(sql);
    return database;
  };
  const app=db('mobiup.sqlite',`
    CREATE TABLE users(id,site_code,role,warehouse_id,active);
    INSERT INTO users VALUES('a','A','agent','w',1);
    CREATE TABLE customers(id,warehouse_id,data,active);
    INSERT INTO customers VALUES('pointA','w','{"cui":"SYNTHETIC","name":"Example customer","historyFranchises":["FR-A"]}',1);
    CREATE TABLE orders(id,kind,number,user_id,warehouse_id,finalized_at,payload,status);
    CREATE TABLE sessions(user_id);
  `);
  mkdirSync(join(root,'client-history'));
  const history=db('client-history/client-sales-history.sqlite',`
    CREATE TABLE history_meta(key,value);
    INSERT INTO history_meta VALUES('current_reference','ref');
    CREATE TABLE history_imports(id,state);
    INSERT INTO history_imports VALUES(1,'active');
    CREATE TABLE history_identities(id,client_code,franchise_code);
    INSERT INTO history_identities VALUES(1,'SYNTHETIC','FR-A'),(2,'<generic client default>','FR-A');
    CREATE TABLE history_allocations(identity_id,reference_id,point_key,partner_ids_json,status);
    INSERT INTO history_allocations VALUES(1,'ref','franchise:FR-A','["pointA"]','direct_code'),(2,'ref','franchise:FR-A','[]','direct_code');
    CREATE TABLE history_rows(import_id,date,document_number,site_id,tr,identity_id,item_code,customer_name,quantity_micros,price_cents,value_cents,raw_json);
    CREATE INDEX history_rows_site_date ON history_rows(site_id,date,import_id);
  `);
  const sales=db('sales.sqlite',`
    CREATE TABLE sales_months(month,import_id);
    INSERT INTO sales_months VALUES('2026-08',1);
    CREATE TABLE sales_rows(import_id,company,site_code,date,location,order_number,item_code,quantity,price_cents,value_cents);
  `);
  const source=db('activations.sqlite',`
    CREATE TABLE activation_meta(key,value);
    INSERT INTO activation_meta VALUES('schema_version','3'),('facts_version','3'),('generation','1');
    CREATE TABLE activation_imports(status,source_kind,operator,company,source_at,period_start,period_end,sha256,row_count,parser_version);
    INSERT INTO activation_imports VALUES('complete','operator','vodafone','Vodafone','2026-07-03','2026-06-01','2026-06-30','synthetic',6,1);
    CREATE TABLE activation_movements(id,site,is_tr,movement_date,item_code,raw_json,quantity);
    CREATE TABLE activation_facts(company,provider,serial,evidence_json);
  `);
  const projection=db('activation-report.sqlite',`
    CREATE TABLE report_meta(key,value);
    INSERT INTO report_meta VALUES('version','4'),('factsVersion','3'),('sourceGeneration','1'),('sourceImports','[["synthetic","vodafone",6,1]]');
    CREATE TABLE details(month,activation_date,distribution_date,company,serial,client_code,point_code,item_code,label,site,contradictory,provider,is_tr,item_type);
  `);
  const types=['Aviz de însoțire a mărfii','Factură','Factură','Factură','Bon de consum','Reglare gestiune'];
  for (const [i,kind] of types.entries()){
    const number='document-'+i,serial='serial-'+i;
    const generic=i===3;
    projection.prepare("INSERT INTO details VALUES('2026-06','2026-06-03','2026-06-01','ERP',?,?,'FR-A','BASE',?,'A',0,'vodafone',1,'SIM')").run(serial,generic?'PARTNER GEN 001':'SYNTHETIC',generic?'Generic Partner':'Example customer');
    source.prepare("INSERT INTO activation_facts VALUES('ERP','vodafone',?,?)").run(serial,JSON.stringify({remainingSaleIds:[i]}));
    source.prepare("INSERT INTO activation_movements VALUES(?,'A',1,'2026-06-01','BASE',?,1)").run(i,JSON.stringify({SiteId:'S-A',Nr:number,TipDocument:kind}));
  }
  const documents=[
    ['payment','AWARD',1,0,0,1,{}],
    ['mixed','AWARD',3,0,0,1,{}],['mixed','SHELF',1,200,200,1,{}],
    ['adjust','AWARD',20,0,0,1,{TipDocument:'Reglare gestiune'}],
    ['consum','AWARD',20,0,0,1,{TipDocument:'Bon Consum'}],
    ['generic','AWARD',20,0,0,2,{}],
  ];
  for(const [num,code,qty,price,value,id,raw] of documents){
    history.prepare("INSERT INTO history_rows VALUES(1,'2026-08-05',?,'S-A','TR A',?,?,?,?,?,?,?)")
      .run(num,id,code,id===2?'Generic client default':'Example customer',qty*1_000_000,price,value,JSON.stringify(raw));
    sales.prepare("INSERT INTO sales_rows VALUES(1,'ERP','A','2026-08-05','TR A',?,?,?,?,?)")
      .run(num,code,qty,price,value);
  }
  for(const db of [app,history,sales,source,projection]) db.close();
  const options={directory:root,today:'2026-08-21',scope:null,month:null,rules:{version:1,history:'all',revision:'portable',assignments:[],products:{BASE:'vodafone_0',AWARD:'vodafone_5'}},
    evidence:parseVodafoneBonusEvidence(JSON.stringify({published:[],documents:[
      {source:'sales',company:'ERP',date:'2026-08-05',site:'S-A',number:'adjust',kind:'commercial',evidence:'Fictional approved receipt'},
    ]})),targets:[{pointCode:'FR-A',month:'2026-06',target:4,bonus:0}],
  };
  // Exercise the installed entrypoint in fresh processes and then request a normal restricted screen.
  const packaged=join(root,'packaged'),workerFile=join(packaged,'vodafone-bonus-worker.mjs');
  mkdirSync(packaged);
  await build({entryPoints:['lib/vodafone-bonus-worker.ts'],outfile:workerFile,bundle:true,platform:'node',format:'esm',packages:'external'});
  const settings=new DatabaseSync(join(root,'mobiup.sqlite'));
  settings.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
  const set=settings.prepare('INSERT INTO settings VALUES(?,?)');
  set.run('distribution-rules-v1',JSON.stringify(options.rules));
  set.run('vodafone-bonus-evidence-v1',JSON.stringify(options.evidence));
  settings.close();
  const campaign=join(root,'campaign.json');
  const updateCampaign=rows=>writeFileSync(campaign,JSON.stringify({version:1,rows}));
  updateCampaign(options.targets);
  const env={...process.env,MOBIUP_DATA_DIR:root,MOBIUP_ACTIVATIONS_DIR:root,MOBIUP_VODAFONE_TOP_LOCATIONS:campaign};
  const runWarm=()=>spawnSync(process.execPath,['--max-old-space-size=192','--max-semi-space-size=8',workerFile,'--warm-ledger'],
    {cwd:root,env,encoding:'utf8',timeout:15000});
  const checksum=path=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
  const sources=['mobiup.sqlite','client-history/client-sales-history.sqlite','sales.sqlite','activations.sqlite','activation-report.sqlite'];
  const initialSources=sources.map(checksum);
  const cacheDir=join(root,'.vodafone-bonus-cache'),ledger=join(cacheDir,'current.bin');
  if (process.getuid?.()) {
    function status() {
      const result=runWarm();
      assert.equal(result.status,0,result.error?.message||result.stderr);
      return JSON.parse(result.stdout).vodafoneLedger;
    }
    mkdirSync(cacheDir,{recursive:true,mode:0o700});
    const lockName=join(cacheDir,'build-lock.sqlite'),lock=new DatabaseSync(lockName);chmodSync(lockName,0o600);
    lock.exec('BEGIN IMMEDIATE');
    try {
      assert.equal(status(),'preparing','the installed timer must not duplicate an existing foreground rebuild');
      const cwd=process.cwd();process.chdir(packaged);
      const screen=new Worker(workerFile);
      try {
        const result=once(screen,'message');screen.postMessage({...options,preview:true,month:'2026-06'});
        assert.deepEqual((await result)[0],{state:'preparing'},'the foreground waits if another process holds the canonical ledger lock');
        assert.equal(existsSync(ledger),false);
      } finally {await screen.terminate();process.chdir(cwd);}
    } finally {lock.close();}
    assert.equal(status(),'rebuilt');
    assert.equal(statSync(ledger).mode&0o777,0o600);
    assert.equal(statSync(cacheDir).mode&0o777,0o700);
    const firstInode=statSync(ledger).ino;
    assert.equal(status(),'current');
    assert.equal(statSync(ledger).ino,firstInode);
    assert.equal(existsSync(join(cacheDir,'preview.bin')),false);
    assert.equal(existsSync(join(cacheDir,'ranking.bin')),false);
    const beforeDirectory=process.cwd();
    process.chdir(packaged);
    const pageWorker=new Worker(workerFile);
    try {
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const targets=options.targets.map(({month,pointCode,target,bonus})=>({month,pointCode,target,bonus}));
      const response=once(pageWorker,'message');
      pageWorker.postMessage({...options,today,targets,scope:['A'],month:'2026-06',preview:true});
      const [screen]=await response;
      assert.ok(screen && screen.months.some(row=>row.month==='2026-06' && row.activations===3));
      assert.equal(statSync(ledger).ino,firstInode,'the restricted web request reused the prewarmed canonical ledger');
      assert.equal(existsSync(join(cacheDir,'preview.bin')),true);
    } finally {await pageWorker.terminate();process.chdir(beforeDirectory);}
    updateCampaign(options.targets.map(row=>({...row,target:row.target+1})));
    assert.equal(status(),'rebuilt');
    const nextInode=statSync(ledger).ino;
    assert.notEqual(nextInode,firstInode);
    assert.equal(status(),'current');
    writeFileSync(campaign,'{}');
    assert.equal(runWarm().status,1,'unusable inputs do not certify a refresh');
    assert.equal(statSync(ledger).ino,nextInode);
    rmSync(cacheDir,{recursive:true});
    writeFileSync(cacheDir,'intentionally blocked derived output');
    updateCampaign(options.targets);
    assert.equal(runWarm().status,1,'a failed private write cannot report success');
    rmSync(cacheDir);
  } else {
    assert.equal(runWarm().status,1,'unsupported identities cannot create private caches');
  }
  assert.deepEqual(sources.map(checksum),initialSources,'maintenance and scoped reads preserve every authoritative source');
  const historyFile=join(root,'client-history','client-sales-history.sqlite');
  const walSetup=new DatabaseSync(historyFile);
  walSetup.exec('PRAGMA journal_mode=WAL');
  walSetup.close();
  assert.equal(existsSync(historyFile+'-wal'),false);
  const computed=readVodafoneBonus(options);
  assert.equal(computed.points.filter(row=>row.month==='2026-06').length,1,'first read may create an empty WAL');
  assert.deepEqual(computed.documents.map(doc=>doc.number).sort(),['mixed','payment']);
  assert.equal(computed.months[0].activations,3);
  assert.equal(computed.months[0].publishedOn,'2026-07-03');
  assert.equal(computed.months[0].confirmedActivations,3);
  assert.equal(computed.points.find(row=>row.month==='2026-06').sim0Bonus,1);
  assert.equal(computed.documents.find(doc=>doc.number==='payment').reason,'document-unknown');
  assert.equal(Buffer.from(vodafoneBonusWorkbook(computed),'base64').subarray(0,2).toString(),'PK');
  const sessions=new DatabaseSync(join(root,'mobiup.sqlite'));
  sessions.exec("INSERT INTO sessions VALUES('another synthetic user')");
  sessions.close();
  assert.equal(readVodafoneBonus(options).revision,computed.revision,'unrelated sessions never invalidate a refresh/export');
  const certified=readVodafoneBonus({...options,evidence:{published:[],documents:[
    {source:'sales',company:'ERP',date:'2026-08-05',site:'S-A',number:'payment',kind:'commercial',evidence:'Fictional invoice'},
  ]}});
  assert.equal(certified.points.find(row=>row.month==='2026-06').remaining,0);
  assert.equal(certified.documents.find(doc=>doc.number==='payment').allocations.filter(row=>row.status==='confirmed').length,1);
  // A transient CRM edit reverted during a cold query must never be attributed to the previous revision.
  const crmWriter=new DatabaseSync(join(root,'mobiup.sqlite'));
  const originalPrepare=Object.getOwnPropertyDescriptor(DatabaseSync.prototype,'prepare').value;
  let crmStage=0;
  try {
    crmWriter.exec('PRAGMA journal_mode=WAL');
    const original=crmWriter.prepare("SELECT data FROM customers WHERE id='pointA'").get().data;
    const update=crmWriter.prepare("UPDATE customers SET data=? WHERE id='pointA'");
    const baseline=readVodafoneBonus({...options,today:'2026-08-18'});
    DatabaseSync.prototype.prepare=function(sql) {
      if (crmStage===0 && sql.includes('FROM details WHERE provider=')) {
        update.run(JSON.stringify({...JSON.parse(original),cui:'another fictional owner'}));
        crmStage=1;
      }
      if (crmStage===1 && sql.includes('r.price_cents=0')) {
        update.run(original);
        crmStage=2;
      }
      return originalPrepare.call(this,sql);
    };
    const observed=readVodafoneBonus({...options,today:'2026-08-19'});
    assert.equal(crmStage,2);
    assert.equal(observed.months[0].confirmedActivations,baseline.months[0].confirmedActivations,'use one pinned CRM version');
  } finally {
    DatabaseSync.prototype.prepare=originalPrepare;
    crmWriter.close();
  }
  // A real WAL commit during a pinned multi-source read must still fail.
  let changed=false;
  const writer=new DatabaseSync(historyFile);
  try {
    DatabaseSync.prototype.prepare=function(sql) {
      if (!changed && sql.includes('FROM details WHERE provider=')) {
        writer.exec("INSERT INTO history_rows SELECT * FROM history_rows WHERE document_number='payment' LIMIT 1");
        changed=true;
      }
      return originalPrepare.call(this,sql);
    };
    assert.throws(()=>readVodafoneBonus({...options,today:'2026-08-20'}),/source updated during read/);
  } finally {
    DatabaseSync.prototype.prepare=originalPrepare;
    writer.close();
  }
  assert.ok(changed);
  assert.notEqual(readVodafoneBonus(options).revision,computed.revision);
  const cwd=process.cwd();
  try {
    process.chdir(root);
    writeFileSync('vodafone-bonus-worker.mjs','// Synthetic packaged worker identity');
    const fresh=key=>import(pathToFileURL(bundle).href+'?instance='+key);
    const first=(await fresh('one')).readVodafoneBonus(options);
    const screenOptions={...options,month:'2026-06',preview:true};
    const screen=(await fresh('screen-one')).readVodafoneBonus(screenOptions);
    assert.deepEqual(screen,vodafoneBonusPreview((await fresh('screen-full')).readVodafoneBonus({...screenOptions,preview:false})));
    try {
      DatabaseSync.prototype.prepare=function(sql) {
        if (sql.includes('SELECT key,value FROM report_meta')) throw new Error('Unexpected full ledger read for a certified preview');
        return originalPrepare.call(this,sql);
      };
      assert.deepEqual((await fresh('screen-restart')).readVodafoneBonus(screenOptions),screen);
    } finally { DatabaseSync.prototype.prepare=originalPrepare; }
    const otherScope=(await fresh('screen-scoped')).readVodafoneBonus({...screenOptions,scope:[]});
    assert.equal(otherScope.points.length,0);
    assert.notEqual(otherScope.revision,screen.revision);
    const saved=join(root,'.vodafone-bonus-cache','current.bin');
    const beforeInode=statSync(saved).ino;
    assert.deepEqual((await fresh('two')).readVodafoneBonus(options),first,'worker restart safely reuses source-keyed snapshot');
    assert.equal(statSync(saved).ino,beforeInode);
    writeFileSync(saved,'damaged synthetic cache');
    assert.deepEqual((await fresh('three')).readVodafoneBonus(options),first);
    assert.notEqual(statSync(saved).ino,beforeInode,'damaged cache was rebuilt');
    assert.equal(statSync(saved).mode&0o777,0o600);
    writeFileSync('vodafone-bonus-worker.mjs','// Different synthetic release');
    const previousRelease=statSync(saved).ino;
    assert.deepEqual((await fresh('four')).readVodafoneBonus(options),first);
    assert.notEqual(statSync(saved).ino,previousRelease,'another release recalculates before reusing');
  } finally {
    process.chdir(cwd);
  }
  const legal=new DatabaseSync(join(root,'mobiup.sqlite'));
  legal.exec(`CREATE TABLE crm_companies(partner_id,partner_code,cif,name);
    INSERT INTO crm_companies VALUES('company-example','SYNTHETIC','SYNTHETIC','Legal Example Company')`);
  legal.close();
  const earlier=new DatabaseSync(join(root,'activation-report.sqlite'));
  earlier.exec("INSERT INTO details SELECT '2026-02','2026-02-05',distribution_date,company,serial,client_code,point_code,item_code,label,site,contradictory,provider,is_tr,item_type FROM details WHERE serial='serial-1'");
  earlier.close();
  rmSync(join(root,'sales.sqlite'));
  const {readVodafoneSim0ActivationRows,projectVodafoneSim0Rows,sim0Coverage,vodafoneSim0CatalogRevision}=await import(pathToFileURL(bundle).href);
  const rank=readVodafoneSim0ActivationRows(options,'2026-01','2026-06');
  assert.equal(rank.activation.filter(row=>row.month==='2026-02' && row.pointCode==='FR-A' && row.reason==='commercial').length,1);
  assert.equal(rank.activation.filter(row=>row.month==='2026-06' && row.reason!=='excluded').length,3);
  assert.equal(rank.companies.get('SYNTHETIC'),'Legal Example Company');
  assert.deepEqual(rank.coverage.map(m=>[m.month,m.reported]),[['2026-01',false],['2026-02',false],['2026-03',false],['2026-04',false],['2026-05',false],['2026-06',true]]);
  assert.equal(rank.coverage.at(-1).sourceThrough,'2026-06-30');
  const previousCwd=process.cwd();
  try {
    process.chdir(root);
    const loadRanking=async(instance,scope,fromMonth='2026-01')=>(await import(pathToFileURL(bundle).href+'?ranking='+instance)).readVodafoneSim0Ranking({
      ...options,fromMonth,toMonth:'2026-06',scope,kind:'sim0-clients',
    });
    const ranked=await loadRanking('initial',['SITE-A']);
    const rankingPath=join(root,'.vodafone-bonus-cache','ranking.bin');
    const ledgerPath=join(root,'.vodafone-bonus-cache','current.bin');
    const ledgerFile=statSync(ledgerPath).ino;
    const initialFile=statSync(rankingPath);
    assert.equal(initialFile.mode&0o777,0o600);
    const stored=deserialize(readFileSync(rankingPath).subarray(160));
    assert.equal(stored.key,ranked.revision);
    assert.deepEqual(Object.keys(stored.value).sort(),['coverage','revision','rows'],'persist only scoped aggregates');
    try {
      DatabaseSync.prototype.prepare=function(sql) {
        if (sql.includes('FROM details WHERE provider=')) throw new Error('Aggregate restart crossed into raw activation reads');
        return originalPrepare.call(this,sql);
      };
      assert.deepEqual(await loadRanking('restart',['SITE-A']),ranked);
      assert.equal(statSync(rankingPath).ino,initialFile.ino);
    } finally {DatabaseSync.prototype.prepare=originalPrepare;}
    const other=await loadRanking('other',['SITE-B']);
    assert.notEqual(other.revision,ranked.revision,'scope changes cannot reuse an aggregate');
    assert.notEqual((await loadRanking('period',['SITE-B'],'2026-02')).revision,other.revision);
    assert.equal(statSync(ledgerPath).ino,ledgerFile,'ranking never evicts the ledger');
    writeFileSync(rankingPath,'corrupted synthetic ranking');
    assert.deepEqual(await loadRanking('recovery',['SITE-A']),ranked);
    const beforeRelease=statSync(rankingPath).ino;
    writeFileSync('vodafone-bonus-worker.mjs','// next synthetic ranking release');
    assert.deepEqual(await loadRanking('release',['SITE-A']),ranked);
    assert.notEqual(statSync(rankingPath).ino,beforeRelease,'release changes force fresh aggregation');
  } finally {process.chdir(previousCwd);}

  assert.equal(rank.coverage[1].status,'observed');
  assert.equal(rank.coverage[1].lastObserved,'2026-02-05');
  assert.equal(rank.coverage[1].sourceThrough,null);
  const intervals=[['2026-01-15','2026-01-31'],['2026-02-01','2026-02-10'],['2026-02-05','2026-02-12'],
    ['2026-02-14','2026-02-28'],['2026-03-01','2026-03-10'],['2026-03-11','2026-04-18'],['2026-04-18','2026-05-01']];
  const cases=sim0Coverage('2026-01','2026-04','2026-04-21',intervals.map(([start,end])=>({start,end})),new Map());
  assert.deepEqual(cases.map(c=>[c.status,c.sourceThrough]),[['partial',null],['partial','2026-02-12'],['complete','2026-03-31'],['current','2026-04-21']]);
  assert.deepEqual(cases[1].ranges,['2026-02-01–2026-02-12','2026-02-14–2026-02-28']);
  assert.deepEqual(cases.map(c=>c.reported),[false,false,true,true]);
  const foreign=new DatabaseSync(join(root,'activations.sqlite'));
  foreign.exec("UPDATE activation_imports SET company='Unrelated Example'");
  const unknown=readVodafoneSim0ActivationRows(options,'2026-06','2026-06').coverage[0];
  assert.deepEqual([unknown.status,unknown.reported,unknown.sourceThrough],['observed',false,null]);
  foreign.exec("UPDATE activation_imports SET company='Vodafone'");
  foreign.close();
  const priorCatalog=vodafoneSim0CatalogRevision(root);
  let projects=0;
  const compact=rows=>{projects++;return rows.activation.length;};
  const first=projectVodafoneSim0Rows(options,'2026-01','2026-06',['SITE-A'],compact);
  const repeat=projectVodafoneSim0Rows(options,'2026-01','2026-06',['SITE-A'],compact,first);
  assert.equal(repeat,first);
  const filtered=projectVodafoneSim0Rows(options,'2026-01','2026-06',['SITE-B'],compact,repeat);
  assert.notEqual(filtered.key,first.key);
  const update=new DatabaseSync(join(root,'mobiup.sqlite'));
  update.exec("UPDATE crm_companies SET name='Synthetic updated name'");
  update.close();
  const refreshed=projectVodafoneSim0Rows(options,'2026-01','2026-06',['SITE-B'],compact,filtered);
  assert.notEqual(refreshed.key,filtered.key);
  assert.equal(projects,3);
  assert.notEqual(vodafoneSim0CatalogRevision(root),priorCatalog);
  const hidden=projectVodafoneSim0Rows(options,'2026-02','2026-02',[],rows=>rows.coverage).value[0];
  assert.equal(hidden.status,'missing','an observation outside the selected scope is private');
  console.log('PASS: Vodafone reward attribution, source changes, restart-safe cache, YTD activation source and XLSX');
} finally {
  rmSync(root,{recursive:true,force:true});
}
