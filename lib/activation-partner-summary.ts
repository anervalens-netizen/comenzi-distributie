import type {ActivationPartner} from './activation-types';

/** Group rows are browse identities; only identified work points enter the denominator. */
export function activationPartnerSummary(rows:ActivationPartner[]){
 const points=new Set<string>();let genericActivations=0,unresolvedActivations=0;
 for(const row of rows){
  if(row.kind==='point')points.add(row.portfolioId?'portfolio:'+row.portfolioId:row.key);
  else if(row.kind==='generic')genericActivations+=row.total;
  else unresolvedActivations+=row.total;
 }
 return {realPointCount:points.size,unassignedActivations:genericActivations+unresolvedActivations,genericActivations,unresolvedActivations};
}
