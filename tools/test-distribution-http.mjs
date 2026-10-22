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
let revision=0;for(const month of ['2026-09','2026-10']){const rows=[{rowNumber:1,date:month+'-05',month,siteCode:'N',itemCode:'CREDIT',itemName:'Synthetic credit',quantity:month.endsWith('09')?2:1,valueCents:month.endsWith('09')?2000:4000,priceCents:1000,brand:'Synthetic',location:'TR North',company:'ExampleCo',asm:'',regional:'',orderNumber:'EXAMPLE',category:'Cartele',subCategory:'',agent:'Synthetic North'}];sales.importSalesRows({rows,month,fileHash:month,filename:'synthetic.xlsx',importedBy:'manager',originalPath:'synthetic.xlsx',expectedRevision:revision++,expectedMappingHash:'same',currentMappingHash:'same',historicalAcknowledged:true});}
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
 browser=await browserFixture(origin);await browser.send('Network.setCookie',{name:'mobiup_session',value:cookies.manager,url:origin});await browser.send('Page.navigate',{url:origin});
 await waitFor(()=>browser.evaluate('document.querySelector(".profile strong")?.textContent==="Synthetic manager"'),'manager session');
 await browser.evaluate(`localStorage.setItem('distribution-selection-v1:manager',JSON.stringify({months:['2026-09','2026-10'],projects:['vodafone_sud','vodafone_nord','non_exclusiv']}));location.reload();`);
 await waitFor(()=>browser.evaluate('document.querySelectorAll(".distribution-operators").length>0'),'overview comparison');
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(b=>b.textContent==="Activări").click()');
 await waitFor(()=>browser.evaluate('document.querySelectorAll(".activation-primary strong")[0]?.textContent==="9"'),'activation union');
 assert.equal(await browser.evaluate('document.querySelectorAll(".activation-operator").length'),2);
 await browser.evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Pe partener").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".distribution-table tbody button")!==null'),'partner table');
 await browser.evaluate('document.querySelector(".distribution-table tbody button").click()');
 await waitFor(()=>browser.evaluate('document.body.textContent.includes("Reper sursă")'),'point detail');
 assert.equal(await browser.evaluate('document.activeElement?.tagName'),'H3','opening a point moves keyboard focus into its detail');
 for(const [width,height] of [[1280,900],[820,1180],[390,844]]){await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),'no overflow '+width);mkdirSync('work/evidence',{recursive:true});const screenshot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('work/evidence/distribution-'+width+'.png',Buffer.from(screenshot.data,'base64'));}
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(b=>b.textContent==="Vânzări").click()');
 await waitFor(()=>browser.evaluate('document.body.textContent.includes("Media / SIM")'),'sales cards');
 assert(await browser.evaluate('document.body.textContent.includes("20,00")'),'weighted sale mean rendered');
 const source=new DatabaseSync(root+'/activations.sqlite');source.prepare("UPDATE activation_meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'").run();source.close();
 assert.equal((await request('activations?month=2026-10','north')).status,503,'generation mismatch fails closed');
 db.close();console.log('PASS: authenticated North/South/nonexclusive policies, forged filters, detail/export, combined partners, weighted months, responsive UI and generation staleness.');
}finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));rmSync(root,{recursive:true,force:true});}
