import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

// Entirely fictional identities and places; reproduce a shared source code without private data.
const root = process.cwd(), directory = mkdtempSync(resolve(tmpdir(), 'sales-location-'));
process.env.MOBIUP_DATA_DIR = directory;
const app = new DatabaseSync(resolve(directory, 'app.sqlite'));
app.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,site_code TEXT,warehouse_name TEXT,warehouse_id TEXT,manager_scope TEXT);
CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);`);
const add = (id, role, site, warehouse, scope = 'assigned', active = 1) => app.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id, `Synthetic ${id}`, role, active, site, warehouse, warehouse ? `warehouse-${id}` : null, scope);
add('north', 'agent', 'OLD-NORTH', 'TR Oraș Nord 01');
add('south', 'agent', 'SHARED', 'TR Oras Sud 01');
add('stable', 'agent', 'STABLE', 'TR Oras Est 04');
add('seller', 'manager', 'SELLER', null);
add('peer', 'manager', '', null);
add('global', 'manager', '', null, 'global');
add('site-only', 'agent', 'ONLY', null);
add('inactive', 'agent', 'DISABLED', 'TR Inactive', 'assigned', 0);
for (const manager of ['seller', 'peer']) for (const agent of ['north', 'stable']) app.prepare('INSERT INTO manager_agents VALUES(?,?)').run(manager, agent);
const user = id => { const row = app.prepare('SELECT * FROM users WHERE id=?').get(id); return { id, role: row.role, managerScope: row.manager_scope, siteCode: row.site_code, warehouseName: row.warehouse_name }; };
const stubs = {
  './server': `import {DatabaseSync} from 'node:sqlite';import {resolve} from 'node:path';
    const connection=new DatabaseSync(resolve(process.env.MOBIUP_DATA_DIR,'app.sqlite'));
    export const db=()=>({prepare(sql){let args=[];return {bind(...values){args=values;return this},async all(){return {results:connection.prepare(sql).all(...args)}},async first(){return connection.prepare(sql).get(...args)||null}}}});
    export const catalog=[];export const fail=(code,message)=>{throw new Error(code+': '+message)};
    export const isGlobalManager=user=>user.role==='manager'&&user.managerScope==='global';
    export const requireManager=user=>{if(user.role!=='manager')fail(403,'manager required')};
    export const readLimited=async req=>new Uint8Array(await req.arrayBuffer());export const response=value=>Response.json(value);`,
  './catalog': 'export const readCatalog=async()=>({products:[]});',
  './sales-parser-runtime': 'export const parseSalesFileRuntime=async bytes=>JSON.parse(new TextDecoder().decode(bytes));',
  './sales-file': `import {createHash} from 'node:crypto';export const SALES_FILE_LIMIT=8*1024*1024;export const salesHash=value=>createHash('sha256').update(value).digest('hex');`,
};
try {
  const { salesLocationKey } = await import('../lib/sales-location.ts');
  assert.equal(salesLocationKey('TR Oras-Sud 01'), salesLocationKey(' tr ORAȘ sud  01 '));
  assert.notEqual(salesLocationKey('TR AB'), salesLocationKey('TR A-B'), 'Normalization must not merge distinct alphanumeric tokens');
  for (const name of ['sales-server', 'sales-store', 'sales-view-worker']) await build({ entryPoints: [resolve(root, `lib/${name}.ts`)], outfile: resolve(directory, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'synthetic', setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => {
      if (args.path in stubs) return { path: args.path, namespace: 'synthetic' };
      if (args.path === './sales-view-runtime') return { path: resolve(root, 'lib/sales-view-node.ts') };
      if (args.path.endsWith('resources/seed.json')) return { path: 'seed', namespace: 'synthetic' };
    });
    plugin.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ contents: args.path === 'seed' ? 'export default {products:[]}' : stubs[args.path], loader: 'js' }));
  } }] });
  process.chdir(directory);
  const { salesView, salesUpload } = await import(pathToFileURL(resolve(directory, 'sales-server.mjs')));
  const store = await import(pathToFileURL(resolve(directory, 'sales-store.mjs')));
  const month = '2026-09';
  const row = (siteCode, location, extra = {}) => ({ rowNumber: 0, date: `${month}-01`, month, siteCode, location, itemCode: 'P1', itemName: 'Synthetic accessory', quantity: 1, brand: 'Synthetic', priceCents: 999, valueCents: 119, company: 'Synthetic', asm: '', regional: '', orderNumber: 'SAME', category: 'Accesorii', subCategory: '', agent: 'Untrusted source label', ...extra });
  const rows = [row('SHARED', 'tr ORAS-NORD 01'), row('SHARED', 'tr ORAS-NORD 01'), row('SHARED', 'tr ORAS-NORD 01', { quantity: -1, valueCents: -117 }), row('SHARED', 'TR Oras Sud 01'), row('STABLE', 'TR Oras Est 04'), row('SELLER', 'TR Seller Location'), row('OLD-NORTH', 'TR Historical Place'), row('ONLY', 'TR Site Only'), row('DISABLED', 'TR Inactive'), row('SELLER', 'TR Oras Sud 01')].map((r, i) => ({ ...r, rowNumber: i + 2 }));
  const preview = async (incoming = rows) => (await salesUpload(new Request('https://example.invalid/api/sales/preview', { method: 'POST', headers: { 'X-Sales-Filename': 'synthetic.xlsx' }, body: JSON.stringify(incoming) }), user('global'), false)).json();
  const read = async (id, query = '') => (await salesView(new Request(`https://example.invalid/api/sales?month=${month}${query}`), user(id))).json();
  const p = await preview();
  assert.equal(p.sites.filter(site => site.siteCode === 'SHARED').length, 2);
  assert.equal(p.mappings.find(m => m.location === 'tr ORAS-NORD 01').userId, 'north');
  assert.equal(p.mappings.find(m => m.siteCode === 'SHARED' && m.location === 'TR Oras Sud 01').userId, 'south');
  assert.equal(p.mappings.find(m => m.siteCode === 'SELLER' && m.location === 'TR Oras Sud 01').userId, 'south', 'Unique warehouse overrides a manager seller code too');
  assert.equal(p.mappings.find(m => m.siteCode === 'STABLE').userId, 'stable');
  assert.equal(p.mappings.find(m => m.location === 'TR Seller Location').userId, 'seller');
  for (const code of ['OLD-NORTH', 'DISABLED']) assert.equal(p.mappings.find(m => m.siteCode === code).status, 'missing');
  const apply = async (incoming, prior) => salesUpload(new Request('https://example.invalid/api/sales/import', { method: 'POST', headers: { 'X-Sales-Filename': 'synthetic.xlsx', 'X-Sales-Hash': prior.fileHash, 'X-Sales-Revision': String(prior.revision), 'X-Sales-Mapping-Hash': prior.mappingHash }, body: JSON.stringify(incoming) }), user('global'), true);
  await apply(rows, p);
  const national = await read('global');
  assert.deepEqual(national.summary, { rows: 10, quantity: 8, value: 9.54 });
  assert.deepEqual(national.summary, p.summary);
  assert.deepEqual([...national.sites].sort((a, b) => JSON.stringify([a.siteCode, a.location]).localeCompare(JSON.stringify([b.siteCode, b.location]))), [...p.sites].sort((a, b) => JSON.stringify([a.siteCode, a.location]).localeCompare(JSON.stringify([b.siteCode, b.location]))));
  const north = await read('north', '&siteCode=SHARED');
  assert.deepEqual(north.summary, { rows: 3, quantity: 1, value: 1.21 });
  assert.equal(north.products[0].value, 1.21);
  assert.equal(north.daily[0].rows, 3);
  assert.equal(north.months[0].rowCount, 3);
  assert.equal(north.monthly[0].rows, 3);
  assert.deepEqual((await read('global', '&agentId=north')).summary, north.summary);
  assert.equal((await read('south')).summary.rows, 2);
  assert.equal((await read('global', '&agentId=south')).summary.rows, 2);
  assert.equal((await read('stable')).summary.rows, 1);
  assert.equal((await read('site-only')).summary.rows, 1);
  assert.equal((await read('seller')).summary.rows, 5, 'Own scope contains assigned warehouses plus manager seller');
  assert.equal((await read('global', '&managerId=seller')).summary.rows, 5);
  assert.equal((await read('global', '&managerId=peer')).summary.rows, 4, 'Shared assignments do not transfer another manager seller identity');
  assert.equal((await read('seller', '&managerId=seller&agentId=north')).summary.rows, 3);
  assert.equal((await read('global', '&managerId=seller&siteCode=SHARED')).summary.rows, 3, 'Requested colliding code cannot broaden region');
  assert.equal((await read('global', '&managerId=seller')).sites.some(s => s.location === 'TR Oras Sud 01'), false);
  assert.equal((await read('global', '&managerId=__unassigned')).sites.some(s => s.agent === 'Synthetic seller'), false);
  // The public handler's legacy raw-code selector still means all locations with that code.
  assert.equal((await read('global', '&siteCode=SHARED')).summary.rows, 4);
  // Same source document and line at another location cannot compensate for lost multiplicity.
  const replacement = [...rows.map(r => r.rowNumber === 2 ? { ...r, location: 'TR Oras Sud 01' } : r), { ...rows[3], rowNumber: 99 }];
  const loss = store.salesCoverageChange(month, replacement);
  assert.equal(loss.rowDelta, 1); assert.equal(loss.reducedSites.length, 0);
  assert.equal(loss.requiresRegressionAcknowledgement, true); assert.equal(loss.removedLineCount, 1);
  assert.equal(loss.reducedDocuments[0].location, 'tr ORAS-NORD 01');
  const lossPreview = await preview(replacement);
  assert.deepEqual(lossPreview.coverageChange, loss);
  await assert.rejects(apply(replacement, lossPreview), /409/);
  assert.deepEqual((await read('global')).summary, national.summary);
  // Warehouse-only actors work; collisions never invalidate a unique location owner.
  app.prepare("UPDATE users SET site_code='SHARED' WHERE id='north'").run();
  assert.equal((await read('north')).summary.rows, 3);
  assert.equal((await preview()).mappings.find(m => m.location === 'tr ORAS-NORD 01').userId, 'north');
  app.prepare("UPDATE users SET site_code='' WHERE id='north'").run();
  assert.equal((await read('north')).summary.rows, 3);
  // No fuzzy place inference, and changing the warehouse invalidates the worker scope/cache.
  const beforeMove = await preview(replacement);
  app.prepare("UPDATE users SET warehouse_name='TR Oras Nord 02' WHERE id='north'").run();
  assert.equal((await read('north')).summary.rows, 0);
  assert.equal((await preview()).mappings.find(m => m.location === 'tr ORAS-NORD 01').status, 'missing');
  await assert.rejects(apply(replacement, beforeMove), /Maparea/);
  // Active manager seller codes also participate in preview freshness and site uniqueness.
  const beforeSellerChange = await preview(replacement);
  app.prepare("UPDATE users SET site_code='SELLER-NEW' WHERE id='seller'").run();
  await assert.rejects(apply(replacement, beforeSellerChange), /Maparea/);
  assert.equal((await read('seller')).summary.rows, 1);
  assert.equal((await preview()).mappings.find(m => m.location === 'TR Seller Location').status, 'missing');
  add('seller-collision', 'manager', 'ONLY', null);
  assert.equal((await preview()).mappings.find(m => m.siteCode === 'ONLY').status, 'duplicate');
  await assert.rejects(read('site-only'), /409/);
  app.prepare("UPDATE users SET active=0 WHERE id='seller-collision'").run();
  assert.equal((await preview()).mappings.find(m => m.siteCode === 'ONLY').userId, 'site-only');
  console.log('PASS: exact location attribution, shared source pairs, manager seller and regional/agent scopes, worker cache, historical/inactive isolation, preview freshness, authoritative totals and location replacement protection.');
} finally {
  process.chdir(root); app.close(); rmSync(directory, { recursive: true, force: true });
}
