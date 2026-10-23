import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const folder=mkdtempSync(join(tmpdir(),'activation-http-')),origin='http://127.0.0.1:3097';
const current=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'}).format(new Date());
const source=new DatabaseSync(folder+'/activations.sqlite');source.exec("CREATE TABLE activation_meta(key,value);INSERT INTO activation_meta VALUES('schema_version','2');CREATE TABLE activation_imports(sha256,operator,row_count,parser_version,status);INSERT INTO activation_imports VALUES('hash','example',35,2,'complete');");source.close();
const report=new DatabaseSync(folder+'/activation-report.sqlite');report.exec("CREATE TABLE report_meta(key,value);CREATE TABLE monthly(month,item_type,site,count,last_date);CREATE TABLE sites(site,label);INSERT INTO report_meta VALUES('version','1'),('importedAt','2026-10-16');INSERT INTO sites VALUES('A','TR Example A'),('B','TR Example B');");report.prepare('INSERT INTO report_meta VALUES(?,?)').run('sourceImports',JSON.stringify([['hash','example',35,2]]));
for(const r of [[current,'SIM','A',10,current+'-01'],[current,'TELSIM','A',2,current+'-01'],[current,'SIM','B',20,current+'-01'],[current,'SIM','',3,current+'-01'],['2024-01','SIM','A',7,'2024-01-31']])report.prepare('INSERT INTO monthly VALUES(?,?,?,?,?)').run(...r);
report.close();
const child=spawn(process.execPath,['dist/standalone/server.js'],{env:{...process.env,MOBIUP_DATA_DIR:folder,MOBIUP_ACTIVATIONS_DIR:folder,MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID:'pilot-manager',MOBIUP_ACTIVATIONS_PILOT_AGENT_ID:'pilot-agent',MOBIUP_USAGE_DISABLED:'1',HOST:'127.0.0.1',PORT:'3097'},stdio:'ignore'});
let browser;
async function request(path,token){const r=await fetch(origin+'/api/'+path,{headers:token?{Cookie:'mobiup_session='+token}:{}});return {status:r.status,body:await r.json()};}
try{
 await waitFor(async()=>{try{return (await fetch(origin+'/api/bootstrap')).ok;}catch{return false;}},'preview startup');
 const db=new DatabaseSync(folder+'/mobiup.sqlite'),tokens={};
 for(const [id,role,site] of [['pilot-manager','manager',''],['pilot-agent','agent','A'],['other-manager','manager',''],['other-agent','agent','B']]){
  db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active,site_code) VALUES(?,?,?,?,'global','invalid-preview-only',0,1,?)").run(id,id,id,role,site);
  const token=randomBytes(24).toString('hex');tokens[id]=token;db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
 }
 assert.equal((await request('activations')).status,401);
 for(const id of ['other-agent','other-manager']){assert.equal((await request('activations',tokens[id])).status,403);assert.equal((await request('bootstrap',tokens[id])).body.user.canViewActivations,false);}
 const mgr=await request('activations?month='+current,tokens['pilot-manager']);assert.equal(mgr.status,200);assert.equal(mgr.body.totals.total,35);
 const agent=await request('activations?month='+current,tokens['pilot-agent']);assert.equal(agent.status,200);assert.equal(agent.body.totals.total,12);assert.equal(agent.body.sites.length,1);assert(!JSON.stringify(agent.body).includes('Example B'));
 assert.equal((await request('activations?agentId=other-agent',tokens['pilot-agent'])).status,403);
 assert.equal((await request('activations?month=invalid',tokens['pilot-manager'])).status,400);
 assert.equal((await request('activations?provider=other',tokens['pilot-manager'])).status,400);
 const digi=await request('activations?provider=digi',tokens['pilot-manager']);assert.equal(digi.status,200);assert.equal(digi.body.available,false);assert.equal(digi.body.totals.total,0);
 assert.equal((await request('activations?provider=digi&agentId=other-agent',tokens['pilot-agent'])).status,403);
 assert.equal((await request('activations?month='+current+'&agentId=other-agent',tokens['pilot-manager'])).body.totals.total,20);
 assert.equal((await request('activations?month=2024-01',tokens['pilot-manager'])).body.totals.total,7);
 db.prepare("INSERT INTO users(id,username,name,role,password_hash,active,site_code) VALUES('old-a','old-a','Old account','agent','invalid-preview-only',0,'a')").run();
 assert.equal((await request('activations',tokens['pilot-agent'])).body.totals.total,0,'ambiguous historical site fails closed');
 db.prepare("DELETE FROM users WHERE id='old-a'").run();db.close();
 browser=await browserFixture(origin);
 async function account(id){await browser.close();browser=await browserFixture(origin);await browser.send('Network.setCookie',{name:'mobiup_session',value:tokens[id],url:origin});await browser.send('Page.navigate',{url:origin});await waitFor(()=>browser.evaluate('document.querySelector(".profile strong")?.textContent==='+JSON.stringify(id)),'account navigation');}
 await account('pilot-manager');
 const tabs=await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].map(x=>x.textContent)');assert.equal(tabs[tabs.indexOf('Accesorii')+1],'Prepay');
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(x=>x.textContent==="Prepay").click()');
 await waitFor(()=>browser.evaluate('document.querySelectorAll(".activation-operator").length===2'),'simultaneous operator cards');
 await waitFor(()=>browser.evaluate('document.querySelector(".activation-primary strong")?.textContent==="35"'),'legacy pilot stays functional before project configuration');
 assert(!(await browser.evaluate('!!document.querySelector(".distribution-filters")')),'unconfigured project filters are not offered');
 await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),'no page overflow on mobile');
 mkdirSync('work/evidence',{recursive:true});const shot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync('work/evidence/activation-mobile.png',Buffer.from(shot.data,'base64'));
 await account('other-manager');assert(await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].some(x=>x.textContent==="Prepay")'));await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(x=>x.textContent==="Prepay").click()');await waitFor(()=>browser.evaluate('!!document.querySelector(".prepay-workspace")'),'sales-only Prepay');assert(!(await browser.evaluate('[...document.querySelectorAll(".commerce-tabs button")].some(x=>x.textContent==="Activări")')),'activation tab stays permission gated');
 await account('other-agent');assert(await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].some(x=>x.textContent==="Prepay")'));await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(x=>x.textContent==="Prepay").click()');await waitFor(()=>browser.evaluate('!!document.querySelector(".prepay-workspace")'),'agent Prepay sales without activation permission');assert(!(await browser.evaluate('[...document.querySelectorAll(".prepay-workspace .commerce-tabs button")].some(button=>button.textContent==="Activări")')),'agent activation tab remains permission gated');
 await account('pilot-agent');assert(await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].some(x=>x.textContent==="Prepay")'));
 await browser.evaluate('[...document.querySelectorAll(".main-nav [role=tab]")].find(x=>x.textContent==="Prepay").click()');
 await waitFor(()=>browser.evaluate('document.querySelector(".activation-primary strong")?.textContent==="12"'),'agent totals');
 assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".activation-source-date")).fontSize'),'12px','cold agent activation owns source-date styles before commerce is loaded');
 assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".activation-operator .commerce-details summary")).fontSize'),'13px','cold agent activation loads shared disclosure styles');
 assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".activation-operator .commerce-details")).borderTopWidth'),'1px','cold agent activation disclosure separation is styled');

 assert(!(await browser.evaluate('document.querySelector(".activation-workspace").textContent.includes("TR Example B")')));
 // A stale source must replace data with an error, never leave old totals visible.
 const changed=new DatabaseSync(folder+'/activations.sqlite');changed.exec("INSERT INTO activation_imports VALUES('new','example',1,2,'complete')");changed.close();
 await browser.evaluate(`document.querySelector('[aria-label="Actualizează Prepay"]').click()`);
 await waitFor(()=>browser.evaluate('document.querySelector(".activation-workspace [role=alert]")!==null'),'stale error');
 assert(!(await browser.evaluate('!!document.querySelector(".activation-primary")')));
 console.log('PASS: real API authentication/pilot/scope, tab placement and exclusion, legacy API, explicit project migration, simultaneous cards, mobile, stale-report error.');
}finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));rmSync(folder,{recursive:true,force:true});}
