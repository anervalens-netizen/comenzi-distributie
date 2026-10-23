import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {randomBytes,createHash} from 'node:crypto';
import {build} from 'esbuild';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const root=mkdtempSync(join(tmpdir(),'distribution-http-')),origin='http://127.0.0.1:3096';
const fixture=spawnSync('python3',['tools/distribution-fixture.py',root],{encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
process.env.MOBIUP_DATA_DIR=root;
const b=await build({entryPoints:['lib/sales-store.ts'],bundle:true,platform:'node',format:'esm',write:false});const sales=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
let revision=0;for(const month of ['2026-09','2026-10']){const rows=[{rowNumber:1,date:month+'-05',month,siteCode:'N',itemCode:'CREDIT',itemName:'Synthetic credit',quantity:month.endsWith('09')?2:1,valueCents:month.endsWith('09')?2000:4000,priceCents:1000,brand:'Synthetic',location:'TR North',company:'ExampleCo',asm:'',regional:'',orderNumber:'EXAMPLE',category:'Cartele',subCategory:'',agent:'Synthetic North'}];rows.push({...rows[0],rowNumber:2,siteCode:'LEGACY',itemCode:'UNMAPPED',itemName:'Synthetic historical item',location:'TR Historical',quantity:1,valueCents:500});sales.importSalesRows({rows,month,fileHash:month,filename:'synthetic.xlsx',importedBy:'manager',originalPath:'synthetic.xlsx',expectedRevision:revision++,expectedMappingHash:'same',currentMappingHash:'same',historicalAcknowledged:true});}
const child=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:root,MOBIUP_ACTIVATIONS_DIR:root,MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID:'manager',MOBIUP_ACTIVATIONS_PILOT_AGENT_ID:'north',MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_AGENT_IDS:'south,non',MOBIUP_USAGE_DISABLED:'1',HOST:'127.0.0.1',PORT:'3096'},stdio:'ignore'});
let browser;const cookies={};
async function request(path,id='manager'){const r=await fetch(origin+'/api/'+path,{headers:{Cookie:'mobiup_session='+cookies[id]}});return {status:r.status,data:await r.json()};}
try{
 await waitFor(async()=>{try{return (await fetch(origin+'/api/bootstrap')).ok;}catch{return false;}},'distribution server');
 const db=new DatabaseSync(root+'/mobiup.sqlite');
 for(const [id,role,site,warehouse] of [['manager','manager','',''],['north','agent','N','WN'],['south','agent','S','WS'],['non','agent','X','WX'],['denied','agent','D','WD']]){
  db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active,site_code,warehouse_id,warehouse_name) VALUES(?,?,?,?,'global','synthetic-invalid',0,1,?,?,?)").run(id,id,'Synthetic '+id,role,site,warehouse,id==='north'?'TR North':'TR '+id);
  const token=randomBytes(24).toString('hex');cookies[id]=token;db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
 }
 db.prepare('INSERT INTO settings VALUES(?,?)').run('distribution-rules-v1',readFileSync(join(root,'rules.json'),'utf8'));
 const points=[['P-A','A'],['P-B','B'],['P-Z','C']];for(const [id,code] of points)db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)').run(id,'WN',JSON.stringify({id,name:'Synthetic point '+code,cui:'EXAMPLE',warehouseId:'WN',warehouseIds:['WN'],county:'CV',city:'Synthetic city',address:'Synthetic address',historyFranchises:[code]}));
 assert.equal((await request('activations?month=2026-10','denied')).status,403);
 for(const [id,total] of [['manager',8],['north',3],['south',1],['non',0]]){const r=await request('activations?month=2026-10',id);assert.equal(r.status,200);assert.equal(r.data.totals.total,total,id);}
 for(const id of ['north','south','non'])for(const attack of ['agentId=south','managerId=manager','siteCode=S'])assert.equal((await request('activations?month=2026-10&'+attack,id)).status,403);
 assert.equal((await request('activations?month=2026-10&months=2026-09,2026-10,2026-10')).data.totals.total,9);
 assert.equal((await request('activations?month=2026-10&projects=vodafone_sud,vodafone_nord')).data.totals.total,7);
 const list=await request('activations?month=2026-10&provider=both&view=partners','north');assert.equal(list.status,200);assert(list.data.partners.rows.some(p=>p.total===0));assert.equal(list.data.partners.rows.reduce((n,p)=>n+p.total,0),3);
 const selected=list.data.partners.rows.find(p=>p.total>0);const point=encodeURIComponent(selected.key);
 assert.equal((await request('activations?month=2026-10&view=detail&point='+point,'north')).data.detail.total,selected.total);
 assert.equal((await request('activations?month=2026-10&view=detail&point=unknown','north')).data.detail.total,0);
 assert.equal((await request('activations?month=2026-10&view=export&company='+encodeURIComponent(JSON.stringify(['ExampleCo','EXAMPLE'])),'south')).data.detail.total,1);
 const multi=await request('sales?month=2026-10&months=2026-09,2026-10,2026-10&projects=vodafone_nord');assert.equal(multi.status,200,JSON.stringify(multi.data));assert.equal(multi.data.distribution.vodafoneCredit.quantity,3);assert.equal(multi.data.distribution.vodafoneCredit.average,20);
 assert.equal((await request('sales?month=2026-10&months=2026-09,2026-10&projects=vodafone_sud','north')).data.summary.quantity,0);
 const allSales=await request('sales?month=2026-10&months=2026-09,2026-10&projects=vodafone_nord,vodafone_sud,non_exclusiv');assert.equal(allSales.data.summary.quantity,5,'all projects preserve authorized historical sellers without current mappings');assert.equal(allSales.data.distribution.groups.unmapped.quantity,2);
 browser=await browserFixture(origin);await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await browser.send('Network.setCookie',{name:'mobiup_session',value:cookies.manager,url:origin});await browser.send('Page.navigate',{url:origin});
 await waitFor(()=>browser.evaluate('document.querySelector(".profile strong")?.textContent==="Synthetic manager"'),'manager session');
 await browser.evaluate(`localStorage.setItem('distribution-selection-v1:manager',JSON.stringify({months:['2026-09','2026-10'],projects:['vodafone_sud','vodafone_nord','non_exclusiv']}));location.reload();`);
 await waitFor(()=>browser.evaluate('document.querySelector(".manager-overview h1")?.textContent==="Sinteză"'),'operational summary');
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
 assert(!(await browser.evaluate('document.querySelector(".prepay-sales")?.textContent.includes("Accesorii")')),'prepay excludes accessory cards');
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
 assert.equal(await browser.evaluate('document.activeElement?.tagName'),'H3','opening a point moves keyboard focus into its detail');
 await browser.evaluate(`document.querySelector('[aria-label="Actualizează Prepay"]').click()`);
 await waitFor(()=>browser.evaluate('document.body.textContent.includes("Reper sursă")'),'refresh keeps selected partner detail');
 assert(await browser.evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent==="Pe partener"&&button.getAttribute("aria-pressed")==="true")'),'refresh preserves partner view');
 for(const [width,height] of [[1280,900],[820,1180],[390,844]]){await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),'no overflow '+width);mkdirSync('work/evidence',{recursive:true});const screenshot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('work/evidence/distribution-'+width+'.png',Buffer.from(screenshot.data,'base64'));}
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(button=>button.textContent==="Accesorii").click()');
 await waitFor(()=>browser.evaluate('document.querySelectorAll(".commerce-category-card").length===3'),'accessory categories');
 assert(!(await browser.evaluate('document.querySelector(".manager-commerce").textContent.includes("Media / SIM")')),'accessories do not duplicate prepay');
 await browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].find(button=>button.textContent==="Alte produse").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".manager-commerce").textContent.includes("Telefoane")&&document.querySelector(".manager-commerce").textContent.includes("vouchere")'),'other useful reports retained');
 await browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].find(button=>button.textContent==="Pe clienți").click()');
 await waitFor(()=>browser.evaluate('!!document.querySelector(".client-sales")'),'customer report contextual month');
 assert(!(await browser.evaluate('!!document.querySelector(".distribution-filters")')),'customer monthly report has no conflicting global multi-month control');
 assert.equal(await browser.evaluate('document.querySelectorAll(".report-period").length'),1,'one customer report monthly control');
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
 const source=new DatabaseSync(root+'/activations.sqlite');source.prepare("UPDATE activation_meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'").run();source.close();
 assert.equal((await request('activations?month=2026-10','north')).status,503,'generation mismatch fails closed');
 db.close();console.log('PASS: authenticated North/South/nonexclusive policies, forged filters, detail/export, combined partners, weighted months, responsive UI and generation staleness.');
}finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));rmSync(root,{recursive:true,force:true});}
