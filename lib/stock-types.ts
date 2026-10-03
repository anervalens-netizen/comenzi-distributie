export type StockRow = {code:string;name:string;quantity:number;category?:string;observedAt?:string};
export type StockView = {warehouseId:string;importedAt:string|null;filename:string|null;rows:StockRow[];depot:Record<string,number|null>;depotImportedAt:string|null;coverage?:StockCoverage;depotCoverage?:StockCoverage;depotObservedAt?:Record<string,string|null>};
export type StockGroup = {key:string;name:string;siteId:string;rowCount:number;quantity:number;warehouseId:string|null};
export type StockCoverageDecision = {warehouses:'full'|'partial';depot:'full'|'partial'};
export type StockCoverage = {mode:'full'|'partial';updatedAt:string;fullSnapshotAt:string|null};
export type StockDelta = {before:{codes:number;quantity:number;unknown:number};after:{codes:number;quantity:number;unknown:number};changes:{code:string;before:number|null;after:number|null;kind:'added'|'removed'|'changed'}[]};
export type StockPreview = {decision:StockCoverageDecision;confirmation:string;impact:{warehouses:(StockDelta&{warehouseId:string})[];depot:StockDelta};version:string;fileHash:string;filename:string;rowCount:number;matchedRows:number;unknownProducts:number;groups:StockGroup[];targets:{id:string;name:string}[]};
export const stockCode = (value:string) => value.trim().toUpperCase();
