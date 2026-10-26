import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const qa=resolve('work/export-qa');rmSync(qa,{recursive:true,force:true});mkdirSync(qa,{recursive:true});
const output=resolve(qa,'exports.mjs');
await build({entryPoints:['lib/exports.ts'],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external'});
const {simExport,xmlSafeText,combinedExport,repairOrderExport,mailFor}=await import(pathToFileURL(output));
assert.equal(xmlSafeText('Șir\nvalid\tA\u0001B\ufffeC'),'Șir\nvalid\tABC','Only XML-incompatible controls are removed');
const order={id:'qa',number:'SIM-QA',userId:'agent',agentName:'Agent Ștefan',warehouseId:'g',warehouseName:'Gestiune & Test',kind:'sim',status:'finalized',items:[],serials:['89400000000000000001'],client:{id:'c',warehouseId:'g',name:'Client <Test>',cui:'RO1',city:'București',county:'Ilfov',address:'Strada 1'},notes:'Valid <&> Ș\ncontrol:\u0001',createdAt:'2026-09-16T10:00:00Z',finalizedAt:'2026-09-16T10:10:00Z',sourceOrderId:null,revision:2,total:0,pieces:1};
const files=unzipSync(simExport(order));
const xml=strFromU8(files['xl/worksheets/sheet1.xml']);
assert.ok(!xml.includes('\u0001'),'Worksheet XML excludes illegal U+0001');
assert.ok(xml.includes('Client &lt;Test&gt;')&&xml.includes('Gestiune &amp; Test'),'XML markup characters remain escaped');
assert.ok(xml.includes('Ș'),'Unicode and diacritics are preserved');
for(const [raw,label] of [['OLT','Olt'],['Iasi','Iași'],['Municipiul Bucuresti','București'],['SB','Sibiu'],['Unknown raw','Unknown raw']]){const fixture={...order,client:{...order.client,county:raw}},sheet=strFromU8(unzipSync(simExport(fixture))['xl/worksheets/sheet1.xml']);assert(sheet.includes(label));assert.equal(fixture.client.county,raw,'export never rewrites CRM field');}
console.log('PASS: generated export XML removes illegal controls and preserves valid text.');

// A custom source-row sentinel must never become Excel row zero. Overwriting a
// template price must also retire shared-formula followers without an anchor.
const templateFiles=unzipSync(readFileSync('resources/accesorii.xlsx'));
templateFiles['xl/worksheets/sheet1.xml']=strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:L3"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Catalog</t></is></c></row><row r="2"><c r="F2"><f t="shared" ref="F2:F3" si="0">E2*1.21</f><v>42</v></c></row><row r="3"><c r="F3"><f t="shared" si="0"/><v>42</v></c></row></sheetData></worksheet>');
const product={id:'demo-merch',code:'DEMO-MERCH',name:'Material demonstrativ',kind:'stands',category:'Mercantizare Vodafone',brand:'Demo',price:null,netPrice:null,sourceRow:0,quantity:3};
const combined={...order,kind:'combined',items:[],standItems:[product],serials:[],client:null,pieces:3};
const fixture=combinedExport(zipSync(templateFiles),combined,[0,2],[{...product,id:'demo-accessory',kind:'accessories',category:'Demo',sourceRow:2,price:12,netPrice:10}]);
const generated=unzipSync(fixture),first=strFromU8(generated['xl/worksheets/sheet1.xml']);
assert(!/<row[^>]*r="0"/.test(first)&&!/<c[^>]*r="[A-Z]+0"/.test(first));
assert(!first.includes('t="shared"'),'No orphan shared-formula follower survives a price replacement');
assert(/<c r="F3"[^>]*><v>42<\/v><\/c>/.test(first),'Retired-row cached price is preserved');
const workbook=strFromU8(generated['xl/workbook.xml']);
assert(workbook.includes('name="Mercantizare și consumabile"')&&workbook.includes('activeTab="1"'));
assert(strFromU8(generated['xl/worksheets/sheet2.xml']).includes('Material demonstrativ'));
const settings={accessoriesEmail:'orders@example.invalid',standsEmail:'stock@example.invalid',simEmail:'sim@example.invalid',accessoriesCc:[],standsCc:[],simCc:[]};
const mail=mailFor(combined,settings);assert(mail.subject.includes('mercantizare și consumabile')&&!mail.subject.includes('cartele'));assert(mail.body.includes('mercantizare și consumabile'));
const mixed={...combined,items:[{...product,kind:'accessories',category:'Demo'}],standItems:[product,{...product,id:'demo-stand',category:'Standuri'}]};
assert(mailFor(mixed,settings).subject.includes('accesorii + cartele, telefoane & standuri + mercantizare și consumabile'));
const mixedBook=strFromU8(unzipSync(combinedExport(zipSync(templateFiles),mixed,[0,2]))['xl/workbook.xml']);assert(mixedBook.includes('activeTab="0"')&&mixedBook.includes('name="Prepay și mercantizare"'));
const legacy=unzipSync(fixture);legacy['xl/worksheets/sheet1.xml']=strToU8(first.replace('</sheetData>','<row r="0"><c r="A0"><v>1</v></c></row></sheetData>'));legacy['xl/worksheets/sheet2.xml']=strToU8(strFromU8(legacy['xl/worksheets/sheet2.xml']).replace('mobiup-stock-v3','mobiup-stock-v2'));
const repaired=unzipSync(repairOrderExport(zipSync(legacy),combined));assert(!strFromU8(repaired['xl/worksheets/sheet1.xml']).includes('r="0"'));assert(strFromU8(repaired['xl/worksheets/sheet2.xml']).includes('mobiup-stock-v3'));assert(strFromU8(repaired['xl/workbook.xml']).includes('activeTab="1"'));
assert.deepEqual(repairOrderExport(fixture,combined),fixture,'A current valid export needs no repeated repair');
console.log('PASS: custom rows, orphan formulas, merchandising sheets, initial sheet, mixed mail labels and historical download repair.');
