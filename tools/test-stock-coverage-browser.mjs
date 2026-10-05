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
   const decision=JSON.parse(req.headers['x-stock-coverage']);
   const mappings=JSON.parse(req.headers['x-stock-mappings']||'{"g":"w"}');
   res.setHeader('Content-Type','application/json');
   if(req.url.endsWith('/import')){
     applied=req.headers;
     assert.equal(applied['x-stock-confirmation'],lastToken);
     res.end(JSON.stringify({warehouses:1,rows:1}));
     return;
   }
   lastToken='preview-'+(++previews);
   const delta={before:{codes:2,quantity:30,unknown:0},after:{codes:decision.depot==='full'?1:2,quantity:22,unknown:0},changes:[{code:'A1',before:10,after:2,kind:'changed'}]};
   res.end(JSON.stringify({
     version:'v1',fileHash:'hash',filename:'stock.xlsx',decision,confirmation:lastToken,
     impact:{warehouses:[{warehouseId:mappings.g,...delta}],depot:{...delta,before:{codes:3,quantity:130,unknown:0}}},
     rowCount:1,matchedRows:1,unknownProducts:0,
     targets:[{id:'w',name:'Warehouse A'},{id:'w2',name:'Warehouse B'}],
     groups:[{key:'g',name:'Source A',siteId:'1',rowCount:1,quantity:2,warehouseId:mappings.g}],
   }));
   return;
 }
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(compiled.outputFiles.find(f=>f.path.endsWith('.js')).text);return;}
 res.setHeader('Content-Type','text/html');
 res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script>');
});

try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);
 const e=browser.evaluate;
 const wait=async(expr)=>{for(let i=0;i<100;i++){if(await e(expr))return;await new Promise(r=>setTimeout(r,30));}throw new Error('Not ready: '+expr);};
 await wait("!!document.querySelector('input[type=file]')");
 await e("const input=document.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(new File(['synthetic'],'stock.xlsx'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));");
 await wait("document.body.textContent.includes('Confirmă importul')");
 const confirm="[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Confirmă importul'))";
 assert.equal(await e(confirm+'.disabled'),false,'initial preview enables confirm directly');
 assert.equal(await e("[...document.querySelectorAll('button')].some(b=>b.textContent==='Verifică impactul')"),false,'manual impact-review button removed');
 assert(await e("document.body.textContent.includes('Impact calculat pentru aceste asocieri')"));
 assert(await e("document.documentElement.scrollWidth<=innerWidth"),'mobile layout does not overflow');

 // Changing coverage keeps confirm available; clicking it refreshes the server token automatically.
 await e("const s=document.querySelectorAll('select')[2];s.value='full';s.dispatchEvent(new Event('change',{bubbles:true}));");
 await wait("document.body.textContent.includes('recalculează automat')");
 assert.equal(await e(confirm+'.disabled'),false);
 await e(confirm+'.click()');
 await wait("document.body.textContent.includes('Import finalizat')");
 assert.equal(previews,2,'one initial preview plus one transparent refresh');
 assert.equal(JSON.parse(applied['x-stock-coverage']).depot,'full');
 assert.equal(JSON.parse(applied['x-stock-coverage']).warehouses,'partial');
 assert.equal(JSON.parse(applied['x-stock-mappings']).g,'w');
 assert.equal(applied['x-stock-hash'],'hash');
 // Mapping changes are independently fenced, including deselection.
 await e("const input=document.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(new File(['synthetic'],'stock.xlsx'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));");
 await wait("document.body.textContent.includes('Confirmă importul')");
 await e("const s=document.querySelector('select');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));");
 await wait(confirm+'.disabled');
 await e("const s=document.querySelector('select');s.value='w2';s.dispatchEvent(new Event('change',{bubbles:true}));");
 await wait('!('+confirm+'.disabled)');
 await e(confirm+'.click()');await wait("document.body.textContent.includes('Import finalizat')");
 assert.equal(JSON.parse(applied['x-stock-mappings']).g,'w2');assert.equal(previews,4);

 // An unchanged initial preview needs no extra request at confirmation.
 await e("const input=document.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(new File(['synthetic'],'stock.xlsx'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));");
 await wait("document.body.textContent.includes('Confirmă importul')");
 await e(confirm+'.click()');await wait("document.body.textContent.includes('Import finalizat')");
 assert.equal(previews,5,'unchanged selection imports using the initial exact token');
 console.log('PASS: stock import confirms directly; changed mapping/coverage refreshes impact/token transparently and mobile stays within viewport.');
}finally{
 await browser?.close();
 server.closeAllConnections();
 await new Promise(r=>server.close(r));
}
