import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {read,utils} from 'xlsx';
import {DatabaseSync} from 'node:sqlite';import {randomBytes,createHash} from 'node:crypto';
import {build} from 'esbuild';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const root=mkdtempSync(join(tmpdir(),'distribution-http-')),origin='http://127.0.0.1:3096';
const fixture=spawnSync('python3',['tools/distribution-fixture.py',root],{encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
const digiFixture=spawnSync('python3',['tools/digi-period-fixture.py',root],{encoding:'utf8'});
assert.equal(digiFixture.status,0,digiFixture.stderr);
const ledger=new DatabaseSync(join(root,'activations.sqlite'));
const insertSnapshot=ledger.prepare(`INSERT INTO activation_imports
 (sha256,filename,operator,nominal_period,parser_version,imported_at,source_kind,source_at,period_start,period_end,company,row_count,status)
 VALUES(?,'synthetic.xlsx','vodafone',?,3,?,'operator',?,?,?,'Vodafone',?,'complete')`);
const focusImport=Number(insertSnapshot.run('synthetic-focus-snapshot','2026-10','2026-11-04','2026-11-04','2026-10-01','2026-10-31',5).lastInsertRowid);
const laterImport=Number(insertSnapshot.run('synthetic-focus-partial','2026-11','2026-11-13','2026-11-13','2026-11-01','2026-11-12',1).lastInsertRowid);
const observe=ledger.prepare("INSERT INTO activation_observations VALUES(?,?,'Vodafone','vodafone',?,?,?,?,?)");
const focusSerial=n=>String(n).padStart(18,'0');
for(const [id,n,county,category,sim,amount] of [
 [1,5,'AG','SIM with initial credit >= 3 EUR','SIM_5EUR',''],
 [2,40,'AG','SIM Zero with Recharge >= 3E','SIM_ZERO','3'],
 [3,42,'OT','PACK_SIM','PACK_SIM',''],
 [4,1,'CV','SIM with initial credit >= 3 EUR','SIM_5EUR',''],
 [5,44,'IS','SIM Zero with Recharge >= 3E','SIM_ZERO','3'],
]) observe.run(focusImport,id,focusSerial(n),'2026-10-15',county,category,JSON.stringify({
 DEALER_NAME:'MOBIUP DISTRIBUTION SRL - CONSIGNATIE',SIM_TYPE:sim,FIRST_RECHARGE_VALUE:amount,
}));
observe.run(laterImport,6,focusSerial(45),'2026-11-10','IS','SIM Zero with Recharge >= 3E',JSON.stringify({
 DEALER_NAME:'MOBIUP DISTRIBUTION SRL - CONSIGNATIE',SIM_TYPE:'SIM_ZERO',FIRST_RECHARGE_VALUE:'3',
}));
const activeImports=ledger.prepare("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").all().map(r=>[r.sha256,r.operator,r.row_count,r.parser_version]);
ledger.close();
const focusProjection=new DatabaseSync(join(root,'activation-report.sqlite'));
focusProjection.prepare("UPDATE report_meta SET value=? WHERE key='sourceImports'").run(JSON.stringify(activeImports));
focusProjection.close();
process.env.MOBIUP_DATA_DIR=root;
const b=await build({entryPoints:['lib/sales-store.ts'],bundle:true,platform:'node',format:'esm',write:false});const sales=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
let revision=0;for(const month of ['2026-09','2026-10']){const rows=[{rowNumber:1,date:month+'-05',month,siteCode:'N',itemCode:'CREDIT',itemName:'Synthetic credit',quantity:month.endsWith('09')?2:1,valueCents:month.endsWith('09')?2000:4000,priceCents:1000,brand:'Synthetic',location:'TR North',company:'ExampleCo',asm:'',regional:'',orderNumber:'EXAMPLE',category:'Cartele',subCategory:'',agent:'Synthetic North'}];rows.push({...rows[0],rowNumber:2,siteCode:'LEGACY',itemCode:'UNMAPPED',itemName:'Synthetic historical item',location:'TR Historical',quantity:1,valueCents:500});sales.importSalesRows({rows,month,fileHash:month,filename:'synthetic.xlsx',importedBy:'manager',originalPath:'synthetic.xlsx',expectedRevision:revision++,expectedMappingHash:'same',currentMappingHash:'same',historicalAcknowledged:true});}
// Separate historical source: complete 2025 coverage, exact TR identities.
mkdirSync(join(root,'client-history'),{recursive:true});
const history=new DatabaseSync(join(root,'client-history','client-sales-history.sqlite'));
history.exec("CREATE TABLE history_imports(id INTEGER PRIMARY KEY,period_start TEXT,period_end TEXT,imported_at TEXT,state TEXT);CREATE TABLE history_rows(import_id INTEGER,date TEXT,tr TEXT,site_id TEXT,item_code TEXT,item_name TEXT,brand TEXT,category TEXT,article_type TEXT,quantity_micros INTEGER,value_cents INTEGER,source_row INTEGER);INSERT INTO history_imports VALUES(1,'2025-01-01','2025-12-31','2026-01-01','active');");
const insertHistory=history.prepare('INSERT INTO history_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
insertHistory.run(1,'2025-11-05','TR North','101','CREDIT','Synthetic credit','Example','Cartele','SIM',2000000,2420,1);
insertHistory.run(1,'2025-11-05','TR south','102','CREDIT','Synthetic credit','Example','Cartele','SIM',3000000,3630,2);
history.close();
writeFileSync(join(root,'vodafone-top-locations.json'),JSON.stringify({version:1,rows:[
 {month:'2026-10',pointCode:'A',target:6,bonus:2},
 {month:'2026-10',pointCode:'B',target:0},
 {month:'2026-09',pointCode:'A',target:4},
]}));
const providerFixture=join(root,'synthetic-provider.mjs');
writeFileSync(providerFixture,`
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(url,options)=>{
   if(String(url)!=='https://api.openai.com/v1/responses')return originalFetch(url,options);
   const request=JSON.parse(options.body);
   const paused=request.input.some(item=>item.role==='user'&&typeof item.content==='string'&&item.content.includes('Verifică oprirea'));
   const text=paused?'**Fragment păstrat** '+'proba '.repeat(24):'**Răspuns sintetic verificat**';
   const events=[
     {type:'response.created',response:{id:'resp_browser_fixture',model:request.model,status:'in_progress',output:[]}},
     {type:'response.output_text.delta',delta:text},
     {type:'response.completed',response:{id:'resp_browser_fixture',model:request.model,status:'completed',output:[{type:'message',id:'msg_browser_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]}},
   ];
   if(paused)return new Response(new ReadableStream({start(controller){
     const first=events.slice(0,2).map(event=>'data: '+JSON.stringify(event)+'\\n\\n').join('');
     controller.enqueue(new TextEncoder().encode(first));
     options.signal.addEventListener('abort',()=>controller.close(),{once:true});
   }}),{headers:{'Content-Type':'text/event-stream'}});
   return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\\n\\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 };
`);
const child=spawn(process.execPath,['--import',providerFixture,'dist/standalone/server.js'],{env:{...process.env,MOBIUP_MANAGER_AI_OPENAI_API_KEY:'synthetic-provider-key',MOBIUP_DATA_DIR:root,MOBIUP_ACTIVATIONS_DIR:root,MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID:'manager',MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS:'regional',MOBIUP_ACTIVATIONS_PILOT_AGENT_ID:'north',MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS:'south,non',MOBIUP_USAGE_DISABLED:'1',HOST:'127.0.0.1',PORT:'3096'},stdio:'ignore'});
let browser;const cookies={};
async function request(path,id='manager'){const r=await fetch(origin+'/api/'+path,{headers:{Cookie:'mobiup_session='+cookies[id]}});return {status:r.status,data:await r.json()};}
async function checkReportingProfile(expected) {
 for(const role of ['manager','north','denied'])for(const path of ['auth/session','bootstrap?compact=1','orders?page=1','orders']) {
  const {status,data}=await request(path,role);
  assert.equal(status,200,role+' '+path);
  assert.equal(data.user.distributionConfigured,expected,role+' '+path+' reporting configuration');
  assert.equal(data.user.canViewActivations,role!=='denied',role+' '+path+' activation access');
 }
}
try{
 await waitFor(async()=>{try{return (await fetch(origin+'/api/bootstrap')).ok;}catch{return false;}},'distribution server');
 const db=new DatabaseSync(root+'/mobiup.sqlite');
 for(const [id,role,site,warehouse] of [['manager','manager','',''],['regional','manager','',''],['north','agent','N','WN'],['north-b','agent','B','WB'],['south','agent','S','WS'],['non','agent','X','WX'],['denied','agent','D','WD']]){
  db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active,site_code,warehouse_id,warehouse_name) VALUES(?,?,?,?,'global','synthetic-invalid',0,1,?,?,?)").run(id,id,'Synthetic '+id,role,site,warehouse,id==='north'?'TR North':'TR '+id);
  const token=randomBytes(24).toString('hex');cookies[id]=token;db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
 }
 db.exec("UPDATE users SET manager_scope='assigned' WHERE id='regional'; INSERT INTO manager_agents(manager_id,agent_id) VALUES('regional','south')");
 db.prepare('INSERT INTO settings VALUES(?,?)').run('distribution-rules-v1',readFileSync(join(root,'rules.json'),'utf8'));
 await checkReportingProfile(true);
 const points=[['P-A','A'],['P-B','B'],['P-Z','C']];for(const [id,code] of points)db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,'WN',JSON.stringify({id,name:'Synthetic point '+code,cui:'EXAMPLE',warehouseId:'WN',warehouseIds:['WN'],county:'CV',city:'Synthetic city',address:'Synthetic address',historyFranchises:[code]}));
 const addSlip=db.prepare("INSERT INTO orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,revision) VALUES(?,?,?,?,'sim','finalized',?,?,?,1)");
 for(const [n,day,agent,warehouse] of [[5,'2026-10-01','south','WS'],[40,'2026-10-18','south','WS'],[1,'2026-10-01','north','WN'],[44,'2026-10-01','north-b','WB'],[45,'2026-11-01','north-b','WB']]){
  const at=day+'T12:00:00.000Z';
  addSlip.run('FOCUS-'+n,'SIM-FICTIONAL-'+n,agent,warehouse,JSON.stringify({serials:[focusSerial(n)+'9'],client:{cui:'EXAMPLE'}}),at,at);
 }
 const focusPath='activations?month=2026-10&view=focus';
 const managerFocus=(await request(focusPath)).data.focus;
 assert.deepEqual([managerFocus.regional.total,managerFocus.attributed,managerFocus.possibleStock],[3,1,1]);
 const regionalFocus=(await request(focusPath,'regional')).data.focus;
 assert.deepEqual([regionalFocus.regional.total,regionalFocus.attributed,regionalFocus.possibleStock],[3,1,1]);
 assert.equal(regionalFocus.regionalDetails,false);
 db.exec("INSERT INTO settings VALUES('vodafone-focus-historical-sites:sud','HISTORY')");
 const historicalFocus=await request(focusPath+'&focusKind=attributed&focusSite=HISTORY','regional');
 assert.equal(historicalFocus.status,200);
 assert.equal(historicalFocus.data.focus.detail.total,0);
 const historicalExport=await request('activations?month=2026-10&view=focus-export&focusKind=attributed&focusSite=HISTORY','regional');
 assert.equal(historicalExport.status,200);
 assert.equal((await request(focusPath+'&focusKind=regional','regional')).status,403);
 const southFocus=(await request(focusPath+'&focusKind=attributed','south')).data.focus;
 assert.deepEqual([southFocus.attributed,southFocus.possibleStock,southFocus.regional],[1,1,undefined]);
 assert.equal(southFocus.detail.rows[0].serial,undefined);
 assert.equal(southFocus.detail.rows[0].document.reference,undefined);
 assert.equal((await request(focusPath+'&focusKind=regional','south')).status,403);
 assert.equal((await request(focusPath+'&focusKind=attributed&focusSite=N','south')).status,403);
 assert.equal((await request(focusPath,'denied')).status,403);
 assert.equal((await request(focusPath,'north')).data.focus,undefined);
 const northA=(await request(focusPath+'&focusTerritory=nord_a')).data.focus;
 assert.deepEqual([northA.regional.total,northA.attributed,northA.possibleStock],[1,1,0]);
 assert.equal((await request(focusPath+'&focusTerritory=nord_b')).data.focus.regional.total,1);
 const parallelFocus=await Promise.all(['sud','nord_a','nord_b'].flatMap(territory =>
   ['', '&focusKind=attributed'].map(detail => request(focusPath+'&focusTerritory='+territory+detail))));
 assert.deepEqual(parallelFocus.map(result=>result.status),[200,200,200,200,200,200]);
 const downloaded=await request('activations?month=2026-10&view=focus-export&focusKind=possibleStock');
 const sheets=read(downloaded.data.workbook,{type:'base64'}).Sheets;
 assert.equal(utils.sheet_to_json(sheets['Detaliu activări'])[0].ICCID,focusSerial(40));
 const agentExport=await request('activations?month=2026-10&view=focus-export&focusKind=attributed','south');
 assert.equal(utils.sheet_to_json(read(agentExport.data.workbook,{type:'base64'}).Sheets['Detaliu activări'])[0].ICCID,undefined);
 assert.equal((await request('activations?month=2026-10&view=focus-export&focusKind=regional','south')).status,403);
 assert.equal((await request('activations?month=2026-10&view=focus-export&revision=old')).status,409);
 assert.equal((await request('activations?month=2026-10','denied')).status,403);
 const octoberOverview='activations?month=2026-10';
 const overview=(await request(octoberOverview)).data;
 assert.equal(overview.totals.eligible,3);
 assert.equal(overview.totals.ineligible,undefined,'operational activations and confirmed attribution use different source populations');
 assert.equal(overview.sites.find(site=>site.site==='HISTORY').eligible,0);
 assert.equal((await request(octoberOverview,'regional')).data.totals.eligible,3,'assigned managers retain national overview');
 assert.equal((await request(octoberOverview+'&managerId=regional')).data.totals.eligible,managerFocus.attributed);
 assert.equal((await request(octoberOverview+'&projects=vodafone_nord')).data.totals.eligible,2);
 assert.equal((await request(octoberOverview,'south')).data.totals.eligible,southFocus.attributed);
 assert.equal((await request(octoberOverview,'north')).data.totals.eligible,northA.attributed);
 const [first, panels]=await Promise.all(['totals','panels'].map(phase=>request(octoberOverview+'&overviewPhase='+phase)));
 assert.match(first.data.publication,/^[a-f0-9]{64}$/);
 assert.equal(panels.data.publication,first.data.publication);
 assert.equal(first.data.totals.total,overview.totals.total);
 assert.equal(panels.data.totals.eligible,overview.totals.eligible);
 assert.deepEqual(panels.data.focusCards.map(card=>card.territory),['sud','nord_a','nord_b']);
 assert.deepEqual(panels.data.focusCards.find(card=>card.territory==='nord_a'),northA);
 const teamOverview=(await request(octoberOverview+'&overviewPhase=panels','regional')).data;
 assert.equal(teamOverview.totals.eligible,3);
 assert.equal(teamOverview.separateFocusScope,true);
 assert.equal(teamOverview.focusCards,undefined);
 const regionalCards=(await request(octoberOverview+'&overviewPhase=cards','regional')).data;
 assert.equal(regionalCards.publication,teamOverview.publication);
 const teamCards=regionalCards.focusCards;
 assert.deepEqual(teamCards.map(card=>card.territory),['sud']);
 assert.equal(teamCards[0].regionalDetails,false);
 const ownTeam=(await request(octoberOverview+'&managerId=regional&overviewPhase=panels','regional')).data;
 assert.deepEqual(ownTeam.focusCards,teamCards);
 const agentCards=(await request(octoberOverview+'&overviewPhase=panels','south')).data.focusCards;
 assert.deepEqual(agentCards,[(await request(focusPath,'south')).data.focus]);
 assert.equal((await request(octoberOverview+'&overviewPhase=cards&managerId=manager','south')).status,403);
 const simultaneous = await Promise.all(Array.from({length:16},()=>request(octoberOverview)));
 assert(simultaneous.every(r=>r.status===200&&r.data.totals.eligible===3),'simultaneous overview readers share a complete certified result');
 const multipleSelections = await Promise.all(Array.from({length:10},(_,index)=>
   request(octoberOverview+'&months=2026-10,2025-'+String(index+1).padStart(2,'0'))));
 assert(multipleSelections.every(r=>r.status===200&&r.data.totals.total===8&&
  (r.data.totals.eligible===3||r.data.commissionCoverage==='unavailable')),'busy attribution retains ordinary activation totals');
 const acrossMonths=(await request(octoberOverview+'&months=2026-09,2026-10,2026-11')).data;
 assert.equal(acrossMonths.commissionCoverage,'partial');
 assert.equal(acrossMonths.totals.eligible,4);
 assert.deepEqual(acrossMonths.monthly.map(en=>en.counts.eligible),[undefined,3,1]);
 assert.equal((await request('activations?month=2026-09')).data.totals.eligible,undefined);
 assert.equal((await request('activations?month=2026-09')).data.commissionCoverage,'missing');
 assert.equal((await request(octoberOverview,'non')).data.commissionCoverage,'outside_scope');
 for(const [id,total] of [['manager',8],['north',3],['south',1],['non',0]]){const r=await request('activations?month=2026-10',id);assert.equal(r.status,200);assert.equal(r.data.totals.total,total,id);}
 for(const id of ['north','south','non'])for(const attack of ['agentId=south','managerId=manager','siteCode=S'])assert.equal((await request('activations?month=2026-10&'+attack,id)).status,403);
 assert.equal((await request('activations?month=2026-10&months=2026-09,2026-10,2026-10')).data.totals.total,9);
 assert.equal((await request('activations?month=2026-10&projects=vodafone_sud,vodafone_nord')).data.totals.total,7);
 const digiMonths='activations?provider=digi&months=2026-03,2026-04,2026-10';
 const digiAnnual=await request(digiMonths);
 assert.equal(digiAnnual.status,200);
 assert.equal(digiAnnual.data.totals.total,3,'the national Digi card sums all reported selected months');
 assert.equal(digiAnnual.data.operatorReported.total,2,'official Digi subtotal stays separately reconciled');
 assert.deepEqual(digiAnnual.data.monthly.map(m=>[m.month,m.reported,m.source,m.counts.total]),[
   ['2026-03',true,'internal',1],['2026-04',false,undefined,0],['2026-10',true,'operator',2],
 ]);
 assert.deepEqual(digiAnnual.data.history.map(m=>[m.month,m.source,m.total]),[
   ['2026-03','internal',1],['2026-10','operator',2],
 ]);
 assert.equal(digiAnnual.data.totals.total,digiAnnual.data.history.reduce((total,m)=>total+m.total,0));
 assert.equal(digiAnnual.data.totals.total,digiAnnual.data.sites.reduce((total,site)=>total+site.total,0));
 assert.equal((await request('activations?provider=digi&months=2026-03')).data.totals.total,1);
 assert.equal((await request('activations?provider=digi&months=2026-10')).data.totals.total,2);
 const digiAgent=(await request(digiMonths,'north')).data;
 assert.equal(digiAgent.operatorReported,undefined);
 assert(!digiAgent.monthly.some(month=>month.source==='operator'),'agent cannot receive national operator data');
 const list=await request('activations?month=2026-10&provider=both&view=partners','north');assert.equal(list.status,200);assert(list.data.partners.rows.some(p=>p.total===0));assert.equal(list.data.partners.rows.reduce((n,p)=>n+p.total,0),3);
 assert.deepEqual(list.data.partners.rows.find(p=>p.pointCode==='A').vodafoneTargets,[{month:'2026-10',units:6}]);
 assert.deepEqual(list.data.partners.rows.find(p=>p.pointCode==='B').vodafoneTargets,[{month:'2026-10',units:0}]);
 assert.equal((await request('activations?month=invalid&provider=both&view=partners','north')).status,400);
 assert.equal((await request('activations?month=2026-10&provider=both&view=partners&agentId=south','north')).status,403);
 const targetQuery='activations?months=2026-09,2026-10&provider=both&view=partners';
 const globalTargets=await request(targetQuery);
 assert.deepEqual(globalTargets.data.partners.rows.find(p=>p.pointCode==='A').vodafoneTargets,[{month:'2026-09',units:4},{month:'2026-10',units:6}]);
 const regionalTargets=await request(targetQuery,'regional');
 assert.equal(regionalTargets.status,200);assert(regionalTargets.data.partners.rows.some(p=>p.pointCode==='A'));
 assert(!regionalTargets.data.partners.rows.some(p=>p.vodafoneTargets),'national activation browsing does not grant private targets');
 assert.equal((await request('vodafone/bonuses','north')).status,403);
 assert.equal((await request('vodafone/bonuses?projects=unrecognized','manager')).status,400);
 assert.equal((await request('vodafone/bonuses?view=preview&all=1','manager')).status,400);
 assert.equal((await request('vodafone/bonuses?view=preview&q=sample','manager')).status,400);
 assert.equal((await request('manager-ai','north')).status,403);
 const selected=list.data.partners.rows.find(p=>p.total>0);const point=encodeURIComponent(selected.key);
 assert.equal((await request('activations?month=2026-10&view=detail&point='+point,'north')).data.detail.total,selected.total);
 assert.equal((await request('activations?month=2026-10&view=detail&point=unknown','north')).data.detail.total,0);
 assert.equal((await request('activations?month=2026-10&view=export&company='+encodeURIComponent(JSON.stringify(['ExampleCo','EXAMPLE'])),'south')).data.detail.total,1);
 const multi=await request('sales?month=2026-10&months=2026-09,2026-10,2026-10&projects=vodafone_nord');assert.equal(multi.status,200,JSON.stringify(multi.data));assert.equal(multi.data.distribution.vodafoneCredit.quantity,3);assert.equal(multi.data.distribution.vodafoneCredit.average,20);
 assert.equal((await request('sales?month=2026-10&months=2026-09,2026-10&projects=vodafone_sud','north')).data.summary.quantity,0);
 const allSales=await request('sales?month=2026-10&months=2026-09,2026-10&projects=vodafone_nord,vodafone_sud,non_exclusiv');assert.equal(allSales.data.summary.quantity,5,'all projects preserve authorized historical sellers without current mappings');assert.equal(allSales.data.distribution.groups.unmapped.quantity,2);
 const historyAll=await request('sales?month=2025-11&months=2025-11&projects=vodafone_nord,vodafone_sud,non_exclusiv');
 assert.equal(historyAll.status,200);assert.equal(historyAll.data.distribution.vodafoneCredit.quantity,5);assert.deepEqual(historyAll.data.distribution.missingMonths,[]);assert.deepEqual(historyAll.data.distribution.historicalMonths,['2025-11']);
 const historyOwn=await request('sales?month=2025-11&months=2025-11&projects=vodafone_nord,vodafone_sud,non_exclusiv','north');
 assert.equal(historyOwn.data.distribution.vodafoneCredit.quantity,2,'history obeys authenticated agent warehouse scope');
 const historyForged=await request('sales?month=2025-11&months=2025-11&projects=vodafone_nord,vodafone_sud,non_exclusiv&siteCode=S','north');
 assert.equal(historyForged.data.distribution.vodafoneCredit.quantity,2,'forged historical SiteCode cannot widen agent scope');
 browser=await browserFixture(origin);await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await browser.send('Network.setCookie',{name:'mobiup_session',value:cookies.manager,url:origin});await browser.send('Page.navigate',{url:origin});
 await waitFor(()=>browser.evaluate('document.querySelector(".profile strong")?.textContent==="Synthetic manager"'),'manager session');
 await browser.evaluate(`localStorage.setItem('distribution-selection-v1:manager',JSON.stringify({months:['2026-09','2026-10'],projects:['vodafone_sud','vodafone_nord','non_exclusiv']}));location.reload();`);
 await waitFor(()=>browser.evaluate('document.querySelector(".manager-overview h1")?.textContent==="Sinteză"'),'operational summary');
 assert(await browser.evaluate(`!Array.from(document.querySelectorAll(".main-nav [role=tab]")).some(tab=>/Notificări|AI manager/.test(tab.textContent))`),'notifications and AI are header-only');
 await browser.evaluate(`document.querySelector(".manager-ai-trigger").click()`);
 await waitFor(()=>browser.evaluate(`!document.querySelector('[aria-label="Mesaj pentru AI Comenzi"]')?.disabled && !!document.querySelector('[role=complementary][aria-label="AI Comenzi"]')`),'AI opens and loads desktop session');
 assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Model AI"]')?.value ?? document.querySelector('[aria-label="AI Comenzi"] select option[value="gpt-6.1-terra"]')?.parentElement.value`),'gpt-6.1-terra');
 await browser.evaluate(`(async()=>{
   const handle=document.querySelector('[aria-label="Redimensionează panoul AI"]');
   for(let i=0;i<24;i++){
     handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
     await new Promise(requestAnimationFrame);
   }
 })()`);
 assert(await browser.evaluate(`(()=>{
   const panel=document.querySelector('aside[aria-label="AI Comenzi"]');
   const shell=document.querySelector('.manager-shell');
   return getComputedStyle(panel.parentElement).position==='sticky' &&
     panel.getBoundingClientRect().width>460 && panel.getBoundingClientRect().width<=innerWidth*0.44 &&
     shell.getBoundingClientRect().width>=document.documentElement.clientWidth*0.55;
 })()`),'desktop AI can resize while keeping the main shell and dock visible');
 await browser.evaluate(`document.querySelector('[aria-label="Resetează lățimea panoului"]').click()`);
 await browser.send('Emulation.setDeviceMetricsOverride',{width:320,height:800,deviceScaleFactor:1,mobile:true});
 await waitFor(()=>browser.evaluate(`!!document.querySelector('[role=dialog][aria-label="AI Comenzi"]')`),'AI becomes a phone dialog');
 assert(await browser.evaluate(`(()=>{
   const panel=document.querySelector('[role=dialog][aria-label="AI Comenzi"]');
   const composer=panel.querySelector('textarea');
   const bounds=panel.getBoundingClientRect(),input=composer.getBoundingClientRect();
   return bounds.left>=0&&bounds.right<=innerWidth&&input.bottom<=innerHeight&&input.width>250;
 })()`),'AI chat fits a 320px phone');
 await browser.evaluate(`(()=>{
   const input=document.querySelector('aside[aria-label="AI Comenzi"] input[type="file"]');
   const files=new DataTransfer();
   files.items.add(new File(['model,unitati\\nSynthetic,7'],'synthetic-report.csv',{type:'text/csv'}));
   input.files=files.files;
   input.dispatchEvent(new Event('change',{bubbles:true}));
   const textarea=document.querySelector('[aria-label="Mesaj pentru AI Comenzi"]');
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'Întrebare sintetică');
   textarea.dispatchEvent(new Event('input',{bubbles:true}));
 })()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[aria-label="Trimite"]')?.disabled===false`),'AI accepts a message');
 await browser.evaluate(`document.querySelector('[aria-label="Trimite"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector("[data-ai-message-list] strong")?.textContent==="Răspuns sintetic verificat"`),'AI renders streamed Markdown');
 mkdirSync('work/evidence',{recursive:true});
 const aiScreenshot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 writeFileSync('work/evidence/manager-ai-mobile-320.png',Buffer.from(aiScreenshot.data,'base64'));
 await browser.evaluate(`document.querySelector('[aria-label="Șterge fișierul synthetic-report.csv"]').click()`);
 await browser.evaluate(`[...document.querySelectorAll('aside[aria-label="AI Comenzi"] button')].find(el=>el.textContent==='Șterge fișierul').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[data-ai-message-list]')?.textContent.includes('Fișier șters') && !document.querySelector('[download="synthetic-report.csv"]')`),'AI reclaims an attachment while preserving its message');

 await browser.evaluate(`document.querySelector('aside [aria-label="Închide AI Comenzi"]').click()`);
 await waitFor(()=>browser.evaluate(`!document.querySelector('aside[aria-label="AI Comenzi"]')`),'AI closes back to current section');
 assert.equal(await browser.evaluate(`document.querySelector(".manager-overview h1")?.textContent`),'Sinteză');
 await browser.evaluate(`location.reload()`);
 await waitFor(()=>browser.evaluate(`!!document.querySelector(".manager-ai-trigger")`),'manager reload');
 await browser.evaluate(`document.querySelector(".manager-ai-trigger").click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector("[data-ai-message-list] strong")?.textContent==="Răspuns sintetic verificat"`),'AI history remains after reload');
 await browser.evaluate(`document.querySelector('[aria-label="Sesiune nouă"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[aria-label="Selectează sesiunea AI"]')?.options.length===2 && !document.querySelector("[data-ai-message-list] strong")`),'AI creates a fresh conversation');
 await browser.evaluate(`(()=>{
   const textarea=document.querySelector('[aria-label="Mesaj pentru AI Comenzi"]');
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'Verifică oprirea');
   textarea.dispatchEvent(new Event('input',{bubbles:true}));
 })()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[aria-label="Trimite"]')?.disabled===false`),'AI accepts another turn');
 await browser.evaluate(`document.querySelector('[aria-label="Trimite"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[data-ai-message-list] strong')?.textContent==='Fragment păstrat' && document.querySelector('[aria-label="Sesiune nouă"]')?.disabled===true`),'AI streams partial text and keeps the active conversation');
 await browser.evaluate(`document.querySelector('[aria-label="Oprește răspunsul"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[data-ai-message-list] strong')?.textContent==='Fragment păstrat' && document.querySelector('[data-ai-message-list]').textContent.includes('Răspuns oprit')`),'AI stop leaves the partial text and a durable status');
 await browser.evaluate(`document.querySelector('aside [aria-label="Închide AI Comenzi"]').click()`);
 await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 assert(!(await browser.evaluate('!!document.querySelector(".manager-overview .distribution-card")')),'summary contains no duplicated commercial reports');
 assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".manager-overview .manager-summary-grid")).gridTemplateColumns.split(" ").length'),4,'cold summary has four operational metric columns before opening commerce');
 assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".manager-operational-title")).fontSize'),'16px','cold summary owns its heading styles');
 await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".manager-overview .manager-summary-grid")).gridTemplateColumns.split(" ").length'),2,'cold mobile summary has two operational metric columns');
 await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});

 assert(!(await browser.evaluate('!!document.querySelector(".distribution-projects")')),'project controls do not pretend to filter operational activity');
 assert.equal(await browser.evaluate('document.querySelectorAll(".report-period").length'),1,'one effective summary period');
 assert(!(await browser.evaluate('document.querySelector(".manager-agent-table")?.textContent.includes("Vânzări")')),'operational table contains no commercial sales column');
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Prepay").click()');
 await waitFor(()=>browser.evaluate('!!document.querySelector(".prepay-sales")'),'prepay sales');
 assert(await browser.evaluate('document.querySelector(".prepay-sales")?.textContent.includes("20,00")'),'weighted credit-only mean rendered');
 assert(await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Evoluție lunară · SIM cu credit');const ids=b.getAttribute('aria-describedby').split(' ');const text=ids.map(id=>document.getElementById(id)?.textContent).join(' ');return ids.every(id=>!!document.getElementById(id))&&text.includes('60,00')&&text.includes('3')})()`),'accessible Prepay total description retains amount and quantity');

 assert(!(await browser.evaluate('document.querySelector(".prepay-sales")?.textContent.includes("Accesorii")')),'prepay excludes accessory cards');
 // Monthly total drill-down keeps the selected months and restores focus.
 await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Evoluție lunară · SIM cu credit');b.focus();b.click();})()`);
 await waitFor(()=>browser.evaluate('!!document.querySelector("[role=dialog] .monthly-sales-table")'),'Prepay monthly dialog');
 assert.equal(await browser.evaluate('document.querySelectorAll("[role=dialog] tbody tr").length'),2);
 assert(await browser.evaluate('document.querySelector("[role=dialog]").textContent.includes("sept. 2026")&&document.querySelector("[role=dialog]").textContent.includes("oct. 2026")'));
 await browser.evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Cantitate').click()`);
 assert(await browser.evaluate('document.querySelector("[role=dialog] svg").getAttribute("aria-label").includes("cantitate")'));
 await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
 await waitFor(()=>browser.evaluate('!document.querySelector("[role=dialog]")'),'close monthly dialog');
 assert(await browser.evaluate('document.activeElement?.getAttribute("aria-label")==="Evoluție lunară · SIM cu credit"'),'focus returns to clicked total');

 assert.equal(await browser.evaluate('document.querySelectorAll(".distribution-projects button[aria-pressed]").length'),3,'all projects remain directly visible');
 assert.equal(await browser.evaluate('document.querySelectorAll(".report-month-grid button[aria-pressed=true]").length'),2,'restored months are selected directly');
 await browser.evaluate(`document.querySelector('[aria-label="septembrie 2026"]').click()`);
 await waitFor(()=>browser.evaluate('document.querySelector(".prepay-sales")?.textContent.includes("40,00")'),'deselect month recomputes weighted mean');
 await browser.evaluate(`document.querySelector('[aria-label="septembrie 2026"]').click()`);
 await waitFor(()=>browser.evaluate('document.querySelector(".prepay-sales")?.textContent.includes("20,00")'),'direct month selection unions reports');
 await browser.evaluate('[...document.querySelectorAll(".distribution-projects button")].find(button=>button.textContent==="Vodafone Nord").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".prepay-sales .distribution-metric strong")?.textContent==="0 buc."'),'project toggle filters report');
 await browser.evaluate('[...document.querySelectorAll(".distribution-projects button")].find(button=>button.textContent==="Vodafone Nord").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".prepay-sales")?.textContent.includes("20,00")'),'multiple projects restore union');
 await browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].find(button=>button.textContent==="Activări").click()');
 await waitFor(()=>browser.evaluate('document.querySelectorAll(".activation-primary strong")[0]?.textContent==="9"'),'activation union');
 assert.equal(await browser.evaluate('document.querySelectorAll(".activation-operator").length'),2);
 await waitFor(()=>browser.evaluate(`document.querySelector('[aria-label="Total regional Focus SUD · detalii"]')?.textContent==='3'`),'Focus South regional result');
 assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Realizare TR SUD · detalii"]')?.textContent`),'1');
 assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Posibile activări din stoc · detalii"]')?.textContent`),'1');
 assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Evoluție lunară · Comisionabile · Vodafone"] span')?.textContent`),'3');
 await browser.evaluate(`document.querySelector('[aria-label="Posibile activări din stoc · detalii"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('.vodafone-focus')?.textContent.includes(${JSON.stringify(focusSerial(40))})`),'Focus stock drill-down');
 await browser.evaluate(`[...document.querySelectorAll('.vodafone-focus button')].find(button=>button.textContent==='Închide detaliul').click()`);

 await waitFor(()=>browser.evaluate(`document.querySelector('[aria-label="Evoluție lunară · Activări Digi"] strong')?.textContent==="2"`),'distinct Digi activations from separate periods after case-only replay');
 for(const label of ['Activări Vodafone','SIM 0 · Vodafone','SIM cu credit · Vodafone','Comisionabile · Vodafone','Distribuite · Vodafone','Activări Digi']){
  await browser.evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==='+JSON.stringify('Evoluție lunară · '+label)+');b.focus();b.click()})()');
  await waitFor(()=>browser.evaluate('!!document.querySelector("[role=dialog] .monthly-sales-table")'),'activation monthly dialog '+label);
  assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("[role=dialog] tbody tr")].map(r=>r.getAttribute("data-month"))'),['2026-09','2026-10']);
  assert(!(await browser.evaluate('document.querySelector("[role=dialog]").textContent')).includes('RON'),'activation counts never look like money');
  if(label==='Distribuite · Vodafone')assert(await browser.evaluate('document.querySelector("[role=dialog]").textContent.includes("Luna distribuirii")'));
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await waitFor(()=>browser.evaluate('!document.querySelector("[role=dialog]")'),'close activation trend');
  assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'),'Evoluție lunară · '+label);
 }
 await browser.evaluate(`document.querySelector('[aria-label="martie 2026"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[aria-label="Evoluție lunară · Activări Digi"] strong')?.textContent==="3"`),'Digi card sums both sources for the selected months');
 assert(!(await browser.evaluate(`document.querySelector('[aria-label="Activări digi"]').textContent.includes("Raport oficial Digi")`)));
 await browser.evaluate(`document.querySelector('[aria-label="Evoluție lunară · Activări Digi"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[role="dialog"] [data-month="2026-03"] td')?.textContent==="1"`),'Digi historic activation month in the chart');
 assert.equal(await browser.evaluate(`document.querySelectorAll('[role="dialog"] .monthly-trend-plot path').length`),1);
 assert(!(await browser.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('Evidență internă TR')`)));
 assert(!(await browser.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('Raport oficial Digi')`)));
 assert.equal(await browser.evaluate(`document.querySelectorAll('[role="dialog"] .monthly-trend-plot circle').length`),2);
 assert.equal(await browser.evaluate(`[...document.querySelectorAll('[role="dialog"] [data-month] td')]
   .reduce((total,cell)=>total+Number(cell.textContent.replace(/[^0-9]/g,'')),0)`),3);
 await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
 await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
 await waitFor(()=>browser.evaluate('!document.querySelector("[role=dialog]")'),'close Digi mixed-coverage trend');
 await browser.evaluate(`document.querySelector('[aria-label="martie 2026"]').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('[aria-label="Evoluție lunară · Activări Vodafone"] strong')?.textContent==="9"`),'restore the original activation selection');

 for(const [width,height] of [[360,800],[390,844]]){
  await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await browser.evaluate('scrollTo(0,0)');
  const geometry=await browser.evaluate(`(()=>{const total=document.querySelector('.activation-primary strong').getBoundingClientRect(),year=document.querySelector('.report-year').getBoundingClientRect(),months=document.querySelector('.report-month-grid').getBoundingClientRect(),projects=[...document.querySelectorAll('.distribution-projects button[aria-pressed]')].map(button=>{const r=button.getBoundingClientRect();return {left:r.left,right:r.right,hit:button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}});return {totalBottom:total.bottom,yearRight:year.right,monthsLeft:months.left,projects,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(geometry.totalBottom<=height-76,'first activation total is visible above mobile navigation: '+JSON.stringify({width,height,...geometry}));
  assert(geometry.yearRight<=geometry.monthsLeft,'year and direct month grid share one compact row');
  assert(geometry.projects.every(project=>project.left>=0&&project.right<=width&&project.hit),'all three project toggles remain visible and clickable');assert(!geometry.overflow,'no mobile report overflow');
  mkdirSync('work/evidence',{recursive:true});const screenshot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('work/evidence/activations-first-screen-'+width+'.png',Buffer.from(screenshot.data,'base64'));
 }

 await browser.evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Pe partener").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".distribution-table tbody button")!==null'),'partner table');
 await browser.evaluate('document.querySelector(".distribution-table tbody button").click()');
 await waitFor(()=>browser.evaluate('document.body.textContent.includes("Reper sursă")'),'point detail');
 assert(await browser.evaluate('document.querySelector(".activation-detail-reasons")?.textContent.includes("Județ în afara ariei")'),'partner detail explains eligibility in Romanian');
 assert(!(await browser.evaluate('/outside_territory|missing_county|ineligible_type|missing_type|contradictory_source/.test(document.querySelector(".activation-workspace").textContent)')),'partner detail never exposes technical reason keys');
 const reasonLayout=await browser.evaluate('(()=>{const explanation=document.querySelector(".activation-detail-reasons"),style=getComputedStyle(explanation);return {display:style.display,gap:parseFloat(style.marginTop),date:document.querySelector(".activation-date").textContent,dateWrap:getComputedStyle(document.querySelector(".activation-date")).whiteSpace}})()');
 assert.equal(reasonLayout.display,'block');assert(reasonLayout.gap>=4,'reason explanation has a visible gap after eligibility');assert.equal(reasonLayout.date,'15.10.2026');assert.equal(reasonLayout.dateWrap,'nowrap');
 assert.equal(await browser.evaluate('document.activeElement?.tagName'),'H3','opening a point moves keyboard focus into its detail');
 await browser.evaluate(`document.querySelector('[aria-label="Actualizează Prepay"]').click()`);
 await waitFor(()=>browser.evaluate('document.body.textContent.includes("Reper sursă")'),'refresh keeps selected partner detail');
 assert(await browser.evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent==="Pe partener"&&button.getAttribute("aria-pressed")==="true")'),'refresh preserves partner view');
 for(const [width,height] of [[1280,900],[820,1180],[390,844]]){await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),'no overflow '+width);mkdirSync('work/evidence',{recursive:true});const screenshot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('work/evidence/distribution-'+width+'.png',Buffer.from(screenshot.data,'base64'));}
 await browser.evaluate(`window.bonusRequests=[];window.bonusOriginalFetch=window.fetch;window.fetch=(...args)=>{window.bonusRequests.push(String(args[0]));return window.bonusOriginalFetch(...args);};true`);
 await browser.evaluate('[...document.querySelectorAll(".activation-workspace button")].find(button=>button.textContent==="Bonusuri Vodafone").click()');
 await waitFor(()=>browser.evaluate(`window.bonusRequests.some(path=>path.startsWith('/api/vodafone/bonuses?')&&new URL(path,location.origin).searchParams.get('month')==='2026-10'&&new URL(path,location.origin).searchParams.get('view')==='preview')`),'bonus report previews the historical reporting month on opening');
 await browser.evaluate(`document.querySelector('[aria-label="octombrie 2026"]').click()`);
 await waitFor(()=>browser.evaluate(`window.bonusRequests.some(path=>path.startsWith('/api/vodafone/bonuses?')&&new URL(path,location.origin).searchParams.get('month')==='2026-09'&&new URL(path,location.origin).searchParams.get('view')==='preview')`),'bonus report previews the changed reporting month');
 const projectToggle="[...document.querySelectorAll('.distribution-projects button')].find(button=>button.textContent==='Vodafone Nord')";
 const northSelected=await browser.evaluate(projectToggle+'.getAttribute("aria-pressed")')==='true';
 await browser.evaluate('window.bonusRequests=[];'+projectToggle+'.click()');
 await waitFor(()=>browser.evaluate(`window.bonusRequests.some(path=>{const q=new URL(path,location.origin).searchParams;return path.startsWith('/api/vodafone/bonuses?')&&q.has('projects')&&q.get('projects').split(',').includes('vodafone_nord')===${!northSelected}})`),'bonus report follows selected projects');
 await browser.evaluate(projectToggle+'.click()');
 await browser.evaluate(`document.querySelector('[aria-label="octombrie 2026"]').click();window.fetch=window.bonusOriginalFetch;true`);
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Accesorii").click()');
 await waitFor(()=>browser.evaluate('document.querySelectorAll(".commerce-category-card").length===3'),'accessory categories');
 await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Evoluție lunară · Accesorii');b.focus();b.click();})()`);
 await waitFor(()=>browser.evaluate('!!document.querySelector("[role=dialog] .monthly-sales-table")'),'accessory monthly dialog');
 assert(await browser.evaluate('document.querySelector("[role=dialog]").textContent.includes("Fără TVA")&&document.querySelector("[role=dialog]").textContent.includes("Cu TVA")'));
 await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await waitFor(()=>browser.evaluate('document.documentElement.scrollWidth<=innerWidth && document.querySelector("[role=dialog]").getBoundingClientRect().width<=innerWidth'),'settled mobile monthly dialog');
 assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth && document.querySelector("[role=dialog]").getBoundingClientRect().width<=innerWidth'),'monthly dialog fits mobile');
 await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
 await waitFor(()=>browser.evaluate('!document.querySelector("[role=dialog]")'),'close accessory dialog');
 await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});

 assert(!(await browser.evaluate('document.querySelector(".manager-commerce").textContent.includes("Media / SIM")')),'accessories do not duplicate prepay');
 await browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].find(button=>button.textContent==="Telefoane & Prepay").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".manager-commerce").textContent.includes("Telefoane")&&document.querySelector(".manager-commerce").textContent.includes("vouchere")'),'other useful reports retained');
 await browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].find(button=>button.textContent==="Pe clienți").click()');
 await waitFor(()=>browser.evaluate('!!document.querySelector(".client-sales")'),'customer report contextual month');
 assert(!(await browser.evaluate('!!document.querySelector(".distribution-filters")')),'customer monthly report has no conflicting global multi-month control');
 assert.equal(await browser.evaluate('document.querySelectorAll(".report-period").length'),1,'one customer report monthly control');
 await browser.evaluate(`document.querySelector('.client-sales [aria-label="septembrie 2026"]').click()`);
 await browser.evaluate('document.querySelector(".manager-ai-trigger").click()');
 await waitFor(()=>browser.evaluate(`[...document.querySelectorAll('aside[aria-label="AI Comenzi"] [title]')].some(el=>el.title.endsWith('Accesorii › Pe clienți · 2026-09'))`),'AI shows the selected customer-report month');
 await browser.evaluate(`document.querySelector('aside [aria-label="Închide AI Comenzi"]').click()`);
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Prepay").click()');
 // Base UI keeps the outgoing inert panel mounted until its exit completes.
 // Wait for that transition before checking that the new view has one period.
 await waitFor(()=>browser.evaluate('!!document.querySelector(".distribution-filters")&&!!document.querySelector(".prepay-workspace")&&!document.querySelector(".client-sales")'),'report months restored after leaving customer mode');
 assert.equal(await browser.evaluate('document.querySelectorAll(".report-month-grid button[aria-pressed=true]").length'),2);
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Accesorii").click()');
 await waitFor(()=>browser.evaluate('!!document.querySelector(".client-sales")'),'customer subview retained');
 assert(!(await browser.evaluate('!!document.querySelector(".distribution-filters")')));
 await browser.evaluate(`localStorage.setItem('distribution-selection-v1:manager',JSON.stringify({months:['2025-09'],projects:['vodafone_nord']}));location.reload();`);
 await waitFor(()=>browser.evaluate('!!document.querySelector(".manager-overview")'),'restore previous year fixture');
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Prepay").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".report-year select")?.value==="2025"'),'restored report opens correct year');
 assert.equal(await browser.evaluate(`document.querySelector('[aria-label="septembrie 2025"]')?.getAttribute('aria-pressed')`),'true');
 await browser.evaluate(`document.querySelector('[aria-label="Resetează filtrele"]').click()`);
 await waitFor(()=>browser.evaluate('document.querySelectorAll(".report-month-grid button[aria-pressed=true]").length===1&&document.querySelector(".report-year select")?.value===String(new Date().getFullYear())'),'reset follows current selected year');
 // Use the authenticated agent sessions with the real shared reports and unchanged policy API.
 for(const [id,october,union] of [['north',3,3],['south',1,2],['non',0,0]]){
  await browser.send('Network.setCookie',{name:'mobiup_session',value:cookies[id],url:origin});
  await browser.evaluate(`localStorage.setItem('agent-report-months-v1:${id}',JSON.stringify(['2026-10']));location.reload();`);
  await waitFor(()=>browser.evaluate('document.querySelector(".profile strong")?.textContent==='+JSON.stringify('Synthetic '+id)),'agent session '+id);
  await browser.evaluate('window.agentRequests=[];window.agentOriginalFetch=window.fetch;window.fetch=(...args)=>{window.agentRequests.push(String(args[0]));return window.agentOriginalFetch(...args);};true');
  const destinations=await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].map(button=>button.textContent)');
  assert(['Comenzi','Avize','Transfer','Parteneri','Accesorii','Prepay','Focus','Stocul meu'].every(label=>destinations.includes(label)),'agent operational destinations and shared commercial labels remain reachable');
  assert.deepEqual(destinations.slice(destinations.indexOf('Prepay'),destinations.indexOf('Prepay')+3),['Prepay','Focus','Stocul meu']);
  assert(!destinations.includes('AI manager'),'AI is a manager destination');
  await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Accesorii").click()');
  await waitFor(()=>browser.evaluate('document.querySelectorAll(".agent-commerce .commerce-category-card").length===3'),'agent accessory reports '+id);
  assert(!(await browser.evaluate('!!document.querySelector(".manager-scope-bar")||!!document.querySelector(".distribution-projects")')),'agent reports never expose manager or project selectors');
  await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Prepay").click()');
  await waitFor(()=>browser.evaluate('!!document.querySelector(".agent-commerce .prepay-sales")'),'agent Prepay sales '+id);
  await browser.evaluate('[...document.querySelectorAll(".prepay-workspace .commerce-tabs button")].find(button=>button.textContent==="Activări").click()');
  await waitFor(()=>browser.evaluate('document.querySelector(".activation-primary strong")?.textContent==='+JSON.stringify(String(october))),'agent activation policy '+id);
  assert.equal(await browser.evaluate('[...document.querySelectorAll(".activation-workspace button")].some(button=>button.textContent==="Bonusuri Vodafone")'),false,'manager-only bonus register is hidden for agents');
  assert.equal(await browser.evaluate('document.querySelectorAll(".agent-commerce .report-period").length'),1,'agent activation and sales share one period');
  assert(!(await browser.evaluate('!!document.querySelector(".activation-workspace input[type=month]")')),'shared agent period replaces the separate activation month');
  // One previously cached order page omitted the current user's reporting flag.
  await browser.evaluate(`window.agentOrderRead=false;window.onlineAgentFetch=window.fetch;window.fetch=async(...args)=>{
   const response=await window.onlineAgentFetch(...args);
   if(!String(args[0]).startsWith('/api/orders?'))return response;
   const data=await response.json();delete data.user.distributionConfigured;window.agentOrderRead=true;
   return new Response(JSON.stringify(data),{status:response.status,headers:response.headers});
  }`);
  await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Comenzi").click()');
  await waitFor(()=>browser.evaluate(`!!document.querySelector('[aria-label="Actualizează comenzile"]')`),'agent order refresh available');
  await browser.evaluate(`document.querySelector('[aria-label="Actualizează comenzile"]').click()`);
  await waitFor(()=>browser.evaluate('window.agentOrderRead'),'agent refreshed order list');
  await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Prepay").click()');
  await waitFor(()=>browser.evaluate('!!document.querySelector(".prepay-workspace .commerce-tabs")'),'agent prepay after order refresh');
  await browser.evaluate('[...document.querySelectorAll(".prepay-workspace .commerce-tabs button")].find(button=>button.textContent==="Activări").click()');
  await waitFor(()=>browser.evaluate('[...document.querySelectorAll(".activation-workspace button")].some(button=>button.textContent==="Pe partener")'),'agent keeps partner breakdown after order refresh');
  await browser.evaluate('window.fetch=window.onlineAgentFetch');
  const control='.agent-report-scope [aria-label="septembrie 2026"]';
  await waitFor(()=>browser.evaluate(`document.querySelector(${JSON.stringify(control)})?.getAttribute('aria-pressed')==='false'`),'agent restored October-only selection '+id);
  await browser.evaluate(`document.querySelector(${JSON.stringify(control)}).click()`);
  await waitFor(()=>browser.evaluate('document.querySelectorAll(".agent-report-scope .report-month-grid button[aria-pressed=true]").length===2'),'agent selects both report months '+id);
  await waitFor(()=>browser.evaluate(`window.agentRequests.some(path=>path.startsWith('/api/activations?')&&new URL(path,location.origin).searchParams.get('months')==='2026-09,2026-10')`),'agent requests both activation months '+id);
  await waitFor(()=>browser.evaluate('document.querySelector(".agent-commerce .activation-primary strong")?.textContent==='+JSON.stringify(String(union))),'agent multi-month activation union '+id);
  await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Accesorii").click()');
  await waitFor(()=>browser.evaluate('!!document.querySelector(".agent-commerce .commerce-tabs")&&!document.querySelector(".prepay-workspace")'),'return to agent accessory reports');
  await browser.evaluate('[...document.querySelectorAll(".agent-commerce .commerce-tabs button")].find(button=>button.textContent==="Pe clienți").click()');
  await waitFor(()=>browser.evaluate('!!document.querySelector(".agent-commerce .client-sales")'),'agent own customer report '+id);
  assert(!(await browser.evaluate('document.querySelector(".agent-commerce .client-sales").textContent.includes("Reconciliere națională")||!!document.querySelector(".agent-report-scope")')),'agent customer report keeps own monthly context without national manager controls');
  await waitFor(()=>browser.evaluate('window.agentRequests.some(path=>path.startsWith("/api/sales/clients?"))'),'agent own client request '+id);
  const requests=await browser.evaluate('window.agentRequests.filter(path=>path.startsWith("/api/sales?")||path.startsWith("/api/sales/clients?")||path.startsWith("/api/activations?"))');
  assert(requests.some(path=>path.startsWith('/api/sales?')&&path.includes('months=2026-10')),'agent sales use authenticated multi-month report');
  assert(requests.some(path=>path.startsWith('/api/sales/clients?')),'agent own portfolio endpoint is requested');
  assert(requests.every(path=>!/[?&](managerId|agentId|siteCode)=/.test(path)),'agent requests never supply another seller/manager scope');
  assert(requests.filter(path=>path.startsWith('/api/sales/clients?')).every(path=>!/[?&](months|projects)=/.test(path)),'agent customer report excludes product-report query fields');
  assert(!(await browser.evaluate('window.agentRequests.some(path=>path.includes("/sales/clients/reconciliation"))')),'agent never requests national reconciliation');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:320,height:800,deviceScaleFactor:1,mobile:true});
  await waitFor(()=>browser.evaluate('innerWidth===320&&document.querySelector(".nav-wrap")?.clientWidth===320'),'320px agent navigation '+id);
  // Let the app's ResizeObserver reveal the selected tab before the user's horizontal scroll.
  await browser.evaluate(`(async()=>{
   await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
   [...document.querySelectorAll('.main-nav [role=tab]')].find(button=>button.textContent==='Stocul meu').scrollIntoView({behavior:'instant',block:'nearest',inline:'nearest'});
   await new Promise(done=>requestAnimationFrame(done));
  })()`);
  const stockTarget=await browser.evaluate('(()=>{const button=[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Stocul meu"),r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,visible:r.left>=0&&r.right<=innerWidth,hit:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),width:innerWidth,left:r.left,right:r.right,scroll:button.closest(".nav-wrap").scrollLeft}})()');
  assert(stockTarget.visible&&stockTarget.hit,'last agent operational tab remains reachable by horizontal navigation at 320px: '+JSON.stringify(stockTarget));
  await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:stockTarget.x,y:stockTarget.y});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:stockTarget.x,y:stockTarget.y});
  await waitFor(()=>browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].some(button=>button.textContent==="Stocul meu"&&button.getAttribute("aria-selected")==="true")'),'agent stock navigation '+id);
 }
 db.prepare("DELETE FROM settings WHERE key='distribution-rules-v1'").run();
 await checkReportingProfile(false);
 await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await browser.send('Network.setCookie',{name:'mobiup_session',value:cookies.manager,url:origin});
 await browser.evaluate('location.reload()');
 await waitFor(()=>browser.evaluate('!!document.querySelector(".manager-ai-trigger")'),'legacy Prepay manager');
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Prepay").click()');
 await waitFor(()=>browser.evaluate(`!!document.querySelector('[aria-label="Luna activării"]')`),'legacy Prepay activation month control');
 await browser.evaluate(`(()=>{
   const input=document.querySelector('[aria-label="Luna activării"]');
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2026-09');
   input.dispatchEvent(new Event('input',{bubbles:true}));
   input.dispatchEvent(new Event('change',{bubbles:true}));
 })()`);
 await browser.evaluate('document.querySelector(".manager-ai-trigger").click()');
 await waitFor(()=>browser.evaluate(`[...document.querySelectorAll('aside[aria-label="AI Comenzi"] [title]')].some(el=>el.title.endsWith('Prepay › Activări · 2026-09'))`),'AI uses the legacy Prepay activation month');
 await browser.evaluate('[...document.querySelectorAll(".prepay-workspace nav button")].find(button=>button.textContent==="Vânzări").click()');
 await waitFor(()=>browser.evaluate(`!!document.querySelector('.prepay-workspace [aria-label="august 2026"]')`),'legacy Prepay sales month control');
 await browser.evaluate(`document.querySelector('.prepay-workspace [aria-label="august 2026"]').click()`);
 await waitFor(()=>browser.evaluate(`[...document.querySelectorAll('aside[aria-label="AI Comenzi"] [title]')].some(el=>el.title.endsWith('Prepay › Vânzări · 2026-08'))`),'AI uses the legacy Prepay sales month');
 db.prepare('INSERT INTO settings VALUES(?,?)').run('distribution-rules-v1',readFileSync(join(root,'rules.json'),'utf8'));
 const source=new DatabaseSync(root+'/activations.sqlite');source.prepare("UPDATE activation_meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'").run();source.close();
 assert.equal((await request('activations?month=2026-10','north')).status,503,'generation mismatch fails closed');
 db.close();console.log('PASS: authenticated North/South/nonexclusive policies, forged filters, detail/export, combined partners, weighted months, responsive UI and generation staleness.');
}finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));rmSync(root,{recursive:true,force:true});}
