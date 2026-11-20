import {createHash} from 'node:crypto';
import {compareActivationPartners} from './activation-partner-sort';
import {activationPartnerSummary} from './activation-partner-summary';
import type {ActivationReport,CombinedActivationPartners} from './activation-types';
import {portfolioPlaceholder,type CombinedPartnerRead} from './activation-portfolio';
import type {ActivationPortfolioPoint,ActivationQuery} from './activation-distribution';

const hash = (value:string)=>createHash('sha256').update(value).digest('hex');
type ReadProvider=(month:string,sites:string[]|null,provider:'vodafone'|'digi',query:ActivationQuery)=>ActivationReport;
export function combinePartnerReports(input:CombinedPartnerRead, portfolio:ActivationPortfolioPoint[], read:ReadProvider) {
  const recentWindow = input.query.todayWindow!;
  const networkQuery = {...input.query, page:0, revision:undefined, allPartners:true, combinedPartnerRows:true, portfolio, portfolioRevision:hash(JSON.stringify(portfolio))};
  const operators: CombinedActivationPartners['operators'] = {};
  const groups = new Map<string, CombinedActivationPartners['partners']['rows'][number]>();
  const revisions:string[] = [];
  let hasPartnerSource=false;
  for (const network of ['vodafone', 'digi'] as const) {
    let report: ActivationReport;
    try {
      report = read(input.month, input.sites, network, networkQuery);
    } catch {
      operators[network] = {available: false, error: 'Datele operatorului nu sunt disponibile.'};
      revisions.push('unavailable');
      continue;
    }
    if(report.partners)hasPartnerSource=true;
    operators[network] = {available: report.available, latestDate: report.latestDate, importedAt: report.importedAt};
    revisions.push(report.revision || '');
    for (const point of report.partners?.rows || []) {
      const entry = groups.get(point.key) ?? {
        ...point, total: 0, recentToday: 0, vodafone: 0, digi: 0, recent: {'7': 0, '14': 0, '30': 0},
      };
      entry.total += point.total;
      entry.recentToday = (entry.recentToday || 0) + (point.recentToday || 0);
      entry[network] += point.total;
      for (const days of ['7', '14', '30']) entry.recent[days] += point.recent[days] || 0;
      if (point.lastDate && (!entry.lastDate || point.lastDate > entry.lastDate)) entry.lastDate = point.lastDate;
      groups.set(point.key, entry);
    }
  }
  const revision = hash(JSON.stringify([revisions,input.userId,...input.selectionParams,input.sort,input.direction,recentWindow,input.showDigi]));

  const allPoints = [...groups.values()];
  const hasActivations = (point: typeof allPoints[number]) => point.total > 0 || (point.recentToday || 0) > 0;
  const represented = new Set(allPoints.filter(hasActivations).map(point => point.portfolioId).filter(Boolean));
  const points = allPoints.filter(point => hasActivations(point) || !point.portfolioId || !represented.has(point.portfolioId));
  if(hasPartnerSource && !input.query.q){
    for(const p of portfolio){
      const key='portfolio:'+p.id;
      if(p.client==='CLIENTGEN'||represented.has(p.id)||groups.has(key))continue;
      points.push({...portfolioPlaceholder(p),recentToday:0,vodafone:0,digi:0});
    }
  }
  points.sort((a, b) => compareActivationPartners(a, b, input.sort, input.direction));
  return {provider:'both' as const,showDigi:input.showDigi,recentWindow,operators,revision,
    partners:{...activationPartnerSummary(points),rows:points,total:points.length,page:0,hasMore:false}};
}
