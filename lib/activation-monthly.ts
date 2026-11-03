import type {ActivationReport,ActivationCounts} from './activation-types';
export type ActivationTrendMetric=keyof Pick<ActivationCounts,'total'|'eligible'|'ineligible'|'ownRegion'|'otherRegion'|'unknownRegion'>|`product:${'zero'|'credit'|'packages'|'other'|'unknown'}`|`cohort:${'distributed'|'activated'|'withoutReportedActivation'}`;
export function activationMonthlyPoints(report:ActivationReport,months:string[],metric:ActivationTrendMetric){
 return [...new Set(months)].sort().map(month=>{
  const entry=report.monthly?.find(p=>p.month===month),history=report.history.find(p=>p.month===month);
  const cohort=metric.startsWith('cohort:'),product=metric.startsWith('product:');
  const value=cohort?entry?.simZero?.[metric.slice(7) as 'distributed'|'activated'|'withoutReportedActivation']:product?entry?.productBreakdown?.[metric.slice(8) as 'zero'|'credit'|'packages'|'other'|'unknown']:(entry?.counts||history)?.[metric as keyof ActivationCounts];
  const reported=report.available&&(cohort?entry?.simZero!==undefined:entry?.reported??!!history);
  return {month,reported:reported&&typeof value==='number',total:typeof value==='number'?value:null};
 });
}
