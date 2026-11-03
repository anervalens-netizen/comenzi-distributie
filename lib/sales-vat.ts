import {managerProductCategory} from './manager-sales-report';
import type {SalesView} from './sales-types';

// Source sales values include Romanian standard VAT. Derive reporting values
// without changing imported cents. Keep precision until final display so totals
// reconcile across products, returns and selections spanning the rate change.
export function salesValueExVat(value:number,month:string):number|undefined {
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'2017-01')return undefined;
 return value*100/(month<'2025-08'?119:121);
}
export function withSalesVat(view:SalesView):SalesView {
 return {...view,products:view.products.map(product=>({...product,valueExVat:['accessories','varta','scent'].includes(managerProductCategory(product)??'')?salesValueExVat(product.value,view.month):undefined}))};
}
