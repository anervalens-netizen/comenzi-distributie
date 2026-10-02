// Isolated browser component fixture. All order/mail/stock content is synthetic;
// every API is mocked in memory and any non-GET request is rejected.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const root=resolve('.'),directory=mkdtempSync(join(tmpdir(),'order-result-stock-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const source=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OrderResult} from './components/order-result';
import {StockPanel} from './components/stock-panel';
import {setLocalWorkUserId} from './lib/local-work';
setLocalWorkUserId('synthetic-agent');
window.fixture={calls:[],downloads:[],shared:[],created:[],revoked:[],ignoreAbort:false};
const f=window.fixture;
const createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=createUrl(blob);f.created.push(url);return url;};
URL.revokeObjectURL=url=>{f.revoked.push(url);revokeUrl(url);};
HTMLAnchorElement.prototype.click=function(){f.downloads.push({url:this.href,name:this.download});};
f.native=enabled=>{
  Object.defineProperty(navigator,'share',{configurable:true,value:enabled?async data=>{if(f.shareError)throw new DOMException('Synthetic share rejection',f.shareError);f.shared.push({name:data.files[0].name,text:await data.files[0].text(),title:data.title,body:data.text});}:undefined});
  Object.defineProperty(navigator,'canShare',{configurable:true,value:enabled?()=>true:undefined});
};f.native(false);
window.fetch=(input,options={})=>{
  const path=String(input);if(options.method&&options.method!=='GET')throw new Error('Unexpected write');
  return new Promise((resolve,reject)=>{
    const call={path,signal:options.signal,aborted:false};f.calls.push(call);
    const ignoreAbort=f.ignoreAbort;
    options.signal?.addEventListener('abort',()=>{call.aborted=true;if(!ignoreAbort)reject(new DOMException('Aborted','AbortError'));},{once:true});
    call.resolve=(body,status=200)=>resolve(new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'Content-Type':path.endsWith('/excel')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/json'}}));
  });
};
const order=(id,kind,status)=>({id,number:'SYN-'+id,kind,status,userId:'synthetic-agent',agentName:'Agent sintetic',warehouseId:'synthetic-warehouse',warehouseName:'Gestiune sintetică',createdAt:'2026-09-30T10:00:00Z',finalizedAt:status==='draft'?null:'2026-09-30T10:00:00Z',items:[],serials:[],client:null,pieces:0,total:0,revision:1,notes:''});
f.mail=id=>({mail:{filename:'synthetic-'+id+'.xlsx',subject:'Subiect '+id,body:'Mesaj '+id,to:'synthetic@example.invalid',cc:[],mailto:'mailto:synthetic@example.invalid?subject='+id}});
function Fixture(){
 const [state,setState]=useState({view:'none',order:order('initial','sim','draft'),auto:false,warehouse:'w-a'});
 f.show=(id,kind='sim',status='finalized',auto=false,native=false)=>{f.native(native);setState({view:'result',order:order(id,kind,status),auto,warehouse:'w-a'});};
 f.stock=warehouse=>setState({view:'stock',order:state.order,auto:false,warehouse});
 f.close=()=>setState(previous=>({...previous,view:'none'}));
 return state.view==='result'?<OrderResult order={state.order} autoDownload={state.auto} onClose={f.close} onCopy={()=>{throw new Error('Unexpected copy');}}/>:state.view==='stock'?<StockPanel warehouseId={state.warehouse}/>:<p>Fixture sintetic</p>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({stdin:{contents:source,resolveDir:root,sourcefile:'result-stock-fixture.tsx',loader:'tsx'},outfile:join(directory,'fixture.js'),bundle:true,minify:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},tsconfig:join(root,'tsconfig.json'),logLevel:'silent'});
const server=createServer((request,response)=>{
  const file=request.url==='/fixture.js'||request.url==='/fixture.css'?join(directory,request.url.slice(1)):null;
  if(file&&existsSync(file)){response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');response.end(readFileSync(file));return;}
  response.setHeader('Content-Type','text/html');response.end('<!doctype html><html lang="ro"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=process.env.CHROME_BIN||'/usr/bin/google-chrome';
const profile=join(directory,'chrome'),child=spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-gpu','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
let chromeError,chromeStderr='',childClosed=false;
child.on('error',error=>{chromeError=error;});
child.stderr.on('data',chunk=>{chromeStderr=(chromeStderr+chunk.toString()).slice(-8000);});
// `close` also fires when spawning fails, while `exit` does not.
const closed=new Promise(resolve=>child.once('close',()=>{childClosed=true;resolve();}));
const chromeFailure=reason=>new Error(`${reason} (${chrome}); exit=${child.exitCode??'none'}, signal=${child.signalCode??'none'}${chromeError?`; ${chromeError.message}`:''}\nChrome stderr (last 8000 chars):\n${chromeStderr||'(empty)'}`);
let socket,closeBrowser,testError,cleanupError;
try{
  let port;
  const startupDeadline=performance.now()+30000;
  while(!port&&performance.now()<startupDeadline){
    if(chromeError||childClosed||child.exitCode!==null||child.signalCode!==null)throw chromeFailure('Chrome failed before DevTools became ready');
    // The file may be absent or only partially written during startup.
    try{const candidate=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);if(Number.isInteger(candidate)&&candidate>0&&candidate<=65535)port=candidate;}catch{}
    if(!port)await delay(100);
  }
  if(!port)throw chromeFailure('Timeout after 30000 ms waiting for Chrome DevTools port');
  const response=await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT',signal:AbortSignal.timeout(5000)}).catch(error=>{throw chromeFailure(`Chrome DevTools connection failed: ${error.message}`);});
  if(!response.ok)throw chromeFailure(`Chrome DevTools returned HTTP ${response.status}`);
  const target=await response.json();
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(chromeFailure('Timeout opening Chrome DevTools WebSocket')),5000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(chromeFailure('Chrome DevTools WebSocket failed'));},{once:true});
  });
  let next=1;const pending=new Map(),errors=[];
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);if(!message.id)return;const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);if(message.error)entry.reject(new Error(message.error.message));else entry.resolve(message.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=next++,timer=setTimeout(()=>reject(new Error('Timeout: '+method)),method==='Page.navigate'?45000:15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  closeBrowser=()=>send('Browser.close');
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  async function waitFor(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(30);}throw new Error('Not ready: '+expression);}
  const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
  const fill=(selector,value)=>evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  const select=(selector,value)=>evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  const resolveMail=(index,id)=>evaluate('fixture.calls.slice('+index+').find(call=>call.path==="/api/orders/"+'+JSON.stringify(id)+'+"/mail").resolve(fixture.mail('+JSON.stringify(id)+'));true');
  const reset=async()=>{await evaluate('fixture.close();true');await delay(40);await evaluate('fixture.calls=[];fixture.downloads=[];fixture.shared=[];fixture.created=[];fixture.revoked=[];fixture.ignoreAbort=false;fixture.shareError="";true');};
  await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
  await waitFor('!!window.fixture?.show');
  await evaluate('fixture.show("draft","sim","draft",true,true);true');await delay(80);
  check(await evaluate('fixture.calls.length===0&&fixture.downloads.length===0'),'Draft consultation never loads mail/Excel or downloads');
  check(await evaluate('!document.querySelector("a[download]")'),'Draft has no finalized download');

  await reset();await evaluate('fixture.show("email","stand_client");true');await waitFor('fixture.calls.length===1');
  check(await evaluate('fixture.calls[0].path==="/api/orders/email/mail"'),'Stand-client consult requests only its mail');
  await resolveMail(0,'email');await waitFor('!document.querySelector(".result-buttons button").disabled');
  check(await evaluate('!document.querySelector(".result-buttons a")&&fixture.calls.length===1'),'Email-only order has no Excel request/link');

  await reset();await evaluate('fixture.show("history");true');await waitFor('fixture.calls.length===1');
  await resolveMail(0,'history');await waitFor('!document.querySelector(".result-buttons button").disabled');
  check(await evaluate('fixture.calls.length===1&&fixture.calls[0].path.endsWith("/mail")'),'Ordinary desktop history consultation does not eagerly load Excel');
  check(await evaluate('document.querySelector(".result-buttons a").getAttribute("href")==="/api/orders/history/excel"'),'Manual lazy export retains exact authenticated Excel URL');
  check(await evaluate('fixture.created.length===0&&fixture.downloads.length===0'),'Ordinary consultation allocates no blob URL and causes no download');

  await reset();await evaluate('fixture.show("auto","sim","finalized",true);true');await waitFor('fixture.calls.length===2');
  check(await evaluate('fixture.calls.some(call=>call.path.endsWith("/mail"))&&fixture.calls.some(call=>call.path.endsWith("/excel"))'),'Autodownload starts independent mail/Excel concurrently before either resolves');
  await resolveMail(0,'auto');await waitFor('!document.querySelector(".result-buttons button").disabled');
  check(await evaluate('fixture.downloads.length===0'),'Mail readiness never downloads before file readiness');
  await evaluate('fixture.calls.find(call=>call.path==="/api/orders/auto/excel").resolve("synthetic-excel-auto");true');await waitFor('fixture.downloads.length===1');
  check(await evaluate('fixture.downloads[0].name==="synthetic-auto.xlsx"&&fixture.downloads[0].url.startsWith("blob:")'),'Autodownload preserves mail-derived filename and generated file');
  await click('.result-buttons a');
  check(await evaluate('fixture.calls.length===2&&fixture.downloads.length===2&&fixture.downloads[0].url===fixture.downloads[1].url'),'Manual redownload reuses prepared bytes rather than another Excel GET');
  await evaluate('fixture.close();true');await waitFor('fixture.revoked.length===1');
  check(await evaluate('fixture.revoked[0]===fixture.created[0]'),'Prepared object URL is revoked when result unmounts');

  await reset();await evaluate('fixture.show("native","sim","finalized",false,true);true');await waitFor('fixture.calls.length===2');
  await evaluate('fixture.calls.find(call=>call.path==="/api/orders/native/excel").resolve("synthetic-excel-native");true');await delay(40);
  check(await evaluate('fixture.created.length===0'),'File waits for correct mail-derived filename even if Excel finishes first');
  await resolveMail(0,'native');await waitFor('!![...document.querySelectorAll("button")].find(button=>button.textContent.includes("Distribuie Excelul"))');
  check(await evaluate('fixture.downloads.length===0'),'Native share preparation does not auto-download history');
  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Distribuie Excelul")).click();true');
  await waitFor('fixture.shared.length===1');
  check(await evaluate('fixture.shared[0].name==="synthetic-native.xlsx"&&fixture.shared[0].text==="synthetic-excel-native"&&fixture.shared[0].title==="Subiect native"'),'Native share receives the exact prepared File and mail metadata');
  check(await evaluate('fixture.calls.length===2'),'Share click issues no asynchronous fetch before navigator.share');
  await evaluate('fixture.shareError="AbortError";[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Distribuie Excelul")).click();true');await delay(40);
  check(await evaluate('!![...document.querySelectorAll("button")].find(button=>button.textContent.includes("Distribuie Excelul"))'),'Cancelled native share preserves retry availability');
  await evaluate('fixture.shareError="NotAllowedError";[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Distribuie Excelul")).click();true');
  await waitFor('!!document.querySelector(".share-help[role=status]")');
  check(await evaluate('fixture.calls.length===2&&document.querySelector(".result-buttons a").href.startsWith("blob:")'),'Failed native share preserves prepared download and manual email fallback');

  await reset();await evaluate('fixture.show("failure","sim","finalized",true);true');await waitFor('fixture.calls.length===2');
  await resolveMail(0,'failure');await evaluate('fixture.calls.find(call=>call.path==="/api/orders/failure/excel").resolve("synthetic failure",503);true');
  await waitFor('!!document.querySelector("[role=alert]")&&document.querySelector(".result-buttons button")?.disabled===false');
  check(await evaluate('!document.querySelector(".result-buttons button").disabled&&fixture.downloads.length===0'),'Excel failure preserves available mail and never auto-downloads');

  await reset();await evaluate('fixture.ignoreAbort=true;fixture.show("old","sim","finalized",true);true');await waitFor('fixture.calls.length===2');
  await evaluate('fixture.show("new","sim","finalized",true);true');await waitFor('fixture.calls.length===4');
  check(await evaluate('fixture.calls[0].aborted&&fixture.calls[1].aborted'),'Changing document aborts both stale requests');
  check(await evaluate('document.querySelector(".result-buttons button").disabled'),'New document never exposes prior mail/file readiness');
  await resolveMail(0,'old');await evaluate('fixture.calls.find(call=>call.path==="/api/orders/old/excel").resolve("old excel");true');await delay(40);
  check(await evaluate('fixture.created.length===0&&fixture.downloads.length===0'),'Late cancelled response cannot create or download an old document');
  await resolveMail(2,'new');await evaluate('fixture.calls.find(call=>call.path==="/api/orders/new/excel").resolve("new excel");true');await waitFor('fixture.downloads.length===1');
  check(await evaluate('fixture.downloads[0].name==="synthetic-new.xlsx"'),'Only active document can auto-download after a response race');

  await reset();await evaluate('fixture.ignoreAbort=true;fixture.show("closed","sim","finalized",true);true');await waitFor('fixture.calls.length===2');
  await evaluate('fixture.close();true');await waitFor('fixture.calls.every(call=>call.aborted)');
  await resolveMail(0,'closed');await evaluate('fixture.calls.find(call=>call.path==="/api/orders/closed/excel").resolve("closed excel");true');await delay(40);
  check(await evaluate('fixture.created.length===0&&fixture.downloads.length===0'),'Unmount cancellation suppresses late automatic download');

  const stock={warehouseId:'w-a',importedAt:'2026-09-30T10:00:00Z',depotImportedAt:null,depot:{},filename:'synthetic-stock.xlsx',rows:[{code:'B2',name:'Încărcător',category:'B',quantity:3},{code:'A1',name:'Cablu',category:'A',quantity:2},{code:'B1',name:'Telefon',category:'B',quantity:4},{code:'N1',name:'Produs fără grup',category:null,quantity:5},{code:'A2',name:'Cablu USB',category:'A',quantity:7}]};
  await reset();await evaluate('fixture.stock("w-a");true');await waitFor('fixture.calls.length===1');
  await evaluate('fixture.calls[0].resolve('+JSON.stringify(stock)+');true');await waitFor('document.querySelectorAll(".stock-row").length===5');
  check(await evaluate('[...document.querySelectorAll(".stock-row small")].map(node=>node.textContent).join(",")==="A1,A2,B2,B1,N1"'),'One-pass stock grouping preserves category order and input order');
  check(await evaluate('[...document.querySelectorAll(".stock-category h3 small")].map(node=>node.textContent).join("|")==="2 coduri · 9 buc.|2 coduri · 7 buc.|1 coduri · 5 buc."'),'Stock category totals preserve exact quantities');
  check(await evaluate('document.querySelector(".stock-summary").textContent.includes("21")'),'Full stock total remains complete');
  await fill('[aria-label="Caută în stoc"]','incarcator');await waitFor('document.querySelectorAll(".stock-row").length===1');
  check(await evaluate('document.querySelector(".stock-row small").textContent==="B2"'),'Stock normalized accent-insensitive search is unchanged');
  await fill('[aria-label="Caută în stoc"]','Cablu');await waitFor('document.querySelectorAll(".stock-row").length===2');
  check(await evaluate('document.querySelector(".stock-result-count").textContent==="2 coduri găsite · 9 buc. · pagina 1 din 1"'),'Filtered count and pieces use all matching stock rows');
  await fill('[aria-label="Caută în stoc"]','');
  await select('[aria-label="Filtrează după categorie"]','B');
  await waitFor('document.querySelectorAll(".stock-row").length===2');
  check(await evaluate('[...document.querySelectorAll(".stock-row small")].map(node=>node.textContent).join(",")==="B2,B1"'),'Stock category filter retains both matching rows in original order');
  check(await evaluate('fixture.calls.length===1'),'Stock local searches and filters cause no extra API calls');
  await evaluate('fixture.ignoreAbort=true;window.dispatchEvent(new Event("stock-imported"));true');await waitFor('fixture.calls.length===2');
  await evaluate('window.dispatchEvent(new Event("stock-imported"));true');await waitFor('fixture.calls.length===3');
  check(await evaluate('fixture.calls[1].aborted&&!fixture.calls[2].aborted'),'A newer stock refresh aborts the previous refresh');
  const latest={...stock,rows:[{code:'NEW',name:'Stoc nou',category:'B',quantity:99}]};
  await evaluate('fixture.calls[2].resolve('+JSON.stringify(latest)+');true');await waitFor('document.querySelector(".stock-row small")?.textContent==="NEW"');
  await evaluate('fixture.calls[1].resolve('+JSON.stringify(stock)+');true');await delay(40);
  check(await evaluate('document.querySelector(".stock-row small").textContent==="NEW"'),'Generation guard prevents an ignored-abort response replacing newer stock');
  await evaluate('window.dispatchEvent(new Event("stock-imported"));true');await waitFor('fixture.calls.length===4');
  await evaluate('fixture.stock("w-b");true');await waitFor('fixture.calls.length===5');
  check(await evaluate('fixture.calls[3].aborted&&fixture.calls[4].path.includes("w-b")'),'Changing warehouse aborts its old stock request and uses the new scope');
  await evaluate('fixture.close();true');await waitFor('fixture.calls[4].aborted');
  check(await evaluate('fixture.calls[4].aborted'),'Stock unmount aborts active request');
  check(errors.length===0,'No runtime exceptions: '+errors.join('; '));
  const result={checks,synthetic:true,desktopHistoryRequests:1,nativeShareRequests:2,autoDownloadRequests:2,stockGrouping:'single-pass',raceAndAbortGuards:true};
  if(process.env.PERFORMANCE_EVIDENCE_PATH)writeFileSync(process.env.PERFORMANCE_EVIDENCE_PATH,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));console.log('PASS: '+checks+' synthetic order-result/stock browser checks.');
}catch(error){testError=error;throw error;}finally{
  const cleanupErrors=[];
  await closeBrowser?.().catch(()=>{});
  try{socket?.close();}catch(error){cleanupErrors.push(error);}
  await Promise.race([closed,delay(2000)]);
  // Only the dedicated process group we spawned, including surviving children.
  if(child.pid){
    try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')cleanupErrors.push(error);}
    await Promise.race([closed,delay(2000)]);
    if(!childClosed){
      try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')cleanupErrors.push(error);}
      await Promise.race([closed,delay(2000)]);
      if(!childClosed)cleanupErrors.push(chromeFailure('Chrome did not close after SIGKILL'));
    }
  }
  await delay(200);
  try{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}catch(error){cleanupErrors.push(error);}
  try{rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){cleanupErrors.push(error);}
  if(cleanupErrors.length){cleanupError=new AggregateError(cleanupErrors,'Browser fixture cleanup failed');if(testError)console.error(cleanupError);}
}
if(cleanupError)throw cleanupError;
