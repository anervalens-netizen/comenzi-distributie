import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { strFromU8, unzipSync } from 'fflate';

const qa=resolve('work/export-qa');rmSync(qa,{recursive:true,force:true});mkdirSync(qa,{recursive:true});
const output=resolve(qa,'exports.mjs');
await build({entryPoints:['lib/exports.ts'],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external'});
const {simExport,xmlSafeText}=await import(pathToFileURL(output));
assert.equal(xmlSafeText('Șir\nvalid\tA\u0001B\ufffeC'),'Șir\nvalid\tABC','Only XML-incompatible controls are removed');
const order={id:'qa',number:'SIM-QA',userId:'agent',agentName:'Agent Ștefan',warehouseId:'g',warehouseName:'Gestiune & Test',kind:'sim',status:'finalized',items:[],serials:['89400000000000000001'],client:{id:'c',warehouseId:'g',name:'Client <Test>',cui:'RO1',city:'București',county:'Ilfov',address:'Strada 1'},notes:'Valid <&> Ș\ncontrol:\u0001',createdAt:'2026-09-16T10:00:00Z',finalizedAt:'2026-09-16T10:10:00Z',sourceOrderId:null,revision:2,total:0,pieces:1};
const files=unzipSync(simExport(order));
const xml=strFromU8(files['xl/worksheets/sheet1.xml']);
assert.ok(!xml.includes('\u0001'),'Worksheet XML excludes illegal U+0001');
assert.ok(xml.includes('Client &lt;Test&gt;')&&xml.includes('Gestiune &amp; Test'),'XML markup characters remain escaped');
assert.ok(xml.includes('Ș'),'Unicode and diacritics are preserved');
console.log('PASS: generated export XML removes illegal controls and preserves valid text.');
