import {productGroup, type DistributionRules} from './distribution-rules';
import {managerAiFilterMatches, type AiReportQuery, type AiSource, type AiSourceRow} from './manager-ai-query';
import {salesSiteKey} from './sales-location';
import type {SalesProduct,SalesView} from './sales-types';
import {fail} from './server';

const source = 'Prepay · Vânzări Vodafone';
const productKey = (p:SalesProduct) => JSON.stringify([p.itemCode,p.itemName,p.brand,p.category,p.subCategory]);
const version = (view:SalesView) => JSON.stringify([view.source,view.revision,view.importedAt,view.fileHash]);

export function managerAiSalesSiteMode(query:AiReportQuery) {
  const filters = query.filters.filter(filter=>filter.field==='site');
  return {filters,split:query.groupBy.includes('site')||query.orderBy==='site'||filters.length>0};
}

export async function managerAiSales(
  query:AiReportQuery,
  month:string,
  rules:DistributionRules|null,
  load:(site:string)=>Promise<SalesView>,
):Promise<AiSource> {
  if (!rules) return {rows:[],coverage:[{source,month,available:false,note:'Catalogul Vodafone nu este configurat.'}]};
  const selection = salesSiteKey(query.site);
  const baseline = await load(selection);
  const {filters,split} = managerAiSalesSiteMode(query);
  const sourceNote = baseline.source==='client-history'?'Istoric comercial pe clienți.':'Import lunar de vânzări. Valori în lei conform raportului Prepay.';
  function complete(rows:AiSourceRow[], through:string|null, note=sourceNote):AiSource {
    return {rows,coverage:[{source,month,available:Boolean(baseline.importedAt),through,revision:String(baseline.revision),note}]};
  }
  function rowsFor(products:SalesProduct[],site:string|null):AiSourceRow[] {
    return products.flatMap(p=>{
      const group = productGroup(rules!,p.itemCode);
      if (!group.startsWith('vodafone_')) return [];
      return [{month,site,sku:p.itemCode,product:p.itemName,brand:p.brand,category:p.category,productGroup:group,
        lines:p.rows,units:p.quantity,valueLei:p.missingValueRows?null:p.value}];
    });
  }
  const baselineThrough = baseline.daily.at(-1)?.date||null;
  if (selection||!split) return complete(rowsFor(baseline.products,selection||null),baselineThrough,
    selection||!baseline.importedAt ? sourceNote : sourceNote+' Datele produselor sunt cumulate pentru gestiunile din selecție.');

  const siteCounts = new Map<string,number>();
  let unknownRows = 0;
  for(const site of baseline.sites){
    const code = salesSiteKey(site.siteCode);
    // HISTORY: values denote the ERP SiteId whose SiteCode could not be mapped.
    if (!code || (baseline.source==='client-history'&&code.startsWith('HISTORY:'))) unknownRows+=site.rows;
    else siteCounts.set(code,(siteCounts.get(code)||0)+site.rows);
  }
  const rows:AiSourceRow[] = [];
  const residual = filters.length===0&&unknownRows>0 ? new Map(baseline.products.map(p=>[productKey(p),{...p}])) : null;
  let through:string|null = null;
  for (const [site,count] of siteCounts) {
    if (filters.some(filter=>!managerAiFilterMatches({site},filter))) continue;
    const scoped = await load(site);
    if (version(scoped)!==version(baseline) || scoped.summary.rows!==count) fail(409,'Sursa vânzărilor sau portofoliul s-a modificat. Reîncarcă raportul.');
    const date = scoped.daily.at(-1)?.date;
    if (date&&(!through||date>through)) through=date;
    rows.push(...rowsFor(scoped.products,site));
    if (residual) for (const product of scoped.products) {
      const balance = residual.get(productKey(product));
      if (!balance) fail(409,'Sursa vânzărilor s-a modificat. Reîncarcă raportul.');
      balance.rows-=product.rows;
      balance.quantity-=product.quantity;
      balance.value=(Math.round(balance.value*100)-Math.round(product.value*100))/100;
      balance.missingValueRows=(balance.missingValueRows||0)-(product.missingValueRows||0);
      if (balance.rows<0||balance.missingValueRows<0) fail(409,'Sursa vânzărilor s-a modificat. Reîncarcă raportul.');
    }
  }
  if (residual) {
    const products=[...residual.values()].filter(p=>p.rows>0);
    if (products.reduce((sum,p)=>sum+p.rows,0)!==unknownRows) fail(409,'Gestiunile raportului nu se reconciliază cu importul de vânzări.');
    rows.push(...rowsFor(products,null));
  }
  return complete(rows,filters.length ? through : baselineThrough,
    sourceNote+(residual?' SiteCode gol pentru rândurile fără cod confirmat.':''));
}
