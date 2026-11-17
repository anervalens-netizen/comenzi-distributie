import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { encode } from 'jpeg-js';
import { decodePDFRawStream, PDFDocument, PDFName, PDFRawStream, PageSizes } from 'pdf-lib';
import { holidays, leaveDays, parseDay } from '../lib/leave-calendar.ts';
import { generateLeavePdf, scanToPdf } from '../lib/leave-pdf.ts';

function assertExcluded(year, calendar, dates) {
  const excluded = holidays(year, calendar);
  for (const date of dates) assert(excluded.has(date), calendar + ' ' + date);
}

assertExcluded(2025, 'orthodox', ['2025-04-18', '2025-04-20', '2025-04-21', '2025-06-08', '2025-06-09']);
assertExcluded(2026, 'orthodox', ['2026-01-06', '2026-01-07', '2026-04-10', '2026-04-12', '2026-04-13', '2026-05-31', '2026-06-01']);
assertExcluded(2026, 'western', ['2026-04-03', '2026-04-05', '2026-04-06', '2026-05-24', '2026-05-25']);
assertExcluded(2027, 'orthodox', ['2027-04-30', '2027-05-02', '2027-05-03', '2027-06-20', '2027-06-21']);
assert.equal(holidays(2026, 'orthodox').has('2026-04-06'), false);
assert.equal(holidays(2026, 'western').has('2026-04-13'), false);
assert.equal(parseDay('2028-02-29').toISOString(), '2028-02-29T00:00:00.000Z');
for (const value of ['2026-02-29', '2100-02-29', '2028-02-30', '2026-4-10', '2026-04-10x', '2024-12-31', '2101-01-01']) {
  assert.throws(() => parseDay(value), value);
}
assert.equal(parseDay('2100-12-31').getUTCFullYear(), 2100);
assert.throws(() => leaveDays('2026-04-13', '2026-04-10'), /în ordine/);
assert.throws(() => leaveDays('2025-01-01', '2026-01-03'), /maximum/);
assert.throws(() => leaveDays('2026-04-10', '2026-04-13'), /zile lucrătoare/);
assert.deepEqual(leaveDays('2026-04-09', '2026-04-14'), {
  days: 2,
  workingDates: ['2026-04-09', '2026-04-14'],
  excludedDates: ['2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13'],
});
assert.deepEqual(leaveDays('2026-12-24', '2027-01-08', 'orthodox', ['2026-12-31']), {
  days: 7,
  workingDates: ['2026-12-24', '2026-12-28', '2026-12-29', '2026-12-30', '2027-01-04', '2027-01-05', '2027-01-08'],
  excludedDates: ['2026-12-25', '2026-12-26', '2026-12-27', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-06', '2027-01-07'],
});

const threeYears = leaveDays('2025-12-31', '2027-01-01');
assert.equal(threeYears.days, 251);
assert.equal(threeYears.workingDates[0], '2025-12-31');
for (const date of ['2026-01-01', '2026-04-10', '2026-04-13', '2026-11-30', '2026-12-25', '2027-01-01']) {
  assert(threeYears.excludedDates.includes(date), date);
}

const record = {
  id: '00000000-0000-4000-8000-000000000001',
  agentId: 'synthetic-agent',
  approverId: 'synthetic-manager',
  startDate: '2026-04-09',
  endDate: '2026-04-14',
  days: 2,
  status: 'draft',
  snapshot: {
    legalName: 'Agent Încercare Șță',
    employer: 'Compania Exemplu SRL',
    approverName: 'Manager de test',
    approverEmail: 'manager@example.test',
    to: 'concediu@example.test',
    workingDates: ['2026-04-09', '2026-04-14'],
    excludedDates: ['2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13'],
    calendar: 'orthodox',
    profileRevision: 1,
  },
  signedAt: null,
  submittedAt: null,
  decisionNote: '',
  createdAt: '2026-04-07T22:29:00.000Z',
  updatedAt: '2026-04-07T22:29:00.000Z',
  revision: 1,
  canDecide: false,
};
const signature = [[
  { x: 0.15, y: 0.73 }, { x: 0.28, y: 0.22 }, { x: 0.36, y: 0.75 },
  { x: 0.46, y: 0.31 }, { x: 0.54, y: 0.75 }, { x: 0.83, y: 0.49 },
]];
const submitted = { ...record, status: 'submitted', signedAt: '2026-04-08T07:00:00.000Z', revision: 2 };
const signed = await generateLeavePdf(submitted, signature);
const unsigned = await generateLeavePdf(record, null);
assert.notDeepEqual(signed, unsigned);
assert.deepEqual(signed, await generateLeavePdf({ ...submitted, status: 'approved', revision: 3 }, signature));

async function pageOperators(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPage(0).node.Contents().lookup(0, PDFRawStream);
  return Buffer.from(decodePDFRawStream(contents).decode()).toString('ascii');
}

const countLines = operators => operators.split('\n').filter(line => line.endsWith(' l')).length;
assert.equal(countLines(await pageOperators(unsigned)), 3);
assert.equal(countLines(await pageOperators(signed)), 3 + signature[0].length - 1);

function pngChunk(type, payload) {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4, 'ascii');
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

function pngFixture(width, height, extraChunks = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...extraChunks,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 33, 100, 155, 255, 100, 180, 20, 128]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgba = Buffer.alloc(40 * 60 * 4, 255);
for (let row = 0; row < 60; row++) {
  for (let col = 0; col < 40; col++) {
    const offset = 4 * (row * 40 + col);
    rgba[offset] = row * 4;
    rgba[offset + 1] = col * 6;
    rgba[offset + 2] = 123;
  }
}
const jpeg = encode({ width: 40, height: 60, data: rgba }, 90).data;
const png = pngFixture(2, 1);
const jpegPdf = await scanToPdf(jpeg, 'image/jpeg');
const pngPdf = await scanToPdf(png, 'image/png');
for (const [name, bytes] of Object.entries({ signed, unsigned, jpeg: jpegPdf, png: pngPdf })) {
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1, name);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: PageSizes.A4[0], height: PageSizes.A4[1] }, name);
  assert.equal(pdf.catalog.has(PDFName.of('OpenAction')), false);
  assert.equal(pdf.catalog.has(PDFName.of('AcroForm')), false);
  if (process.argv[2]) writeFileSync(join(process.argv[2], name + '.pdf'), bytes);
}

function withOrientation(bytes, orientation, littleEndian) {
  const exif = Buffer.alloc(36);
  exif.writeUInt16BE(0xffe1, 0);
  exif.writeUInt16BE(exif.length - 2, 2);
  exif.write('Exif', 4, 'ascii');
  const tiff = new DataView(exif.buffer, exif.byteOffset + 10, exif.length - 10);
  tiff.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
  tiff.setUint16(2, 42, littleEndian);
  tiff.setUint32(4, 8, littleEndian);
  tiff.setUint16(8, 1, littleEndian);
  tiff.setUint16(10, 0x0112, littleEndian);
  tiff.setUint16(12, 3, littleEndian);
  tiff.setUint32(14, 1, littleEndian);
  tiff.setUint16(18, orientation, littleEndian);
  return Buffer.concat([bytes.subarray(0, 2), exif, bytes.subarray(2)]);
}

const orientationCases = [
  [1, '1 0 0 1'], [2, '-1 0 0 1'], [3, '-1 0 0 -1'], [4, '1 0 0 -1'],
  [5, '0 -1 -1 0'], [6, '0 -1 1 0'], [7, '0 1 1 0'], [8, '0 1 -1 0'], [9, '1 0 0 1'],
];
for (const [orientation, matrix] of orientationCases) {
  const bytes = await scanToPdf(withOrientation(jpeg, orientation, orientation % 2 === 0), 'image/jpeg');
  const operators = await pageOperators(bytes);
  assert(operators.startsWith('q\n' + matrix + ' '), 'Exif orientation ' + orientation);
  if (process.argv[2] && orientation === 6) writeFileSync(join(process.argv[2], 'jpeg-rotated.pdf'), bytes);
}

const malformedPng = Buffer.from(png);
malformedPng[29] ^= 1;
const invalidScan = /JPEG sau PNG/;
await assert.rejects(() => scanToPdf(png, 'image/jpeg'), invalidScan);
await assert.rejects(() => scanToPdf(jpeg, 'image/png'), invalidScan);
await assert.rejects(() => scanToPdf(unsigned, 'application/pdf'), invalidScan);
await assert.rejects(() => scanToPdf(Buffer.alloc(4_000_001), 'image/jpeg'), invalidScan);
await assert.rejects(() => scanToPdf(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'), invalidScan);
await assert.rejects(() => scanToPdf(pngFixture(8000, 8000), 'image/png'), invalidScan);
await assert.rejects(() => scanToPdf(pngFixture(1, 1), 'image/png'), invalidScan);
await assert.rejects(() => scanToPdf(pngFixture(2, 1, [pngChunk('acTL', Buffer.alloc(8))]), 'image/png'), invalidScan);
await assert.rejects(() => scanToPdf(malformedPng, 'image/png'), invalidScan);
console.log('Leave calendar, signed and draft PDF, and bounded scan cases passed.');
