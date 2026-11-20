import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './server';
import { salesYield } from './client-sales-cooperative';
import { managerAiAnalysisCatalog, managerAiAnalysisLimits, type ManagerAiAnalysisTable } from './manager-ai-analysis-schema';

const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Invalid analytical table identifier');
  return '"' + name + '"';
};

export async function materializeManagerAiDatabase(tables: readonly ManagerAiAnalysisTable[], signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const limits = managerAiAnalysisLimits;
  if (!tables.length || tables.length>limits.tables || tables.reduce((total,table)=>total+table.rows.length,0)>limits.rows) {
    fail(413,'Selecția depășește limita de analiză. Restrânge perioada, portofoliul sau numărul de tabele.');
  }
  if (new Set(tables.map(table=>table.table)).size!==tables.length) fail(400,'Un tabel a fost cerut de mai multe ori.');
  const directory = mkdtempSync(join(tmpdir(),'manager-ai-snapshot-'));
  const path = join(directory,'comenzi.sqlite');
  let connection: DatabaseSync|undefined;
  try {
    connection = new DatabaseSync(path);
    connection.exec(`PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      BEGIN;
      CREATE TABLE _datasets (table_name TEXT PRIMARY KEY, label TEXT NOT NULL, grain TEXT NOT NULL,
        from_month TEXT NOT NULL, to_month TEXT NOT NULL, row_count INTEGER NOT NULL) STRICT;
      CREATE TABLE _coverage (table_name TEXT NOT NULL, month TEXT, source TEXT NOT NULL, available INTEGER NOT NULL,
        through TEXT, revision TEXT, note TEXT) STRICT;`);
    const dataset = connection.prepare('INSERT INTO _datasets VALUES (?,?,?,?,?,?)');
    const coverage = connection.prepare('INSERT INTO _coverage VALUES (?,?,?,?,?,?,?)');
    let bytes = 0, inserted = 0;
    for (const table of tables) {
      if (!Object.hasOwn(managerAiAnalysisCatalog,table.table)) fail(400,'Tabel de analiză necunoscut.');
      const info = managerAiAnalysisCatalog[table.table];
      const columns = info.columns;
      if (JSON.stringify(table.columns)!==JSON.stringify(columns)) throw new Error('Invalid analytical table schema');
      const sql = columns.map(column=>identifier(column.name) + (column.type==='text'?' TEXT':' REAL') + (column.nullable?'':' NOT NULL'));
      const name = identifier(table.table);
      connection.exec(`CREATE TABLE ${name} (${sql.join(',')}) STRICT`);
      const insert = connection.prepare(`INSERT INTO ${name} VALUES (${columns.map(()=>'?').join(',')})`);
      for (const row of table.rows) {
        if (row.length!==columns.length) throw new Error('Invalid analytical row width');
        for (const cell of row) {
          const size = typeof cell==='string'?Buffer.byteLength(cell):8;
          bytes+=size;
          if (size>limits.cellBytes||bytes>limits.textBytes) fail(413,'Selecția de analiză depășește limita de spațiu. Restrânge selecția.');
        }
        insert.run(...row);
        if (++inserted%512===0) {
          await salesYield();
          signal?.throwIfAborted();
        }
      }
      dataset.run(table.table,info.label,info.grain,table.fromMonth,table.toMonth,table.rows.length);
      for (const line of table.coverage) {
        coverage.run(table.table,line.month??null,line.source,Number(line.available),line.through??null,line.revision??null,line.note??null);
      }
    }
    signal?.throwIfAborted();
    connection.exec('COMMIT');
    connection.close();
    connection=undefined;
    if (statSync(path).size>limits.sqliteBytes) fail(413,'Fișierul de analiză depășește limita. Restrânge selecția.');
    return readFileSync(path);
  } finally {
    connection?.close();
    rmSync(directory,{recursive:true,force:true});
  }
}
