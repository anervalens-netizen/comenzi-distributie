// Native original route/import oracles and two dedicated connections to a new
// synthetic WAL database. No HTTP, PostgreSQL, live SQLite file or selector.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build, transformSync } from 'esbuild';
import { parse } from 'acorn';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { authorityFixtureStatements } from './authority-session-contract.mjs';
import { customerSqliteObjects } from './customer-sqlite-fixture.mjs';
import { runCustomerWriteContract } from './customer-write-contract.mjs';

mkdirSync('work', { recursive: true });
const folder = mkdtempSync(resolve('work/customer-writes-'));
let database, other, setup;
const sourceHashes = {};
const parsedSource = (file) => {
  const raw = readFileSync(file, 'utf8');
  sourceHashes[file] = createHash('sha256').update(raw).digest('hex');
  const code = transformSync(raw, {
    loader: 'ts',
    format: 'esm',
    target: 'node24',
  }).code;
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  return { code, ast };
};
const declarations = (file, names) => {
  const { code, ast } = parsedSource(file);
  const nodes = ast.body
    .map((node) =>
      node.type === 'ExportNamedDeclaration' ? node.declaration : node,
    )
    .filter(Boolean);
  return names
    .map((name) => {
      const matching = nodes.filter(
        (node) =>
          node.id?.name === name ||
          (node.type === 'VariableDeclaration' &&
            node.declarations.some((item) => item.id.name === name)),
      );
      if (matching.length !== 1)
        throw new Error(
          'Original customer declaration missing or duplicated: ' + name,
        );
      return code.slice(matching[0].start, matching[0].end);
    })
    .join('\n');
};
const editBranch = () => {
  const { code, ast } = parsedSource('app/api/[...path]/route.ts'),
    found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'IfStatement') {
      const test = code.slice(node.test.start, node.test.end);
      if (test === 'path[1] === "clients" && path[2] && req.method === "PUT"')
        found.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(child)) for (const item of child) visit(item);
      else visit(child);
    }
  };
  visit(ast);
  assert.equal(
    found.length,
    1,
    'Original client edit branch must be uniquely identified',
  );
  assert.equal(found[0].consequent.type, 'BlockStatement');
  return code.slice(found[0].consequent.start + 1, found[0].consequent.end - 1);
};
try {
  const moduleFile = join(folder, 'writer.mjs');
  await build({
    stdin: {
      contents:
        "export * from './lib/sql-database'; export * from './lib/sql-sqlite'; export * from './lib/session-repository-async'; export * from './lib/authority-repository-async'; export * from './lib/customer-write-repository-async';",
      loader: 'ts',
      resolveDir: resolve('.'),
    },
    outfile: moduleFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  const api = await import(pathToFileURL(moduleFile)),
    appFile = join(folder, 'app.sqlite'),
    ledgerFile = join(folder, 'ledger.sqlite');
  const open = () => {
    const connection = new DatabaseSync(appFile);
    connection.exec(
      'PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF; PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL',
    );
    connection.prepare('ATTACH DATABASE ? AS ledger').run(ledgerFile);
    return connection;
  };
  setup = open();
  for (const sql of authorityFixtureStatements(api, 'main', 'ledger', 'sqlite'))
    setup.exec(sql);
  setup.exec(
    'ALTER TABLE portfolio_revision ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 1',
  );
  for (const object of customerSqliteObjects)
    if (object.name !== 'portfolio_revision') setup.exec(object.sql);
  setup.exec('INSERT INTO crm_directory_revision VALUES(1,300)');
  const customerTriggers = setup
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('customers','partner_profiles') ORDER BY rowid",
    )
    .all();
  assert.deepEqual(
    customerTriggers.map((row) => ({ name: row.name, sql: row.sql })),
    customerSqliteObjects
      .filter((item) => item.type === 'trigger')
      .map((item) => ({ name: item.name, sql: item.sql })),
  );
  const sqliteVersion = setup
    .prepare('SELECT sqlite_version() AS version')
    .get().version;
  database = new api.SqliteDatabase(setup);
  other = new api.SqliteDatabase(open());
  const oracleFile = join(folder, 'original.mjs');
  const shared = declarations('lib/server.ts', [
    'AppError',
    'fail',
    'sha256',
    'textField',
    'requireManager',
    'isGlobalManager',
    'canAccessAgent',
    'requireAgentAccess',
    'canAccessWarehouse',
    'requireWarehouseAccess',
  ]);
  const imported = declarations('lib/client-import-server.ts', [
    'identity',
    'editInstruction',
    'importClients',
  ]);
  const branch = editBranch();
  await build({
    stdin: {
      contents:
        "import {createHash} from 'node:crypto'; import {normalizeCui,partnerPointKey} from './lib/partner-identity';\nexport function makeOracle(db,warehouses){\n" +
        shared +
        '\n' +
        imported +
        '\nconst response=value=>value; const getUsers=async()=>[];\n' +
        '\nreturn {async edit(user,id,inputBody){requireManager(user);const req={method:"PUT"};const path=["admin","clients",id];const jsonBody=async()=>inputBody;\n' +
        branch +
        '\n},async applyImport(user,body){requireManager(user);const warehouseId=textField(body.warehouseId);' +
        'if(!warehouses.some(g=>g.id===warehouseId))fail(400,"Gestiune invalidă.");await requireWarehouseAccess(user,warehouseId);return importClients(warehouseId,body);}};\n}',
      loader: 'ts',
      resolveDir: resolve('.'),
    },
    outfile: oracleFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  const { makeOracle } = await import(pathToFileURL(oracleFile));
  let oracleCount = 0;
  const legacyOracle = async (kind, body, id, userId, tables) => {
    assert.equal(
      setup.isTransaction,
      false,
      'Original oracle copy requires an idle synthetic connection',
    );
    const filename = join(folder, 'original-' + ++oracleCount + '.sqlite');
    assert.equal(existsSync(filename), false);
    // This copies only the newly created synthetic database. It never opens any
    // application or externally supplied SQLite path.
    setup.prepare('VACUUM INTO ?').run(filename);
    const clone = new DatabaseSync(filename);
    clone.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF;');
    try {
      const prepared = (sql, values = []) => {
        const run = () => {
          const result = clone.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        };
        return {
          bind: (...next) => prepared(sql, next),
          first: async () => {
            const row = clone.prepare(sql).get(...values);
            return row ? { ...row } : null;
          },
          all: async () => ({
            results: clone
              .prepare(sql)
              .all(...values)
              .map((row) => ({ ...row })),
          }),
          run: async () => run(),
          nativeRun: run,
        };
      };
      const db = () => ({
        prepare: (sql) => prepared(sql),
        batch: async (statements) => {
          clone.exec('BEGIN IMMEDIATE');
          try {
            const values = statements.map((statement) => statement.nativeRun());
            clone.exec('COMMIT');
            return values;
          } catch (error) {
            if (clone.isTransaction) clone.exec('ROLLBACK');
            throw error;
          }
        },
      });
      const user = api.accountRecord({
        ...clone.prepare('SELECT * FROM users WHERE id=?').get(userId),
      });
      const original = makeOracle(
        db,
        ['a', 'b', 'c', 'd'].map((letter) => ({
          id: 'warehouse-' + letter,
          name: 'Synthetic ' + letter.toUpperCase(),
        })),
      );
      const started = Date.now();
      let value, error;
      try {
        const result =
          kind === 'edit'
            ? await original.edit(user, id, structuredClone(body))
            : await original.applyImport(user, structuredClone(body));
        value = kind === 'edit' ? { client: result.client } : result;
      } catch (failure) {
        error = { status: failure.status ?? null, message: failure.message };
      }
      const ended = Date.now(),
        state = {};
      for (const [table, order] of tables)
        state[table] = clone
          .prepare(`SELECT * FROM "${table}" ORDER BY ${order}`)
          .all()
          .map((row) => ({ ...row }));
      return { value, error, state, bounds: { started, ended } };
    } finally {
      clone.close();
      for (const path of [filename, filename + '-wal', filename + '-shm'])
        if (existsSync(path)) rmSync(path);
    }
  };
  const result = await runCustomerWriteContract(api, {
    database,
    other,
    applicationSchema: 'main',
    legacyOracle,
  });
  assert.equal(oracleCount, result.oracleCount);
  console.log(
    JSON.stringify({
      kind: 'async-customer-writes-native-contract',
      schema_version: 1,
      passed: true,
      node: process.version,
      sqliteVersion,
      case_count: result.caseIds.length,
      case_ids: result.caseIds,
      original_oracle_count: result.oracleCount,
      original_source_hashes: sourceHashes,
      authority_lock: 'two dedicated adapters to one synthetic WAL file',
      observations: result.observations,
      customer_schema_postgresql_executed: false,
      runtime_wired: false,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      kind: 'async-customer-writes-native-contract',
      schema_version: 1,
      passed: false,
      node: process.version,
      original_source_hashes: sourceHashes,
      evidence: error.customerWriterEvidence ?? null,
      error: { name: error.name, message: error.message },
    }),
  );
  throw error;
} finally {
  await database?.close();
  await other?.close();
  if (!database && setup?.isOpen) setup.close();
  rmSync(folder, { recursive: true, force: true });
}
