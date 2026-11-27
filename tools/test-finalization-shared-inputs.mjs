import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** Runtime reads use database; the explicit fixture writer seeds synthetic inputs. */
export async function runFinalizationSharedInputContract(api, { database, fixtureDatabase, applicationSchema }) {
  const a = api.sqlIdentifier(applicationSchema), sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL)');
  const write = (sqlite, postgresql, values) => fixtureDatabase.write(tx => tx.query(api.sqlQuery('write', sqlite, postgresql), values));
  try {
  const cases = [];
  for (const [name, memberships, warehouse] of [
    ['finalization_membership_uses_first_duplicate_key_allow', '"warehouseIds":["fictional-a"],"warehouseIds":["fictional-b"]', 'fictional-a'],
    ['finalization_membership_uses_first_duplicate_key_deny', '"warehouseIds":["fictional-b"],"warehouseIds":["fictional-a"]', 'fictional-a'],
    ['finalization_membership_preserves_nested_json_lexeme', '"warehouseIds":[{"id":1.0}]', '{"id":1.0}'],
  ]) {
    const raw = '{"id":"fictional-client","name":"Fictional","cui":"TEST","city":"Fictional","county":"Fictional","address":"Fictional","route":"Fictional",' + memberships + '}';
    sql.prepare('INSERT INTO customers VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET warehouse_id=excluded.warehouse_id,data=excluded.data').run('fictional-client', 'fictional-fallback', raw);
    await write(`INSERT INTO ${a}.customers VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET warehouse_id=excluded.warehouse_id,data=excluded.data`,
      `INSERT INTO ${a}.customers VALUES($1,$2,$3,1) ON CONFLICT(id) DO UPDATE SET warehouse_id=excluded.warehouse_id,data=excluded.data`,
      ['fictional-client', 'fictional-fallback', raw]);
    // This is the original route predicate, executed by SQLite JSON1 itself.
    const oracle = sql.prepare("SELECT data FROM customers WHERE id=? AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.warehouseIds'),json_array(warehouse_id))) WHERE value=?) AND active=1").get('fictional-client', warehouse);
    const order = { kind: 'sim', serials: ['100000000000000001'], warehouseId: warehouse, client: JSON.parse(raw) };
    const action = () => database.read(tx => api.readFinalizationClient(tx, a, order));
    if (oracle) assert.equal(await action(), oracle.data, name);
    else await assert.rejects(action, error => error?.code === 'client_changed', name);
    cases.push(name);
  }
  const product = { id: 'fictional-product', code: 'TEST', name: 'Fictional', kind: 'accessories', category: 'Synthetic', brand: 'Synthetic', price: 1, netPrice: 1, sourceRow: 1, image: null };
  const raw = ' { "overrides" : {} } ', mappingsRaw = ' {"1234567890128" : "TEST"} ';
  for (const [key, value] of [['catalog', raw], ['inventory-ean-v1', mappingsRaw]]) await write(
    `INSERT INTO ${a}.settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    `INSERT INTO ${a}.settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
  await database.read(async tx => {
    const expected = await api.readCatalogSnapshot(tx, a, [product]);
    const actual = await api.readFinalizationCatalog(tx, a, [product]);
    assert.deepEqual(actual, { raw: expected.raw, mappingsRaw: expected.mappingsRaw, products: expected.products });
    assert.equal(actual.raw, raw); assert.equal(actual.mappingsRaw, mappingsRaw);
  });
  cases.push('finalization_shared_catalog_retains_raw_text_and_projection');
  return cases;
  } finally { sql.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mkdirSync('work', { recursive: true });
  const folder = mkdtempSync(resolve('work/finalization-shared-inputs-'));
  let database;
  try {
    const output = join(folder, 'inputs.mjs');
    await build({ stdin: { contents: [
      'sql-database', 'sql-sqlite', 'catalog-customer-repository-async', 'order-finalization-state-async',
    ].map(name => `export * from './lib/${name}';`).join('\n'), loader: 'ts', resolveDir: resolve('.') },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
    const api = await import(pathToFileURL(output)), sql = new DatabaseSync(':memory:');
    sql.exec('CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    database = new api.SqliteDatabase(sql);
    const cases = await runFinalizationSharedInputContract(api, { database, fixtureDatabase: database, applicationSchema: 'main' });
  console.log(JSON.stringify({ kind: 'finalization-shared-input-oracles', passed: true,
    engine: 'sqlite', oracle_count: 3, case_count: cases.length, case_ids: cases, postgresql_executed: false, runtime_wired: false }));
  } finally {
    await database?.close(); rmSync(folder, { recursive: true, force: true });
  }
}
