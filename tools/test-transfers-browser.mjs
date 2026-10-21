import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function testTransferBrowser(origin,cookies){
 const profile=mkdtempSync(join(tmpdir(),'transfer-chrome-')),port=9467;
 const chrome=spawn(process.env.CHROME_BIN,['--headless=new','--no-sandbox','--disable-dev-shm-usage',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
 let socket;let checks=0;const pending=new Map();let next=0;
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const check=(value,label)=>{assert.ok(value,label);checks++;};
 const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await pause(100);}throw new Error('Browser timeout: '+label);};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};
 const click=async(selector)=>{check(await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return false;node.click();return true;})()`),'Clickable '+selector);};
 const button=async(text)=>{check(await evaluate(`(()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(text)});if(!node)return false;node.click();return true;})()`),'Button '+text);};
 const fill=async(selector,value)=>{await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);};
 const screenshot=async(name)=>{mkdirSync('work/transfer-browser',{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(`work/transfer-browser/${name}.png`,Buffer.from(shot.data,'base64'));};
 try{
  let target;await wait(async()=>{try{target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(response=>response.json());return !!target.webSocketDebuggerUrl;}catch{return false;}},'Chrome start');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id)return;const request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result);});
  await send('Page.enable');await send('Network.enable');await send('Emulation.setDeviceMetricsOverride',{width:820,height:1180,deviceScaleFactor:1,mobile:false});
  const login=async(id)=>{await send('Network.setCookie',{name:'mobiup_session',value:cookies[id].split('=')[1],url:origin,httpOnly:true,sameSite:'Strict'});await send('Page.navigate',{url:origin});await wait(()=>evaluate("!!document.querySelector('.app-shell')"),'Authenticated app');};
  await login('ta');
  const tabs=await evaluate("[...document.querySelectorAll('.main-nav [role=tab]')].map(node=>node.textContent.trim())");check(tabs.indexOf('Transfer')===tabs.indexOf('Avize')+1&&tabs.indexOf('Parteneri')===tabs.indexOf('Transfer')+1,'Agent Transfer between Avize and Parteneri');
  await evaluate("[...document.querySelectorAll('[role=tab]')].find(node=>node.textContent==='Transfer').click();true");
  await wait(()=>evaluate("document.querySelector('.transfer-start button')&&!document.querySelector('.transfer-start button').disabled"),'Transfer list loaded');await button('Transfer nou');
  await wait(()=>evaluate("document.querySelectorAll('.transfer-product').length>0"),'Product catalog');
  await fill('[aria-label="Gestiunea destinație"]','tb');
  await click('.transfer-product');await button('Telefoane');await click('.transfer-product');
  const imeiSelector='input[aria-label^="Scanează IMEI1"]';await wait(()=>evaluate(`!!document.querySelector(${JSON.stringify(imeiSelector)})`),'IMEI input');await fill(imeiSelector,'012345678901234');
  await evaluate(`document.querySelector(${JSON.stringify(imeiSelector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await wait(()=>evaluate("document.querySelector('.transfer-serials')?.textContent.includes('012345678901234')"),'IMEI scan committed');
  await button('SIM-uri');await click('.transfer-product');const simSelector='input[aria-label^="Scanează seria SIM"]';await fill(simSelector,'00123456789012345678');
  await evaluate(`document.querySelector(${JSON.stringify(simSelector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));true`);
  await wait(()=>evaluate("document.querySelectorAll('.transfer-serials li').length===2"),'SIM Tab suffix scan');
  await wait(()=>evaluate("document.querySelector('.transfer-editor output')?.textContent==='Ciornă salvată'"),'Autosaved transfer');
  check(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),'Tablet editor fits viewport');await screenshot('agent-editor-tablet');
  await button('Finalizează solicitarea');await wait(()=>evaluate("!!document.querySelector('.transfer-result')"),'Finalized transfer result');
  check(await evaluate("document.querySelector('.email-preview')?.textContent.includes('manager-b@example.invalid')"),'Result shows manager from destination region');
  check(await evaluate("[...document.querySelectorAll('.transfer-result a')].some(node=>node.textContent.includes('.eml'))"),'Result offers eml with attachment');await screenshot('agent-result-tablet');
  await login('tm-a');await evaluate("[...document.querySelectorAll('[role=tab]')].find(node=>node.textContent==='Operațiuni').click();true");
  await wait(()=>evaluate("!!document.querySelector('.manager-operation-nav')"),'Manager operations');await button('Transferuri');
  await wait(()=>evaluate("!!document.querySelector('[aria-label=\"Agent expeditor\"]')"),'Manager source selector');await fill('[aria-label="Agent expeditor"]','tc');await button('Transfer nou');
  await wait(()=>evaluate("document.querySelector('.transfer-editor .page-heading p')?.textContent.includes('Synthetic tc')"),'Manager unassigned source editor');
  await fill('[aria-label="Gestiunea destinație"]','ta');await wait(()=>evaluate("document.querySelector('.transfer-editor output')?.textContent==='Ciornă salvată'"),'Manager autosave');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});await screenshot('manager-editor-desktop');
  check(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),'Manager editor fits desktop');
  console.log(`PASS: ${checks} transfer tablet/browser/scanner/manager checks.`);
 }finally{for(const request of pending.values())clearTimeout(request.timer);socket?.close();chrome.kill();await new Promise(resolve=>{if(chrome.exitCode!==null)return resolve();chrome.once('exit',resolve);});rmSync(profile,{recursive:true,force:true});}
}
