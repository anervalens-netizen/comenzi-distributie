import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
const root=resolve('.'),temp=mkdtempSync(join(tmpdir(),'history-import-browser-')),delay=ms=>new Promise(r=>setTimeout(r,ms));
await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{ClientHistoryImport}from'./components/client-history-import';createRoot(document.getElementById('root')).render(<main className='main-content'><ClientHistoryImport/></main>);",resolveDir:root,loader:'tsx'},outfile:join(temp,'ui.js'),bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const preview={month:'2024-02',from:'2024-02-01',through:'2024-02-02',rows:2,valueCents:3800,quantityMicros:4000000,previous:{rows:3,valueCents:6000,lastDate:'2024-02-03'},requiresAcknowledgement:true,removedOccurrences:2,coverageShorter:true,inferredPeriod:true};
let job=null,failedPoll=false,commits=0,uploadName='';
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture.invalid');
 if(url.pathname.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(url.pathname.endsWith('/preview')){uploadName=decodeURIComponent(req.headers['x-client-sales-filename']);job={id:'fixture',state:'running',operation:'preview',filename:uploadName,message:'Se verifică…',preview};}
  else if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;assert.equal(JSON.parse(body).allowRegression,true);commits++;job={...job,state:'completed',operation:'import',result:preview,message:'Vânzările pe clienți și centralizările au fost actualizate.'};}
  else if(url.searchParams.has('job')){
   if(!failedPoll){failedPoll=true;res.statusCode=503;res.end('{}');return;}job={...job,state:'ready'};
  }
  res.end(JSON.stringify({job,latest:null}));return;
 }
 if(url.pathname==='/ui.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(join(temp,'ui.js')));return;}
 if(url.pathname==='/base.css'){res.setHeader('Content-Type','text/css');res.end(readFileSync('app/globals.css','utf8').replace(/^@import .*;$/gm,''));return;}
 res.setHeader('Content-Type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"></head><body><div id="root"></div><script src="/ui.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port,profile=join(temp,'chrome');
const child=spawn(process.env.CHROME_BIN||'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let socket;
try{
 let port;for(let i=0;i<150;i++){if(existsSync(join(profile,'DevToolsActivePort'))){port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}await delay(100);}
 assert(port,'Chrome startup');
 const target=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let serial=0;const pending=new Map();
 socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject,timer:setTimeout(()=>reject(Error(method)),method==='Page.navigate'?45000:15000)});socket.send(JSON.stringify({id,method,params}));});
 const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{for(let i=0;i<150;i++){if(await run(expression))return;await delay(100);}throw Error('Not ready: '+expression);};
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});
 await send('Page.navigate',{url:origin});await wait("document.querySelector('input[type=file]')!==null");
 await run("(()=>{const input=document.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(new File(['synthetic'],'cumulative.xlsx'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await wait("document.body.textContent.includes('Conexiunea a fost întreruptă')");
 await wait("document.querySelector('.sales-preview')!==null");
 assert.equal(uploadName,'cumulative.xlsx');assert(await run("document.querySelector('.sales-preview-actions button').disabled"));
 assert(await run('document.documentElement.scrollWidth<=360'),'No mobile document overflow');
 await send('Page.reload');await wait("document.querySelector('.sales-preview')!==null");
 assert(await run("document.querySelector('.sales-preview-actions button').disabled"),'Reload restores preview, requires fresh correction acknowledgement');
 await run("document.querySelector('input[type=checkbox]').click();document.querySelector('.sales-preview-actions button').click()");
 await wait("document.body.textContent.includes('centralizările au fost actualizate')");
 assert.equal(commits,1);assert(await run("document.querySelector('output')!==null"));
 await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 assert(await run('document.documentElement.scrollWidth<=1280'));
 console.log('PASS: real import panel upload, connection recovery, persisted preview, correction acknowledgement, completion and mobile/desktop layout.');
 await send('Browser.close').catch(()=>{});
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));await delay(300);rmSync(temp,{recursive:true,force:true});}
