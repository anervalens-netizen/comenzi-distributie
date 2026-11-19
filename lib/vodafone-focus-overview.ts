import {emptyActivationCounts, type ActivationReport} from './activation-types';
import type {FocusReport} from './vodafone-focus';

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
      summary.eligible = site.attributed;
      sites.set(site.site, summary);
    }
  }
  if (!monthly.size) return report;

  report.totals.eligible = [...monthly.values()].reduce((total, value) => total + value, 0);
  report.commissionPartial = reports.some(focus => focus.months.some(month => !month.complete));
  report.sites = [...sites.values()];
  const history = new Map(report.history.map(month => [month.month, month]));
  for (const [month, eligible] of monthly) {
    history.set(month, {...(history.get(month) ?? emptyActivationCounts()), month, eligible});
  }
  report.history = [...history.values()].sort((a, b) => b.month.localeCompare(a.month));
  for (const month of report.monthly ?? []) month.counts.eligible = monthly.get(month.month);
  return report;
}
