import type {ParsedStockGroup} from './stock-file';
import type {StockDelta,StockRow} from './stock-types';

export function stockDelta(before:Record<string,number|null>,after:Record<string,number|null>):StockDelta {
  const codes=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();
  const summary=(values:Record<string,number|null>)=>({codes:Object.keys(values).length,quantity:Object.values(values).reduce<number>((sum,n)=>sum+(n??0),0),unknown:Object.values(values).filter(n=>n===null).length});
  return {before:summary(before),after:summary(after),changes:codes.filter(code=>!Object.hasOwn(before,code)||!Object.hasOwn(after,code)||before[code]!==after[code]).map(code=>({code,before:before[code]??null,after:after[code]??null,kind:!Object.hasOwn(before,code)?'added':!Object.hasOwn(after,code)?'removed':'changed'}))};
}
// The ERP export is the complete current stock. Absence means no current stock,
// including warehouses omitted entirely and old warehouses with no active agent.
export function stockSnapshot(groups:ParsedStockGroup[],mappings:Record<string,string|null>,warehouseIds:string[]) {
  const warehouses:Record<string,StockRow[]>=Object.fromEntries([...new Set(warehouseIds)].sort().map(id=>[id,[]]));
  for(const group of groups){const id=mappings[group.key];if(id)warehouses[id]=group.rows.map(({code,name,quantity})=>({code,name,quantity}));}
  const depot=Object.fromEntries(groups.flatMap(group=>group.rows.map(row=>[row.code,row.depotQuantity])));
  return {warehouses,depot};
}
export function stockImpact(state:{warehouses:Record<string,{rows:StockRow[]}>;depot?:Record<string,number|null>},groups:ParsedStockGroup[],mappings:Record<string,string|null>,warehouseIds:string[]=[]) {
  const snapshot=stockSnapshot(groups,mappings,[...Object.keys(state.warehouses),...warehouseIds]);
  return {warehouses:Object.entries(snapshot.warehouses).map(([warehouseId,rows])=>({
    warehouseId,...stockDelta(Object.fromEntries((state.warehouses[warehouseId]?.rows||[]).map(r=>[r.code,r.quantity])),Object.fromEntries(rows.map(r=>[r.code,r.quantity])))
  })),depot:stockDelta(state.depot||{},snapshot.depot)};
}
