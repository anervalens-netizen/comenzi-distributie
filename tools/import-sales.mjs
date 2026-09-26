#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=') || '1'];
}));
const source = args.get('file');
if (!source) { console.error('Usage: node tools/import-sales.mjs --file=raport.xlsx [--data-dir=work/server-data] [--allow-historical]'); process.exit(2); }
const filePath = resolve(source);
const dataDirectory = resolve(args.get('data-dir') || process.env.MOBIUP_DATA_DIR || './work/server-data');
process.env.MOBIUP_DATA_DIR = dataDirectory;
const runtime = resolve('work', '.sales-cli-runtime');
mkdirSync(runtime, { recursive: true });
const parserPath = resolve(runtime, 'sales-file.mjs');
const storePath = resolve(runtime, 'sales-store.mjs');
await build({ entryPoints: ['lib/sales-file.ts'], outfile: parserPath, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
await build({ entryPoints: ['lib/sales-store.ts'], outfile: storePath, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { parseSalesFile, salesHash } = await import(pathToFileURL(parserPath));
const store = await import(pathToFileURL(storePath));
const bytes = readFileSync(filePath);
const filename = filePath.split(/[\\/]/).pop() || 'sales.xlsx';
const rows = parseSalesFile(bytes, filename);
const month = rows[0].month;
const fileHash = salesHash(bytes);
const originalPath = await store.saveSalesOriginal(fileHash, filename, bytes);
const result = store.importSalesRows({ rows, month, fileHash, filename, importedBy: 'cli', originalPath, expectedRevision: store.salesRevision(), expectedMappingHash: 'cli', currentMappingHash: 'cli', historicalAcknowledged: args.has('allow-historical'), regressionAcknowledged: args.has('allow-regression') });
console.log(JSON.stringify({ ...result, source: filePath, originalPath }));
