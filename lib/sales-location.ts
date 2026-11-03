/** Exact identity normalization only: never infer a different place or seller. */
export const salesLocationKey = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
export const salesSiteKey = (value: string) => value.trim().replace(/[a-z]/g, char => char.toUpperCase());
export const salesPairKey = (site: { siteCode: string; location: string }) => JSON.stringify([salesSiteKey(site.siteCode), site.location]);

/** Locations, constrained location/site pairs and site-only sellers are ORed; a requested site narrows all. */
export type SalesScope = string | string[] | {
  warehouseNames: string[];
  warehouseSites?: { warehouseName: string; siteCode: string }[];
  siteCodes: string[];
  excludedWarehouseNames: string[];
  siteCode?: string;
};

/** Keep the same TR token contract for monthly files and historical projection. */
export const isTrSalesLocation=(value:string)=>/(^|[^A-Z0-9])TR(?=$|[^A-Z0-9])/i.test(value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim());
