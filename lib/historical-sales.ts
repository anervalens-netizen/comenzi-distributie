import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {historyFileGeneration} from './history-source-generation';
import {salesLocationKey,salesSiteKey,type SalesScope} from './sales-location';
import {createSalesProductClassifier,type SalesCatalogEntry} from './sales-classification';
import type {SalesView,SalesProduct,SalesAggregate} from './sales-types';

export const historicalSalesPath=()=>resolve(process.env.MOBIUP_DATA_DIR||'./work/server-data','client-history','client-sales-history.sqlite');
export const historicalSalesGeneration=()=>historyFileGeneration(historicalSalesPath())||'missing';

/** ERP SiteId is not a sales SiteCode. Only exact, unique location evidence from
 * the authoritative sales source can supply that code; never infer from a name. */
export function historicalScopeMatch(scope:SalesScope|undefined,location:string,code:string){
 const key=salesLocationKey(location),site=salesSiteKey(code);
 if(scope===undefined)return true;
 if(typeof scope==='string')return !!site&&site===salesSiteKey(scope);
 if(Array.isArray(scope))return !!site&&scope.some(s=>salesSiteKey(s)===site);
 if(scope.siteCode&&(!site||salesSiteKey(scope.siteCode)!==site))return false;
 return scope.warehouseNames.some(n=>salesLocationKey(n)===key)
  ||(scope.warehouseSites||[]).some(p=>salesLocationKey(p.warehouseName)===key&&!!site&&salesSiteKey(p.siteCode)===site)
  ||(!!site&&scope.siteCodes.some(s=>salesSiteKey(s)===site)&&!scope.excludedWarehouseNames.some(n=>salesLocationKey(n)===key));
}
const zero=():SalesAggregate=>({rows:0,quantity:0,value:0});
export function historicalSalesView(empty:SalesView,scope:SalesScope|undefined,catalog:readonly SalesCatalogEntry[],sales:DatabaseSync):SalesView|null{
 const file=historicalSalesPath();if(!existsSync(file))return null;
 const before=historicalSalesGeneration(),c=new DatabaseSync(file,{readOnly:true});
 try{
 c.exec('BEGIN;');
 const fields=new Set(c.prepare('PRAGMA table_info(history_rows)').all().map(r=>r.name));if(!['site_id','tr','article_type','category','quantity_micros','value_cents'].every(k=>fields.has(k)))return null;
 const importFields=new Set(c.prepare('PRAGMA table_info(history_imports)').all().map(r=>r.name));if(!importFields.has('imported_at'))return null;
 const month=empty.month,from=month+'-01',next=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)).toISOString().slice(0,10);
 const imports=c.prepare("SELECT id,period_start,period_end,imported_at FROM history_imports WHERE state='active' AND period_start<? AND period_end>=? ORDER BY period_start,id").all(next,from);
 for(let i=1;i<imports.length;i++)if(String(imports[i].period_start)<=String(imports[i-1].period_end))throw new Error('Istoricul conține perioade suprapuse.');
 // Only complete declared coverage can replace an absent monthly report.
 let through=from;
 for(const row of imports){if(String(row.period_start)>through)break;if(String(row.period_end)>=through)through=new Date(Date.parse(String(row.period_end)) +86400000).toISOString().slice(0,10);}
 if(through<next)return null;
 const codes=new Map<string,Set<string>>();
 for(const r of sales.prepare('SELECT DISTINCT location,site_code FROM sales_rows').all()){const k=salesLocationKey(String(r.location)),set=codes.get(k)||new Set<string>();set.add(salesSiteKey(String(r.site_code)));codes.set(k,set);}
 const result:SalesView={...empty,source:'client-history',filename:'Istoric pe clienți',importedAt:imports.map(r=>String(r.imported_at)).sort().at(-1)||null,products:[],sites:[],daily:[],summary:zero(),missingValueRows:0};
 const products=new Map<string,SalesProduct>(),sites=new Map<string,SalesView['sites'][number]>(),days=new Map<string,SalesView['daily'][number]>();
 const classifier=createSalesProductClassifier(catalog);
 for(const row of c.prepare("SELECT r.date,r.tr,r.site_id,r.item_code,r.item_name,r.brand,r.category,r.article_type,r.quantity_micros,r.value_cents FROM history_rows r JOIN history_imports i ON i.id=r.import_id AND i.state='active' WHERE r.date>=? AND r.date<? ORDER BY r.date,r.import_id,r.source_row").iterate(from,next)){
 const location=String(row.tr),set=codes.get(salesLocationKey(location)),code=set?.size===1?[...set][0]:'';
 if(!historicalScopeMatch(scope,location,code))continue;
 const quantity=Number(row.quantity_micros)/1e6,value=Number(row.value_cents??0)/100,missing=row.value_cents===null?1:0,itemCode=String(row.item_code),itemName=String(row.item_name),brand=String(row.brand),category=String(row.category),date=String(row.date);
 const key=JSON.stringify([itemCode,itemName,brand,category]),p=products.get(key)||{...zero(),itemCode,itemName,brand,category,subCategory:'',missingValueRows:0};
 p.rows++;p.quantity+=quantity;p.value+=value;p.missingValueRows=(p.missingValueRows||0)+missing;products.set(key,p);
 const sk=JSON.stringify([code,location]),s=sites.get(sk)||{...zero(),siteCode:code||'HISTORY:'+String(row.site_id),location,agent:''};s.rows++;s.quantity+=quantity;s.value+=value;sites.set(sk,s);
 const d=days.get(date)||{...zero(),date};d.rows++;d.quantity+=quantity;d.value+=value;days.set(date,d);
 result.summary.rows++;result.summary.quantity+=quantity;result.summary.value+=value;result.missingValueRows!+=missing;
 }
 for(const p of products.values()){
 p.value=Math.round(p.value*100)/100;const classified=classifier({itemCode:p.itemCode,itemName:p.itemName,quantity:p.quantity,valueCents:Math.round(p.value*100),category:p.category,subCategory:''});
 const bucket=classified.bucket; p.segment=bucket==='phone'?'phones':bucket==='accessory'?'accessories':bucket==='ambiguous'?'unclassified':'cardsSim';
 if(p.segment==='cardsSim')p.subsegment=bucket==='value-card-voucher'?'vouchers':/\bSIM\b|^SIM/.test((p.itemCode+' '+p.itemName).toUpperCase())?'sim':'cards';
 const g=result.segments[p.segment];g.products.push(p);g.summary.rows+=p.rows;g.summary.quantity+=p.quantity;g.summary.value+=p.value;
 if(p.segment==='cardsSim'){for(const k of p.subsegment==='vouchers'?['vouchers','valueVouchers'] as const:[p.subsegment||'cards'] as const){const s=result.segments.cardsSim.subsegments[k];s.rows+=p.rows;s.quantity+=p.quantity;s.value+=p.value;}}
 }
 result.products=[...products.values()].sort((a,b)=>b.value-a.value);result.sites=[...sites.values()];result.daily=[...days.values()];
 for(const a of [result.summary,...result.sites,...result.daily,...Object.values(result.segments).map(s=>s.summary)])a.value=Math.round(a.value*100)/100;
 c.exec('COMMIT;');if(before!==historicalSalesGeneration())throw new Error('Istoricul s-a modificat. Reîncarcă raportul.');
 return result;
 }finally{c.close();}
}
