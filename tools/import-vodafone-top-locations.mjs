import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import XLSX from 'xlsx';
import { parseVodafoneTopLocations } from '../lib/vodafone-top-locations-schema.ts';

const { values } = parseArgs({
  options: {
    workbook: { type: 'string' },
    sheet: { type: 'string' },
    month: { type: 'string' },
    output: { type: 'string' },
    previous: { type: 'string' },
    'point-column': { type: 'string', default: 'Cod_Franciza' },
    'target-column': { type: 'string', default: 'Target' },
    'bonus-units-column': { type: 'string' },
  },
});

const header = cell => String(cell ?? '').normalize('NFD').replace(/\p{M}/gu, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const wholeUnits = value => typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;

const countUnit = /\b(?:SIM(?:URI)?|VOUCHER(?:E|S)?|BUC(?:ATA|ATI)?|UNIT(?:ATE|ATI|S)?)\b/;
const moneyOrRate = /\b(?:LEU|LEI|RON|EUR|EURO|USD|DOLARI|GBP|BANI|PRET|SUMA|VALOARE|VALORIC[A-Z]*|PROCENT[A-Z]*|PERCENT[A-Z]*|PRICE|AMOUNT|VALUE|CASH)\b/;

function verifyBonusUnits(worksheet, bounds, column, label) {
  // A card's denomination can be part of the product name.
  const name = header(label).replace(/\b((?:SIM|VOUCHER)(?:URI|E|S)?) (?:DE )?\d+ (?:EUR|EURO)\b/g, '$1');
  if (!countUnit.test(name) || moneyOrRate.test(name) || /[\p{Sc}%]/u.test(String(label)))
    throw new Error('Bonus units require a column labelled in SIM cards, vouchers or pieces');
  for (let row = bounds.s.r + 1; row <= bounds.e.r; row++) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: bounds.s.c + column })];
    if (!cell || cell.v == null) continue;
    const format = String(cell.z || '').replace(/\[\$-[^\]]+\]/g, ''); // locale-only marker
    if (/[\p{Sc}%]/u.test(format) || moneyOrRate.test(header(format)) || XLSX.SSF.is_date(format))
      throw new Error('Bonus units cannot be read from currency, percentage or date cells');
  }
}

try {
  const { workbook, sheet, month, output, previous } = values;
  if (!workbook || !sheet || !month || !output || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error('Use --workbook FILE --sheet NAME --month YYYY-MM --output NEW_JSON [--previous JSON]');
  if (statSync(workbook).size > 12 * 1024 * 1024) throw new Error('Workbook exceeds 12 MiB');
  const input = readFileSync(workbook);
  const book = XLSX.read(input, { type: 'buffer', sheets: [sheet], cellNF: true });
  const worksheet = book.Sheets[sheet];
  if (!worksheet || !worksheet['!ref']) throw new Error('Specified worksheet is empty or missing');
  const bounds = XLSX.utils.decode_range(worksheet['!ref']);
  if (bounds.e.r > 100_000 || bounds.e.c > 150) throw new Error('Worksheet is too large');
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false });
  const required = [values['point-column'], values['target-column'], values['bonus-units-column']].filter(Boolean).map(header);
  if (new Set(required).size !== required.length) throw new Error('Point, target and bonus require distinct columns');
  const headers = rows[0].map(header);
  const positions = required.map(name => {
    if (headers.filter(value => value === name).length !== 1)
      throw new Error('Each configured column must occur exactly once in the first row');
    return headers.indexOf(name);
  });
  const [pointColumn, targetColumn, bonusColumn] = positions;
  if (bonusColumn !== undefined) verifyBonusUnits(worksheet, bounds, bonusColumn, rows[0][bonusColumn]);
  const campaigns = rows.slice(1).flatMap(row => {
    const pointCode = row[pointColumn], target = row[targetColumn], bonus = row[bonusColumn];
    if (pointCode === undefined && target === undefined && bonus === undefined) return [];
    return [{ month, pointCode, target: wholeUnits(target), bonus: wholeUnits(bonus) ?? null }];
  });
  if (!campaigns.length) throw new Error('The worksheet contains no work points');
  const existing = previous ? JSON.parse(readFileSync(previous, 'utf8')) : { version: 1, rows: [] };
  const newRows = parseVodafoneTopLocations({
    version: 1,
    rows: [...parseVodafoneTopLocations(existing).filter(row => row.month !== month), ...campaigns],
  });
  const sources = { ...existing.sources, [month]: { sha256: createHash('sha256').update(input).digest('hex'), rowCount: campaigns.length, targetColumn: rows[0][targetColumn],
    ...(bonusColumn === undefined ? {} : { bonusColumn: rows[0][bonusColumn], bonusUnit: 'pieces' }) } };
  writeFileSync(output, JSON.stringify({ version: 1, sources, rows: newRows }) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Prepared ${campaigns.length} work points for ${month}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cannot prepare Vodafone Top Locations snapshot');
  process.exitCode = 1;
}
