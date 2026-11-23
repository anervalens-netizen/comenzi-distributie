import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';

const bundle=await build({stdin:{contents:`
  import {createRoot} from 'react-dom/client';
  import {ActivationOperatorCard} from './components/activations';
  import {setLocalWorkUserId} from './lib/local-work';
  setLocalWorkUserId('fictional-user');
  const provider=location.search.includes('digi')?'digi':'vodafone';
  if(location.search.includes('timeout')){
    const schedule=window.setTimeout.bind(window);
    let firstDeadline=true;
    window.setTimeout=(callback,ms,...args)=>{
      if(firstDeadline&&ms===20000){firstDeadline=false;return schedule(callback,750,...args);}
      return schedule(callback,ms,...args);
    };
  }
  createRoot(document.getElementById('root')).render(<ActivationOperatorCard userId="fictional-user" query="month=2026-10" provider={provider} reload={0}/>);
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'empty','.woff2':'empty'},write:false});
const queues={totals:[],panels:[],cards:[],digi:[]};
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/activations'){
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    queues[url.searchParams.get('overviewPhase')||url.searchParams.get('provider')].push(res);
  }else if(url.pathname==='/fixture.js'){
    res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text);
  }else{
    res.setHeader('Content-Type','text/html');res.end('<main id="root"></main><script type="module" src="/fixture.js"></script>');
  }
});
const reply=async(phase,number,body,status=200)=>{
  await waitFor(()=>queues[phase][number],phase+' request '+number);
  const res=queues[phase][number];res.statusCode=status;res.end(JSON.stringify(body));
};
const report=(publication,total)=>({publication,month:'2026-10',provider:'vodafone',available:true,scoped:false,
  totals:{total,sim:total,telsim:0,other:0,unassigned:0},months:[],sites:[],history:[],selectedMonths:['2026-10'],
  coveredMonths:['2026-10'],latestDate:'2026-10-05',importedAt:'',separateFocusScope:true});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await browserFixture(origin);
  const total="document.querySelector('.activation-primary strong')?.textContent";
  const text='document.body.innerText';
  await reply('totals',0,report('one',15));
  await waitFor(()=>browser.evaluate(total+"==='15'"),'first ordinary totals');
  assert.equal(await browser.evaluate("!!document.querySelector('.activation-product-breakdown')"),false);
  await reply('panels',0,report('one',15));
  await reply('cards',0,{publication:'two',focusUnavailable:['nord_a']});
  await waitFor(()=>queues.totals.length===2&&queues.panels.length===2,'different scoped card publication restarts overview');
  assert.equal(await browser.evaluate(total),undefined);
  assert.equal(await browser.evaluate(text+".includes('Nord A')"),false);

  await reply('totals',1,report('two',26));
  await reply('panels',1,report('two',26));
  await reply('cards',1,{publication:'two',focusUnavailable:['sud']});
  await waitFor(()=>browser.evaluate(total+"==='26'&&document.body.innerText.includes('date indisponibile temporar')"),'matching restricted card and total');
  const fresh=await browser.newTab(origin);
  for(const n of [2,3])await reply('totals',n,{error:'Sursa activărilor s-a actualizat.',currentRevision:'updated'},409);
  await waitFor(()=>fresh.evaluate(text+".includes('s-a actualizat din nou')"),'second rotation requires explicit refresh');
  assert.equal(await fresh.evaluate(total),undefined);
  assert.equal(queues.totals.length,4);
  const revoked=await browser.newTab(origin);
  await reply('panels',4,{...report('two',26),separateFocusScope:false});
  await waitFor(()=>revoked.evaluate(total+"==='26'"),'completed panel can arrive first');
  await reply('totals',4,{error:'Acces revocat'},403);
  await waitFor(()=>revoked.evaluate(text+".includes('Acces revocat')"),'late permission failure clears authorized panels');
  assert.equal(await revoked.evaluate(total),undefined);
  assert.equal(queues.totals.length,5);
  const digi=await browser.newTab(origin+'/?digi');
  await reply('digi',0,{error:'Serviciu ocupat'},503);
  await waitFor(()=>digi.evaluate("document.querySelector('[role=alert]')?.textContent.includes('Se reîncearcă automat')"),'a transient read is visible before its automatic retry');
  await reply('digi',1,{error:'Serviciu ocupat'},503);
  await waitFor(()=>digi.evaluate(text+".includes('Reîncearcă pentru Digi')"),'two transient failures expose a manual retry');
  await digi.evaluate("document.querySelector('.activation-operator button').click();true");
  await reply('digi',2,{error:'Răspuns întârziat'},504);
  await reply('digi',3,{...report('three',17),provider:'digi'});
  await waitFor(()=>digi.evaluate(total+"==='17'"),'Digi recovers from a transient read error');
  assert.equal(queues.totals.length,5,'retrying Digi does not reload Vodafone');
  const timedOut=await browser.newTab(origin+'/?digi-timeout');
  // Hold request 4 past its client deadline and answer only the automatic retry.
  await reply('digi',5,{...report('three',23),provider:'digi'});
  await waitFor(()=>timedOut.evaluate(total+"==='23'"),'an actual client timeout recovers on the same card');
  const partial=await browser.newTab(origin);
  await reply('totals',5,{...report('four',31),separateFocusScope:false});
  for(const n of [5,6])await reply('panels',n,{error:'Serviciu ocupat'},503);
  await waitFor(()=>partial.evaluate("document.querySelector('[role=alert]')?.textContent.includes('Detaliile activărilor nu s-au încărcat. Serviciu ocupat')"),'partial results explain why details failed');
  assert.equal(await partial.evaluate(total),'31','the verified total stays visible');
  assert.equal(await partial.evaluate(text+".includes('Reîncearcă pentru Vodafone')"),true);
  console.log('PASS: background totals stay optional; mixed publications are discarded and retry once; rapid rotation clears stale figures.');
}finally{
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
