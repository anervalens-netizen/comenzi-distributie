import * as XLSX from 'xlsx';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import type { SalesRow } from './sales-types';

export const SALES_FILE_LIMIT = 8_000_000;
export const SALES_ROW_LIMIT = 50_000;
export const SALES_SOURCE_ROW_LIMIT = 150_000;
export const salesHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const salesName = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const headers = ['DATA', 'SITECODE', 'ITEMCODE', 'ITEMNAME', 'CANTITATE', 'BRAND', 'PRET', 'VALOARE', 'LOCATIE', 'FIRMA', 'ASM', 'REGIONAL', 'NR', 'CATEGORIE', 'SUBCATEGORIE', 'AGENT'];

function text(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function numberValue(value: unknown, label: string, row: number) {
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000) return value;
  const raw = text(value).replace(/\s/g, '');
  if (!raw) throw new Error(`Rândul ${row}: ${label} este obligatoriu.`);
  const normalized = raw.includes('.') && raw.includes(',')
    ? (raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''))
    : raw.replace(',', '.');
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(normalized)) throw new Error(`Rândul ${row}: ${label} este invalid.`);
  const result = Number(normalized);
  if (!Number.isFinite(result) || Math.abs(result) > 1_000_000_000) throw new Error(`Rândul ${row}: ${label} este invalid.`);
  return result;
}

function cents(value: unknown, label: string, row: number) {
  // SheetJS may expose an Excel decimal with a trailing binary rounding error.
  const valueNumber = numberValue(value, label, row);
  const result = Math.round((valueNumber + (valueNumber >= 0 ? 1e-8 : -1e-8)) * 100);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 100_000_000_000) throw new Error(`Rândul ${row}: ${label} este invalid.`);
  return result;
}

function dateValue(value: unknown, row: number) {
  let year = 0, month = 0, day = 0;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    year = value.getFullYear(); month = value.getMonth() + 1; day = value.getDate();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) { year = parsed.y; month = parsed.m; day = parsed.d; }
  } else {
    const raw = text(value);
    let match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(raw);
    if (match) { day = Number(match[1]); month = Number(match[2]); year = Number(match[3]); }
    else if ((match = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(raw))) { year = Number(match[1]); month = Number(match[2]); day = Number(match[3]); }
  }
  const iso = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (!year || Number.isNaN(check.getTime()) || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) throw new Error(`Rândul ${row}: data este invalidă.`);
  return iso;
}

export function parseSalesFile(bytes: Uint8Array, filename: string): SalesRow[] {
  if (!/\.(xls|xlsx)$/i.test(filename) || !bytes.length || bytes.length > SALES_FILE_LIMIT) throw new Error('Încarcă un fișier .xls sau .xlsx de maximum 8 MB.');
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!ole && !zip) throw new Error('Fișierul nu este un registru Excel .xls sau .xlsx valid.');
  if (zip) {
    let total = 0;
    unzipSync(bytes, { filter: file => { total += file.originalSize; if (total > 120_000_000 || file.originalSize > 100_000_000) throw new Error('Fișierul Excel este prea mare după decomprimare.'); return false; } });
  }
  const book = XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false, cellDates: true, sheetRows: SALES_SOURCE_ROW_LIMIT + 2 });
  if (!book.SheetNames.length) throw new Error('Fișierul Excel nu conține foi.');
  const matchingSheets = book.SheetNames.filter(name => {
    const sheet = book.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true, range: { s: { r: 0, c: 0 }, e: { r: 14, c: Math.min(100, (sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).e.c : 100)) } } });
    return rows.some(row => headers.every(header => row.some(cell => salesName(String(cell)) === header)));
  });
  if (matchingSheets.length === 0) throw new Error('Lipsesc coloanele obligatorii din raportul de vânzări.');
  if (matchingSheets.length > 1) throw new Error('Raportul conține mai multe foi cu antet de vânzări. Păstrează o singură foaie pentru import.');
  const sheetName = matchingSheets[0];
  const sheet = book.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
  if (range.e.r >= SALES_SOURCE_ROW_LIMIT + 1) throw new Error('Fișierul conține prea multe rânduri.');
  const preview = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true, range: { s: { r: 0, c: 0 }, e: { r: Math.min(14, range.e.r), c: Math.min(100, range.e.c) } } });
  const headerIndex = preview.findIndex(row => headers.every(name => row.some(cell => salesName(String(cell)) === name)));
  if (headerIndex < 0) throw new Error('Lipsesc coloanele obligatorii din raportul de vânzări.');
  const header = preview[headerIndex].map(cell => salesName(String(cell)));
  if (headers.some(name => header.filter(cell => cell === name).length !== 1)) throw new Error('Antetul conține coloane duplicate sau lipsă.');
  const cols = headers.map(name => header.indexOf(name));
  const maxRequiredColumn = Math.max(...cols);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true, range: { s: { r: 0, c: 0 }, e: { r: Math.min(range.e.r, SALES_SOURCE_ROW_LIMIT), c: maxRequiredColumn } } });
  const result: SalesRow[] = [];
  const months = new Set<string>();
  const trToken = /(^|[^A-Z0-9])TR(?=$|[^A-Z0-9])/i;
  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.every(cell => cell === '' || cell === null || cell === undefined)) continue;
    const [dateRaw, siteRaw, codeRaw, nameRaw, quantityRaw, brandRaw, priceRaw, valueRaw, locationRaw, companyRaw, asmRaw, regionalRaw, numberRaw, categoryRaw, subCategoryRaw, agentRaw] = cols.map(col => row[col]);
    const location = text(locationRaw);
    if (!trToken.test(salesName(location))) continue;
    const sourceRow = index + 1;
    const date = dateValue(dateRaw, sourceRow);
    const siteCode = text(siteRaw);
    const itemCode = text(codeRaw);
    const itemName = text(nameRaw);
    if (!siteCode || !itemCode || !itemName) throw new Error(`Rândul ${sourceRow}: SiteCode, ItemCode și ItemName sunt obligatorii.`);
    if ([siteCode, itemCode, itemName, location].some(value => value.length > 500)) throw new Error(`Rândul ${sourceRow}: un câmp text depășește limita permisă.`);
    const quantity = numberValue(quantityRaw, 'Cantitate', sourceRow);
    const month = date.slice(0, 7);
    months.add(month);
    result.push({ rowNumber: sourceRow, date, month, siteCode, itemCode, itemName, quantity, brand: text(brandRaw), priceCents: cents(priceRaw, 'Pret', sourceRow), valueCents: cents(valueRaw, 'Valoare', sourceRow), location, company: text(companyRaw), asm: text(asmRaw), regional: text(regionalRaw), orderNumber: text(numberRaw), category: text(categoryRaw), subCategory: text(subCategoryRaw), agent: text(agentRaw) });
    if (result.length > SALES_ROW_LIMIT) throw new Error('Importul acceptă maximum 50.000 de rânduri.');
  }
  if (!result.length) throw new Error('Fișierul nu conține rânduri cu Locatie TR.');
  if (months.size !== 1) throw new Error('Fișierul trebuie să conțină o singură lună.');
  return result;
}

export function monthFromSalesRows(rows: SalesRow[]) { return rows[0]?.month || null; }
