/** Exact identity normalization only: never infer a different place or seller. */
export const salesLocationKey = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
export const salesSiteKey = (value: string) => value.trim().replace(/[a-z]/g, char => char.toUpperCase());
export const salesPairKey = (site: { siteCode: string; location: string }) => JSON.stringify([salesSiteKey(site.siteCode), site.location]);

/** Location selectors and site-only sellers are ORed; a requested site narrows both. */
export type SalesScope = string | string[] | {
  warehouseNames: string[];
  siteCodes: string[];
  excludedWarehouseNames: string[];
  siteCode?: string;
};
