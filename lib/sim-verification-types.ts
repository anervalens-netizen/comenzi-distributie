export type SimSale = {company:string;serial:string;seller:string;kind:'agent'|'store'|'central'|'inventory';date:string|null;receipt:string;quantity:number|null};
export type SimVerification = {provider:'vodafone'|'digi';serial:string;status:'sold'|'returned'|'ambiguous'|'recorded'|'not_found';importedAt:string;sourceDate:string;sale:SimSale|null;history:SimSale[]};
