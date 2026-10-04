import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import XLSX from 'xlsx';

const chrome=process.env.CHROME_BIN||'/usr/bin/google-chrome';
const work=mkdtempSync(join(tmpdir(),'client-import-browser-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['PartnerName','CIF','Oras','Judet','Street','Ruta nr'],...Array.from({length:3000},(_,i)=>[`Synthetic ${i}`,`RO${i}`,'Test City','Test County','Test Street','01'])]),'Portofoliu');
const fixture=process.env.CLIENT_IMPORT_BENCHMARK_FIXTURE?readFileSync(process.env.CLIENT_IMPORT_BENCHMARK_FIXTURE):XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true});
await build({entryPoints:['lib/client-import.worker.ts'],outfile:join(work,'worker.js'),bundle:true,platform:'browser',format:'esm'});
await build({stdin:{contents:"import { readClientsInWorker } from './lib/client-import-worker-client.ts';window.readClients=(file,signal)=>readClientsInWorker(file,()=>new Worker('/worker.js',{type:'module'}),signal);",resolveDir:process.cwd()},outfile:join(work,'client.js'),bundle:true,platform:'browser',format:'esm'});
const server=createServer((request,response)=>{
  if(request.url==='/fixture.xlsx'){response.end(fixture);return;}
  if(['/worker.js','/client.js'].includes(request.url)){response.setHeader('Content-Type','text/javascript');response.end(readFileSync(join(work,request.url.slice(1))));return;}
  response.setHeader('Content-Type','text/html');response.end('<html><body>Synthetic client import test<script type="module" src="/client.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const processChrome=spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${join(work,'profile')}`,origin],{stdio:'ignore',detached:true});
let socket;
try {
  let port;
  for(let attempt=0;attempt<100&&!port;attempt++){try{port=Number(readFileSync(join(work,'profile','DevToolsActivePort'),'utf8').split('\n')[0]);}catch{}if(!port)await sleep(100);}
  assert.ok(port,'Owned isolated Chrome started');
  const page=await fetch(`http://127.0.0.1:${port}/json/new?${origin}`,{method:'PUT'}).then(r=>r.json());
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let nextId=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id)return;const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);if(message.error)request.reject(Error(message.error.message));else request.resolve(message.result);});
  function send(method,params){return new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP test timeout'));},method==='Page.navigate'?45000:15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
  async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
  await send('Page.navigate',{url:origin});
  let ready=false;for(let i=0;i<80;i++){ready=await evaluate('typeof window.readClients==="function"');if(ready)break;await sleep(100);}
  assert.ok(ready,`Synthetic import page ready: ${JSON.stringify(await evaluate('({href:location.href,body:document.body.innerText})'))}`);
  const evidence=await evaluate(`(async()=>{
    const file=new File([await fetch('/fixture.xlsx').then(r=>r.arrayBuffer())],'synthetic.xlsx');
    let ticks=0,last=performance.now(),maxGap=0;const long=[];
    const observer=new PerformanceObserver(list=>long.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask'});
    const interval=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},5);
    const started=performance.now(),parsed=await window.readClients(file),elapsed=performance.now()-started;
    clearInterval(interval);await new Promise(r=>setTimeout(r,50));observer.disconnect();
    const abort=new AbortController();const cancelled=window.readClients(file,abort.signal);abort.abort();let abortName;try{await cancelled;}catch(error){abortName=error.name;}
    return {syntheticRows:parsed.clients.length,elapsedMs:elapsed,mainLoopTicks:ticks,maxTimerGapMs:maxGap,longTasksMs:long,abortName};
  })()`);
  assert.equal(evidence.syntheticRows,3000);assert.ok(evidence.mainLoopTicks>=3,'Browser main thread continued ticking during XLSX parse');
  assert.ok(Math.max(0,...evidence.longTasksMs)<150,'Client import worker must not produce a 150 ms main-thread long task');
  assert.equal(evidence.abortName,'AbortError','Browser worker cancellation rejects before any result can become a preview');
  const result={pass:true,...evidence};
  if(process.env.CLIENT_IMPORT_BENCHMARK_OUTPUT)writeFileSync(process.env.CLIENT_IMPORT_BENCHMARK_OUTPUT,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
} finally {
  socket?.close();const processChromePid=processChrome.pid;if(typeof processChromePid==='number'&&Number.isInteger(processChromePid)&&processChromePid>0){try{process.kill(-processChromePid,'SIGTERM');}catch{}}processChrome.kill();await new Promise(resolve=>{if(processChrome.exitCode!==null)resolve();else processChrome.once('exit',resolve);});
  await new Promise(resolve=>server.close(resolve));try{rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){console.warn(`Owned temporary browser profile cleanup: ${error.code}`);}
}
