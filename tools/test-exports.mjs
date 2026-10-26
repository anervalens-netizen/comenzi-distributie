import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const qa=resolve('work/export-qa');rmSync(qa,{recursive:true,force:true});mkdirSync(qa,{recursive:true});
const output=resolve(qa,'exports.mjs');
await build({entryPoints:['lib/exports.ts'],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external'});
const {simExport,xmlSafeText,templateExport,combinedExport,repairOrderExport,mailFor}=await import(pathToFileURL(output));
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
const catalogProduct={...product,id:'demo-accessory',kind:'accessories',category:'Demo',sourceRow:2,price:12,netPrice:10};
const oldAccessory=unzipSync(templateExport(zipSync(templateFiles),{...combined,kind:'accessories'},[0,2],[catalogProduct]));
const legacyFirst=strFromU8(oldAccessory['xl/worksheets/sheet1.xml']);
assert(!/<row[^>]*r="0"/.test(legacyFirst)&&!legacyFirst.includes('t="shared"'));
assert(/<c r="F3"[^>]*><v>42<\/v><\/c>/.test(legacyFirst),'Orphan cleanup preserves cached retired-row price');
const fixture=combinedExport(zipSync(templateFiles),combined,[0,2],[catalogProduct]);
const generated=unzipSync(fixture),first=strFromU8(generated['xl/worksheets/sheet1.xml']),workbook=strFromU8(generated['xl/workbook.xml']);
assert.equal(Object.keys(generated).filter(k=>/^xl\/worksheets\/sheet\d+\.xml$/.test(k)).length,1);
assert(workbook.includes('name="Mercantizare și consumabile"')&&workbook.includes('activeTab="0"'));
assert(first.includes('Material demonstrativ')&&!first.includes('Catalog')&&!first.includes('t="shared"')&&!first.includes('r="0"'));
assert(first.includes('<autoFilter ref="A7:D8">')&&first.includes('<customFilter operator="greaterThan" val="0"/>'));
const settings={accessoriesEmail:'orders@example.invalid',standsEmail:'stock@example.invalid',simEmail:'sim@example.invalid',accessoriesCc:[],standsCc:[],simCc:[]};
const mail=mailFor(combined,settings);assert(mail.subject.startsWith('Comandă mercantizare și consumabile |'));assert(mail.body.includes('Mercantizare și consumabile: 3 buc.'));assert(!mail.body.includes(product.name));
const mixed={...combined,items:[{...catalogProduct,quantity:2},{...catalogProduct,id:'zero',name:'UNSELECTED_ZERO',quantity:0}],standItems:[product,{...product,id:'demo-stand',category:'Standuri',quantity:7}]};
const mixedMail=mailFor(mixed,settings);assert(mixedMail.subject.startsWith('Comandă mixtă |'));for(const phrase of ['Accesorii: 2 buc.','Cartele, telefoane și standuri: 7 buc.','Mercantizare și consumabile: 3 buc.'])assert(mixedMail.body.includes(phrase));assert(mixedMail.body.length<500);
const mixedFiles=unzipSync(combinedExport(zipSync(templateFiles),mixed,[0,2]));const mixedBook=strFromU8(mixedFiles['xl/workbook.xml']);
assert.equal([...mixedBook.matchAll(/<sheet name=/g)].length,3);
for(const name of ['Accesorii','Cartele, telefoane &amp; standuri','Mercantizare și consumabile'])assert(mixedBook.includes(`name="${name}"`));
for(const [,bytes] of Object.entries(mixedFiles).filter(([n])=>n.startsWith('xl/worksheets/sheet'))){const x=strFromU8(bytes);assert(x.includes('<autoFilter ')&&x.includes('operator="greaterThan" val="0"'));assert(!x.includes('UNSELECTED_ZERO'));assert(!x.includes('Poza'));assert(!x.includes('STOC DEPOZIT'));}
assert(strFromU8(mixedFiles['xl/worksheets/sheet1.xml']).includes('<f>D8*F8</f><v>24</v>'));
const legacy=unzipSync(fixture);legacy['xl/workbook.xml']=strToU8(workbook.replace('mobiup-order-v4','old-format'));legacy['xl/worksheets/sheet1.xml']=templateFiles['xl/worksheets/sheet1.xml'];
const repaired=unzipSync(repairOrderExport(zipSync(legacy),combined));assert(strFromU8(repaired['xl/workbook.xml']).includes('mobiup-order-v4'));assert(strFromU8(repaired['xl/worksheets/sheet1.xml']).includes('Material demonstrativ'));assert(!strFromU8(repaired['xl/worksheets/sheet1.xml']).includes('t="shared"'));
assert.deepEqual(repairOrderExport(fixture,combined),fixture,'Current selected-products workbook is not repeatedly rebuilt');
console.log('PASS: legacy cleanup; selected products only; one to three sheets; quantity filters; prices; concise single/mixed mail; historical download migration.');
