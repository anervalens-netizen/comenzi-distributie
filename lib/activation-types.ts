export type ActivationPartner={key:string;company:string;clientCode:string;pointCode:string;label:string;portfolioId?:string;total:number;lastDate:string|null;recent:Record<string,number>;kind:'point'|'generic'|'unresolved';};
export type ActivationDetail={id:string;date:string;itemType:string;county:string;handset:string;eligible:boolean|null;reasons:string[]};
export type ActivationCounts = {total:number;sim:number;telsim:number;other:number;unassigned:number;eligible?:number;ineligible?:number;ownRegion?:number;otherRegion?:number;unknownRegion?:number;reasons?:Record<string,number>};
export type ActivationProvider = 'vodafone'|'digi';
export type ActivationReport = {
  partners?:{rows:ActivationPartner[];total:number;page:number;hasMore:boolean;asOf:string|null};
  detail?:{rows:ActivationDetail[];total:number;page:number;hasMore:boolean;lastDate:string|null;recent:Record<string,number>;asOf:string|null};
  revision?:string;rulesRevision?:string;builtAt?:string;selectedMonths?:string[];coveredMonths?:string[];sourcePeriods?:{from:string;to:string}[];reconciliation?:number;
  simZero?:{distributed:number;activated:number;withoutReportedActivation:number};
  month:string;provider:ActivationProvider;available:boolean;scoped:boolean;importedAt:string;latestDate:string|null;
  months:{month:string;total:number}[];totals:ActivationCounts;
  sites:({site:string;label:string}&ActivationCounts)[];
  history:({month:string}&ActivationCounts)[];
};
export const emptyActivationCounts=():ActivationCounts=>({total:0,sim:0,telsim:0,other:0,unassigned:0});

export type CombinedActivationPartners={provider:'both';operators:Record<string,{available:boolean;latestDate?:string|null;importedAt?:string;error?:string}>;revision:string;partners:{rows:(ActivationPartner&{vodafone:number;digi:number})[];total:number;page:number;hasMore:boolean}};
