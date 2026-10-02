// Real React portfolio and client API; synthetic delayed/error HTTP browse pages.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor,delay} from './offline-browser-fixture.mjs';
let browser,server,failPage=true,holdPage=false,releasePage,checks=0;
const calls=[];
const check=(value,label)=>{assert.ok(value,label);checks++;};
const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {PartnerPortfolio} from './components/partner-portfolio';import {setLocalWorkUserId} from './lib/local-work';setLocalWorkUserId('synthetic-agent');localStorage.setItem('mobiup-partner-view|synthetic-agent|',JSON.stringify({layout:'list'}));function Fixture(){const [scope,setScope]=useState('');window.setScope=setScope;return <PartnerPortfolio userId="synthetic-agent" scopeQuery={scope}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundle=await build({stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},write:false,outdir:'out',bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'unused-map',setup(b){b.onResolve({filter:/^\.\/partner-map$/},()=>({path:'map',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function Map(){return null}',loader:'js'}));}}]});
try{
 server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles.find(f=>f.path.endsWith('.js')).text);return;}
  if(url.pathname.startsWith('/api/')){
   res.setHeader('Content-Type','application/json');
   if(url.pathname==='/api/partner/browse'){
    const offset=Number(url.searchParams.get('offset')),scope=url.searchParams.get('agentId')||'original',q=url.searchParams.get('q')||'';calls.push({offset,scope,q});
    const finish=()=>{
     if(offset===100&&failPage){res.writeHead(503);res.end(JSON.stringify({error:'Synthetic page failure'}));return;}
     const total=scope==='original'&&!q?205:3;
     res.end(JSON.stringify({partners:Array.from({length:Math.max(0,Math.min(100,total-offset))},(_,i)=>({id:scope+'-'+q+'-'+(offset+i),name:scope+' '+q+' row '+(offset+i),cui:'TEST',address:'Example',city:'Example',county:'Example',route:'1',latitude:null,longitude:null,lastVisitedAt:null})),total,located:0,geocoded:0,nextOffset:offset+100<total?offset+100:null,facets:{counties:['Example'],cities:['Example'],routes:['1']},styleUrl:'/style',bounds:null}));
    };
    if(holdPage&&offset===100){releasePage=finish;return;}
    setTimeout(finish,q==='slow'?700:50);return;
   }
   res.end(JSON.stringify({state:'unavailable',message:'Synthetic fixture'}));return;
  }
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await browserFixture('http://127.0.0.1:'+server.address().port);const evaluate=browser.evaluate;
 const wait=expression=>waitFor(()=>evaluate(expression),expression);
 const click=text=>evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
 const fill=text=>evaluate(`const input=document.querySelector('.partner-filters input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));`);
 await wait("document.querySelectorAll('.partner-card').length===100");
 await click('Pagina următoare');await wait("!!document.querySelector('[role=alert]')");
 check(await evaluate("document.querySelector('.bounded-pagination span').textContent==='1–100 din 205'&&document.querySelector('.partner-card strong').textContent==='original  row 0'"),'page 2 failure never relabels page 1 rows');
 check(await evaluate("document.querySelector('.bounded-pagination button').disabled"),'backward action still belongs to successful page 1');
 failPage=false;holdPage=true;await click('Reîncearcă');await waitFor(()=>!!releasePage,'retry request');
 check(calls.at(-1).offset===100,'retry uses the failed page offset');
 check(await evaluate("document.querySelector('.bounded-pagination span').textContent==='1–100 din 205'&&[...document.querySelectorAll('.bounded-pagination button')].every(b=>b.disabled)"),'loading keeps successful label and disables pagination');
 holdPage=false;releasePage();releasePage=null;await wait("document.querySelector('.bounded-pagination span').textContent==='101–200 din 205'");
 check(await evaluate("document.querySelector('.partner-card strong').textContent==='original  row 100'"),'retry displays actual page 2 rows');
 await click('Pagina anterioară');await wait("document.querySelector('.bounded-pagination span').textContent==='1–100 din 205'");
 check(await evaluate("document.querySelector('.partner-card strong').textContent==='original  row 0'"),'backwards restores page 1 data and identity');
 // Hold a forced page request then change the scope without remounting the component.
 await evaluate("window.dispatchEvent(new CustomEvent('mobiup-offline-cache-invalidated',{detail:{prefixes:['partner/browse']}}))");
 holdPage=true;await click('Pagina următoare');await waitFor(()=>!!releasePage,'held page');
 await evaluate("window.setScope('agentId=fresh')");await delay(50);
 check(await evaluate("document.querySelectorAll('.partner-card').length===0&&!document.querySelector('.bounded-pagination')"),'scope transition hides stale actionable rows and labels');
 holdPage=false;releasePage();releasePage=null;await wait("document.querySelectorAll('.partner-card').length===3");
 check(await evaluate("document.querySelector('.partner-card strong').textContent==='fresh  row 0'&&!document.querySelector('.bounded-pagination')"),'late old page cannot overwrite fresh scope');
 assert.deepEqual(calls.at(-1),{offset:0,scope:'fresh',q:''});
 await fill('slow');await delay(30);check(await evaluate("document.querySelectorAll('.partner-card').length===3&&[...document.querySelectorAll('.partner-card')].every(b=>b.disabled)&&!!document.querySelector('.partner-stale-results')"),'same-scope previous results stay visible, labeled and non-actionable while filters debounce');await waitFor(()=>calls.some(c=>c.q==='slow'),'slow search started');await fill('latest');await wait("document.querySelector('.partner-card strong')?.textContent==='fresh latest row 0'");await delay(750);
 check(await evaluate("document.querySelector('.partner-card strong').textContent==='fresh latest row 0'"),'rapid search transitions ignore late replies');
 check(calls.filter(c=>c.q).every(c=>c.offset===0),'search resets successful pagination to zero');
 console.log(`PASS: ${checks} portfolio page failure, retry, loading, backwards, scope and rapid-search browser checks.`);
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
