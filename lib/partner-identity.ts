export function normalizeCui(value:string) {
  const compact=value.toUpperCase().replace(/[^A-Z0-9]/g,'');
  return compact.startsWith('RO')?compact.slice(2):compact;
}

export function normalizePartnerPointPart(value:string) {
  // Punctuation can distinguish work locations (1-3 / 13, 1/2 / 12).
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim().replace(/\s+/g,' ');
}

export function partnerPointKey(city:string,county:string,address:string) {
  return `${normalizePartnerPointPart(county)}|${normalizePartnerPointPart(city)}|${normalizePartnerPointPart(address)}`;
}

export function partnerLegacyPointKey(city:string,address:string) {
  return `${normalizePartnerPointPart(city)}|${normalizePartnerPointPart(address)}`;
}

export function hasPartnerCounty(county:string) {
  return normalizePartnerPointPart(county).length>0;
}
