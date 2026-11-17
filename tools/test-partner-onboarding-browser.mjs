import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {PartnerNew} from './components/partner-new';import {setLocalWorkUserId} from './lib/local-work';setLocalWorkUserId('synthetic-agent');window.confirm=()=>true;createRoot(document.getElementById('root')).render(<PartnerNew userId="synthetic-agent"/>);`;
const bundle=await build({stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},write:false,outdir:'out',bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const css=readFileSync('app/globals.css','utf8')+bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
const points=[1,2].map(i=>({id:'synthetic-point-'+i,name:'CRM Synthetic',cui:' r.o. 900-000-000 ',city:'Example '+i,county:'BV',address:'Shop '+i+' Nr 10',warehouseIds:['synthetic-other']}));
let searchError=false,lookupError=false,anafStatus='found',anafDelay=0,conflict=null;
const searches=[],fiscals=[],posts=[];
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles.find(f=>f.path.endsWith('.js')).text);return;}
 if(url.pathname.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  const send=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(url.pathname==='/api/partner/search'){
   const query=url.searchParams.get('q');searches.push(query);
   if(searchError){send({error:'Synthetic search outage'},503);return;}
   const data={companies:query==='Empty'||query==='Stale'?[]:[{name:'CRM Synthetic',cui:'900000000',pointCount:2}],hasMore:false};
   setTimeout(()=>send(data),query==='Stale'?1000:0);return;
  }
  if(url.pathname==='/api/partner/lookup'){if(lookupError)send({error:'Synthetic lookup outage'},503);else send({locations:url.searchParams.get('cui')==='900000000'?points:[]});return;}
  if(url.pathname==='/api/partner/anaf'){
   const cui=url.searchParams.get('cui');fiscals.push(cui);const status=anafStatus;
   setTimeout(()=>send({source:'ANAF',cui,status,message:status==='found'?'Firmă identificată.':status==='not_found'?'CUI negăsit în ANAF.':'ANAF indisponibil.',checkedAt:'2026-01-02T10:00:00Z',...(status==='found'?{company:{cui,name:'Official Synthetic '+cui,fiscalAddress:'Fiscal office only',vatRegistered:true,inactive:false}}:{})}),anafDelay);return;
  }
  if(url.pathname==='/api/partner/mail'){
   let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);posts.push(payload);
   conflict={...payload,id:payload.requestId,revision:3,status:'requested',createdAt:'2026-01-02T10:00:00Z'};send({error:'Synthetic concurrent update'},409);return;
  }
  if(url.pathname.startsWith('/api/partner/requests/')){send({request:conflict});return;}
  send({requests:[]});return;
 }
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
const set=async(selector,value)=>browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const click=async text=>browser.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click()`);
const value=selector=>browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
const contains=text=>browser.evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`);
const fresh=async()=>{await click('Cerere nouă');await waitFor(()=>browser.evaluate("document.querySelector('#partner-discovery').value===''") );};
try{
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);
 await waitFor(()=>browser.evaluate("!!document.querySelector('#partner-discovery')"));
 assert.equal(await browser.evaluate("document.querySelector('.partner-details').hidden"),true);
 await set('#partner-discovery','ab');await delay(750);assert.equal(searches.length,0);assert.equal(fiscals.length,0);
 await set('#partner-discovery','RO1');await delay(750);assert.equal(searches.length,0);assert.equal(fiscals.length,0);
 await set('#partner-discovery','Synthetic');await waitFor(()=>contains('2 puncte de lucru'));assert.equal(fiscals.length,0,'name searches never query ANAF');
 await click('CRM Synthetic');await waitFor(()=>contains('Shop 2'));await waitFor(()=>contains('denumirea ANAF diferă'));
 assert.equal(await value('[name=company]'),'CRM Synthetic');
 await click('EXISTENT');await browser.evaluate("const e=document.querySelector('select[name=locationResolution]');e.value='synthetic-point-2';e.dispatchEvent(new Event('change',{bubbles:true}))");
 assert.equal(await value('[name=address]'),'Shop 2 Nr 10');assert.equal(await value('[name=location]'),'Example 2');
 assert.equal(await browser.evaluate("document.querySelector('[name=address]').readOnly"),true);
 await set('[name=contact]','Synthetic contact');await set('[name=phone]','0000000000');
 await click('Adaugă clientul');await waitFor(()=>contains('versiune mai nouă'));
 assert.equal(posts.length,1);assert.equal(posts[0].locationResolution,'synthetic-point-2');assert.equal(posts[0].cui,'900000000');
 await click('Păstrează modificările mele');assert.equal(await value('[name=revision]'),'3');
 await click('punct NOU');assert.equal(await value('[name=company]'),'CRM Synthetic');assert.equal(await value('[name=address]'),'');assert.equal(await value('[name=cui]'),'900000000');
 await set('[name=location]','Example 3');await set('[name=county]','BV');await set('[name=address]','Other 99');
 await browser.send('Page.reload');await waitFor(()=>browser.evaluate("document.querySelector('[name=address]')?.value==='Other 99'"));
 assert.equal(await browser.evaluate("document.querySelector('.partner-paths button[aria-pressed=true]').textContent.includes('punct NOU')"),true,'mode survives draft reload');
 await fresh();await set('#partner-discovery','Stale');await delay(450);await set('#partner-discovery','Synthetic');await waitFor(()=>contains('2 puncte de lucru'));await delay(1100);assert.equal(await contains('2 puncte de lucru'),true,'stale empty result cannot replace suggestions');
 searchError=true;await set('#partner-discovery','Unavailable');await waitFor(()=>contains('Căutarea CRM este indisponibilă'));assert.equal(await contains('Niciun rezultat'),false);searchError=false;await click('Reîncearcă căutarea');await waitFor(()=>contains('2 puncte de lucru'));
 await fresh();await set('#partner-discovery','900000001');await delay(800);assert.equal(fiscals.includes('900000001'),false,'invalid checksum');
 await fresh();await set('#partner-discovery','RO900000018');await waitFor(()=>contains('Official Synthetic 900000018'));await waitFor(()=>contains('Niciun punct găsit'));
 await click('Firmă NOUĂ');await waitFor(async()=>await value('[name=company]')==='Official Synthetic 900000018');await set('[name=company]','Manually edited name');await click('Preia denumirea');assert.equal(await value('[name=company]'),'Official Synthetic 900000018');assert.equal(await value('[name=address]'),'');
 await set('[name=company]','Keep my edit');anafStatus='found';await click('Reîncearcă verificarea');await delay(900);assert.equal(await value('[name=company]'),'Keep my edit','async retry never overwrites manual edit');
 for(const state of ['not_found','unavailable']){anafStatus=state;await click('Reîncearcă verificarea');await waitFor(()=>contains(state==='not_found'?'CUI negăsit':'ANAF indisponibil'));assert.equal(await browser.evaluate("document.querySelector('.partner-generate').disabled"),false);}
 anafStatus='found';anafDelay=1000;await set('[name=cui]','900000026');await delay(750);await set('[name=cui]','900000001');await delay(1150);assert.equal(await contains('Official Synthetic 900000026'),false,'stale ANAF ignored');assert.equal(await value('[name=company]'),'Keep my edit');
 await fresh();lookupError=true;await set('#partner-discovery','900000000');await waitFor(()=>contains('Lista punctelor este indisponibilă'));assert.equal(await contains('Niciun punct găsit'),false);lookupError=false;await click('Reîncearcă punctele');await waitFor(()=>contains('Shop 2'));
 await click('punct NOU');
 for(const [width,height] of [[320,800],[390,844],[844,390],[1440,900]]){
  await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'mobile overflow '+width);
 }
 assert.equal(posts.length,1,'only explicit submission writes to synthetic fixture');
 console.log('PASS onboarding browser: discovery, global company/points, ANAF warning and safe prefill, stale/error/retry, exact selection, 409 rebase, drafts, reset, four widths');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
