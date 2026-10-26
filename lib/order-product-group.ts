import type {Product} from './types';

export type OrderProductGroup='accessories'|'stands'|'merchandising';
export const orderProductGroupLabels:Record<OrderProductGroup,string>={accessories:'Accesorii',stands:'Cartele, telefoane & standuri',merchandising:'Mercantizare și consumabile'};
/** Presentation groups retain product identity, export routing and saved drafts. */
export function orderProductGroup(product:Pick<Product,'kind'|'category'>):OrderProductGroup{
 if(product.kind==='accessories')return 'accessories';
 const category=product.category.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
 return ['role','consumabile','mercantizare','mercantizare vodafone'].includes(category)?'merchandising':'stands';
}
