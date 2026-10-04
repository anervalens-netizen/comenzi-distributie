// Isolated synthetic browser tests: ephemeral origin, profile and debugging port.
import {spawn} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function waitFor(fn,label='browser condition'){
 for(let i=0;i<300;i++){if(await fn())return;await delay(50);}
 throw Error('Timeout: '+label);
}
export async function browserFixture(origin){
 const profile=mkdtempSync(join(tmpdir(),'offline-regression-'));
 const child=spawn(process.env.CHROME_BIN||'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',detached:true});
 const tabs=[];
 const close=async()=>{
  for(const tab of tabs)await tab.close();
  const childPid=child.pid;
  if(typeof childPid==='number'&&Number.isInteger(childPid)&&childPid>0){try{process.kill(-childPid,'SIGTERM');}catch{}}
  await delay(150);if(typeof childPid==='number'&&Number.isInteger(childPid)&&childPid>0){try{process.kill(-childPid,'SIGKILL');}catch{}}
  rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 };
 try{
  let port;await waitFor(()=>{try{port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);return !!port;}catch{return false;}},'Chrome startup');
  const newTab=async(url=origin)=>{
  const pending=new Map();
  const target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));let id=0;
  socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')console.error('Browser exception:',m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP '+method));},45000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{
   try{
   let result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:false,replMode:true});
   // REPL evaluation can return a Promise handle despite awaitPromise. Never let
   // a serialized {} make an asynchronous browser assertion pass spuriously.
   if(result.result?.subtype==='promise')result=await send('Runtime.awaitPromise',{promiseObjectId:result.result.objectId,returnByValue:false});
   if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
   if(result.result?.objectId){const objectId=result.result.objectId;result=await send('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){return this}',returnByValue:true});await send('Runtime.releaseObject',{objectId});}
   return result.result?.value;
   }catch(error){throw new Error(error.message+'; evaluating '+expression.slice(0,180),{cause:error});}
  };
  await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await send('Page.navigate',{url});
  await waitFor(()=>evaluate('document.readyState==="complete"'),'page load');
  const tab={evaluate,send,close:async()=>{socket.close();for(const p of pending.values())clearTimeout(p.timer);await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(()=>{});}};
  tabs.push(tab);return tab;
  };
  const first=await newTab();return {...first,newTab,closeTab:first.close,close};
 }catch(error){await close();throw error;}
}
