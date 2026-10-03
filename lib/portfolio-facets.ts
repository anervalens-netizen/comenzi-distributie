/** Read-only CRM geography aliases. Unknown labels remain exact, including casing. */
const key = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
const counties = [
  ['AB','Alba'],['AR','Arad'],['AG','Argeș'],['BC','Bacău'],['BH','Bihor'],['BN','Bistrița-Năsăud'],
  ['BT','Botoșani'],['BV','Brașov'],['BR','Brăila'],['B','București','Municipiul Bucuresti'],['BZ','Buzău'],
  ['CS','Caraș-Severin'],['CL','Călărași'],['CJ','Cluj'],['CT','Constanța'],['CV','Covasna'],['DB','Dâmbovița'],
  ['DJ','Dolj'],['GL','Galați'],['GR','Giurgiu'],['GJ','Gorj'],['HR','Harghita'],['HD','Hunedoara'],
  ['IL','Ialomița'],['IS','Iași'],['IF','Ilfov'],['MM','Maramureș'],['MH','Mehedinți'],['MS','Mureș'],
  ['NT','Neamț'],['OT','Olt'],['PH','Prahova'],['SM','Satu Mare'],['SJ','Sălaj'],['SB','Sibiu'],
  ['SV','Suceava'],['TR','Teleorman'],['TM','Timiș'],['TL','Tulcea'],['VS','Vaslui'],['VL','Vâlcea'],['VN','Vrancea'],
];
const aliases = new Map(counties.flatMap(([id,label,...extra]) => [id,`RO-${id}`,label,...extra].map(alias => [key(alias),{id,label,aliases:[id,label,...extra]}] as const)));
export function canonicalCounty(raw: string = '') {
  const known = aliases.get(key(raw));
  return {raw, id:known ? `RO-${known.id}` : null, label:known?.label ?? raw};
}
export const countyLabel = (raw: string = '') => canonicalCounty(raw).label;
export const countyMatches = (raw: string, selected: string) => countyLabel(raw) === countyLabel(selected);
export const countySearch = (raw: string = '') => [raw,...(aliases.get(key(raw))?.aliases ?? [])].join(' ');
/** Route text is an unordered membership list; storage/display retains the original. */
export const routeTokens = (raw: string = '') => [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
export const routeMatches = (raw: string, selected: string) => routeTokens(raw).includes(selected.trim());
