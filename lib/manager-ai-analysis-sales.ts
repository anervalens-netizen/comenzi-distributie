import { DatabaseSync } from 'node:sqlite';
import { salesYield } from './client-sales-cooperative';
import { historyFileGeneration } from './history-source-generation';
import { iterateHistoricalSalesMonth } from './historical-sales';
import { salesDatabasePath, salesScopeFilter } from './sales-store';
import { salesLocationKey, salesSiteKey, type SalesScope } from './sales-location';

export type AnalysisSalesLine = {
  date:string;site:string;warehouse:string;sku:string;product:string;brand:string;category:string;subcategory:string;
  quantity:number;valueCents:number|null;source:'monthly_import'|'client_history';
};

/** Select exactly one source per month. The history fallback requires the same
 * complete coverage, sales office attribution and amounts as the Sales view. */
export async function scanManagerAiAnalysisSales(
  month:string, scope:SalesScope|undefined, onLine:(line:AnalysisSalesLine)=>void, signal?:AbortSignal,
) {
  signal?.throwIfAborted();
  let readRows=0;
  const generation=historyFileGeneration(salesDatabasePath);
  const connection=generation?new DatabaseSync(salesDatabasePath,{readOnly:true}):null;
  try {
    if (connection) {
      connection.function('sales_location_key',{deterministic:true},value=>salesLocationKey(String(value??'')));
      connection.exec('BEGIN');
      const active=connection.prepare('SELECT import_id,revision FROM sales_months WHERE month=?').get(month);
      if (active) {
        const filter=salesScopeFilter(scope,()=>connection);
        let through:string|null=null;
        for (const row of connection.prepare(`SELECT date,site_code,location,item_code,item_name,brand,category,sub_category,quantity,value_cents
          FROM sales_rows WHERE import_id=?${filter.sql} ORDER BY date,row_number`).iterate(active.import_id,...filter.args)) {
          through=String(row.date);
          onLine({date:through,site:salesSiteKey(String(row.site_code)),warehouse:String(row.location),
            sku:String(row.item_code),product:String(row.item_name),brand:String(row.brand),category:String(row.category),subcategory:String(row.sub_category),
            quantity:Number(row.quantity),valueCents:Number(row.value_cents),source:'monthly_import'});
          if (++readRows%512===0) {
            await salesYield();
            signal?.throwIfAborted();
          }
        }
        return {source:'Import lunar de vânzări',month,available:true,through,revision:String(active.revision),
          note:'Liniile importului activ. Data limită este ultima observație din selecție și nu certifică o lună închisă.'};
      }
    }
    const lines=iterateHistoricalSalesMonth(month,scope,connection);
    try {
      for (;;) {
        const next=lines.next();
        if (next.done) {
          if (next.value) return {source:'Istoric comercial · vânzări',month,available:true,through:next.value.through,
            note:'Acoperire declarată integral. SiteCode gol în lipsa mapării univoce. Valorile NULL sunt necunoscute; retururile păstrează semnul.'};
          break;
        }
        const row=next.value;
        onLine({date:row.date,site:row.site,warehouse:row.location,sku:row.sku,product:row.product,
          brand:row.brand,category:row.category,subcategory:'',quantity:row.quantity,valueCents:row.valueCents,source:'client_history'});
        if (++readRows%512===0) {
          await salesYield();
          signal?.throwIfAborted();
        }
      }
    } finally { lines.return(null); }
    return {source:'Vânzări',month,available:false,note:'Lipsește importul lunar sau acoperirea integrală a istoricului.'};
  } finally { connection?.close(); }
}
