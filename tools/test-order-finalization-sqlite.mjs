import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { authorityFixtureStatements } from './authority-session-contract.mjs';
import { orderDraftFixtureStatements } from './order-draft-contract.mjs';
import {
  orderFinalizationFixtureStatements,
  runOrderFinalizationContract,
} from './order-finalization-contract.mjs';

mkdirSync('work', { recursive: true });
const folder = mkdtempSync(resolve('work/order-finalization-'));
let database, other;
try {
  const output = join(folder, 'finalization.mjs');
  await build({
    stdin: {
      contents: [
        'sql-database',
        'sql-sqlite',
        'sql-postgres',
        'session-repository-async',
        'authority-repository-async',
        'order-write-authority-async',
        'order-finalization-state-async',
        'order-limit-source-async',
        'order-limit-repository-async',
        'order-finalization-repository-async',
      ]
        .map((name) => `export * from './lib/${name}';`)
        .join('\n'),
      loader: 'ts',
      resolveDir: resolve('.'),
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  const api = await import(pathToFileURL(output)),
    appFile = join(folder, 'application.sqlite');
  const open = () => {
    const sql = new DatabaseSync(appFile);
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100');
    sql
      .prepare('ATTACH DATABASE ? AS ledger')
      .run(join(folder, 'ledger.sqlite'));
    sql.prepare('ATTACH DATABASE ? AS sales').run(join(folder, 'sales.sqlite'));
    return sql;
  };
  const sql = open();
  for (const statement of [
    ...authorityFixtureStatements(api, 'main', 'ledger', 'sqlite'),
    ...orderDraftFixtureStatements(api, 'main', 'sqlite'),
    ...orderFinalizationFixtureStatements(api, 'main', 'sales', 'sqlite'),
  ])
    sql.exec(statement);
  database = new api.SqliteDatabase(sql);
  other = new api.SqliteDatabase(open());
  const cases = await runOrderFinalizationContract(api, {
    database,
    other,
    applicationSchema: 'main',
    salesSchema: 'sales',
  });
  console.log(
    JSON.stringify({
      kind: 'async-order-finalization-synthetic-contract',
      engine: 'sqlite',
      passed: true,
      case_count: cases.length,
      case_ids: cases,
      postgresql_executed: false,
      runtime_wired: false,
      production_export_store_implemented: false,
    }),
  );
} finally {
  await database?.close();
  await other?.close();
  rmSync(folder, { recursive: true, force: true });
}
