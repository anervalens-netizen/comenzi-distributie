declare module '*.sql?raw' { const sql: string; export default sql; }
declare module '#mobiup-runtime' {
  export const env: { DB: D1Database; FILES: R2Bucket };
  export const runtimeKind: 'node' | 'cloudflare';
}
declare module '#mobiup-sales-parser' {
  export function parseSalesFileRuntime(bytes:Uint8Array,filename:string):Promise<import('./sales-types').SalesRow[]>;
}
declare module '#mobiup-stock-parser' {
  export function parseStockFileRuntime(bytes:Uint8Array,filename:string):Promise<import('./stock-file').ParsedStockGroup[]>;
}
declare module '#mobiup-sales-view' {
  export function getSalesViewRuntime(month:string,siteCode:string|string[]|undefined,fromMonth:string,toMonth:string,catalog:readonly import('./sales-classification').SalesCatalogEntry[]):Promise<import('./sales-types').SalesView>;
}
