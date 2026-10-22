// Synthetic navigation rendered with the application's real styles.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {browserFixture} from './offline-browser-fixture.mjs';

const css=readFileSync('app/globals.css','utf8')+readFileSync('components/manager-workspace.css','utf8');
const labels=['Sinteză','Parteneri','Vânzări','Activări','Echipă','Operațiuni'];
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div class="app-shell manager-shell"><div class="nav-wrap"><div class="main-nav" data-slot="tabs-list">${labels.map(label=>`<button data-slot="tabs-trigger" onclick="document.body.dataset.selected=this.textContent">${label}</button>`).join('')}</div></div><main class="main-content">Synthetic content</main></div>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,checks=0;
try{
 browser=await browserFixture('http://127.0.0.1:'+server.address().port);
 for(const count of [6,5]){
  if(count===5)await browser.evaluate('document.querySelectorAll("[data-slot=tabs-trigger]")[3].remove()');
  for(const [width,height] of [[360,800],[390,844],[430,932],[820,1180]]){
   await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
   const geometry=await browser.evaluate(`(()=>{const bar=document.querySelector('.nav-wrap').getBoundingClientRect();return [...document.querySelectorAll('[data-slot=tabs-trigger]')].map(b=>{const r=b.getBoundingClientRect();return {label:b.textContent,width:r.width,height:r.height,visible:r.top>=bar.top&&r.bottom<=bar.bottom+1&&r.left>=0&&r.right<=innerWidth,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})})()`);
   assert.equal(geometry.length,count);
   assert(geometry.every(g=>g.visible&&g.hit&&g.width>=44&&g.height>=44),JSON.stringify({width,count,geometry}));checks++;
   const center=await browser.evaluate(`(()=>{const r=[...document.querySelectorAll('button')].find(b=>b.textContent==='Operațiuni').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
   await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...center});
   await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...center});
   assert.equal(await browser.evaluate('document.body.dataset.selected'),'Operațiuni');checks++;
   await browser.evaluate('delete document.body.dataset.selected');
  }
 }
 console.log(JSON.stringify({status:'PASS',checks}));
}finally{await browser?.close();server.close();}
