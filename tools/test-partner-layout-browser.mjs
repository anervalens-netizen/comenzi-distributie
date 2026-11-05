// Real portfolio, its own emitted CSS, and synthetic data. Agent runs first,
// without importing or visiting the lazy manager workspace.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {PartnerPortfolio} from './components/partner-portfolio';import {setLocalWorkUserId} from './lib/local-work';setLocalWorkUserId('synthetic-agent');const manager=location.search.includes('manager');createRoot(document.getElementById('root')).render(<div className={manager?'manager-shell':''}><PartnerPortfolio userId="synthetic-agent" manager={manager}/></div>);`;
const bundle=await build({stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},write:false,outdir:'out',bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'synthetic-map',setup(b){b.onResolve({filter:/^\.\/partner-map$/},()=>({path:'map',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`import React from 'react';export default function Map(){return <div className="partner-map">Synthetic map</div>}`,loader:'jsx',resolveDir:resolve('.')}));}}]});
const css=readFileSync('app/globals.css','utf8')+bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
const managerCss=readFileSync('components/manager-workspace.css','utf8');
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles.find(f=>f.path.endsWith('.js')).text);return;}
 if(url.pathname.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(url.pathname==='/api/partner/browse'?{partners:[{id:'synthetic-point',name:'Example partner',cui:'TEST',address:'Example address',city:'Example',county:'Example',route:'1',latitude:45,longitude:25,lastVisitedAt:null}],total:1,located:1,geocoded:0,nextOffset:null,facets:{counties:[],cities:[],routes:[]},styleUrl:'/style',bounds:null}:{state:'unavailable',message:'Synthetic fixture'}));return;
 }
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${url.searchParams.has('manager')?managerCss:''}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await browserFixture(origin);
 for(const manager of [false,true]){
  const tab=manager?await browser.newTab(origin+'/?manager'):browser;
  await waitFor(()=>tab.evaluate("!!document.querySelector('.partner-card')"),'portfolio loaded');
  for(const [width,height] of [[320,800],[390,844],[844,390],[1440,900]]){
   await tab.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
   for(const [index,mode] of ['split','list','map'].entries()){
    const geometry=await tab.evaluate(`(()=>{const b=document.querySelectorAll('.partner-layout-modes button')[${index}];b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect(),s=getComputedStyle(b);return {x:r.x+r.width/2,y:r.y+r.height/2,styled:s.borderTopStyle==='solid'&&parseFloat(s.borderTopWidth)>=1&&parseFloat(s.paddingLeft)>=10,visible:r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
    check(geometry.styled&&geometry.visible&&geometry.hit,JSON.stringify({manager,width,mode,geometry}));
    for(const type of ['mousePressed','mouseReleased'])await tab.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:geometry.x,y:geometry.y});
    await waitFor(()=>tab.evaluate(`document.querySelector('.partner-hub').dataset.layout==='${mode}'`),'layout changed');
    if(mode!=='list')await waitFor(()=>tab.evaluate("!!document.querySelector('.partner-map')"),'map loaded');
    const state=await tab.evaluate(`(()=>{const visible=s=>{const e=document.querySelector(s);return !!e&&e.getClientRects().length>0};return {map:visible('.partner-map'),list:visible('.partner-card'),selected:[...document.querySelectorAll('.partner-layout-modes button')].map(b=>b.getAttribute('aria-pressed')),saved:JSON.parse(localStorage.getItem('mobiup-partner-view|synthetic-agent|')).layout}})()`);
    check(state.map===(mode!=='list')&&state.list===(mode!=='map'),JSON.stringify({manager,width,mode,state}));
    assert.deepEqual(state.selected,['split','list','map'].map(v=>String(v===mode)));checks++;
    assert.equal(state.saved,mode);checks++;
   }
  }
  // Reload independently to verify the saved choice survives fresh mounting.
  await tab.send('Page.reload');
  await waitFor(()=>tab.evaluate("document.querySelector('.partner-hub')?.dataset.layout==='map'&&!!document.querySelector('.partner-map')"),'saved map layout');
  check(await tab.evaluate("!document.querySelector('.partner-card').getClientRects().length"),'saved map layout hides list');
  if(process.env.PARTNER_LAYOUT_SCREENSHOT_DIR){
   await tab.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
   await tab.evaluate("document.querySelectorAll('.partner-layout-modes button')[1].click();scrollTo(0,0)");
   const shot=await tab.send('Page.captureScreenshot',{format:'png'});
   writeFileSync(resolve(process.env.PARTNER_LAYOUT_SCREENSHOT_DIR,manager?'manager.png':'agent.png'),Buffer.from(shot.data,'base64'));
  }
 }
 console.log(JSON.stringify({status:'PASS',checks,roles:['fresh-agent','manager'],widths:[320,390,844,1440],modes:['split','list','map']}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
