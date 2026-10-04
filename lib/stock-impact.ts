import type {ParsedStockGroup} from './stock-file';
import type {StockCoverageDecision,StockDelta,StockRow} from './stock-types';

export function stockDelta(before:Record<string,number|null>,after:Record<string,number|null>):StockDelta {
  const codes=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();
  const summary=(values:Record<string,number|null>)=>({codes:Object.keys(values).length,quantity:Object.values(values).reduce<number>((sum,n)=>sum+(n??0),0),unknown:Object.values(values).filter(n=>n===null).length});
  return {before:summary(before),after:summary(after),changes:codes.filter(code=>!Object.hasOwn(before,code)||!Object.hasOwn(after,code)||before[code]!==after[code]).map(code=>({code,before:before[code]??null,after:after[code]??null,kind:!Object.hasOwn(before,code)?'added':!Object.hasOwn(after,code)?'removed':'changed'}))};
}
export function mergeStockRows(before:StockRow[],rows:StockRow[],mode:'full'|'partial') {
  return mode==='full'?rows:[...new Map([...before,...rows].map(row=>[row.code,row])).values()];
}
export function stockImpact(state:{warehouses:Record<string,{rows:StockRow[]}>;depot?:Record<string,number|null>},groups:ParsedStockGroup[],mappings:Record<string,string|null>,decision:StockCoverageDecision) {
  const depotRows=Object.fromEntries(groups.flatMap(g=>g.rows.map(r=>[r.code,r.depotQuantity])));
  const depot=decision.depot==='full'?depotRows:{...state.depot,...depotRows};
  return {warehouses:groups.flatMap(g=>{const warehouseId=mappings[g.key];if(!warehouseId)return [];const before=state.warehouses[warehouseId]?.rows||[],rows=g.rows.map(({code,name,quantity})=>({code,name,quantity}));return [{warehouseId,...stockDelta(Object.fromEntries(before.map(r=>[r.code,r.quantity])),Object.fromEntries(mergeStockRows(before,rows,decision.warehouses).map(r=>[r.code,r.quantity])))}];}),depot:stockDelta(state.depot||{},depot)};
}
