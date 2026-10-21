import type { Product, Mail } from './types';

export type TransferCategory = 'accessories' | 'phones' | 'stands' | 'sim';
export const transferLabels: Record<TransferCategory,string> = {accessories:'Accesorii',phones:'Telefoane',stands:'Standuri',sim:'SIM-uri'};
export function transferCategory(product: Pick<Product,'kind'|'category'>): TransferCategory | null {
  if(product.kind==='accessories')return 'accessories';
  const category=product.category.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  if(/telefon/.test(category))return 'phones';
  if(/\bsim\b|cartel/.test(category))return 'sim';
  if(/stand/.test(category))return 'stands';
  return null;
}
export const serializedCategory=(category:TransferCategory)=>category==='phones'||category==='sim';
export const validTransferSerial=(category:TransferCategory,serial:string)=>category==='phones'?/^\d{15}$/.test(serial):category==='sim'?/^\d{18,22}$/.test(serial):false;
export type TransferTarget={agentId:string;agentName:string;warehouseId:string;warehouseName:string};
export type TransferLine={id:string;code:string;name:string;category:TransferCategory;quantity:number;serials:string[]};
export type Transfer={id:string;number:string;source:TransferTarget;destination:TransferTarget|null;createdBy:string;createdAt:string;updatedAt:string;finalizedAt:string|null;status:'draft'|'finalized';revision:number;lines:TransferLine[];notes:string;mail?:Mail};
export type TransferView=Transfer&{canEdit:boolean;canDelete:boolean};
