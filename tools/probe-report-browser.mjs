// One explicit, already authenticated page target. Never enumerate tabs, read cookies or log CDP errors.
import {readFileSync} from 'node:fs';
import {distribution} from './performance/lab.mjs';
import {observeReport, bonusReferenceError} from './performance/report-browser.mjs';

const projects = ['non_exclusiv','vodafone_nord','vodafone_sud'];
const integer = n => Number.isSafeInteger(n) && n >= 0;
const monthKey = value => typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
function requireConfig(ok) {
  if (!ok) throw new Error('invalid_config');
}
export function reference(input) {
  const {origin, scenario, role, release, shellVersion, month, expected, accountId, referenceId} = input;
  const known = ['origin','scenario','role','release','shellVersion','month','expected','accountId','referenceId','scope','samples','timeoutMs'];
  requireConfig(Object.keys(input).every(key => known.includes(key)));
  const url = new URL(origin);
  requireConfig(['https:', 'http:'].includes(url.protocol) && url.origin === origin);
  requireConfig(['annual','bonus'].includes(scenario) && ['manager','agent'].includes(role));
  requireConfig(/^[0-9a-f]{40}$/.test(release) && /^[0-9a-f]{16}$/.test(shellVersion) && /^[0-9a-f]{32}$/.test(referenceId));
  requireConfig(monthKey(month) && expected && typeof expected === 'object' && (accountId === undefined || (typeof accountId === 'string' && accountId.trim())));
  const metrics = scenario === 'annual' ? ['vodafone','digi','simZero','simCredit','coverage','eligible'] : ['rows','pointCode','sim0Bonus','totalBonus'];
  requireConfig(Object.keys(expected).every(key => metrics.includes(key)));
  const {samples = 1, timeoutMs = 60000} = input;
  requireConfig(integer(samples) && samples >= 1 && samples <= 1000 && integer(timeoutMs) && timeoutMs >= 250 && timeoutMs <= 180000);
  const scope = {...input.scope};
  requireConfig(Object.keys(scope).every(key => ['managerId','agentId','siteCode','projects'].includes(key)));
  requireConfig(!input.scope || role === 'manager');
  for (const key of ['managerId','agentId','siteCode']) requireConfig(!(key in scope) || typeof scope[key] === 'string');
  const selected = scope.projects ?? (role === 'manager' ? projects : []);
  requireConfig(Array.isArray(selected) && selected.every(p => projects.includes(p)) && new Set(selected).size === selected.length);
  scope.projects = [...selected].sort((a,b) => a.localeCompare(b));
  const months = [month];
  if (scenario === 'annual') {
    requireConfig(['vodafone','digi','simZero','simCredit'].every(key => integer(expected[key])));
    requireConfig(['complete','partial','outside_scope','missing'].includes(expected.coverage));
    const numeric = ['complete','partial'].includes(expected.coverage);
    requireConfig(numeric ? integer(expected.eligible) : expected.eligible === undefined);
    const date = new Date(month + '-01T12:00Z');
    while (months.length < 12) {
      date.setUTCMonth(date.getUTCMonth() + 1);
      months.push(date.toISOString().slice(0,7));
    }
    requireConfig(monthKey(months.at(-1)));
  } else {
    const current = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit'}).format(new Date());
    requireConfig(role === 'manager' && month >= '2026-06' && month < current);
    const amounts = ['sim0Bonus','totalBonus'].filter(key => key in expected);
    requireConfig(integer(expected.rows) && amounts.length && amounts.every(key => integer(expected[key])));
    requireConfig(expected.rows ? typeof expected.pointCode === 'string' && !!expected.pointCode.trim() :
      expected.pointCode === undefined && amounts.every(key => expected[key] === 0));
  }
  return {origin, role, scenario, accountId, scope, release, shellVersion, referenceId, months, expected, samples, timeoutMs};
}

export async function runProbe(config, evaluate) {
  const {scenario, role, release, shellVersion, referenceId, months, samples} = config;
  const runs = [], timings = {}, startedAt = new Date().toISOString();
  for (let i = 0; i < samples; i++) {
    let run;
    try {
      run = await evaluate('(' + observeReport.toString() + ')(' + JSON.stringify(config) + ',' + bonusReferenceError.toString() + ')');
    } catch { /* Transport errors can include endpoint URLs. */ }
    if (!run || !['pass','error'].includes(run.outcome)) run = {outcome:'error', stage:'transport', code:'page_unavailable'};
    runs.push(run);
    if (run.outcome === 'error') break;
    for (const [name, ms] of Object.entries(run.timingsMs)) (timings[name] ??= []).push(ms);
  }
  return {schema:1, scenario, role, release, releaseSource:'operator', shellVersion, referenceId, months, requestedSamples:samples, timeoutMs:config.timeoutMs, startedAt,
    outcome:runs.at(-1).outcome, runs, uiMs:Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, distribution(values)]))};
}

async function attach(endpoint, timeoutMs) {
  const target = new URL(endpoint);
  requireConfig(target.protocol === 'ws:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname) &&
    !target.username && !target.password && !target.search && !target.hash && /^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(target.pathname));
  const socket = new WebSocket(target);
  let id = 0;
  function wait(event, ms) {
    return new Promise((resolve,reject) => {
      const timer = setTimeout(failed, ms);
      function clean() {
        clearTimeout(timer);
        socket.removeEventListener(event, received);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
      }
      function failed() { clean(); reject(new Error('page_unavailable')); }
      function received(e) {
        if (event === 'message') {
          let reply;
          try { reply = JSON.parse(e.data); } catch { failed(); return; }
          if (reply?.id !== id) return;
          clean();
          if (reply.error || reply.result?.exceptionDetails) return reject(new Error('page_unavailable'));
          resolve(reply.result?.result?.value);
        } else { clean(); resolve(); }
      }
      socket.addEventListener(event, received);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
    });
  }
  try {
    await wait('open', 10000);
    return {evaluate(expression) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('page_unavailable');
      // Three identity checks (two reads each), period setup, the UI action and restoration.
      const reply = wait('message', timeoutMs * 9 + 5000);
      socket.send(JSON.stringify({id:++id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
      return reply;
    }, close:() => socket.close()};
  } catch (error) { socket.close(); throw error; }
}
if (import.meta.main) {
  let page, evidence = {outcome:'error', stage:'config', code:'invalid_config'};
  try {
    const config = reference(JSON.parse(readFileSync(0,'utf8')));
    evidence = await runProbe(config, async expression => {
      page ??= await attach(process.env.REPORT_PAGE_WS, config.timeoutMs);
      return page.evaluate(expression);
    });
  } catch { /* Only the redacted result reaches stdout. */ }
  finally { page?.close(); }
  console.log(JSON.stringify(evidence));
  process.exitCode = evidence.outcome === 'pass' ? 0 : 1;
}
