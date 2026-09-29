// Synthetic, isolated regression tests. No HTTP server or application data needed.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import XLSX from 'xlsx';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'r2-imports-'));
const sqlite = new DatabaseSync(':memory:');
let beforeBatch;
const adapter = {
  prepare(sql) {
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async all() { return { results: sqlite.prepare(sql).all(...this.args) }; },
      execute() { return sqlite.prepare(sql).run(...this.args); },
    };
  },
  async batch(statements) {
    const mutate = beforeBatch;
    beforeBatch = undefined;
    mutate?.();
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(statement => statement.execute());
      sqlite.exec('COMMIT');
      return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
globalThis.__r2ImportsDb = adapter;
const columns = ['Data', 'SiteCode', 'ItemCode', 'ItemName', 'Cantitate', 'Brand', 'Pret', 'Valoare', 'Locatie', 'Firma', 'ASM', 'Regional', 'Nr', 'Categorie', 'SubCategorie', 'Agent'];
const sample = { Data: '2026-09-01', SiteCode: 'S1', ItemCode: 'P1', ItemName: 'Synthetic product', Cantitate: 1.2345, Brand: 'Example', Pret: 1.005, Valoare: -1.005, Locatie: 'TR Example', Firma: 'Example', ASM: '', Regional: '', Nr: 'D1', Categorie: 'Example', SubCategorie: '', Agent: '' };
function fixture(values = {}, { formats = {}, date1904 = false, order = columns, offset = 0, bookType = 'xlsx' } = {}) {
  const book = XLSX.utils.book_new(), row = { ...sample, ...values };
  const sheet = XLSX.utils.aoa_to_sheet([...Array.from({ length: offset }, () => ['Synthetic report']), order, order.map(name => row[name])]);
  for (const [name, format] of Object.entries(formats)) sheet[XLSX.utils.encode_cell({ r: offset + 1, c: order.indexOf(name) })].z = format;
  book.Workbook = { WBProps: { date1904 } };
  XLSX.utils.book_append_sheet(book, sheet, 'Sales');
  return XLSX.write(book, { type: 'buffer', bookType });
}
let passed = 0, failed = 0;
async function test(label, run) {
  try { await run(); passed++; }
  catch (error) { failed++; console.error(`FAIL: ${label}\n${error.stack}`); }
}

try {
  const parserPath = join(directory, 'sales-file.mjs');
  await build({ entryPoints: ['lib/sales-file.ts'], outfile: parserPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { parseSalesFile } = await import(pathToFileURL(parserPath));
  const parse = (values, options) => parseSalesFile(fixture(values, options), `synthetic.${options?.bookType || 'xlsx'}`)[0];
  const identifiers = { SiteCode: 'siteCode', ItemCode: 'itemCode', Nr: 'orderNumber' };

  await test('installed SheetJS retains v/w/z only when requested', () => {
    const bytes = fixture({ SiteCode: 12, ItemCode: 123456789012345 }, { formats: { SiteCode: '00000' } });
    const withNF = XLSX.read(bytes, { cellNF: true }).Sheets.Sales;
    const withoutNF = XLSX.read(bytes).Sheets.Sales;
    assert.equal(withNF.B2.v, 12);
    assert.equal(withNF.B2.w, '00012');
    assert.equal(withNF.B2.z, '00000');
    assert.equal(withoutNF.B2.z, undefined);
    assert.match(withNF.C2.w, /E\+/);
    assert.equal(withNF.C2.v, 123456789012345);
  });
  for (const bookType of ['xlsx', 'xls']) for (const [column, property] of Object.entries(identifiers)) {
    for (const [value, format, expected] of [
      [12, 'General', '12'], [12, '00000', '00012'], ['00012', 'General', '00012'],
      ['00012', '0000000', '00012'], [' 00012 ', 'General', ' 00012 '],
      [0, '00000', '00000'], [-12, '00000', '-00012'], [123456, '00000', '123456'],
      [123456789012345, 'General', '123456789012345'], ['9007199254740993', 'General', '9007199254740993'],
    ]) await test(`${bookType} ${column}: ${JSON.stringify(value)} / ${format}`, () => {
      assert.equal(parse({ [column]: value }, { bookType, formats: { [column]: format } })[property], expected);
    });
    for (const [value, format] of [
      [12.25, 'General'], [12.25, '00000'], [Number.MAX_SAFE_INTEGER + 1, 'General'],
      [1234567890123456, 'General'], [1e21, 'General'], [12, '0.00'], [12, '0.00E+00'],
      [12, '#,##0'], [12, '0%'], [12, 'yyyy-mm-dd'], [12, '[>10]00000;0'], [true, 'General'],
    ]) await test(`${bookType} ${column} rejects ambiguous/inexact ${value} / ${format}`, () => {
      assert.throws(() => parse({ [column]: value }, { bookType, formats: { [column]: format } }), new RegExp(`Rândul 2: ${column}.*invalid`));
    });
  }
  await test('reordered columns and header offset use original cell metadata', () => {
    const row = parse({ SiteCode: 12, ItemCode: 34, Nr: 56 }, { order: [...columns].reverse(), offset: 3, formats: { SiteCode: '00000', ItemCode: '0000', Nr: '000000', Cantitate: '0', Pret: '0', Valoare: '0' } });
    assert.equal(row.rowNumber, 5);
    assert.deepEqual([row.siteCode, row.itemCode, row.orderNumber], ['00012', '0034', '000056']);
    assert.deepEqual([row.quantity, row.priceCents, row.valueCents], [1.2345, 101, -101]);
  });
  await test('optional document number remains optional; blank required IDs reject', () => {
    assert.equal(parse({ Nr: '' }).orderNumber, '');
    for (const column of ['SiteCode', 'ItemCode']) assert.throws(() => parse({ [column]: '  ' }), /obligatorii/);
  });
  await test('numeric amounts keep precision regardless of cell display', () => {
    const row = parse({ Cantitate: -1.23456789, Pret: 1234.565, Valoare: -1234.565 }, { formats: { Cantitate: '0', Pret: '0', Valoare: '0' } });
    assert.deepEqual([row.quantity, row.priceCents, row.valueCents], [-1.23456789, 123457, -123457]);
  });
  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Europe/Bucharest', 'Pacific/Kiritimati']) {
      process.env.TZ = timezone;
      for (const bookType of ['xlsx', 'xls']) for (const date1904 of [false, true]) {
        for (const format of ['General', 'yyyy-mm-dd']) await test(`${timezone} ${bookType} date1904=${date1904} ${format}`, () => {
          const row = parse({ Data: date1904 ? 44804 : 46266 }, { bookType, date1904, formats: { Data: format } });
          assert.equal(row.date, '2026-09-01');
          assert.equal(row.month, '2026-09');
        });
        for (const value of ['2026-09-01', '01.09.2026']) await test(`${timezone} ${bookType} date1904=${date1904} text ${value}`, () => {
          assert.equal(parse({ Data: value }, { bookType, date1904 }).date, '2026-09-01');
        });
      }
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone;
  }
  await test('same serial respects epoch and date validity stays enforced', () => {
    assert.equal(parse({ Data: 44804 }).date, '2022-08-31');
    for (const Data of ['2026-02-29', '31.09.2026', -1, 2958466, 60]) assert.throws(() => parse({ Data }), /data este invalidă/);
    assert.equal(parse({ Data: '2024-02-29' }).date, '2024-02-29');
    assert.throws(() => parse({ Data: { t: 'e', v: 0x17 } }), /data este invalidă/);
  });

  sqlite.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE partner_requests(customer_id TEXT,confirmed_at TEXT);`);
  sqlite.exec(readFileSync('drizzle/0006_partner_portfolio.sql', 'utf8'));
  const clientPath = join(directory, 'client-import-server.mjs');
  const stub = `import {createHash} from 'node:crypto';
    export const db=()=>globalThis.__r2ImportsDb;
    export const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
    export const sha256=value=>createHash('sha256').update(value).digest('hex');
    export const textField=(value,max=1000)=>typeof value==='string'?value.trim().slice(0,max):'';`;
  await build({ entryPoints: ['lib/client-import-server.ts'], outfile: clientPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{
    name: 'r2-synthetic-server', setup(plugin) {
      plugin.onResolve({ filter: /^\.\/server$/ }, () => ({ path: 'server', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js' }));
    },
  }] });
  const { importClients } = await import(pathToFileURL(clientPath));
  const point = (address, cui = '991000') => ({ name: 'Synthetic Company', cui, city: 'Synthetic City', county: 'Synthetic County', address, route: '1' });
  const insert = (id, client, active = 1, warehouse = 'W') => sqlite.prepare('INSERT INTO customers VALUES(?,?,?,?)').run(id, warehouse, JSON.stringify({ ...client, id, warehouseId: warehouse }), active);
  const rows = () => sqlite.prepare('SELECT * FROM customers ORDER BY id').all();
  const snapshot = () => JSON.stringify(rows());
  const reset = () => { beforeBatch = undefined; sqlite.exec('DELETE FROM partner_profiles; DELETE FROM customers'); };
  const preview = async clients => (await importClients('W', { clients, preview: true })).preview;
  const apply = (clients, p, acknowledge = false) => importClients('W', { clients, snapshot: p.snapshot, ...(acknowledge ? { confirmRemovals: p.snapshot } : {}) });
  const rejects = action => assert.rejects(action, error => error.status === 409);
  const seed = () => { reset(); insert('old-preserved', point('Synthetic closed point'), 0); insert('active-preserved', point('Synthetic active point')); };
  const clients = [point('Synthetic active point'), point('Synthetic new point')];

  await test('inactive old + active exact + new same-CUI point applies and preserves history', async () => {
    seed();
    const old = rows().find(row => row.id === 'old-preserved');
    const p = await preview(clients);
    assert.deepEqual(p.blocked, []);
    assert.deepEqual(p.ambiguous, []);
    assert.deepEqual(p.removed, []);
    assert.equal(p.added.length, 1);
    assert.equal(p.unchanged[0].id, 'active-preserved');
    assert.equal((await apply(clients, p)).count, 2);
    assert.equal(rows().length, 3);
    assert.equal(rows().filter(row => row.active === 1).length, 2);
    assert.deepEqual(rows().find(row => row.id === 'old-preserved'), old);
  });
  await test('exact inactive reactivation preserves ID, raw address and fingerprint', async () => {
    seed();
    const original = JSON.parse(rows().find(row => row.id === 'old-preserved').data);
    const fingerprint = createHash('sha256').update(JSON.stringify([original.address, original.city, original.county])).digest('hex');
    sqlite.prepare('INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,address_fingerprint,updated_at) VALUES(?,?,?,?,?,?)').run(original.id, 1, 2, 'manual', fingerprint, '2026-09-01T00:00:00Z');
    const profile = sqlite.prepare('SELECT * FROM partner_profiles').get();
    const input = [...clients, { ...point('  SYNTHETIC  CLOSED  POINT '), city: 'SYNTHETIC CITY', county: 'SYNTHETIC COUNTY' }];
    const p = await preview(input);
    assert.deepEqual(p.blocked, []);
    assert.ok(p.unchanged.some(client => client.id === original.id));
    await apply(input, p);
    const saved = rows().find(row => row.id === original.id);
    assert.equal(saved.active, 1);
    assert.deepEqual(JSON.parse(saved.data), original);
    assert.deepEqual(sqlite.prepare('SELECT * FROM partner_profiles').get(), profile);
    assert.equal(rows().length, 3);
  });
  await test('omitting an active same-CUI point still denies a changed address', async () => {
    seed();
    const input = [point('Synthetic changed point')], before = snapshot(), p = await preview(input);
    assert.equal(p.ambiguous.length, 1);
    assert.ok(p.blocked.some(message => message.includes('editează mai întâi')));
    await rejects(() => apply(input, p, true));
    assert.equal(snapshot(), before);
  });
  await test('same-CUI new point without an address remains ambiguous', async () => {
    seed();
    const input = [clients[0], point('')], p = await preview(input), before = snapshot();
    assert.equal(p.ambiguous.length, 1);
    await rejects(() => apply(input, p));
    assert.equal(snapshot(), before);
  });
  await test('active omission of another firm still requires acknowledgement', async () => {
    seed(); insert('omitted-active', point('Synthetic other firm', '991001'));
    const p = await preview(clients), before = snapshot();
    assert.deepEqual(p.blocked, []);
    assert.deepEqual(p.removed.map(client => client.id), ['omitted-active']);
    await rejects(() => apply(clients, p));
    assert.equal(snapshot(), before);
    await apply(clients, p, true);
    assert.equal(rows().find(row => row.id === 'omitted-active').active, 0);
  });
  for (const activity of [[0, 0], [0, 1], [1, 1]]) await test(`duplicate exact identities fail closed (${activity.join(",")})`, async () => {
    reset(); activity.forEach((active, index) => insert(`duplicate-${index}`, point('Synthetic duplicate'), active));
    const input = [point('Synthetic duplicate')], p = await preview(input), before = snapshot();
    assert.equal(p.ambiguous.length, 1);
    await rejects(() => apply(input, p, true));
    assert.equal(snapshot(), before);
  });
  for (const active of [0, 1]) for (const warehouse of ['W', 'OTHER']) await test(`shared identity protected: active=${active}, owner=${warehouse}`, async () => {
    reset(); insert('shared', { ...point('Synthetic shared point'), warehouseIds: ['W', 'OTHER'] }, active, warehouse);
    const input = [point('Synthetic shared point')], p = await preview(input), before = snapshot();
    assert.ok(p.blocked.length);
    await rejects(() => apply(input, p, true));
    assert.equal(snapshot(), before);
  });
  await test('unrelated inactive shared same-CUI history does not block addition', async () => {
    seed(); insert('shared-history', { ...point('Synthetic shared history'), warehouseIds: ['W', 'OTHER'] }, 0);
    const p = await preview(clients);
    assert.deepEqual(p.blocked, []);
    await apply(clients, p);
    assert.equal(rows().find(row => row.id === 'shared-history').active, 0);
  });
  for (const active of [0, 1]) await test(`moved deterministic identity cannot be reclaimed: active=${active}`, async () => {
    reset();
    const generated = (await preview([point('Synthetic moved point')])).added[0].id;
    insert(generated, point('Synthetic moved point'), active, 'OTHER');
    const input = [point('Synthetic moved point')], p = await preview(input), before = snapshot();
    assert.ok(p.blocked.length);
    await rejects(() => apply(input, p));
    assert.equal(snapshot(), before);
  });
  for (const timing of ['after-preview', 'before-batch']) for (const mutation of ['data', 'active', 'ownership', 'insert', 'delete']) {
    await test(`inactive history participates in CAS: ${mutation} ${timing}`, async () => {
      seed(); const p = await preview(clients); assert.deepEqual(p.blocked, []);
      let expected;
      const mutate = () => {
        if (mutation === 'data') sqlite.exec("UPDATE customers SET data=json_set(data,'$.route','9') WHERE id='old-preserved'");
        if (mutation === 'active') sqlite.exec("UPDATE customers SET active=1 WHERE id='old-preserved'");
        if (mutation === 'ownership') sqlite.exec("UPDATE customers SET warehouse_id='OTHER' WHERE id='old-preserved'");
        if (mutation === 'insert') insert('concurrent-history', point('Synthetic concurrent point'), 0);
        if (mutation === 'delete') sqlite.exec("DELETE FROM customers WHERE id='old-preserved'");
        expected = snapshot();
      };
      if (timing === 'after-preview') mutate(); else beforeBatch = mutate;
      await rejects(() => apply(clients, p, true));
      assert.equal(snapshot(), expected);
    });
  }
} finally {
  sqlite.close();
  delete globalThis.__r2ImportsDb;
  rmSync(directory, { recursive: true, force: true });
}
console.log(`R2 imports: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
