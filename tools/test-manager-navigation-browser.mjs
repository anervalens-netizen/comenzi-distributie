// Synthetic navigation rendered with the application's real styles.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {browserFixture} from './offline-browser-fixture.mjs';

const css=readFileSync('app/globals.css','utf8')+readFileSync('components/manager-workspace.css','utf8');
const labels=['Sinteză','Parteneri','Accesorii','Prepay','Focus','Echipă','Operațiuni','Concedii'];
const buttons=labels.map(label=>`<button data-slot="tabs-trigger" onclick="document.body.dataset.selected=this.textContent"><svg width="19" height="19" aria-hidden="true"></svg>${label}</button>`).join('');
const server=createServer((_req,res)=>{
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div class="app-shell manager-shell"><div class="nav-wrap"><div class="main-nav" data-slot="tabs-list">${buttons}</div></div><main class="main-content">Synthetic content</main></div>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,checks=0;
try {
  browser=await browserFixture('http://127.0.0.1:'+server.address().port);
  for(const [width,height] of [[320,800],[360,800],[390,844],[430,932],[640,960],[820,1180]]) {
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    const geometry=await browser.evaluate(`(()=>{
      const nav=document.querySelector('.nav-wrap');
      const buttons=[...nav.querySelectorAll('button')];
      const fit=buttons.map(button=>{
        const text=document.createRange();
        text.selectNode(button.lastChild);
        const label=text.getBoundingClientRect(), target=button.getBoundingClientRect();
        return {label:button.textContent,width:target.width,height:target.height,
          fits:label.left>=target.left-0.5&&label.right<=target.right+0.5,
          left:target.left,right:target.right};
      });
      return {fit,overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    assert.deepEqual(geometry.fit.map(target=>target.label),labels);
    assert(!geometry.overflow&&geometry.fit.every((target,i,targets)=>
      target.fits&&target.width>=44&&target.height>=44&&(!i||target.left>=targets[i-1].right-0.5)),
    JSON.stringify({width,geometry}));
    checks++;
    for(const label of labels) {
      const target=await browser.evaluate(`(()=>{
        const button=[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent===${JSON.stringify(label)});
        button.scrollIntoView({block:'nearest',inline:'nearest'});
        const rect=button.getBoundingClientRect(),nav=button.closest('.nav-wrap').getBoundingClientRect();
        const x=rect.x+rect.width/2,y=rect.y+rect.height/2;
        return {x,y,visible:rect.left>=-0.5&&rect.right<=innerWidth+0.5&&rect.top>=nav.top&&rect.bottom<=nav.bottom+1,
          hit:button.contains(document.elementFromPoint(x,y))};
      })()`);
      assert(target.visible&&target.hit,JSON.stringify({width,label,target}));
      const {x,y}=target;
      await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x,y});
      await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y});
      assert.equal(await browser.evaluate('document.body.dataset.selected'),label);
      checks++;
    }
  }
  console.log(JSON.stringify({status:'PASS',checks}));
}finally{await browser?.close();server.close();}
