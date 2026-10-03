import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {browserFixture} from './offline-browser-fixture.mjs';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {StockImport} from './components/stock-import';createRoot(document.getElementById('root')).render(<StockImport lastImportText="Synthetic fixture"/>);`;
const compiled=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},outfile:'fixture.js',write:false,bundle:true,format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent'});
let browser,applied,previews=0,lastToken;
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
   for await(const _ of req){}
   const decision=JSON.parse(req.headers['x-stock-coverage']),mappings=JSON.parse(req.headers['x-stock-mappings']||'{"g":"w"}');
   res.setHeader('Content-Type','application/json');
   if(req.url.endsWith('/import')){applied=req.headers;assert.equal(applied['x-stock-confirmation'],lastToken);res.end(JSON.stringify({warehouses:1,rows:1}));return;}
   lastToken='review-'+(++previews);const delta={before:{codes:2,quantity:30,unknown:0},after:{codes:decision.depot==='full'?1:2,quantity:22,unknown:0},changes:[{code:'A1',before:10,after:2,kind:'changed'}]};
   res.end(JSON.stringify({version:'v1',fileHash:'hash',filename:'stock.xlsx',decision,confirmation:lastToken,impact:{warehouses:[{warehouseId:mappings.g,...delta}],depot:{...delta,before:{codes:3,quantity:130,unknown:0}}},rowCount:1,matchedRows:1,unknownProducts:0,targets:[{id:'w',name:'Warehouse A'},{id:'w2',name:'Warehouse B'}],groups:[{key:'g',name:'Source A',siteId:'1',rowCount:1,quantity:2,warehouseId:mappings.g}]}));return;
 }
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(compiled.outputFiles.find(f=>f.path.endsWith('.js')).text);return;}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await browserFixture('http://127.0.0.1:'+server.address().port);const e=browser.evaluate;
 const wait=async(expr)=>{for(let i=0;i<100;i++){if(await e(expr))return;await new Promise(r=>setTimeout(r,30));}throw new Error('Not ready: '+expr);};
 await wait("!!document.querySelector('input[type=file]')");
 await e("const input=document.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(new File(['synthetic'],'stock.xlsx'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));");
 await wait("document.body.textContent.includes('Confirmă importul')");
 const disabled="[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Confirmă importul')).disabled";
 assert(await e(disabled));
 const review=async()=>{await e("[...document.querySelectorAll('button')].find(b=>b.textContent==='Verifică impactul').click()");await wait('!('+disabled+')');};
 await review();assert(await e("document.body.textContent.includes('Depozit global: 3')&&document.body.textContent.includes('Warehouse A: 2')"));
 await e("const s=document.querySelectorAll('select')[2];s.value='full';s.dispatchEvent(new Event('change',{bubbles:true}));");await wait(disabled);await review();
 await e("const s=document.querySelector('select');s.value='w2';s.dispatchEvent(new Event('change',{bubbles:true}));");await wait(disabled);await review();
 await e("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Confirmă importul')).click()");await wait("document.body.textContent.includes('Import finalizat')");
 assert.equal(JSON.parse(applied['x-stock-coverage']).depot,'full');assert.equal(JSON.parse(applied['x-stock-coverage']).warehouses,'partial');assert.equal(JSON.parse(applied['x-stock-mappings']).g,'w2');assert.equal(applied['x-stock-hash'],'hash');assert.equal(previews,4);
 console.log('PASS: stock UI requires impact review, displays separate depot/warehouse deltas, invalidates review on coverage/mapping changes, submits exact confirmation.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
