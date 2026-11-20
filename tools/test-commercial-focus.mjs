import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const {outputFiles} = await build({
  stdin: {resolveDir: process.cwd(), contents: "export * from './lib/commercial-focus.ts'; export * from './lib/commercial-focus-store.ts'; export * from './lib/commercial-focus-runtime-node.ts';"},
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const {focusOffers, calculateFocus, readFocusSales, readFocusSalesAsync} =
  await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const actor = {id: 'agent-a', siteCode: 'SITE-A', name: 'Agent A'};
const fixture = {
  version: 1,
  periods: [{
    fromMonth: '2026-06', throughMonth: '2026-10', simulation: true,
    accessories: [{code: 'ACC', name: 'Accessory'}],
    phones: [
      {code: 'PHONE-A', name: 'Phone one', belowTargetCents: 300, reachedTargetCents: 900},
      {code: 'PHONE-B', name: 'Phone two', belowTargetCents: 100, reachedTargetCents: 700},
      {code: 'PHONE-0', name: 'Phone zero incentive', belowTargetCents: 0, reachedTargetCents: 0},
    ],
    targets: [{userId: actor.id, units: 5}, {userId: 'agent-b', units: 8}],
  }],
};
const [offer] = focusOffers(fixture);
assert.throws(() => focusOffers({...fixture, periods: [offer, {...offer, fromMonth: '2026-07'}]}));
assert.throws(() => focusOffers({...fixture, periods: [{...offer, phones: [...offer.phones, offer.phones[0]]}]}));
assert.throws(() => focusOffers({...fixture, periods: [{...offer, targets: [{userId: actor.id, units: -1}]}]}));

const work = mkdtempSync(join(tmpdir(), 'comenzi-commercial-focus-'));
const db = new DatabaseSync(join(work, 'sales.sqlite'));
mkdirSync(join(work, 'client-history'));
const detail = new DatabaseSync(join(work, 'client-history', 'client-sales-history.sqlite'));
try {
  db.exec(`CREATE TABLE sales_months(month TEXT PRIMARY KEY, import_id INTEGER, imported_at TEXT);
    CREATE TABLE sales_rows(import_id INTEGER, date TEXT, site_code TEXT, location TEXT, item_code TEXT, quantity INTEGER,
      order_number TEXT DEFAULT 'TEST-DOC', price_cents INTEGER DEFAULT 200, value_cents INTEGER DEFAULT 200);
    INSERT INTO sales_months VALUES ('2026-08',2,'2026-08-31T10:00:00Z');`);
  const row = db.prepare('INSERT INTO sales_rows(import_id,date,site_code,location,item_code,quantity) VALUES (?,?,?,?,?,?)');
  row.run(2, '2026-08-01', 'SITE-A', 'TR Agent A', 'PHONE-A', 4);
  row.run(2, '2026-08-21', 'SITE-A', 'TR Agent A', 'PHONE-A', -1);
  row.run(2, '2026-08-15', 'SITE-A', 'TR Agent A', 'PHONE-B', 1);
  row.run(2, '2026-08-20', 'SITE-OLD', 'TR Agent A Vechi', 'PHONE-0', 1);
  row.run(2, '2026-08-20', 'SITE-A', 'TR Agent A', 'ACC', 3);
  row.run(2, '2026-08-21', 'SITE-A', 'TR Agent A', 'ACC', -1);
  row.run(2, '2026-08-30', 'SITE-A', 'TR Different Holder', 'PHONE-A', 10);
  row.run(2, '2026-08-31', 'SITE-B', 'TR Agent B', 'PHONE-0', 8);
  row.run(1, '2026-08-01', 'SITE-A', 'TR Agent A', 'PHONE-A', 1000);
  db.exec(`INSERT INTO sales_rows VALUES
    (2,'2026-08-24','SITE-A','TR Agent A','ACC',1,'TEST-GENERIC',200,200),
    (2,'2026-08-25','SITE-A','TR Agent A','PHONE-B',1,'TEST-CORRECTION',200,200),
    (2,'2026-08-25','SITE-A','TR Agent A','ACC',1,'Bon de consum TEST',200,200);`);
  detail.exec(`CREATE TABLE history_imports(id INTEGER,state TEXT);INSERT INTO history_imports VALUES (1,'active');
    CREATE TABLE history_identities(id INTEGER,client_code TEXT);INSERT INTO history_identities VALUES (1,'GENERICCLIENT'),(2,'12345');
    CREATE TABLE history_rows(import_id INTEGER,identity_id INTEGER,date TEXT,tr TEXT,document_number TEXT,item_code TEXT,
      quantity_micros INTEGER,price_cents INTEGER,value_cents INTEGER,customer_name TEXT,raw_json TEXT);
    INSERT INTO history_rows VALUES
      (1,1,'2026-08-24','TR Agent A','TEST-GENERIC','ACC',1000000,200,200,'Partner de verificat','{}'),
      (1,2,'2026-08-25','TR Agent A','TEST-CORRECTION','PHONE-B',1000000,200,200,'Client sintetic','{"Tip document":"Corecție de stoc"}');`);
  const identity = (id, siteCode, warehouseName) => ({id, siteCode, warehouseName});
  const identities = [
    identity('agent-a', 'SITE-A', 'TR Agent A'), identity('agent-a', 'SITE-OLD', 'TR Agent A Vechi'),
    identity('agent-b', 'SITE-B', 'TR Agent B'),
  ];
  const itemCodes = ['ACC', 'PHONE-A', 'PHONE-B', 'PHONE-0'];
  const selected = new Set([actor.id]);
  const sales = readFocusSales('2026-08', itemCodes, identities, selected, work);
  assert.equal(sales.lastDate, '2026-08-31');
  assert.equal(sales.excludedRows, 3);
  assert.equal(sales.unmatchedRows, 6);
  assert.deepEqual([...sales.quantities.keys()], [actor.id]);
  const report = calculateFocus(offer, actor, sales.quantities.get(actor.id));
  assert.equal(report.units, 5);
  assert.equal(report.targetReached, true);
  assert.equal(report.phoneCents, 3400);
  assert.equal(report.accessoriesCents, 1000);
  assert.equal(report.phones.find(item => item.code === 'PHONE-0').quantity, 1);
  const under = calculateFocus(offer, actor, new Map([['PHONE-A', 3], ['PHONE-B', 1], ['ACC', 1]]));
  assert.deepEqual([under.units, under.targetReached, under.phoneCents, under.accessoriesCents], [4, false, 1000, 500]);

  const ambiguity = readFocusSales('2026-08', itemCodes, [...identities, identity('agent-b', 'SITE-A', 'TR Agent A')], selected, work);
  assert.deepEqual([...ambiguity.quantities.get(actor.id)], [['PHONE-0', 1]]);
  assert.equal(readFocusSales('2026-07', itemCodes, identities, selected, work), null);

  await build({entryPoints: ['lib/commercial-focus-worker.ts'], outfile: join(work, 'commercial-focus-worker.mjs'),
    bundle: true, platform: 'node', format: 'esm'});
  const previousDirectory = process.cwd();
  process.chdir(work);
  try {
    assert.deepEqual(await readFocusSalesAsync('2026-08', itemCodes, identities, selected, work), sales);
    assert.equal(await readFocusSalesAsync('2026-07', itemCodes, identities, selected, work), null);
  } finally {
    process.chdir(previousDirectory);
  }
} finally {
  detail.close();
  db.close();
  rmSync(work, {recursive: true, force: true});
}
console.log('PASS Focus monthly import, scoped seller and owner alias, returns, inclusive targets, and zero-rate phones.');
