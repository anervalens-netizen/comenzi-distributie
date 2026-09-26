import assert from 'node:assert/strict';
import { classifySalesProduct, classifySalesRows } from '../lib/sales-classification.ts';

const row = (itemCode, itemName, category='', subCategory='') => ({ itemCode, itemName, quantity: 1, valueCents: 1000, category, subCategory });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

for (const [name, category, subCategory] of [
  ['Husă Samsung Galaxy A55', 'Huse', 'Huse telefon'],
  ['Încărcător Samsung USB-C 25W', 'Încărcătoare', 'Încărcătoare rețea'],
  ['Cablu iPhone USB-C', 'Cabluri', 'Cabluri date'],
]) {
  const result = classifySalesProduct(row('X', name, category, subCategory));
  check(result.bucket === 'accessory' && result.matchedBy === 'source-category', `${name} must remain an accessory when the source category is explicit`);
}

const explicitSim = classifySalesProduct(row('SIM-X', 'SIM Vodafone', 'SIM', 'SIM'));
check(explicitSim.bucket === 'main-card' && explicitSim.matchedBy === 'source-category', 'Explicit SIM source category remains in cards/SIM');

const voucher = classifySalesProduct(row('VOU-10', 'Voucher valoric', 'Cartele', 'Voucher'));
check(voucher.bucket === 'value-card-voucher', 'Voucher detection remains distinct from numbered cards');

const heuristicPhone = classifySalesProduct(row('PHONE-X', 'Samsung Galaxy A55'));
check(heuristicPhone.bucket === 'phone' && heuristicPhone.matchedBy === 'heuristic', 'Phone heuristic still works when no source category exists');

const explicitPhone = classifySalesProduct(row('OTHER', 'Generic handset', 'Telefoane', 'Telefon'));
check(explicitPhone.bucket === 'phone' && explicitPhone.matchedBy === 'source-category', 'Explicit phone category remains authoritative');

for (const name of ['HUSA SAMSUNG A56','CABLU IPHONE USB C','FOLIE XIAOMI REDMI','INCARCATOR HUAWEI 25W']) {
  const result = classifySalesProduct(row('AUDIT-NEW-SKU', name));
  check(result.bucket === 'accessory' && result.matchedBy === 'heuristic', `${name} must not be inferred as a phone from brand wording`);
}
const brandOnly = classifySalesProduct(row('AUDIT-BRAND', 'SAMSUNG MODEL NECUNOSCUT'));
check(brandOnly.bucket === 'ambiguous' && brandOnly.ambiguous, 'Brand wording alone is insufficient evidence for a phone');

const ambiguous = classifySalesProduct(row('UNKNOWN', 'Produs necunoscut ZZZ'));
check(ambiguous.bucket === 'ambiguous', 'Unknown product remains explicitly ambiguous');

const currentAccessoryCatalog = [{ code: 'SKU-1', name: 'Samsung Galaxy Kit', category: 'Huse', kind: 'accessories' }];
const catalogAccessory = classifySalesProduct(row('SKU-1', 'Samsung Galaxy Kit'), currentAccessoryCatalog);
check(catalogAccessory.bucket === 'accessory' && catalogAccessory.matchedBy === 'catalog-code', 'Current catalog can override phone-like wording as an accessory');

const currentPhoneCatalog = [{ code: 'SKU-1', name: 'Samsung Galaxy Kit', category: 'Telefoane', kind: 'stands' }];
const catalogPhone = classifySalesProduct(row('SKU-1', 'Samsung Galaxy Kit'), currentPhoneCatalog);
check(catalogPhone.bucket === 'phone' && catalogPhone.matchedBy === 'catalog-code', 'Changing the supplied current catalog changes the classification');

const duplicateRows = [
  { ...row('DUP', 'Husă Samsung', 'Huse'), quantity: 2, valueCents: 2000 },
  { ...row('DUP', 'Husă Samsung', 'Huse'), quantity: -1, valueCents: -1000 },
];
const summary = classifySalesRows(duplicateRows).summary;
check(summary.rows === 2, 'Duplicate commercial rows retain multiplicity');
check(summary.quantity === 1 && summary.valueCents === 1000, 'Signed returns remain in aggregate totals');
check(summary.byBucket.accessory.rows === 2, 'Both duplicate rows remain classified as accessories');

console.log(`PASS: ${checks} sales classification checks.`);
