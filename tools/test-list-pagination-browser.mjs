// Entirely synthetic component fixture: no application API, auth or database.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'list-pagination-'));
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome';
// The comparison is opt-in: HEAD advances after a commit and shallow CI clones
// may not contain the audited source. Functional acceptance always tests current.
const baselineRef = process.env.PERFORMANCE_BASELINE_REF;
const modes = baselineRef ? ['before', 'after'] : ['after'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
const source = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProductCatalog} from './components/product-catalog';
import {OrderTable} from './components/order-table';
import {normalize} from './lib/client-api';
const products=Array.from({length:524},(_,i)=>({id:'p'+i,code:'SYN'+String(i).padStart(4,'0'),name:'Produs sintetic '+i,ean:String(9000000000000+i),brand:'Marca test',category:'Categorie '+(i%4),kind:i%2?'stands':'accessories',price:i%2?null:12.5,netPrice:i%2?null:10,sourceRow:i,image:null}));
const orders=Array.from({length:252},(_,i)=>({id:'o'+i,number:'DOC'+String(i).padStart(4,'0'),kind:'sim',userId:i%2?'a':'b',agentName:'Agent sintetic',warehouseName:'Gestiune test',status:i%7?'finalized':'draft',createdAt:'2026-09-30T10:00:00Z',finalizedAt:i%7?'2026-09-30T10:00:00Z':null,pieces:1,items:[],serials:[],itemCount:1,total:0,revision:1,client:{name:'Client sintetic '+i,cui:'TEST-'+i,city:'Localitate test'}}));
window.fixture={products,orders,opened:[],copied:[],deleted:[],writes:0};
function Fixture(){
const [view,setView]=useState('catalog'),[query,setQuery]=useState(''),[scope,setScope]=useState('all'),[status,setStatus]=useState('all'),[period,setPeriod]=useState('all'),[count,setCount]=useState(252);
const visible=orders.slice(0,count).filter(o=>normalize(o.number+' '+o.client.name).includes(normalize(query))&&(status==='all'||o.status===status));
window.fixture.setScope=setScope;window.fixture.setCount=setCount;
return <><nav><button onClick={()=>setView('catalog')}>Catalog fixture</button><button onClick={()=>setView('orders')}>Istoric fixture</button></nav>{view==='catalog'?<ProductCatalog products={products} onProducts={()=>{throw new Error('Unexpected write')}}/>:<section><h1>Istoric sintetic</h1><p id="full-count">{visible.length} documente</p><label>Caută document<input aria-label="Caută document" value={query} onChange={e=>setQuery(e.target.value)}/></label><label>Status<select aria-label="Status document" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">Toate</option><option value="draft">Ciorne</option><option value="finalized">Finalizate</option></select></label><label>Perioadă<select aria-label="Perioadă document" value={period} onChange={e=>setPeriod(e.target.value)}><option value="all">Tot</option><option value="30d">30 zile</option></select></label><OrderTable orders={visible} manager paginationKey={JSON.stringify([query,scope,status,period])} onOpen={o=>window.fixture.opened.push(o.id)} onCopy={o=>window.fixture.copied.push(o.id)} onDelete={o=>window.fixture.deleted.push(o.id)} canWrite={o=>o.userId==='a'} canCopy={o=>o.userId==='a'}/></section>}</>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
for (const mode of modes) {
  const baseline = mode === 'before' ? { name: 'baseline-components', setup(builder) {
    builder.onLoad({ filter: /components\/(?:product-catalog|order-table)\.tsx$/ }, args => ({
      contents: execFileSync('git', ['show', `${baselineRef}:${args.path.slice(root.length + 1)}`], { cwd: root, encoding: 'utf8' }),
      loader: 'tsx', resolveDir: join(root, 'components'),
    }));
  } } : null;
  await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'list-fixture.tsx', loader: 'tsx' },
    outfile: join(directory, mode + '.js'), bundle: true, minify: true, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, tsconfig: join(root, 'tsconfig.json'),
    plugins: baseline ? [baseline] : [], logLevel: 'silent' });
}
const server = createServer((request, response) => {
  const file = request.url === '/before.js' || request.url === '/after.js' || request.url === '/after.css' || request.url === '/before.css' ? join(directory, request.url.slice(1)) : null;
  if (request.url.startsWith('/api/')) { response.writeHead(500); response.end('No API exists in synthetic fixture'); return; }
  if (file && existsSync(file)) { response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(readFileSync(file)); return; }
  const mode = request.url.startsWith('/before') ? 'before' : 'after';
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><html lang="ro"><head><meta charset="utf-8"><link rel="stylesheet" href="/${mode}.css"><style>body{font-family:Arial;font-size:14px;margin:20px}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #ddd}button{padding:8px;cursor:pointer}button:disabled{cursor:default}small{display:block}input,select{padding:8px}svg{width:18px;height:18px}.table-actions{display:flex;gap:6px}</style></head><body><div id="root"></div><script src="/${mode}.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = join(directory, 'chrome');
const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let chromeError, chromeStderr = '', childClosed = false;
child.on('error', error => { chromeError = error; });
child.stderr.on('data', chunk => { chromeStderr = (chromeStderr + chunk.toString()).slice(-8000); });
// `close` also fires when spawning fails, while `exit` does not.
const closed = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
const chromeFailure = reason => new Error(`${reason} (${chrome}); exit=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}${chromeError ? `; ${chromeError.message}` : ''}\nChrome stderr (last 8000 chars):\n${chromeStderr || '(empty)'}`);
let socket, closeBrowser, testError, cleanupError;
try {
  let port;
  const startupDeadline = performance.now() + 30000;
  while (!port && performance.now() < startupDeadline) {
    if (chromeError || childClosed || child.exitCode !== null || child.signalCode !== null) throw chromeFailure('Chrome failed before DevTools became ready');
    // The file may be absent or only partially written during startup.
    try {
      const candidate = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) port = candidate;
    } catch {}
    if (!port) await delay(100);
  }
  if (!port) throw chromeFailure('Timeout after 30000 ms waiting for Chrome DevTools port');
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).catch(error => { throw chromeFailure(`Chrome DevTools connection failed: ${error.message}`); });
  if (!response.ok) throw chromeFailure(`Chrome DevTools returned HTTP ${response.status}`);
  const target = await response.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(chromeFailure('Timeout opening Chrome DevTools WebSocket')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(chromeFailure('Chrome DevTools WebSocket failed')); }, { once: true });
  });
  let next = 1;
  const pending = new Map(), errors = [], apiRequests = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/api/')) apiRequests.push(message.params.request.url);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++, timer = setTimeout(() => reject(new Error('Timeout: ' + method)), 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  closeBrowser = () => send('Browser.close');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  async function waitFor(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error('Not ready: ' + expression);
  }
  const fill = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  const select = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const rows = attribute => evaluate(`[...document.querySelectorAll('[${attribute}]')].map(node=>node.getAttribute('${attribute}'))`);
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  const evidence = {};
  for (const mode of modes) {
    await send('Page.navigate', { url: origin + '/' + mode });
    await waitFor("!!document.querySelector('.catalog-admin-table tbody tr')");
    await delay(150);
    await evaluate("window.longTasks=[];window.longObserver=new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(entry=>entry.duration)));window.longObserver.observe({type:'longtask'})");
    const initialNodes = await evaluate("document.querySelectorAll('*').length");
    await fill('[aria-label="Caută produs după cod, EAN sau denumire"]', 'missing-fixture');
    await waitFor("!document.querySelector('.catalog-admin-table tbody tr')");
    await delay(100); await evaluate('window.longTasks=[]');
    await fill('[aria-label="Caută produs după cod, EAN sau denumire"]', '');
    await waitFor("!!document.querySelector('.catalog-admin-table tbody tr')");
    await delay(250);
    const catalogTasks = await evaluate('window.longTasks');
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Istoric fixture').click();true");
    await waitFor("!!document.querySelector('.orders-table tbody tr')"); await delay(100);
    const ordersNodes = await evaluate("document.querySelectorAll('*').length");
    await fill('[aria-label="Caută document"]', 'missing-fixture');
    await waitFor("!document.querySelector('.orders-table tbody tr')");
    await delay(100); await evaluate('window.longTasks=[]');
    await fill('[aria-label="Caută document"]', '');
    await waitFor("!!document.querySelector('.orders-table tbody tr')"); await delay(250);
    evidence[mode] = { catalog: { nodes: initialNodes, resetLongTasksMs: catalogTasks }, orders: { nodes: ordersNodes, resetLongTasksMs: await evaluate('window.longTasks') } };
    if (mode === 'before') continue;
    check((await rows('data-order-id')).length === 40, 'History mounts forty rows, not 252');
    check(await evaluate("document.querySelector('#full-count').textContent.includes('252')&&document.querySelector('.list-pagination output').textContent.includes('din 252')"), 'History count remains full set');
    const seenOrders = new Set();
    while (true) {
      for (const id of await rows('data-order-id')) { check(!seenOrders.has(id), 'No document repeated across pages'); seenOrders.add(id); }
      if (await evaluate("document.querySelector('.list-pagination button:last-child').disabled")) break;
      await evaluate("document.querySelector('.list-pagination button:last-child').focus();true");
      await click('.list-pagination button:last-child'); await delay(30);
    }
    check(seenOrders.size === 252, 'Every synthetic document remains reachable');
    check([...seenOrders].every((id, index) => id === 'o' + index), 'History preserves the existing document order across page boundaries');
    check(await evaluate("document.activeElement===document.querySelector('.list-pagination button:first-child')"), 'At last page keyboard focus moves to enabled previous control');
    while (!await evaluate("document.querySelector('.list-pagination button:first-child').disabled")) {
      await evaluate("document.querySelector('.list-pagination button:first-child').focus();true");
      await click('.list-pagination button:first-child'); await delay(30);
    }
    check(await evaluate("document.activeElement===document.querySelector('.list-pagination button:last-child')"), 'At first page keyboard focus moves to enabled next control');
    await fill('[aria-label="Caută document"]', 'DOC0251');
    await waitFor("document.querySelector('[data-order-id=o251]')!==null");
    check((await rows('data-order-id')).length === 1, 'Search matches a document outside the initial page');
    await click('[data-order-id="o251"] .order-link');
    check(await evaluate("window.fixture.opened.at(-1)==='o251'"), 'Open callback retains exact document identity');
    await fill('[aria-label="Caută document"]', ''); await waitFor("document.querySelector('[data-order-id=o0]')!==null");
    await click('.list-pagination button:last-child'); await waitFor("document.querySelector('[data-order-id=o40]')!==null");
    await evaluate("window.fixture.setScope('other');true");
    await waitFor("document.querySelector('[data-order-id=o0]')!==null");
    check(await evaluate("document.querySelector('.list-pagination output').textContent.includes('Pagina 1')"), 'Scope token resets page even with identical result IDs');
    await click('.list-pagination button:last-child');
    await select('[aria-label="Perioadă document"]', '30d');
    await waitFor("document.querySelector('[data-order-id=o0]')!==null");
    check(await evaluate("document.querySelector('.list-pagination output').textContent.includes('Pagina 1')"), 'Date filter resets page atomically');
    await select('[aria-label="Status document"]', 'draft');
    await waitFor("document.querySelector('#full-count').textContent.includes('36')");
    check((await rows('data-order-id')).length === 36, 'All matching drafts remain accessible independently of date/page');
    check(await evaluate("[...document.querySelectorAll('[data-order-id]')].every(row=>row.textContent.includes('Ciornă'))"), 'Status filter searches full document set');
    check(await evaluate("document.querySelector('[data-order-id=o0] button[title=\"Copiază comanda\"]').disabled"), 'Pagination preserves denied copy permission');
    check(await evaluate("!document.querySelector('[data-order-id=o7] button[title=\"Copiază comanda\"]').disabled"), 'Pagination preserves allowed copy permission');
    await select('[aria-label="Status document"]', 'all');
    await waitFor("document.querySelector('.list-pagination button:last-child')!==null");
    await click('.list-pagination button:last-child'); await evaluate('window.fixture.setCount(3);true');
    await waitFor("document.querySelector('#full-count').textContent.includes('3')");
    check((await rows('data-order-id')).length === 3, 'Data shrink clamps an obsolete page without hiding rows');
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Catalog fixture').click();true");
    await waitFor("document.querySelector('[data-product-id=p0]')!==null");
    check((await rows('data-product-id')).length === 40, 'Catalog mounts forty products, not 524');
    const seenProducts = new Set();
    while (true) {
      for (const id of await rows('data-product-id')) { check(!seenProducts.has(id), 'No product repeated across pages'); seenProducts.add(id); }
      if (await evaluate("document.querySelector('.list-pagination button:last-child').disabled")) break;
      await click('.list-pagination button:last-child'); await delay(30);
    }
    check(seenProducts.size === 524, 'Every product remains reachable in category order');
    const expectedProductOrder = Array.from({ length: 4 }, (_, category) => Array.from({ length: 131 }, (_, index) => 'p' + (index * 4 + category))).flat();
    check([...seenProducts].every((id, index) => id === expectedProductOrder[index]), 'Catalog preserves category ordering and input ordering within each category');
    check(await evaluate('window.fixture.products.length===524'), 'Complete product dataset is independent of mounted rows');
    await fill('[aria-label="Caută produs după cod, EAN sau denumire"]', 'SYN0523');
    await waitFor("document.querySelector('[data-product-id=p523]')!==null");
    check((await rows('data-product-id')).length === 1, 'Product code search spans every page');
    await click('[data-product-id="p523"] button[aria-label="Editează SYN0523"]');
    await waitFor("!!document.querySelector('[role=dialog]')");
    check(await evaluate("[...document.querySelectorAll('[role=dialog] input')].some(input=>input.value==='SYN0523')"), 'Edit dialog refers to exact searched product');
    await fill('[role="dialog"] input[maxlength="300"]', 'Editare sintetică nesalvată');
    await fill('[aria-label="Caută produs după cod, EAN sau denumire"]', '');
    await waitFor("!document.querySelector('[data-product-id=p523]')");
    check(await evaluate("document.querySelector('[role=dialog] input[maxlength=\"300\"]').value==='Editare sintetică nesalvată'"), 'Unsaved editor state survives unmounting its product row');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor("!document.querySelector('[role=dialog]')");
    await fill('[aria-label="Caută produs după cod, EAN sau denumire"]', String(9000000000523));
    await waitFor("document.querySelector('[data-product-id=p523]')!==null");
    check((await rows('data-product-id')).length === 1, 'EAN search remains complete');
    await fill('[aria-label="Caută produs după cod, EAN sau denumire"]', '');
    await waitFor("(document.querySelectorAll('[data-product-id]').length===40)");
    check(await evaluate("document.querySelector('.catalog-group-row').textContent.includes('131 produse')"), 'Category header retains full category count rather than page count');
    await delay(100);
    await evaluate("document.querySelector('.list-pagination button:last-child').focus();true");
    check(await evaluate("document.activeElement===document.querySelector('.list-pagination button:last-child')"), 'Pagination control can receive keyboard focus');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor("document.querySelector('.list-pagination output').textContent.includes('Pagina 2')");
    check(await evaluate("document.activeElement===document.querySelector('.list-pagination button:last-child')"), 'Keyboard pagination retains focus on a stable control');
    await fill('[aria-label="Caută produs după cod, EAN sau denumire"]', 'Produs sintetic');
    await waitFor("document.querySelector('.list-pagination output').textContent.includes('Pagina 1')");
    check((await rows('data-product-id')).length === 40, 'Search token resets page even when all IDs still match');
    await click('.list-pagination button:last-child');
    await click('[aria-label="Categorie produse"]');
    await waitFor("[...document.querySelectorAll('[role=option]')].some(option=>option.textContent==='Categorie 3')");
    await evaluate("[...document.querySelectorAll('[role=option]')].find(option=>option.textContent==='Categorie 3').click();true");
    await waitFor("document.querySelector('.list-pagination output').textContent.includes('din 131')");
    check(await evaluate("document.querySelector('.list-pagination output').textContent.includes('Pagina 1')"), 'Category change resets catalog page');
    check((await rows('data-product-id')).every(id=>Number(id.slice(1))%4===3), 'Category filters the complete product set');
    await click('[aria-label="Tip produse"]');
    await waitFor("[...document.querySelectorAll('[role=option]')].some(option=>option.textContent==='Accesorii')");
    await evaluate("[...document.querySelectorAll('[role=option]')].find(option=>option.textContent==='Accesorii').click();true");
    await waitFor("document.querySelector('.list-pagination output').textContent.includes('din 262')");
    check((await rows('data-product-id')).every(id=>Number(id.slice(1))%2===0), 'Type filter searches all products and resets incompatible category');
    check(await evaluate("window.fixture.products.length===524&&window.fixture.orders.length===252&&window.fixture.writes===0"), 'Paging leaves the complete datasets and writes untouched');
  }
  check(errors.length === 0, 'No browser runtime exceptions: ' + errors.join('; '));
  check(apiRequests.length === 0, 'Component filtering/paging makes zero API requests');
  check(evidence.after.catalog.nodes < 1500, 'Catalog fixture DOM stays bounded for 524 products');
  check(evidence.after.orders.nodes < 2400, 'History fixture DOM stays bounded for 252 documents');
  if (evidence.before) {
    check(evidence.after.catalog.nodes < evidence.before.catalog.nodes / 3, 'Catalog DOM reduced by more than two thirds');
    check(evidence.after.orders.nodes < evidence.before.orders.nodes / 3, 'History DOM reduced by more than two thirds');
  }
  const result = { checks, synthetic: true, ...evidence };
  if (process.env.PERFORMANCE_EVIDENCE_PATH) writeFileSync(process.env.PERFORMANCE_EVIDENCE_PATH, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`PASS: ${checks} synthetic pagination/browser checks.`);
} catch (error) {
  testError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  await closeBrowser?.().catch(() => {});
  try { socket?.close(); } catch (error) { cleanupErrors.push(error); }
  await Promise.race([closed, delay(2000)]);
  // Signal only the dedicated process group we spawned, including descendants
  // that may outlive Chrome's main process. A failed spawn has no pid.
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); }
    await Promise.race([closed, delay(2000)]);
    if (!childClosed) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); }
      await Promise.race([closed, delay(2000)]);
      if (!childClosed) cleanupErrors.push(chromeFailure('Chrome did not close after SIGKILL'));
    }
  }
  // Chromium subprocesses may flush profile files briefly after their exit.
  await delay(200);
  try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { cleanupErrors.push(error); }
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    cleanupError = new AggregateError(cleanupErrors, 'Browser fixture cleanup failed');
    if (testError) console.error(cleanupError);
  }
}
if (cleanupError) throw cleanupError;
