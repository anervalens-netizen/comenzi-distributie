import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const source=`import React from 'react';import{createRoot}from'react-dom/client';import{ImportsJournal}from'./components/imports-journal';createRoot(document.getElementById('root')).render(<ImportsJournal/>);`;
const compiled=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},outfile:'fixture.js',write:false,bundle:true,format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent'});
const files=new Map(compiled.outputFiles.map(f=>['/'+f.path.split('/').at(-1),f.text]));let browser,job=null,commitBody=null,repreviewBody=null;
const delta={before:{codes:2,quantity:10},after:{codes:1,quantity:5},changes:[{}]};
const preview=(mapping='w')=>({rowCount:1,fileHash:'a'.repeat(64),version:'v',confirmation:'confirmed',targets:[{id:'w',name:'Gestiune A'},{id:'w2',name:'Gestiune B'}],groups:[{key:'g',name:'Sursă A',warehouseId:mapping}],impact:{warehouses:[{warehouseId:mapping,...delta}],depot:delta}});
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;res.setHeader('Content-Type','application/json');
 if(req.url==='/api/auth/session')return res.end(JSON.stringify({user:{id:'manager'}}));
 if(req.url==='/api/imports/catalog')return res.end(JSON.stringify({kinds:[{id:'stock_tr',label:'Stoc TR',extensions:['.xlsx'],max_bytes:8000000}]}));
 if(req.url==='/api/admin/imports/status')return res.end(JSON.stringify({sales:null,stock:null}));
 if(req.url==='/api/client-sales/import/status')return res.end(JSON.stringify({latest:null}));
 if(req.url?.startsWith('/api/imports/jobs?'))return res.end(JSON.stringify({jobs:job?[job]:[]}));
 if(req.url==='/api/imports/jobs'&&req.method==='POST'){
  job={id:req.headers['x-import-id'],kind:'stock_tr',actor:{id:'manager',label:'Manager sintetic'},source:{filename:'stoc.xlsx',size:9,sha256:req.headers['x-import-sha256'],date_start:'2026-01-01',date_end:'2026-01-31'},state:'ready',created_at:'2026-01-02T10:00:00Z',preview_hash:'a'.repeat(64),preview:preview()};return res.end(JSON.stringify({job}));
 }
 if(req.url?.endsWith('/preview')&&req.method==='POST'){
  repreviewBody=JSON.parse(body);assert.equal(repreviewBody.preview_hash,'a'.repeat(64));job={...job,preview_hash:'b'.repeat(64),preview:preview(repreviewBody.options.mappings.g)};return res.end(JSON.stringify({job}));
 }
 if(req.url?.endsWith('/commit')&&req.method==='POST'){
  commitBody=JSON.parse(body);job={...job,state:'completed',result:{ok:true}};return res.end(JSON.stringify({job}));
 }
 if(req.url?.startsWith('/api/imports/jobs/'))return res.end(JSON.stringify({job}));
 if(files.has(req.url)){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(files.get(req.url));}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await browserFixture('http://127.0.0.1:'+server.address().port);await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});const e=browser.evaluate;
 await waitFor(()=>e("document.querySelector('select')?.options.length>0"),'catalog');
 await e("const s=document.querySelector('select');s.value='stock_tr';s.dispatchEvent(new Event('change',{bubbles:true}));");
 await e("const inputs=document.querySelectorAll('input[type=date]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inputs[0],'2026-01-01');inputs[0].dispatchEvent(new Event('input',{bubbles:true}));set.call(inputs[1],'2026-01-31');inputs[1].dispatchEvent(new Event('input',{bubbles:true}));const f=document.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(new File(['synthetic'],'stoc.xlsx'));f.files=dt.files;f.dispatchEvent(new Event('change',{bubbles:true}));");
 await waitFor(()=>e("![...document.querySelectorAll('button')].find(x=>x.textContent==='Verifică fișierul').disabled"),'valid source');
 await e("[...document.querySelectorAll('button')].find(x=>x.textContent==='Verifică fișierul').click()");await waitFor(()=>e("document.body.textContent.includes('Asocieri gestiuni')"),'preview');
 assert(await e("document.body.textContent.includes('Impact')&&document.body.textContent.includes('vor fi golite')"));
 await e("const s=document.querySelectorAll('select')[1];s.value='w2';s.dispatchEvent(new Event('change',{bubbles:true}));");
 assert(await e("[...document.querySelectorAll('button')].find(x=>x.textContent==='Confirmă importul').disabled"));
 await e("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Reverifică')).click()");await waitFor(()=>e("![...document.querySelectorAll('button')].find(x=>x.textContent==='Confirmă importul').disabled"),'repreview');
 await e("[...document.querySelectorAll('button')].find(x=>x.textContent==='Confirmă importul').click()");await waitFor(()=>e("document.body.textContent.includes('Datele au fost aplicate')"),'committed');
 assert.equal(commitBody.preview_hash,'b'.repeat(64));assert.equal(commitBody.options.mappings.g,'w2');assert.equal(repreviewBody.options.mappings.g,'w2');
 assert(await e('document.documentElement.scrollWidth<=innerWidth'),'mobile layout has no page overflow');
 assert(await e("document.body.textContent.includes('12:00')"),'journal timestamp uses Bucharest time');
 console.log('PASS: mobile journal, explicit dates, stock impact, mapping re-preview and exact-hash confirmation.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
