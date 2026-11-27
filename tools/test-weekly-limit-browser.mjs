// Actual admin component in an isolated browser. Only its network client is mocked.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const source=`import React from 'react';import{createRoot}from'react-dom/client';import{SettingsPanel}from './components/admin';
window.saved=[];window.initialSettings={accessoriesEmail:'accessories@example.invalid',standsEmail:'stands@example.invalid',simEmail:'',accessoriesCc:[],standsCc:[],simCc:[],partnerTo:['synthetic@example.invalid'],partnerCc:[],weeklyLimit:5};
const root=createRoot(document.getElementById('root'));window.renderSettings=(settings)=>{window.currentSettings=settings;root.render(<SettingsPanel settings={settings} users={[]} onSettings={next=>window.renderSettings(next)} onUsers={()=>{}}/>);};window.renderSettings(initialSettings);`;
const client={name:'mock-admin-network',setup(b){b.onResolve({filter:/^@\/lib\/client-api$/},a=>a.importer.endsWith('/components/admin.tsx')?{path:'admin-client',namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},()=>({loader:'js',contents:`export async function api(path,method,body){if(path!=='admin/settings'||method!=='PUT')throw Error('Unexpected request');window.saved.push(body);return {settings:body.repairWeeklyLimit?{...window.currentSettings,weeklyLimit:body.weeklyLimit}:body};}export const errorMessage=e=>String(e);export const normalize=s=>s.toLowerCase();`}));}};
const out=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},write:false,outdir:'out',bundle:true,format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent',alias:{'next/image':resolve('tools/offline-image.tsx')},plugins:[client]});
const js=out.outputFiles.find(f=>f.path.endsWith('.js')).text;
let server,browser;
try {
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?js:'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await browserFixture('http://127.0.0.1:'+server.address().port);const ev=browser.evaluate;
 const select="[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('Comenzi accesorii / agent / săptămână'))?.querySelector('select')";
 await waitFor(()=>ev('!!('+select+')'),'weekly select');
 assert.deepEqual(await ev('Array.from(('+select+').options,o=>[o.value,o.textContent])'),[['','Alege limita'],['0','Fără limită'],...Array.from({length:7},(_,i)=>[String(i+1),String(i+1)])]);
 assert.equal(await ev('('+select+').value'),'5');
 const choose=value=>ev('(()=>{const s='+select+';s.value='+JSON.stringify(value)+';s.dispatchEvent(new Event("change",{bubbles:true}));})()');
 const save=()=>ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Salvează setările')).click()");
 await choose('');await ev('('+select+').form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await waitFor(()=>ev('saved.length===1'),'invalid selection preserves finite cap');assert.equal(await ev('saved[0].weeklyLimit'),5);
 await choose('0');await waitFor(()=>ev('('+select+').value==="0"'),'explicit unlimited selection');await save();await waitFor(()=>ev('saved.length===2'),'unlimited save');assert.equal(await ev('saved[1].weeklyLimit'),0);
 await choose('5');await save();await waitFor(()=>ev('saved.length===3'),'restore finite');assert.equal(await ev('saved[2].weeklyLimit'),5);
 // Simulate fresh bootstrap reporting an invalid persisted value while the panel is open.
 await ev('renderSettings({...initialSettings,weeklyLimit:null})');
 await waitFor(()=>ev('('+select+').value===""'),'no preselected repair limit');
 assert.equal(await ev("[...document.querySelectorAll('fieldset.email-recipient-group')].every(f=>f.disabled)"),true);
 assert.equal(await ev("document.querySelector('input[type=email]').value"),'accessories@example.invalid');
 await ev('('+select+').form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 assert.equal(await ev('saved.length'),3);
 await choose('0');await save();await waitFor(()=>ev('saved.length===4'),'explicit repair');
 assert.deepEqual(await ev('saved[3]'),{weeklyLimit:0,repairWeeklyLimit:true});
 await waitFor(()=>ev("!document.querySelector('fieldset.email-recipient-group').disabled"),'normal settings after repair');
 assert.equal(await ev("document.querySelector('input[type=email]').value"),'accessories@example.invalid');
 await ev('renderSettings(undefined)');await waitFor(()=>ev("document.body.innerText.includes('Setările nu sunt disponibile')"),'failed bootstrap cannot save');
 assert.equal(await ev("!!document.querySelector('form')"),false);
 console.log('PASS explicit weekly limit selector, safe targeted repair and unavailable-settings guard');
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
