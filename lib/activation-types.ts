import type {DigiOperatorReported} from './digi-operator-source';

import type {FocusReport} from './vodafone-focus';

export type ActivationPartner={key:string;company:string;clientCode:string;pointCode:string;label:string;siteCode?:string;portfolioId?:string;total:number;recentToday?:number;lastDate:string|null;recent:Record<string,number>;kind:'point'|'generic'|'unresolved';vodafoneTargets?:{month:string;units:number}[];};
export type ActivationPartnerSummary={realPointCount:number;unassignedActivations:number;genericActivations:number;unresolvedActivations:number};
export type ActivationDetail={id:string;date:string;itemType:string;county:string;handset:string;eligible:boolean|null;reasons:string[]};
export type ActivationCounts = {total:number;sim:number;telsim:number;other:number;unassigned:number;eligible?:number;ineligible?:number;ownRegion?:number;otherRegion?:number;unknownRegion?:number;reasons?:Record<string,number>};
/** Internal analytical facts. Source identifiers and personal fields are deliberately absent. */
export type ActivationAnalysisDay = {date:string;site:string;itemType:string;sku:string;county:string;handset:string;conflict:number;count:number};
export type ActivationProvider = 'vodafone'|'digi';
export type ActivationProductBreakdown={zero:number;credit:number;packages:number;other:number;unknown:number};
export type ActivationSimZero={distributed:number;activated:number;withoutReportedActivation:number};
export type DigiActivationSource='internal'|'operator';
export type ActivationMonth={month:string;reported:boolean;counts:ActivationCounts;source?:DigiActivationSource;productBreakdown?:ActivationProductBreakdown;simZero?:ActivationSimZero};
export type ActivationReport = {
  /** Opaque provider publication shared by ordinary totals and independently scoped Focus. */
  publication?:string;
  focus?:FocusReport;
  focusCards?:FocusReport[];
  focusUnavailable?:FocusReport['territory'][];
  separateFocusScope?:boolean;
  commissionCoverage?:'complete'|'partial'|'missing'|'outside_scope'|'unavailable';
  focusWorkbook?:string;
  /** Optional panels may still be loading when authorized totals and history are available. */
  monthly?:ActivationMonth[];
  analysisDays?:ActivationAnalysisDay[];
  /** Full operator count; never exposed to scoped managers or agents. */
  operatorReported?:DigiOperatorReported;
  partners?:ActivationPartnerSummary&{rows:ActivationPartner[];total:number;page:number;hasMore:boolean;asOf:string|null};
  detail?:{rows:ActivationDetail[];total:number;page:number;hasMore:boolean;lastDate:string|null;recent:Record<string,number>;asOf:string|null};
  revision?:string;rulesRevision?:string;builtAt?:string;selectedMonths?:string[];coveredMonths?:string[];sourcePeriods?:{from:string;to:string}[];reconciliation?:number;
  productBreakdown?:ActivationProductBreakdown;
  ineligibleSourceTypes?:Record<string,number>;
  simZero?:ActivationSimZero;
  month:string;provider:ActivationProvider;available:boolean;scoped:boolean;importedAt:string;latestDate:string|null;
  months:{month:string;total:number}[];totals:ActivationCounts;
  sites:({site:string;label:string}&ActivationCounts)[];
  history:({month:string;source?:DigiActivationSource}&ActivationCounts)[];
};
export const emptyActivationCounts=():ActivationCounts=>({total:0,sim:0,telsim:0,other:0,unassigned:0});

export type CombinedActivationPartners={provider:'both';showDigi?:boolean;vodafoneTargetStatus?:'available'|'missing'|'unavailable';recentWindow?:{from:string;to:string};operators:Record<string,{available:boolean;latestDate?:string|null;importedAt?:string;error?:string}>;revision:string;partners:ActivationPartnerSummary&{rows:(ActivationPartner&{vodafone:number;digi:number})[];total:number;page:number;hasMore:boolean}};
