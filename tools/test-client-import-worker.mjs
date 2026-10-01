import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { zipSync, strToU8 } from 'fflate';
import XLSX from 'xlsx';
import { parseClients } from '../lib/import-clients-parser.ts';
import { readClientsNode } from '../lib/client-import-parser-node.ts';
import { readClientsInWorker } from '../lib/client-import-worker-client.ts';

const ns='xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const inline=(ref,value)=>`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
const row=(number,values)=>`<row r="${number}">${values.map((value,index)=>inline(String.fromCharCode(65+index)+number,value)).join('')}</row>`;
function fixture(sheet,extra={}) {
  return zipSync({
    'xl/workbook.xml':strToU8(`<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Other" sheetId="1" r:id="rId1"/><sheet name="Portofóliu" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/unused.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/unused.xml':strToU8(`<worksheet ${ns}><sheetData/></worksheet>`),
    'xl/worksheets/sheet2.xml':strToU8(`<worksheet ${ns}><sheetData>${sheet}</sheetData></worksheet>`),...extra,
  });
}
const headers=['Denumire client','CUI','Localitatea','Județ','Adresă magazin','Nr rută'];
const rows=row(1,['Synthetic title'])+row(2,headers)+row(3,['  Client   Test & Demo ','RO001','  Oraș\n Test ','Județ Test','Strada <Test>','01'])+row(4,['Incomplete','RO2',''])+row(5,['','','']);
const expected={clients:[{name:'Client Test & Demo',cui:'RO001',city:'Oraș Test',county:'Județ Test',address:'Strada <Test>',route:'01'}],warnings:['Rând 4: Incomplete — lipsesc denumire, CUI sau localitate.'],sheet:'Portofóliu'};
assert.deepEqual(parseClients(fixture(rows),'clients.xlsx'),expected);
assert.deepEqual(await readClientsNode(new File([fixture(rows)],'clients.xlsx')),expected);
await assert.rejects(readClientsNode(new File([fixture('<row></wrong>')],'bad.xlsx')),/nu poate fi citit/);
const rich=`<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>123</v></c><c r="C2" t="inlineStr"><is><r><t>New </t></r><r><t>Town</t></r></is></c></row>`;
const shared='<sst '+ns+'><si><r><t xml:space="preserve">Client </t></r><r><t>Test &#x1F600; &amp; <![CDATA[Demo]]></t></r></si></sst>';
const parsedRich=parseClients(fixture(row(1,headers)+rich,{'xl/sharedStrings.xml':strToU8(shared)}),'CLIENTS.XLSX');
assert.equal(parsedRich.clients[0].name,'Client Test 😀 & Demo');assert.equal(parsedRich.clients[0].city,'New Town');assert.equal(parsedRich.clients[0].cui,'123');
for(const bad of ['<row></wrong>','<row r="2" r="3"/>','<row><c t="inlineStr"><is><t>&undefined;</t></is></c></row>','<row><c><v>bad & text</v></c></row>'])assert.throws(()=>parseClients(fixture(row(1,headers)+bad),'bad.xlsx'),/nu poate fi citit/);
assert.throws(()=>parseClients(fixture(row(1,['Denumire','CUI'])+row(2,['Client','1'])),'bad.xlsx'),/Lipsește coloana/);
assert.throws(()=>parseClients(fixture(Array.from({length:15},(_,i)=>row(i+1,['title'])).join('')+row(16,headers)),'bad.xlsx'),/Nu găsesc coloanele/);
assert.throws(()=>parseClients(fixture(row(1,headers)+row(2,['','',''])),'bad.xlsx'),/Nu am găsit clienți/);
assert.throws(()=>parseClients(new Uint8Array(8_000_001),'large.xlsx'),/maximum 8 MB/);
assert.throws(()=>parseClients(new Uint8Array(),'bad.xls'),/maximum 8 MB/);
assert.throws(()=>parseClients(fixture(rows,{'oversize.bin':new Uint8Array(15_000_001)}),'large.xlsx'),/după decomprimare/);
assert.throws(()=>parseClients(fixture(rows,Object.fromEntries([1,2,3].map(n=>[`total-${n}.bin`,new Uint8Array(14_000_000)]))),'large.xlsx'),/după decomprimare/);
const tooMany=row(1,headers)+Array.from({length:3001},(_,i)=>row(i+2,[`Test ${i}`,`RO${i}`,'Test City'])).join('')+'<malformed';
assert.throws(()=>parseClients(fixture(tooMany),'large.xlsx'),/3.000 de clienți/,'Row limit stops parsing before trailing malformed XML');
const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,...Array.from({length:3000},(_,i)=>[`Synthetic ${i}`,`RO${i}`,'Test City','Test County','Test Street','01'])]),'Portofoliu');
const file=new File([XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true})],'synthetic.xlsx');
let ticks=0;const timer=setInterval(()=>ticks++,5);const start=performance.now();
const result=await readClientsNode(file);const elapsed=performance.now()-start;clearInterval(timer);
assert.equal(result.clients.length,3000);assert.ok(ticks>=3,`Main event loop remains responsive: ${ticks} ticks`);
const abort=new AbortController();const job=readClientsNode(file,abort.signal);abort.abort();await assert.rejects(job,{name:'AbortError'});
let created=0;await assert.rejects(readClientsInWorker(file,()=>{created++;throw Error('Should not start');},abort.signal),{name:'AbortError'});assert.equal(created,0);
let terminated=0,lateMessage;const controller=new AbortController();
const fake={onmessage:null,onerror:null,onmessageerror:null,terminate(){terminated++;},postMessage(){lateMessage=this.onmessage;}};
const pending=readClientsInWorker(file,()=>fake,controller.signal);controller.abort();lateMessage({data:{ok:true,result:expected}});await assert.rejects(pending,{name:'AbortError'});assert.equal(terminated,1);assert.equal(fake.onmessage,null);
const fakeError={...fake,terminate(){terminated++;},postMessage(){this.onerror({message:'Worker failed'});}};
await assert.rejects(readClientsInWorker(file,()=>fakeError),/Worker failed/);assert.equal(terminated,2);
const fakeBadMessage={...fake,terminate(){terminated++;},postMessage(){this.onmessageerror({});}};
await assert.rejects(readClientsInWorker(file,()=>fakeBadMessage),/nu poate fi citit/);assert.equal(terminated,3);
console.log(JSON.stringify({pass:true,syntheticRows:3000,workerElapsedMs:Math.round(elapsed),mainLoopTicks:ticks,tests:'inline/shared strings, rich text, entities/CDATA/namespaces, aliases/whitespace/warnings, invalid XML, header selection, 8/15/40 MB limits, early 3000 limit, worker cancellation/stale/error cleanup'}));
