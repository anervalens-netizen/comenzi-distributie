import type {SalesProduct} from './sales-types';

export type ManagerProductCategory='accessories'|'varta'|'scent'|'phones'|'vouchers'|'other';
export const managerCategoryLabels:Record<ManagerProductCategory,string>={accessories:'Accesorii',varta:'Varta',scent:'Odorizante Q Car',phones:'Telefoane',vouchers:'Cartele valorice / vouchere',other:'Produse de verificat'};
/** Exact configured groups win over the older, broader sales segments. */
export function managerProductCategory(product:SalesProduct):ManagerProductCategory|null{
  const group=product.distributionGroup;
  if(group==='accessories'||group==='varta'||group==='scent')return group;
  if(group&&group!=='unmapped')return null;
  if(product.segment==='phones')return 'phones';
  if(product.subsegment==='vouchers')return 'vouchers';
  if(!group&&product.segment==='cardsSim')return null;
  if(!group&&product.segment==='accessories')return 'accessories';
  // Unmapped SIMs stay inspectable as other products; never mix them into accessories.
  return 'other';
}
export function managerCategoryRows(products:SalesProduct[]){
  const rows=new Map<string,{category:ManagerProductCategory;name:string;quantity:number;valueCents:number;products:SalesProduct[]}>();
  for(const product of products){
    const category=managerProductCategory(product);if(!category)continue;
    const sourceCategory=product.category.trim(),sourceSubCategory=product.subCategory.trim();
    const name=category==='accessories'?(sourceCategory||'Alte accesorii'):category==='other'?[sourceCategory||'Fără categorie în sursă',sourceSubCategory].filter(Boolean).join(' · '):managerCategoryLabels[category];
    // Residual rows retain their source categories; they are not new product mappings.
    const key=JSON.stringify(category==='other'?[category,sourceCategory,sourceSubCategory]:[category,name]),row=rows.get(key)||{category,name,quantity:0,valueCents:0,products:[]};
    row.quantity+=product.quantity;row.valueCents+=Math.round(product.value*100);row.products.push(product);rows.set(key,row);
  }
  return [...rows.values()].sort((a,b)=>b.valueCents-a.valueCents||a.name.localeCompare(b.name,'ro'));
}
