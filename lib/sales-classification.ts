import type { Product } from './types';
import type { SalesRow } from './sales-types';

export type SalesProductBucket = 'accessory' | 'main-card' | 'value-card-voucher' | 'phone' | 'ambiguous';
export type SalesProductMatch = 'catalog-code' | 'catalog-name' | 'source-category' | 'heuristic' | 'unmatched';

export type SalesClassificationInput = Pick<SalesRow, 'itemCode' | 'itemName' | 'quantity' | 'valueCents'> & {
  category?: string | null;
  subCategory?: string | null;
};

export type SalesProductClassification = {
  bucket: SalesProductBucket;
  category: string;
  subCategory: string;
  confidence: 'high' | 'medium' | 'low';
  ambiguous: boolean;
  matchedBy: SalesProductMatch;
  reasons: string[];
};

export type ClassifiedSalesRow = SalesClassificationInput & { classification: SalesProductClassification };

export type ProductBreakdown = {
  itemCode: string;
  itemName: string;
  bucket: SalesProductBucket;
  category: string;
  subCategory: string;
  rows: number;
  quantity: number;
  valueCents: number;
  ambiguous: boolean;
};

export type SalesClassificationSummary = {
  rows: number;
  quantity: number;
  valueCents: number;
  byBucket: Record<SalesProductBucket, { rows: number; quantity: number; valueCents: number }>;
  products: ProductBreakdown[];
  ambiguousProducts: ProductBreakdown[];
};

export type SalesCatalogEntry = Pick<Product, 'code' | 'name' | 'category' | 'kind'>;

export type SalesCatalogIndex = {
  byCode: Map<string, SalesCatalogEntry[]>;
  byName: Map<string, SalesCatalogEntry[]>;
};

const PHONE_MARKERS = [
  'GALAXY', 'IPHONE', 'REDMI', 'SMARTPHONE', 'TELEFON',
];
const ACCESSORY_MARKERS = [
  'ADAPTOR', 'CABLU', 'CASE', 'CASTI', 'FOLIE', 'HUSA', 'HUSE', 'INCARCATOR',
  'POWER BANK', 'SCREEN PROTECTOR', 'STICLA', 'SUPORT',
];

function normalized(value: string | null | undefined) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function codeKey(value: string | null | undefined) { return normalized(value); }
function hasAny(text: string, markers: readonly string[]) { return markers.some(marker => text.includes(marker)); }

function isValueCard(code: string, name: string) {
  return /^(?:V\d|VOU)/.test(code) || /CARTELA\s+VALORIC|VOUCHER/.test(name);
}

function isMainCard(code: string, name: string) {
  return /^(?:SIM|SPN)/.test(code) || /^CARTELA\b/.test(name) || /^SIM\b/.test(name);
}

function isPhone(code: string, name: string) {
  return hasAny(name, PHONE_MARKERS) || /^(?:ALL|H\d|MM|NOK|SAMA|TAL|TCL|TMB|TNO|TXI|TZA)/.test(code);
}

function isAccessoryName(name: string) {
  return hasAny(name, ACCESSORY_MARKERS);
}

function isPhonePackage(name: string) {
  return /PACHET/.test(name) && (hasAny(name, PHONE_MARKERS) || /PREPAID|CU\s+SIM/.test(name));
}

function sourceCategory(value: string | null | undefined) { return normalized(value); }

function accessoryResult(category: string, subCategory: string, matchedBy: SalesProductMatch, confidence: SalesProductClassification['confidence'], reason: string): SalesProductClassification {
  return { bucket: 'accessory', category: category || 'Accesorii', subCategory: subCategory || 'Alte accesorii', confidence, ambiguous: false, matchedBy, reasons: [reason] };
}

export function indexSalesCatalog(catalog: readonly SalesCatalogEntry[]): SalesCatalogIndex {
  const byCode = new Map<string, SalesCatalogEntry[]>();
  const byName = new Map<string, SalesCatalogEntry[]>();
  for (const entry of catalog) {
    const code = codeKey(entry.code);
    const name = normalized(entry.name);
    const codeEntries = byCode.get(code) || [];
    codeEntries.push(entry);
    byCode.set(code, codeEntries);
    const nameEntries = byName.get(name) || [];
    nameEntries.push(entry);
    byName.set(name, nameEntries);
  }
  return { byCode, byName };
}

function catalogCandidates(input: SalesClassificationInput, catalog: SalesCatalogIndex) {
  const code = codeKey(input.itemCode);
  const name = normalized(input.itemName);
  const byCode = catalog.byCode.get(code) || [];
  if (byCode.length) {
    const exactName = byCode.filter(entry => normalized(entry.name) === name);
    return { entries: exactName.length ? exactName : byCode, matchedBy: 'catalog-code' as const };
  }
  const byName = catalog.byName.get(name) || [];
  return { entries: byName, matchedBy: byName.length ? 'catalog-name' as const : 'unmatched' as const };
}

function fromCatalog(input: SalesClassificationInput, candidates: ReturnType<typeof catalogCandidates>): SalesProductClassification | null {
  if (!candidates.entries.length) return null;
  const entries = candidates.entries;
  const first = entries[0];
  const kind = normalized(first.kind);
  const category = sourceCategory(input.category) ? String(input.category).trim() : String(first.category || '').trim();
  const subCategory = String(input.subCategory || '').trim();
  const names = new Set(entries.map(entry => normalized(entry.name)));
  const conflicting = new Set(entries.map(entry => `${normalized(entry.kind)}\u001f${normalized(entry.category)}`)).size > 1 || names.size > 1;
  const name = normalized(input.itemName);
  if (isValueCard(codeKey(input.itemCode), name)) return { bucket: 'value-card-voucher', category: 'Cartele valorice / vouchere', subCategory: 'Cartele valorice / vouchere', confidence: conflicting ? 'medium' : 'high', ambiguous: conflicting, matchedBy: candidates.matchedBy, reasons: [conflicting ? 'Codul catalogului are mai multe descrieri compatibile.' : 'Potrivire în catalog.'] };
  if (kind === 'STANDS' && (sourceCategory(first.category) === 'CARTELE' || isMainCard(codeKey(input.itemCode), name))) return { bucket: 'main-card', category: 'Cartele cu număr / SIM', subCategory: 'Cartele cu număr și SIM', confidence: conflicting ? 'medium' : 'high', ambiguous: conflicting, matchedBy: candidates.matchedBy, reasons: [conflicting ? 'Codul catalogului are mai multe descrieri compatibile.' : 'Potrivire în catalog.'] };
  if (kind === 'STANDS' && (sourceCategory(first.category) === 'TELEFOANE' || isPhonePackage(name))) return { bucket: 'phone', category: 'Telefoane', subCategory: isPhonePackage(name) ? 'Pachete telefon + SIM' : 'Telefoane', confidence: conflicting ? 'medium' : 'high', ambiguous: conflicting, matchedBy: candidates.matchedBy, reasons: [conflicting ? 'Codul catalogului are mai multe descrieri compatibile.' : 'Potrivire în catalog.'] };
  if (kind === 'ACCESSORIES' || sourceCategory(first.category) !== 'CARTELE' && sourceCategory(first.category) !== 'TELEFOANE') return accessoryResult(category, subCategory || String(first.category || ''), candidates.matchedBy, conflicting ? 'medium' : 'high', conflicting ? 'Codul catalogului are mai multe descrieri compatibile.' : 'Potrivire în catalog.');
  return null;
}

export function classifySalesProductWithIndex(input: SalesClassificationInput, catalog: SalesCatalogIndex): SalesProductClassification {
  const code = codeKey(input.itemCode);
  const name = normalized(input.itemName);
  const category = sourceCategory(input.category);
  const catalogResult = fromCatalog(input, catalogCandidates(input, catalog));
  if (catalogResult) return catalogResult;

  if (isValueCard(code, name)) return { bucket: 'value-card-voucher', category: 'Cartele valorice / vouchere', subCategory: 'Cartele valorice / vouchere', confidence: 'high', ambiguous: false, matchedBy: 'heuristic', reasons: ['Codul sau denumirea indică o cartelă valorică ori un voucher.'] };
  if (['CARTELE', 'CARTELA', 'SIM'].includes(category)) return { bucket: 'main-card', category: 'Cartele cu număr / SIM', subCategory: 'Cartele cu număr și SIM', confidence: 'high', ambiguous: false, matchedBy: 'source-category', reasons: ['Categoria sursă indică o cartelă sau un SIM.'] };
  if (['TELEFOANE', 'TELEFON'].includes(category)) return { bucket: 'phone', category: 'Telefoane', subCategory: isPhonePackage(name) ? 'Pachete telefon + SIM' : 'Telefoane', confidence: 'high', ambiguous: false, matchedBy: 'source-category', reasons: ['Categoria sursă indică un telefon.'] };
  // Any other explicit source category is treated as an accessory before name heuristics.
  if (String(input.category || '').trim()) return accessoryResult(String(input.category).trim(), String(input.subCategory || '').trim(), 'source-category', 'high', 'Categoria sursă indică un accesoriu.');
  // Explicit accessory words win before phone model/brand-like wording. A brand alone is not enough evidence for a phone.
  if (isAccessoryName(name)) return accessoryResult('Accesorii', String(input.subCategory || '').trim(), 'heuristic', 'medium', 'Denumirea conține un termen explicit de accesoriu.');
  if (isPhonePackage(name) || (isPhone(code, name) && !isMainCard(code, name))) return { bucket: 'phone', category: 'Telefoane', subCategory: isPhonePackage(name) ? 'Pachete telefon + SIM' : 'Telefoane', confidence: 'medium', ambiguous: false, matchedBy: 'heuristic', reasons: ['Codul sau denumirea indică un telefon.'] };
  if (isMainCard(code, name)) return { bucket: 'main-card', category: 'Cartele cu număr / SIM', subCategory: 'Cartele cu număr și SIM', confidence: 'medium', ambiguous: false, matchedBy: 'heuristic', reasons: ['Codul sau denumirea indică SIM/cartelă cu număr.'] };
  return { bucket: 'ambiguous', category: 'De clasificat', subCategory: 'Produs fără regulă', confidence: 'low', ambiguous: true, matchedBy: 'unmatched', reasons: ['Nu există potrivire în catalog, categorie sursă sau regulă de denumire.'] };
}

export function createSalesProductClassifier(catalog: readonly SalesCatalogEntry[] = []) {
  const index = indexSalesCatalog(catalog);
  return (input: SalesClassificationInput) => classifySalesProductWithIndex(input, index);
}

export function classifySalesProduct(input: SalesClassificationInput, catalog: readonly SalesCatalogEntry[] = []): SalesProductClassification {
  return classifySalesProductWithIndex(input, indexSalesCatalog(catalog));
}

export function classifySalesRows(rows: readonly SalesClassificationInput[], catalog: readonly SalesCatalogEntry[] = []): { rows: ClassifiedSalesRow[]; summary: SalesClassificationSummary } {
  const classify = createSalesProductClassifier(catalog);
  const classified = rows.map(row => ({ ...row, classification: classify(row) }));
  const byBucket = Object.fromEntries((['accessory', 'main-card', 'value-card-voucher', 'phone', 'ambiguous'] as SalesProductBucket[]).map(bucket => [bucket, { rows: 0, quantity: 0, valueCents: 0 }])) as SalesClassificationSummary['byBucket'];
  const products = new Map<string, ProductBreakdown>();
  for (const row of classified) {
    const c = row.classification;
    const bucket = byBucket[c.bucket];
    bucket.rows += 1; bucket.quantity += row.quantity; bucket.valueCents += row.valueCents;
    const key = `${codeKey(row.itemCode)}\u001f${c.bucket}`;
    const current = products.get(key) || { itemCode: row.itemCode, itemName: row.itemName, bucket: c.bucket, category: c.category, subCategory: c.subCategory, rows: 0, quantity: 0, valueCents: 0, ambiguous: c.ambiguous };
    current.rows += 1; current.quantity += row.quantity; current.valueCents += row.valueCents; current.ambiguous ||= c.ambiguous;
    products.set(key, current);
  }
  const productList = [...products.values()].sort((a, b) => b.valueCents - a.valueCents || a.itemCode.localeCompare(b.itemCode));
  return { rows: classified, summary: { rows: classified.length, quantity: classified.reduce((sum, row) => sum + row.quantity, 0), valueCents: classified.reduce((sum, row) => sum + row.valueCents, 0), byBucket, products: productList, ambiguousProducts: productList.filter(product => product.ambiguous) } };
}
