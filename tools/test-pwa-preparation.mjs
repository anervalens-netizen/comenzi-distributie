// Deterministic protocol/race simulation; real installed-worker coverage is separate.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
const compiled=await build({stdin:{contents:"export {prepareOfflineShell,getOfflineShellPreparation} from './components/pwa';",loader:'ts',resolveDir:resolve('.')},bundle:true,write:false,format:'esm',platform:'node',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const original={navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),window:globalThis.window,document:globalThis.document,setTimeout:globalThis.setTimeout};
let registration,active,waiting;const events=[],ports=[];
class Worker extends EventTarget{
 constructor(name,reply){super();this.name=name;this.state=name==='active'?'activated':'installed';this.reply=reply;this.calls=0;}
 postMessage(message,channels){if(message.type!=='PREPARE_OFFLINE_SHELL')return;this.calls++;ports.push(channels[0]);this.reply?.(channels[0]);}
}
const ready=port=>port.postMessage({type:'OFFLINE_SHELL_PREPARATION',state:'ready',completed:2,total:2});
try{
 globalThis.window=new EventTarget();window.addEventListener('mobiup-shell-preparation',e=>events.push(e.detail.state));globalThis.document={scripts:[]};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serviceWorker:{get controller(){return active},get ready(){return Promise.resolve(registration)},getRegistration:async()=>registration}}});
 const m=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 function reset(reply=ready){events.length=0;active=new Worker('active',ready);waiting=new Worker('waiting',reply);registration={active,waiting,installing:null};}
 reset();await m.prepareOfflineShell();assert.equal(active.calls,1);assert.equal(waiting.calls,1);assert.equal(m.getOfflineShellPreparation().state,'ready');assert.equal(events.filter(s=>s==='ready').length,1);
 reset(port=>{registration.waiting=new Worker('replacement',ready);ready(port)});await assert.rejects(m.prepareOfflineShell(),/schimbat/);assert(!events.includes('ready'));
 reset(port=>{registration.installing=new Worker('newly installing',ready);ready(port)});await assert.rejects(m.prepareOfflineShell(),/schimbat/);assert(!events.includes('ready'));
 reset(port=>{active=new Worker('new controller',ready);ready(port)});await assert.rejects(m.prepareOfflineShell(),/schimbat/);assert(!events.includes('ready'));
 reset(port=>port.postMessage({type:'OFFLINE_SHELL_PREPARATION',state:'error',completed:1,total:2,error:'Synthetic worker error'}));await assert.rejects(m.prepareOfflineShell(),/Synthetic worker error/);assert(!events.includes('ready'));
 let late;reset(port=>{late=port});globalThis.setTimeout=(fn,ms,...args)=>original.setTimeout(fn,[5000,15000,30000].includes(ms)?30:ms,...args);
 await assert.rejects(m.prepareOfflineShell(),/expirat/);ready(late);await new Promise(r=>original.setTimeout(r,10));assert.equal(m.getOfflineShellPreparation().state,'error');assert(!events.includes('ready'));
 reset(port=>{waiting.state='redundant';waiting.dispatchEvent(new Event('statechange'));ready(port)});await assert.rejects(m.prepareOfflineShell(),/schimbat/);assert(!events.includes('ready'));
 reset(port=>port.postMessage({type:'OFFLINE_SHELL_PREPARATION',state:'ready',completed:1,total:2}));await assert.rejects(m.prepareOfflineShell(),/nu a reușit/);assert(!events.includes('ready'));
 console.log('PASS: 8 deterministic PWA target, replacement, installation, controller, failure, timeout, redundancy and incomplete-ready scenarios.');
}finally{
 for(const port of ports)port.close();globalThis.setTimeout=original.setTimeout;
 Object.defineProperty(globalThis,'navigator',original.navigator);if(original.window===undefined)delete globalThis.window;else globalThis.window=original.window;if(original.document===undefined)delete globalThis.document;else globalThis.document=original.document;
}
