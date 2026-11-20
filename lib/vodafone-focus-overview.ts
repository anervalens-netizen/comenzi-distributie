import {emptyActivationCounts, type ActivationReport} from './activation-types';
import type {FocusQuery,FocusReport} from './vodafone-focus';

/** Apply the same certified attribution to the general card and its monthly and TR views. */
export function applyVodafoneFocusOverview(report: ActivationReport, reports: FocusReport[]) {
  const monthly = new Map<string, number>();
  const sites = new Map(report.sites.map(site => [site.site.toUpperCase(), site]));
  for (const focus of reports) {
    for (const month of focus.months) {
      if (month.coveredThrough) monthly.set(month.month, (monthly.get(month.month) ?? 0) + month.attributed);
    }
    for (const site of focus.sites) {
      const summary = sites.get(site.site) ?? {site: site.site, label: site.label, ...emptyActivationCounts()};
      summary.eligible = (summary.eligible ?? 0) + site.attributed;
      sites.set(site.site, summary);
    }
  }
  if (!monthly.size) {
    report.commissionCoverage = reports.length ? 'missing' : 'outside_scope';
    return report;
  }

  report.totals.eligible = [...monthly.values()].reduce((total, value) => total + value, 0);
  report.commissionCoverage = reports.some(focus => focus.months.some(month => !month.complete)) ? 'partial' : 'complete';
  report.sites = [...sites.values()];
  const history = new Map(report.history.map(month => [month.month, month]));
  for (const [month, eligible] of monthly) {
    history.set(month, {...(history.get(month) ?? emptyActivationCounts()), month, eligible});
  }
  report.history = [...history.values()].sort((a, b) => b.month.localeCompare(a.month));
  for (const month of report.monthly ?? []) month.counts.eligible = monthly.get(month.month);
  return report;
}

/** A source error in one territory must not erase the independently valid cards. */
export function readFocusSummaries(
  report:ActivationReport, queries:FocusQuery[], read:(focus:FocusQuery)=>FocusReport|undefined,
  includeCards:boolean, cardsOnly:boolean,
):ActivationReport {
  const summaries:FocusReport[]=[], failed:FocusReport['territory'][]=[];
  for(const focus of queries){
    try{
      const summary=read(focus);
      if(summary)summaries.push(summary);
    }catch{failed.push(focus.territory);}
  }
  const result=cardsOnly?report:applyVodafoneFocusOverview(report,summaries);
  if(failed.length){
    result.commissionCoverage=summaries.some(summary=>summary.months.some(month=>month.coveredThrough))?'partial':'unavailable';
    if(includeCards)result.focusUnavailable=failed;
  }
  if(includeCards)result.focusCards=summaries;
  return result;
}
