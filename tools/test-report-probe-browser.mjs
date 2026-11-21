// Serve the real commerce components and API client to the existing disposable Chrome fixture.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {build} from 'esbuild';
import {browserFixture,waitFor} from './offline-browser-fixture.mjs';
import {reference, runProbe} from './probe-report-browser.mjs';

const fixture = await build({stdin:{contents:`
  import {useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {ManagerPrepay} from './components/manager-commerce';
  import {AgentCommerce} from './components/agent-commerce';
  import {ReportPeriod} from './components/report-period';
  import {setLocalWorkUserId} from './lib/local-work';
  const role = location.search.includes('agent') ? 'agent' : 'manager';
  const user = {id:'fixture-' + role, role, distributionConfigured:true, canViewActivations:true};
  setLocalWorkUserId(user.id);
  function Fixture() {
    const [open, setOpen] = useState(false), [months, setMonths] = useState(['2025-07','2026-06']);
    const query = new URLSearchParams({months:months.join(','),projects:'vodafone_sud,vodafone_nord,non_exclusiv'}).toString();
    return <><nav className="main-nav"><button onClick={()=>setOpen(true)}>Prepay</button></nav>
      {open && (role==='agent' ? <AgentCommerce user={user} mode="activations" onViewChange={()=>{}}/> :
        <><ReportPeriod selected={months} onChange={setMonths}/>
        <ManagerPrepay userId={user.id} query={query} distributionConfigured canViewActivations scopeLabel="Synthetic"/></>)}</>;
  }
  createRoot(document.querySelector('main')).render(<Fixture/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'empty','.woff2':'empty'},write:false});

let mode = 'good', role = 'manager', bonusReads = 0, fullBonusReads = 0, pendingReads = 0;
const script = '/_next/static/fixture-pilot.js';
const shellVersion = 'a'.repeat(16);
const ref = {release:'a'.repeat(40),shellVersion,referenceId:'b'.repeat(32),role:'manager'};
const annual = {scenario:'annual',month:'2025-08',expected:{vodafone:1234,digi:2,simZero:275,simCredit:842,eligible:0,coverage:'partial'}};
const bonus = {scenario:'bonus',month:'2026-07',expected:{rows:51,pointCode:'EXAMPLE-50',sim0Bonus:5}};

function activation(p) {
  const provider = p.get('provider'), phase = p.get('overviewPhase');
  const months = p.get('months').split(',');
  const selectedMonths = mode === 'wrong_period' ? ['2025-07', ...months.slice(1)] : months;
  const report = {provider,month:p.get('month'),available:mode !== 'blank_200',selectedMonths,coveredMonths:months,
    latestDate:'2026-07-31',sites:[],history:[],totals:{total:provider === 'digi' ? 2 : 1234},publication:'synthetic'};
  if (phase === 'panels') {
    report.productBreakdown = {zero:275,credit:842,packages:117,other:0,unknown:0};
    if (mode !== 'unfinished_commission') {
      report.totals.eligible = 0;
      report.commissionCoverage = 'partial';
    } else report.commissionCoverage = 'unavailable';
  }
  return report;
}
function register(params) {
  const month = params.get('month');
  const months = mode === 'blank_register' ? [] : [{month,publishedOn:mode === 'open_month' ? null : '2026-08-03',sourceThrough:'2026-07-31',activations:0,unresolvedActivations:0}];
  const points = mode === 'empty' ? [] : Array.from({length:51},(_,i) => ({
    month,pointCode:'EXAMPLE-' + i,cui:'EXAMPLE',partner:'Fixture partner',sites:[],activations:5,confirmedActivations:5,
    target:5,topBonus:0,sim0Bonus:i === 50 && mode !== 'zero' ? 5 : 0,totalBonus:i === 50 ? 8 : 0,partial:false,givenOnDocuments:0,
    candidateOnDocuments:0,applied:0,remaining:0,simulatedRemaining:0,
  }));
  const report = {months,selectedMonth:month,points,documents:[],unresolved:[],fiscalKindsComplete:true};
  if (params.get('view') === 'preview') return {...report,points:points.slice(0,50),preview:{counts:{points:points.length,documents:0,unresolved:0}}};
  fullBonusReads++;
  return mode === 'short_full' ? {...report,points:points.slice(0,50)} : report;
}
const server = createServer((req,res) => {
  const url = new URL(req.url,'http://fixture.invalid');
  assert.equal(req.method,'GET');
  res.setHeader('Cache-Control','no-store');
  if (url.pathname === script) {
    res.setHeader('Content-Type','text/javascript');
    res.end(fixture.outputFiles[0].contents);
  } else if (url.pathname === '/sw.js') {
    res.end(`const CACHE='mobiup-shell-v3-${shellVersion}';const FILES=[${JSON.stringify(script)}];`);
  } else if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type','application/json');
    const json = data => res.end(JSON.stringify(data));
    switch (url.pathname) {
      case '/api/auth/session': return json({user:{id:'fixture-' + role,role,canViewActivations:true}});
      case '/api/sim/verify': return json({digi:false});
      case '/api/activations': {
        const data = activation(url.searchParams);
        if (url.searchParams.get('overviewPhase') === 'panels') setTimeout(() => json(data), 300);
        else json(data);
        return;
      }
      case '/api/vodafone/bonuses':
        bonusReads++;
        if(mode==='pending_register' && !pendingReads && url.searchParams.get('view')==='preview' && url.searchParams.get('progressive')==='1'){
          pendingReads++;res.statusCode=202;res.setHeader('Retry-After','5');return json({state:'preparing'});
        }
        return json(register(url.searchParams));
      default: res.statusCode = 503; return json({error:'Synthetic unused view'});
    }
  } else {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><main></main><script type="module" src="'+script+'"></script>');
  }
});

let browser;
try {
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await browserFixture(origin);
  const mounted = tab => waitFor(() => tab.evaluate("!!document.querySelector('.main-nav button')"),'Prepay fixture mounted');
  await mounted(browser);
  async function probe(target, options = {}, timeoutMs = 5000, tab = browser) {
    const result = await runProbe(reference({...ref,origin,timeoutMs,...target,...options}),tab.evaluate);
    const evidence = JSON.stringify(result);
    for (const secret of [origin,'EXAMPLE','fixture-manager','fixture-agent','Fixture partner','/api/']) assert(!evidence.includes(secret));
    return result;
  }
  const error = (result,code,stage) => {
    assert.equal(result.outcome,'error');
    assert.equal(result.runs[0].code,code);
    if (stage) assert.equal(result.runs[0].stage,stage);
  };
  const pass = result => assert.equal(result.outcome,'pass',JSON.stringify(result));
  async function cli(target, expectedExit) {
    const child = spawn(process.execPath,['tools/probe-report-browser.mjs'],{
      env:{REPORT_PAGE_WS:browser.debuggerUrl},stdio:['pipe','pipe','pipe'],timeout:25000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data',chunk => { stdout += chunk; });
    child.stderr.on('data',chunk => { stderr += chunk; });
    const closed = once(child,'close');
    child.stdin.end(JSON.stringify({...ref,origin,timeoutMs:5000,...target}));
    const [code] = await closed;
    assert.equal(stderr,'');
    assert.equal(code,expectedExit);
    for (const secret of [origin,'EXAMPLE-','/devtools/']) assert(!stdout.includes(secret));
    return JSON.parse(stdout);
  }
  const ok = await cli(annual,0);
  pass(ok);
  assert.equal(await browser.evaluate("document.querySelector('.report-period-selection').textContent"), 'Iul 2025 · Iun 2026');
  const timings = ok.runs[0].timingsMs;
  assert(timings.vodafoneDetails > timings.vodafoneTotal && timings.vodafoneCommission > timings.vodafoneTotal);
  assert.equal(ok.months.length,12);
  assert.equal(ok.uiMs.digiTotal.p95,undefined);
  mode = 'blank_200';
  error(await probe(annual,{},900),'annual_value_or_phase_missing','vodafoneTotal');
  mode = 'unfinished_commission';
  error(await probe(annual,{},1100),'annual_value_or_phase_missing','vodafoneCommission');
  mode = 'wrong_period';
  error(await probe(annual),'trend_months_mismatch');
  mode = 'good';
  mode='pending_register';
  pass(await probe(bonus,{},15000));
  assert.equal(pendingReads,1,'a browser opens the completed register automatically after a cold source');
  mode='good';
  const initialFullReads = fullBonusReads;
  pass(await probe(bonus));
  assert.equal(fullBonusReads, initialFullReads + 1, 'the reference point beyond page one requires the full scoped request');
  error(await probe(bonus,{scope:{projects:['vodafone_sud']}}),'report_scope_mismatch');
  mode = 'short_full';
  error(await probe(bonus,{},1100),'bonus_pagination_stalled');
  mode = 'good';
  error(await cli({...bonus,expected:{...bonus.expected,sim0Bonus:4}},1),'bonus_amount_mismatch');
  pass(await probe(bonus,{expected:{...bonus.expected,totalBonus:8}}));
  mode = 'blank_register';
  error(await probe(bonus,{},1000),'bonus_register_missing');
  mode = 'zero';
  assert.equal((await probe(bonus,{expected:{...bonus.expected,sim0Bonus:0}})).runs[0].verified,'closed_zero_bonus');
  mode = 'empty';
  error(await probe(bonus),'bonus_unexpected_empty');
  assert.equal((await probe(bonus,{expected:{rows:0,sim0Bonus:0}})).runs[0].verified,'closed_empty');
  mode = 'open_month';
  error(await probe(bonus),'bonus_month_not_final');
  error(await probe(annual,{shellVersion:'0'.repeat(16)}),'release_mismatch');
  role = 'agent';
  mode = 'good';
  const count = bonusReads;
  error(await probe(bonus),'session_mismatch');
  const agentTab = await browser.newTab(origin + '/?agent');
  await mounted(agentTab);
  pass(await probe(annual,{role},5000,agentTab));
  assert.equal(bonusReads,count);
  console.log('PASS: annual phase readiness, HTTP 200 without totals, exact months, scoped closed bonus values, zero and empty, role and release pins.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
