import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import XLSX from 'xlsx';

const qa = resolve('work/sales-qa');
rmSync(qa, { recursive: true, force: true });
mkdirSync(qa, { recursive: true });
const parserPath = resolve(qa, 'sales-file.mjs');
const storePath = resolve(qa, 'sales-store.mjs');
await build({ entryPoints: ['lib/sales-file.ts'], outfile: parserPath, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
await build({ entryPoints: ['lib/sales-store.ts'], outfile: storePath, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { parseSalesFile, salesHash } = await import(pathToFileURL(parserPath));
process.env.MOBIUP_DATA_DIR = qa;
const { getSalesView, importSalesRows, saveSalesOriginal } = await import(pathToFileURL(storePath));

const columns = ['Data', 'SiteCode', 'ItemCode', 'ItemName', 'Cantitate', 'Brand', 'Pret', 'Valoare', 'Locatie', 'Firma', 'ASM', 'Regional', 'Nr', 'Categorie', 'SubCategorie', 'Agent'];
const rows = [
  ['08.09.2026', 'A001', 'P1', 'Produs 1', 2, 'Brand', 10.5, 21, 'Gestiune TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '1', 'Cat', 'Sub', 'DAVIDD'],
  ['08.09.2026', 'A001', 'P1', 'Produs 1', -1, 'Brand', 10.5, -10.5, 'TR DAVIDD', 'MobiCell', 'ASM', 'Regional', '2', 'Cat', 'Sub', 'DAVIDD'],
  ['09.09.2026', 'A002', 'P2', 'Produs 2', 1, 'Other', 5, 5, 'Bucuresti', 'MobiUp', 'ASM', 'Regional', '3', 'Cat2', 'Sub2', 'AGENT2'],
];
const fixture = values => { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...values]), 'Raport'); return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }); };
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const bytes = fixture(rows);
const parsed = parseSalesFile(bytes, 'vanzari.xlsx');
check(parsed.length === 2, 'Only standalone TR locations are imported');
check(parsed[1].quantity === -1 && parsed[1].valueCents === -1050, 'Signed return and decimal currency are preserved');
check(parseSalesFile(fixture([rows[0], rows[0]]), 'duplicate.xlsx').length === 2, 'Duplicate source lines retain multiplicity');
const sparseBook=XLSX.utils.book_new(),sparseSheet=XLSX.utils.aoa_to_sheet([columns,rows[0]]);
sparseSheet.XFD500={t:'s',v:'noise'};sparseSheet['!ref']='A1:XFD500';XLSX.utils.book_append_sheet(sparseBook,sparseSheet,'Raport');
const sparseBytes=XLSX.write(sparseBook,{type:'buffer',bookType:'xlsx'}),sparseStarted=performance.now();
check(parseSalesFile(sparseBytes,'sparse-wide.xlsx').length===1&&performance.now()-sparseStarted<2000,'Sparse far-right Excel cells do not expand sales parser work');
assert.throws(() => parseSalesFile(fixture([['08.09.2026', 'A', 'P', 'P', 1, '', 1, 1, 'TR', '', '', '', '', '', '', ''], ['09.10.2026', 'A', 'P', 'P', 1, '', 1, 1, 'TR', '', '', '', '', '', '', '']]), 'mixed.xlsx'), /o singură lună/); checks++;
assert.throws(() => parseSalesFile(fixture([rows[2]]), 'empty.xlsx'), /nu conține rânduri/); checks++;
const hash = salesHash(bytes);
const original = await saveSalesOriginal(hash, 'vanzari.xlsx', bytes);
check(original === `sales-imports/${hash}.xlsx` && existsSync(resolve(qa, original)), 'Original source is stored under relative immutable audit path');
const first = importSalesRows({ rows: parsed, month: '2026-09', fileHash: hash, filename: 'vanzari.xlsx', importedBy: 'qa-manager', originalPath: original, expectedRevision: 0, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false });
check(first.revision === 1, 'First month import increments revision');
let view = getSalesView('2026-09');
check(view.summary.rows === 2 && view.summary.quantity === 1 && view.summary.value === 10.5, 'Summary uses signed quantities and exact cents');
const replacement = parseSalesFile(fixture([rows[0]]), 'replacement.xlsx');
const replacementHash = salesHash(fixture([rows[0]]));
const replacementOriginal = await saveSalesOriginal(replacementHash, 'replacement.xlsx', fixture([rows[0]]));
assert.throws(() => importSalesRows({ rows: replacement, month: '2026-09', fileHash: replacementHash, filename: 'replacement.xlsx', importedBy: 'qa-manager', originalPath: replacementOriginal, expectedRevision: 1, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false }), /REGRESSION_ACK/); checks++;
const second = importSalesRows({ rows: replacement, month: '2026-09', fileHash: replacementHash, filename: 'replacement.xlsx', importedBy: 'qa-manager', originalPath: replacementOriginal, expectedRevision: 1, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false, regressionAcknowledged: true });
view = getSalesView('2026-09');
check(second.revision === 2 && view.summary.rows === 1 && view.summary.value === 21, 'Same month replacement requires acknowledgement and removes previous rows');
const repeat = importSalesRows({ rows: replacement, month: '2026-09', fileHash: replacementHash, filename: 'replacement.xlsx', importedBy: 'qa-manager', originalPath: replacementOriginal, expectedRevision: 2, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false });
check(repeat.idempotent === true && repeat.revision === 2, 'Identical file import is idempotent');
const regressionBytes = fixture([['07.09.2026', 'A001', 'P1', 'Produs 1', 1, 'Brand', 10.5, 10.5, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '4', 'Cat', 'Sub', 'DAVIDD']]);
const regressionRows = parseSalesFile(regressionBytes, 'regression.xlsx');
const regressionHash = salesHash(regressionBytes);
const regressionOriginal = await saveSalesOriginal(regressionHash, 'regression.xlsx', regressionBytes);
assert.throws(() => importSalesRows({ rows: regressionRows, month: '2026-09', fileHash: regressionHash, filename: 'regression.xlsx', importedBy: 'qa-manager', originalPath: regressionOriginal, expectedRevision: 2, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false }), /REGRESSION_ACK/); checks++;
const regression = importSalesRows({ rows: regressionRows, month: '2026-09', fileHash: regressionHash, filename: 'regression.xlsx', importedBy: 'qa-manager', originalPath: regressionOriginal, expectedRevision: 2, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false, regressionAcknowledged: true });
check(regression.revision === 3, 'Coverage regression requires explicit acknowledgement');
assert.throws(() => importSalesRows({ rows: parsed, month: '2026-09', fileHash: hash, filename: 'vanzari.xlsx', importedBy: 'qa-manager', originalPath: original, expectedRevision: 1, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false }), /STALE_REVISION/); checks++;
assert.throws(() => importSalesRows({ rows: parsed, month: '2026-09', fileHash: hash, filename: 'vanzari.xlsx', importedBy: 'qa-manager', originalPath: original, expectedRevision: 3, expectedMappingHash: 'map-1', currentMappingHash: 'map-2', historicalAcknowledged: false }), /STALE_MAPPING/); checks++;
const segmentBytes = fixture([
  ['01.10.2026', 'A001', 'CARD', 'Cartela prepaid', 2, 'Telco', 10, 20, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '5', 'Cartele', 'Cartela', 'DAVIDD'],
  ['01.10.2026', 'A001', 'SIM', 'SIM Vodafone', 3, 'Telco', 2, 6, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '6', 'SIM', 'SIM', 'DAVIDD'],
  ['01.10.2026', 'A001', 'PHONE', 'Telefon test', 1, 'Brand', 100, 100, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '7', 'Telefoane', 'Telefon', 'DAVIDD'],
  ['01.10.2026', 'A001', 'VOUCHER', 'Voucher valoric', 4, 'Telco', 1.5, 6, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '8', 'Cartele', 'Voucher', 'DAVIDD'],
  ['01.10.2026', 'A001', 'BUNDLE', 'Pachet telefon SIM', 2, 'Telco', 100, 200, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '9', 'Cartele', 'Pachet', 'DAVIDD'],
  ['01.10.2026', 'A001', 'ACC', 'Husa protectie', 1, 'Brand', 15, 15, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '10', 'Accesorii', 'Huse', 'DAVIDD'],
  ['01.10.2026', 'A001', 'UNKNOWN', 'Produs necunoscut ZZZ', 1, 'Brand', 9, 9, 'TR DAVIDD', 'MobiUp', 'ASM', 'Regional', '11', '', '', 'DAVIDD'],
]);
const segmentRows = parseSalesFile(segmentBytes, 'segments.xlsx');
const segmentHash = salesHash(segmentBytes);
const segmentOriginal = await saveSalesOriginal(segmentHash, 'segments.xlsx', segmentBytes);
importSalesRows({ rows: segmentRows, month: '2026-10', fileHash: segmentHash, filename: 'segments.xlsx', importedBy: 'qa-manager', originalPath: segmentOriginal, expectedRevision: 3, expectedMappingHash: 'map-1', currentMappingHash: 'map-1', historicalAcknowledged: false });
const segmentView = getSalesView('2026-10', undefined, '2026-09', '2026-10');
check(segmentView.segments.cardsSim.summary.quantity === 9 && segmentView.segments.cardsSim.subsegments.sim.quantity === 3 && segmentView.segments.cardsSim.subsegments.cards.quantity === 2 && segmentView.segments.cardsSim.subsegments.valueVouchers.value === 6, 'Cards, SIM and value vouchers breakdown is separated');
check(segmentView.segments.phones.summary.value === 300 && segmentView.segments.phones.summary.quantity === 3 && segmentView.segments.accessories.summary.rows === 1 && segmentView.segments.accessories.summary.value === 15, 'Phones and accessories segments are separated');
check(segmentView.segments.unclassified.summary.rows === 1 && segmentView.segments.unclassified.summary.value === 9 && segmentView.products.find(product=>product.itemCode==='UNKNOWN')?.segment === 'unclassified', 'Ambiguous products stay in totals but are exposed as unclassified');
check(segmentView.monthly.length === 2 && segmentView.monthly.find(item => item.month === '2026-10')?.segments.phones.rows === 2, 'Monthly evolution covers selected interval and segments');
console.log(`PASS: ${checks} sales parser, replacement, audit and CAS checks.`);
