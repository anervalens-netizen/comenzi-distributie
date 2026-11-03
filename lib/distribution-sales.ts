import {managerCategoryRows,type ManagerProductCategory} from './manager-sales-report';
import {salesValueExVat} from './sales-vat';
import {productGroup,type DistributionRules,type ProductGroup} from './distribution-rules';
import type {SalesView} from './sales-types';
export type DistributionSalesMetric={quantity:number;valueCents:number;average:number|null;valueExVat?:number;missingValueRows?:number};
export type DistributionSales={rulesRevision:string;groups:Record<ProductGroup,DistributionSalesMetric>;vodafoneCredit:DistributionSalesMetric;months:string[];missingMonths:string[];historicalMonths?:string[];monthly?:DistributionSalesMonth[]};
export type DistributionSalesMonth={month:string;imported:boolean;source?:'client-history';groups:DistributionSales['groups'];vodafoneCredit:DistributionSalesMetric;missingValueRows:number;categories:Partial<Record<ManagerProductCategory,DistributionSalesMetric>>};
const blank=():DistributionSalesMetric=>({quantity:0,valueCents:0,average:null});
/** Integer monetary sums; means are recomputed after union, excluding all zero-credit SIMs. */
export function distributionSales(views:SalesView[],rules:DistributionRules,months:string[],includeMonthly=true):DistributionSales{
 const groups=Object.fromEntries(['vodafone_0','vodafone_3','vodafone_5','vodafone_credit','digi','accessories','varta','scent','unmapped'].map(k=>[k,blank()])) as DistributionSales['groups'];
 const unknownVat=new Set<ProductGroup>();
 for(const view of views)for(const p of view.products){const key=productGroup(rules,p.itemCode),g=groups[key];g.missingValueRows=(g.missingValueRows||0)+(p.missingValueRows||0);g.quantity+=p.quantity;g.valueCents+=Math.round(p.value*100);if(['accessories','varta','scent'].includes(key)){const net=p.valueExVat??salesValueExVat(p.value,view.month);if(net===undefined)unknownVat.add(key);else g.valueExVat=(g.valueExVat??0)+net;}}
 for(const key of unknownVat)groups[key].valueExVat=undefined;
 const vodafoneCredit=blank();for(const key of ['vodafone_3','vodafone_5','vodafone_credit'] as const){vodafoneCredit.missingValueRows=(vodafoneCredit.missingValueRows||0)+(groups[key].missingValueRows||0);vodafoneCredit.quantity+=groups[key].quantity;vodafoneCredit.valueCents+=groups[key].valueCents;}
 for(const g of [...Object.values(groups),vodafoneCredit])g.average=g.quantity>0&&g.valueCents>=0?g.valueCents/100/g.quantity:null;
 const monthly=includeMonthly?months.map(month=>{const view=views.find(v=>v.month===month);const totals=distributionSales(view?[view]:[],rules,[month],false);const categories:DistributionSalesMonth['categories']={};for(const row of managerCategoryRows((view?.products||[]).map(p=>({...p,category:p.category||'',subCategory:p.subCategory||''})))){const g=categories[row.category]||{quantity:0,valueCents:0,average:null,valueExVat:0};g.missingValueRows=(g.missingValueRows||0)+(row.missingValueRows||0);g.quantity+=row.quantity;g.valueCents+=row.valueCents;g.valueExVat=g.valueExVat!==undefined&&row.valueExVat!==undefined?g.valueExVat+row.valueExVat:undefined;categories[row.category]=g;}return {month,categories,imported:!!view?.filename,source:view?.source,groups:totals.groups,vodafoneCredit:totals.vodafoneCredit,missingValueRows:view?.missingValueRows||0};}):undefined;
 return {rulesRevision:rules.revision,groups,vodafoneCredit,months,missingMonths:months.filter(m=>!views.some(v=>v.month===m&&v.filename)),historicalMonths:views.filter(v=>v.source==='client-history').map(v=>v.month),...(monthly?{monthly}: {})};
}
export function combineSalesViews(views:SalesView[],fallback:SalesView):SalesView{
 const result=structuredClone(views[0]||fallback);result.summary={rows:0,quantity:0,value:0};result.products=[];result.sites=[];result.daily=[];result.monthly=views.flatMap(v=>v.monthly);
 result.source=views.length&&views.every(v=>v.source==='client-history')?'client-history':undefined;result.missingValueRows=views.reduce((n,v)=>n+(v.missingValueRows||0),0);
 const products=new Map<string,SalesView['products'][number]>(),sites=new Map<string,SalesView['sites'][number]>();
 for(const v of views){result.summary.rows+=v.summary.rows;result.summary.quantity+=v.summary.quantity;result.summary.value=Math.round((result.summary.value+v.summary.value)*100)/100;
   for(const p of v.products){const key=JSON.stringify([p.itemCode,p.itemName,p.brand,p.category,p.subCategory]);const a=products.get(key)||{...p,rows:0,quantity:0,value:0,valueExVat:0,missingValueRows:0};a.missingValueRows=(a.missingValueRows||0)+(p.missingValueRows||0);a.valueExVat=a.valueExVat!==undefined&&p.valueExVat!==undefined?a.valueExVat+p.valueExVat:undefined;a.rows+=p.rows;a.quantity+=p.quantity;a.value=Math.round((a.value+p.value)*100)/100;products.set(key,a);}
   for(const p of v.sites){const key=JSON.stringify([p.siteCode,p.location]);const a=sites.get(key)||{...p,rows:0,quantity:0,value:0};a.rows+=p.rows;a.quantity+=p.quantity;a.value=Math.round((a.value+p.value)*100)/100;sites.set(key,a);}
 }
 result.products=[...products.values()];result.sites=[...sites.values()];result.daily=views.flatMap(v=>v.daily).sort((a,b)=>a.date.localeCompare(b.date));
 // Segment summaries use the same disjoint union as product rows.
 for(const key of ['accessories','cardsSim','phones','unclassified'] as const){const group=result.segments[key];group.summary={rows:0,quantity:0,value:0};group.products=result.products.filter(p=>p.segment===key);for(const p of group.products){group.summary.rows+=p.rows;group.summary.quantity+=p.quantity;group.summary.value=Math.round((group.summary.value+p.value)*100)/100;}}
 for(const key of ['cards','sim','vouchers','valueVouchers'] as const){const target=result.segments.cardsSim.subsegments[key];target.rows=0;target.quantity=0;target.value=0;for(const v of views){const p=v.segments.cardsSim.subsegments[key];target.rows+=p.rows;target.quantity+=p.quantity;target.value=Math.round((target.value+p.value)*100)/100;}}
 result.filename=views.some(v=>v.filename)?'Perioade selectate':null;return result;
}
