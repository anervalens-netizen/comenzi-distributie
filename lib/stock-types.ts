export type StockRow = {code:string;name:string;quantity:number;category?:string};
export type StockView = {warehouseId:string;importedAt:string|null;filename:string|null;rows:StockRow[];depot:Record<string,number|null>;depotImportedAt:string|null};
export type StockGroup = {key:string;name:string;siteId:string;rowCount:number;quantity:number;warehouseId:string|null};
export type StockPreview = {version:string;fileHash:string;filename:string;rowCount:number;matchedRows:number;unknownProducts:number;groups:StockGroup[];targets:{id:string;name:string}[]};
export const stockCode = (value:string) => value.trim().toUpperCase();
