import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {PartnerPortfolio} from './components/partner-portfolio';import {PartnerNew} from './components/partner-new';import {setLocalWorkUserId} from './lib/local-work';setLocalWorkUserId('synthetic-agent');createRoot(document.getElementById('root')).render(location.search.includes('new')?<PartnerNew userId="synthetic-agent"/>:<PartnerPortfolio userId="synthetic-agent"/>);`;
const bundle=await build({stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},write:false,outdir:'out',bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'map',setup(b){b.onResolve({filter:/^\.\/partner-map$/},()=>({path:'map',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function Map(){return null}',loader:'jsx'}));}}]});
const css=readFileSync('app/globals.css','utf8')+bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
let mode='found',delay=0,lookups=0,writes=0;
const company=cui=>({cui,name:'Synthetic '+cui,fiscalAddress:'Fiscal address only',registrationNumber:'SYNTHETIC',registrationState:'',vatRegistered:false,inactive:true});
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles.find(f=>f.path.endsWith('.js')).text);return;}
 if(url.pathname.startsWith('/api/')){
  if(req.method!=='GET')writes++;
  res.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/partner/anaf'){lookups++;const cui=url.searchParams.get('cui');const state={source:'ANAF',cui,status:mode,queriedFor:'2026-01-02',checkedAt:'2026-01-02T10:00:00Z',message:mode==='found'?'Firmă identificată în ANAF.':mode==='not_found'?'CUI negăsit în răspunsul ANAF.':'Verificare ANAF indisponibilă momentan.',...(mode==='found'?{company:company(cui)}:{})};setTimeout(()=>res.end(JSON.stringify(state)),delay);return;}
  res.end(JSON.stringify(url.pathname==='/api/partner/browse'?{partners:[],total:0,located:0,geocoded:0,nextOffset:null,facets:{counties:[],cities:[],routes:[]},styleUrl:'/style',bounds:null}:url.pathname==='/api/partner/lookup'?{locations:[]}:url.pathname==='/api/partner/requests'?{requests:[]}:{state:'unavailable',message:'Synthetic'}));return;
 }
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
const set=async(tab,selector,value)=>tab.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
try{
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);
 await waitFor(()=>browser.evaluate("!!document.querySelector('.partner-filters input[placeholder^=\"Nume\"]')"),'search');
 const query='.partner-filters input[placeholder^="Nume"]';
 await set(browser,query,'24');
 await new Promise(r=>setTimeout(r,700));
 assert.equal(await browser.evaluate("!!document.querySelector('.partner-anaf')"),false,'ordinary numeric searches are not mislabeled as invalid CUIs');
 await set(browser,query,'RO900000000');
 await waitFor(()=>browser.evaluate("document.querySelector('.partner-anaf')?.textContent.includes('Synthetic 900000000')"),'search fiscal result');
 assert.ok(await browser.evaluate("document.querySelector('.partner-anaf').textContent.includes('inactiv fiscal')"));
 await set(browser,query,'Example name');
 await waitFor(()=>browser.evaluate("!document.querySelector('.partner-anaf')"),'name search clears fiscal result');
 const tab=await browser.newTab(origin+'/?new');
 await waitFor(()=>tab.evaluate("!!document.querySelector('input[name=cui]')"),'new partner');
 await set(tab,'input[name=address]','Keep my delivery address');
 await set(tab,'input[name=company]','My entered company');
 await set(tab,'input[name=cui]','900000000');
 await waitFor(()=>tab.evaluate("document.querySelector('.partner-anaf')?.textContent.includes('Synthetic 900000000')"),'new fiscal result');
 assert.equal(await tab.evaluate("document.querySelector('input[name=company]').value"),'My entered company');
 await tab.evaluate("[...document.querySelectorAll('.partner-anaf button')].find(b=>b.textContent.includes('Preia')).click()");
 assert.equal(await tab.evaluate("document.querySelector('input[name=company]').value"),'Synthetic 900000000');
 assert.equal(await tab.evaluate("document.querySelector('input[name=address]').value"),'Keep my delivery address');
 for(const status of ['not_found','unavailable']){
  mode=status;
  await tab.evaluate("[...document.querySelectorAll('.partner-anaf button')].find(b=>b.textContent.includes('Reîncearcă')).click()");
  await waitFor(()=>tab.evaluate(`document.querySelector('.partner-anaf')?.textContent.includes('${status==='not_found'?'negăsit':'indisponibilă'}')`),status);
  assert.equal(await tab.evaluate("document.querySelector('.partner-generate').disabled"),false);
 }
 mode='found';delay=1000;
 await set(tab,'input[name=cui]','900000018');
 await new Promise(r=>setTimeout(r,750));
 await set(tab,'input[name=cui]','900000001');
 await waitFor(()=>tab.evaluate("document.querySelector('.partner-anaf')?.textContent.includes('CUI invalid')"),'invalid');
 await new Promise(r=>setTimeout(r,1100));
 assert.equal(await tab.evaluate("document.querySelector('.partner-anaf').textContent.includes('Synthetic')"),false);
 assert.equal(writes,0,'lookup must never submit/create/notify');
 await tab.send('Emulation.setDeviceMetricsOverride',{width:320,height:800,deviceScaleFactor:1,mobile:true});
 const rect=await tab.evaluate("(()=>{const r=document.querySelector('.partner-anaf').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()");
 assert.ok(rect.left>=0&&rect.right<=rect.width,JSON.stringify(rect));
 console.log('PASS ANAF browser: both entry points, manual name application, address preservation, invalidation, outages, no writes, mobile width. Lookups: '+lookups);
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
