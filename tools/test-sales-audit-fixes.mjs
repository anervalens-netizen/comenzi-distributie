import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const directory = mkdtempSync(resolve(tmpdir(), 'sales-audit-'));
process.env.MOBIUP_DATA_DIR = directory;
try {
  // Bundle only the sales modules, without a global application build.
  for (const name of ['sales-store', 'sales-view-node', 'sales-view-worker']) {
    await build({ entryPoints: [`lib/${name}.ts`], outfile: resolve(directory, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'synthetic-sales-catalog', setup(plugin) { plugin.onResolve({ filter: /resources\/seed\.json$/ }, () => ({ path: 'seed', namespace: 'synthetic' })); plugin.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: JSON.stringify({ products: [] }), loader: 'json' })); } }] });
  }
  // Exercise the real preview handler with only unrelated HTTP/auth/parser infrastructure stubbed.
  const previewStubs = {
    './server': `export const catalog=[]; export const db=()=>({prepare:()=>({all:async()=>({results:[]})})}); export const fail=(code,message)=>{throw new Error(code+': '+message)}; export const requireManager=()=>{}; export const isGlobalManager=()=>true; export const readLimited=async req=>new Uint8Array(await req.arrayBuffer()); export const response=value=>Response.json(value);`,
    './catalog': 'export const readCatalog=async()=>({products:[]});',
    './sales-parser-runtime': 'export const parseSalesFileRuntime=async bytes=>JSON.parse(new TextDecoder().decode(bytes));',
    './sales-file': `import {createHash} from 'node:crypto'; export const SALES_FILE_LIMIT=8*1024*1024; export const salesHash=value=>createHash('sha256').update(value).digest('hex');`,
    './sales-view-runtime': 'export const getSalesViewRuntime=()=>{throw new Error("unused")};',
    './manager-scope': 'export const managerFilter=async()=>null;',
  };
  await build({ entryPoints: ['lib/sales-server.ts'], outfile: resolve(directory, 'sales-server.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'preview-fixtures', setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => {
      if (args.path in previewStubs && args.importer.endsWith('sales-server.ts')) return { path: args.path, namespace: 'preview' };
      if (args.path.endsWith('resources/seed.json')) return { path: 'seed', namespace: 'preview' };
    });
    plugin.onLoad({ filter: /.*/, namespace: 'preview' }, args => ({ contents: args.path === 'seed' ? 'export default {products:[]}' : previewStubs[args.path], loader: 'js' }));
  } }] });
  const { salesUpload } = await import(pathToFileURL(resolve(directory, 'sales-server.mjs')));
  const preview = async rows => (await salesUpload(new Request('https://example.invalid/api/sales/preview', { method: 'POST', headers: { 'X-Sales-Filename': 'synthetic.xlsx' }, body: JSON.stringify(rows) }), { id: 'synthetic-manager', role: 'manager' }, false)).json();
  const store = await import(pathToFileURL(resolve(directory, 'sales-store.mjs')));
  const { createSalesViewRuntime, getSalesViewRuntime, SALES_VIEW_CACHE_TTL_MS } = await import(pathToFileURL(resolve(directory, 'sales-view-node.mjs')));
  const month = '2026-09';
  const row = (siteCode, orderNumber, extra = {}) => ({ rowNumber: 0, date: `${month}-01`, month, siteCode, orderNumber, company: 'Example', itemCode: 'P1', itemName: 'Synthetic accessory', quantity: 1, brand: 'Example', priceCents: 123, valueCents: 119, location: 'TR Example', asm: '', regional: '', category: 'Accesorii', subCategory: '', agent: '', ...extra });
  const numbered = rows => rows.map((row, i) => ({ ...row, rowNumber: i + 2 }));
  let serial = 0;
  const apply = (rows, regressionAcknowledged = false) => store.importSalesRows({ rows, month, fileHash: `synthetic-${++serial}`, filename: 'synthetic.xlsx', importedBy: 'synthetic-manager', originalPath: 'synthetic', expectedRevision: store.salesRevision(), expectedMappingHash: 'mapping', currentMappingHash: 'mapping', historicalAcknowledged: true, regressionAcknowledged });
  const baseline = numbered([row('A', 'one'), row('A', 'two'), row('B', 'one')]);
  apply(baseline);
  const grown = numbered([baseline[0], baseline[2], row('B', 'two'), row('B', 'three')]);
  const loss = store.salesCoverageChange(month, grown);
  assert.equal(loss.rowDelta, 1); assert.equal(loss.requiresRegressionAcknowledgement, true);
  assert.deepEqual(loss.reducedSites, [{ siteCode: 'A', previousRows: 2, incomingRows: 1 }]);
  assert.equal(loss.reducedDocuments[0].orderNumber, 'two');
  const previewLoss = await preview(grown);
  assert.equal(previewLoss.requiresRegressionAcknowledgement, true);
  assert.deepEqual(previewLoss.coverageChange, loss);
  const auditBefore = store.salesAudit(), viewBefore = store.getSalesView(month), revisionBefore = store.salesRevision();
  assert.throws(() => apply(grown), /REGRESSION_ACK/);
  assert.deepEqual(store.salesAudit(), auditBefore); assert.deepEqual(store.getSalesView(month), viewBefore); assert.equal(store.salesRevision(), revisionBefore);
  const sameTotal = numbered([baseline[0], baseline[2], row('B', 'two')]);
  assert.equal(store.salesCoverageChange(month, sameTotal).requiresRegressionAcknowledgement, true);
  const reordered = [...baseline].reverse().map((row, i) => ({ ...row, rowNumber: i + 100, siteCode: ` ${row.siteCode.toLowerCase()} `, company: ' example ', orderNumber: row.orderNumber.toUpperCase(), itemCode: 'p1', itemName: row.itemName.toUpperCase(), brand: 'example' }));
  assert.equal(store.salesCoverageChange(month, reordered).requiresRegressionAcknowledgement, false);
  assert.equal((await preview(reordered)).requiresRegressionAcknowledgement, false); apply(reordered);
  // Same document number across company/date/site cannot compensate for a missing document.
  for (const change of [{ company: 'Other' }, { date: `${month}-02` }, { siteCode: 'C' }, { itemCode: 'P2' }, { quantity: -1, valueCents: -119 }]) {
    assert.equal(store.salesCoverageChange(month, reordered.map((r, i) => i === 0 ? { ...r, ...change } : r)).requiresRegressionAcknowledgement, true);
  }
  const repeats = numbered([row('A', 'repeat'), row('A', 'repeat'), row('A', 'return', { quantity: -1, valueCents: -117 })]);
  apply(repeats, true);
  assert.equal(store.getSalesView(month).summary.value, 1.21); // authoritative 119 + 119 - 117, never quantity * price
  const lostRepeat = numbered([repeats[0], repeats[2], row('A', 'new'), row('A', 'newer')]);
  assert.equal(store.salesCoverageChange(month, lostRepeat).removedLineCount, 1);
  assert.throws(() => apply(lostRepeat), /REGRESSION_ACK/); apply(lostRepeat, true);
  const beforeFailedWrite = store.getSalesView(month), beforeFailedAudit = store.salesAudit();
  assert.throws(() => apply([row('Z', 'first'), row('Z', 'second')], true), /UNIQUE/);
  assert.deepEqual(store.getSalesView(month), beforeFailedWrite); assert.deepEqual(store.salesAudit(), beforeFailedAudit);
  const sql = new DatabaseSync(store.salesDatabasePath);
  const plan = sql.prepare('EXPLAIN QUERY PLAN SELECT * FROM sales_rows WHERE import_id=? AND UPPER(TRIM(site_code))=?').all(1, 'A');
  assert.match(JSON.stringify(plan), /idx_sales_rows_import_site_normalized/);
  sql.close();

  // Exercise the production identity reader and default worker resolution too.
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await getSalesViewRuntime(month, 'A', month, month, []);
    apply(numbered([...lostRepeat, row('B', 'identity-extra')]));
    const next = await getSalesViewRuntime(month, 'B', month, month, []);
    assert.equal(next.summary.rows, 1);
    const refreshed = await getSalesViewRuntime(month, 'A', month, month, []);
    assert.ok(refreshed.revision > first.revision);
    apply(lostRepeat, true);
  } finally { process.chdir(previousCwd); }

  let starts = 0, clock = 0, mode = 'ok', identityPath = store.salesDatabasePath, live = 0, maxLive = 0;
  const createWorker = input => {
    starts++;
    if (mode === 'exit') return new Worker('process.exit(0)', { eval: true });
    if (mode === 'error') return new Worker('throw new Error("synthetic worker error")', { eval: true });
    if (mode === 'message') return new Worker('require("node:worker_threads").parentPort.postMessage({ok:false,error:"synthetic rejection"})', { eval: true });
    if (mode === 'timeout') return new Worker('setInterval(()=>{},1000)', { eval: true });
    if (mode === 'constructor') throw new Error('synthetic constructor failure');
    const worker = new Worker(pathToFileURL(resolve(directory, 'sales-view-worker.mjs')), { workerData: input, env: { ...process.env, MOBIUP_DATA_DIR: directory } });
    live++; maxLive = Math.max(maxLive, live); worker.once('exit', () => live--); return worker;
  };
  const runtime = createSalesViewRuntime({ identity: () => ({ revision: store.salesRevision(), dataPath: identityPath }), createWorker, now: () => clock, timeoutMs: 2000 });
  const read = (scope, catalog = [], from = month, to = month) => runtime(month, scope, from, to, catalog);
  const views = await Promise.all(Array.from({ length: 12 }, (_, i) => read(i % 2 ? [' a ', 'A'] : 'A')));
  assert.equal(starts, 1); assert.equal(views[0].summary.rows, 4);
  views[0].summary.rows = 999; assert.equal((await read('A')).summary.rows, 4); assert.equal(starts, 1);
  const scopes = await Promise.all([read('B'), read([]), read(undefined)]);
  assert.equal(starts, 4); assert.deepEqual(scopes.map(view => view.summary.rows), [0, 0, 4]);
  await read('A', [], '2026-08'); assert.equal(starts, 5);
  const catalog = [{ code: 'P1', name: 'Synthetic accessory', kind: 'stands', category: 'Telefoane' }];
  await read('A', catalog); assert.equal(starts, 6);
  catalog[0].category = 'Accesorii'; await read('A', catalog); assert.equal(starts, 7);
  identityPath += '.other'; await read('A', catalog); assert.equal(starts, 8); identityPath = store.salesDatabasePath;
  apply(numbered([...lostRepeat, row('A', 'extra')]), true);
  assert.equal((await read('A')).summary.rows, 5); assert.equal(starts, 9);
  clock += 5 * 60 * 1000; await read('A'); assert.equal(starts, 9, 'Revision-validated reports survive navigation five minutes later');
  clock += SALES_VIEW_CACHE_TTL_MS; await read('A'); assert.equal(starts, 10);
  // Revision changes while work is queued cannot leave a cache entry under the old revision.
  const racing = read('A', [], '2026-07');
  apply(numbered([...lostRepeat, row('A', 'extra'), row('A', 'another')]), true);
  await racing; const startsBefore = starts; assert.equal((await read('A', [], '2026-07')).summary.rows, 6); assert.equal(starts, startsBefore + 1);
  for (const failure of ['exit', 'error', 'message', 'constructor', 'timeout']) {
    clock += SALES_VIEW_CACHE_TTL_MS + 1; mode = failure;
    await assert.rejects(read(`FAIL-${failure}`));
    mode = 'ok'; assert.equal((await read(`FAIL-${failure}`)).summary.rows, 0);
  }
  mode = 'ok';
  const bounded = Array.from({ length: 18 }, (_, i) => read(`QUEUE-${i}`).then(() => 'ok', error => error.message));
  const boundedResults = await Promise.all(bounded);
  assert.equal(boundedResults.filter(result => result === 'ok').length, 17);
  assert.match(boundedResults[17], /Prea multe/);
  // Entry bound: first of 17 unique cached scopes must be evicted.
  const priorStarts = starts; await read('QUEUE-0'); assert.equal(starts, priorStarts + 1);
  assert.equal(maxLive, 1); assert.equal(live, 0);
  await assert.rejects(read('A', [{ code: 'X'.repeat(8 * 1024 * 1024), name: '', kind: 'stands', category: '' }]), /prea mare/);
  const unicodeStarts = starts; await read('ä'); await read('Ä'); assert.equal(starts, unicodeStarts + 2);
  console.log('PASS: A01 coverage/multiplicity/returns/acknowledgement/rollback and A05 singleflight/scope/revision/catalog/TTL/queue/cache/failure recovery.');
} finally { rmSync(directory, { recursive: true, force: true }); }
