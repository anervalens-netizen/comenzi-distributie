import {vodafoneEligibility,territories,type DistributionRules,type DistributionProject} from './distribution-rules';
import type {FocusQuery} from './vodafone-focus';
import {canonicalCounty} from './portfolio-facets';
export type ActivationPolicy='manager'|'north'|'south'|'nonexclusive';
export type ActivationPortfolioPoint={id:string;name:string;client:string;codes:string[]};
export type ActivationQuery={months:string[];projects:DistributionProject[];rules:DistributionRules;policy:ActivationPolicy;analysisLimit?:number;view?:'partners'|'detail'|'export';point?:string;company?:string;q?:string;page?:number;revision?:string;portfolio?:ActivationPortfolioPoint[];portfolioRevision?:string;allPartners?:boolean;todayWindow?:{from:string;to:string};focus?:FocusQuery;focusSummaries?:FocusQuery[];returnFocusCards?:boolean;focusCardsOnly?:boolean;progressiveTotals?:boolean};
export function visibleActivation(provider:string,county:string,handset:string,contradictory:boolean,policy:ActivationPolicy){
  if(policy==='manager')return true;
  if(provider==='digi')return policy==='north'||policy==='nonexclusive';
  const id=canonicalCounty(county).id?.slice(3);
  if(policy==='north')return !!id&&Object.values(territories).some(cs=>(cs as readonly string[]).includes(id));
  return policy==='south'&&!!id&&(territories.sud as readonly string[]).includes(id)&&vodafoneEligibility(county,handset,'sud',contradictory).eligible;
}
