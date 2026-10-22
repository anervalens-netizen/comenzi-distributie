export type ActivationCounts = {total:number;sim:number;telsim:number;other:number;unassigned:number};
export type ActivationProvider = 'vodafone'|'digi';
export type ActivationReport = {
  month:string;provider:ActivationProvider;available:boolean;scoped:boolean;importedAt:string;latestDate:string|null;
  months:{month:string;total:number}[];totals:ActivationCounts;
  sites:({site:string;label:string}&ActivationCounts)[];
  history:({month:string}&ActivationCounts)[];
};
export const emptyActivationCounts=():ActivationCounts=>({total:0,sim:0,telsim:0,other:0,unassigned:0});
