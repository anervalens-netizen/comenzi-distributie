import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import XLSX from 'xlsx';

await mkdir('work/runtime-tests',{recursive:true});
const outfile='work/runtime-tests/stock-parser-cloudflare.mjs';
await build({
  entryPoints:['lib/stock-parser-cloudflare.ts'],
  outfile,
  bundle:true,
  platform:'node',
  format:'esm',
  packages:'external',
});
const { parseStockFileRuntime }=await import(pathToFileURL(resolve(outfile)).href);

const columns=['Gestiune','ItemCode','ItemName','Stoc','SiteId','StocDepozit'];
const book=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
  columns,
  ['GESTIUNE TR TEST','P1','Produs 1',4,1001,9],
  ['GESTIUNE TR TEST','P2','Produs 2',0,1001,''],
]),'Stoc_TR');
const bytes=new Uint8Array(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
const parsed=await parseStockFileRuntime(bytes,'stock-cloudflare.xlsx');

assert.equal(parsed.length,1,'Cloudflare parser returns the stock group');
assert.equal(parsed[0].rows.length,2,'Cloudflare parser returns every stock row');
assert.equal(parsed[0].rows[0].depotQuantity,9,'Cloudflare parser preserves depot quantity');
assert.equal(parsed[0].rows[1].depotQuantity,null,'Cloudflare parser preserves blank depot stock as unknown');
await assert.rejects(()=>parseStockFileRuntime(new Uint8Array([1,2,3]),'bad.xlsx'),/registru Excel/);
await rm(outfile,{force:true});
console.log('PASS: Cloudflare stock parser uses the direct runtime-safe implementation.');
