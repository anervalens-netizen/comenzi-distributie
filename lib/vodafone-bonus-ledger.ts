import {firstVodafoneBonusMonth, type VodafoneBonusAllocation, type VodafoneBonusDocument, type VodafoneBonusMonth, type VodafoneBonusPoint, type VodafoneBonusReport, type VodafoneBonusScope, type VodafoneBonusUnresolved, type VodafoneTopLocation} from './vodafone-bonus-types';
import {vodafoneSim0Bonus} from './vodafone-bonus-rules';

export type BonusActivation = {
  month: string;
  site: string;
  pointCode: string | null;
  cui: string;
  partner: string;
  reason: VodafoneBonusUnresolved['reason'] | 'excluded';
};
export type BonusLedgerInput = {
  activation: BonusActivation[];
  documents: Omit<VodafoneBonusDocument, 'allocations'>[];
  coverage: Pick<VodafoneBonusMonth, 'month' | 'sourceThrough' | 'publishedOn'>[];
  targets: readonly VodafoneTopLocation[];
  portfolios: {pointCode: string; cui: string; partner: string; sites: string[]}[];
  revision: string;
};
type Position = {
  month: string;
  pointCode: string;
  cui: string;
  partner: string;
  sites: Map<string, {activations: number; confirmed: number}>;
  top: VodafoneTopLocation | undefined;
  pending: void | {simulation: number; confirmedSim0: number; confirmedTop: number};
  simulatedApplied: number;
  applied: number;
  given: number;
  candidate: number;
};
function addSite(row: Position, site: string) {
  let contribution = row.sites.get(site);
  if (!contribution) row.sites.set(site, contribution = {activations: 0, confirmed: 0});
  return contribution;
}
const pointMonth = (point: string, month: string) => JSON.stringify([point, month]);
const sum = (row: Position) => [...row.sites.values()].reduce((total, item) => total + item.activations, 0);
const confirmedSum = (row: Position) => [...row.sites.values()].reduce((total, item) => total + item.confirmed, 0);

export function vodafoneBonusLedger(input: BonusLedgerInput, scope: VodafoneBonusScope, selectedMonth: string | null): VodafoneBonusReport {
  const permitted = scope === null ? null : new Set(scope);
  const allowed = (site: string) => permitted === null || permitted.has(site);
  const visibleMonth = (month: string) => !selectedMonth || month === selectedMonth;
  const portfolio = new Map(input.portfolios.map(point => [point.pointCode, point]));
  const targets = new Map(input.targets.map(target => [pointMonth(target.pointCode, target.month), target]));
  const coverage = new Map(input.coverage.map(source => [source.month, {...source, activations: 0, confirmedActivations: 0, unresolvedActivations: 0}]));
  const positions = new Map<string, Position>();
  const byPoint = new Map<string, Position[]>();
  const unresolved = new Map<string, VodafoneBonusUnresolved>();
  const unresolvedCompanies = new Set<string>();
  const uncertainDocuments = new Set<string>();
  const historySites = new Map<string, Set<string>>();
  function position(pointCode: string, month: string, cui: string, partner: string) {
    const key = pointMonth(pointCode, month);
    let row = positions.get(key);
    if (!row) {
      row = {month,pointCode,cui,partner,sites:new Map(),top:targets.get(key),pending:undefined,simulatedApplied:0,applied:0,given:0,candidate:0};
      positions.set(key, row);
      const history = byPoint.get(pointCode);
      if (history) history.push(row);
      else byPoint.set(pointCode,[row]);
    }
    return row;
  }
  const linkSite = (code: string, site: string) => {
    const sites = historySites.get(code) || new Set<string>();
    sites.add(site);
    historySites.set(code, sites);
  };
  for (const row of input.activation) {
    if (row.reason === 'excluded') continue;
    const {month,site,cui,partner,reason} = row;
    const summary = coverage.get(month);
    if (!summary) continue;
    if (allowed(site)) {
      summary.activations++;
      if (reason === 'commercial' && row.pointCode) summary.confirmedActivations++;
      if (!row.pointCode) summary.unresolvedActivations++;
    }
    if (row.pointCode) {
      const point = position(row.pointCode,month,cui,partner);
      const contribution = addSite(point,site);
      contribution.activations++;
      if (reason === 'commercial') contribution.confirmed++;
      linkSite(row.pointCode,site);
      continue;
    }
    if (cui) unresolvedCompanies.add(cui);
    if (!allowed(site) || !visibleMonth(month)) continue;
    const key = JSON.stringify([month,site,cui,reason]);
    const item = unresolved.get(key) || {month,site,cui,partner,reason,count:0};
    item.count++;
    unresolved.set(key,item);
  }
  for (const {pointCode,month} of input.targets) {
    const known = portfolio.get(pointCode);
    if (!known || !coverage.has(month)) continue;
    const row = position(pointCode,month,known.cui,known.partner);
    for (const site of known.sites) {
      addSite(row,site);
      linkSite(pointCode,site);
    }
  }
  for (const doc of input.documents) {
    const {pointCode,reason,quantity,sites,cui,partner} = doc;
    if (!pointCode) {
      if (cui && reason !== 'mixed') unresolvedCompanies.add(cui);
      continue;
    }
    if (reason !== 'commercial' && reason !== 'mixed') uncertainDocuments.add(pointCode);
    if (reason !== 'commercial' && reason !== 'document-unknown') continue;
    if (quantity === null) continue;
    const row = position(pointCode,doc.date.slice(0,7),cui,partner);
    if (reason === 'commercial') row.given += quantity;
    else row.candidate += quantity;
    for (const site of sites) {
      addSite(row,site);
      linkSite(pointCode,site);
    }
  }
  for (const history of byPoint.values()) history.sort((a,b) => a.month.localeCompare(b.month));
  function canConfirm(row: Position) {
    return row.top?.bonus != null && coverage.get(row.month)?.publishedOn && sum(row) === confirmedSum(row) &&
      !uncertainDocuments.has(row.pointCode) && !unresolvedCompanies.has(row.cui);
  }
  for (const row of positions.values()) {
    const eligible = canConfirm(row);
    row.pending = {simulation: vodafoneSim0Bonus(sum(row)),confirmedSim0: eligible ? vodafoneSim0Bonus(sum(row)) : 0,confirmedTop: eligible ? row.top?.bonus ?? 0 : 0};
  }
  const fullyVisible = (point: string) => [...(historySites.get(point) || [])].every(allowed);
  const documents: VodafoneBonusDocument[] = [];
  const ordered = [...input.documents].sort((a,b) => a.date.localeCompare(b.date) || a.company.localeCompare(b.company) || a.siteId.localeCompare(b.siteId) || a.number.localeCompare(b.number));
  for (const doc of ordered) {
    const inScope = permitted === null || (doc.sites.length > 0 && doc.sites.every(allowed));
    const allocations: VodafoneBonusAllocation[] = [];
    if (doc.pointCode && doc.quantity && (doc.reason === 'commercial' || doc.reason === 'document-unknown')) {
      let remainingForSimulation = doc.quantity;
      let remainingConfirmed = doc.reason === 'commercial' ? doc.quantity : 0;
      for (const row of byPoint.get(doc.pointCode) || []) {
        if (row.month >= doc.date.slice(0,7)) break;
        const pending = row.pending!;
        if (remainingForSimulation && pending.simulation) {
          const quantity = Math.min(remainingForSimulation,pending.simulation);
          pending.simulation -= quantity;
          remainingForSimulation -= quantity;
          row.simulatedApplied += quantity;
          allocations.push({month:row.month,kind:'SIM 0',quantity,status:'simulation'});
        }
        // An older unverified right stops definitive allocation to newer rights.
        const publication = coverage.get(row.month)?.publishedOn;
        if ((sum(row) >= 3 || row.top?.bonus) && (!canConfirm(row) || !publication || publication > doc.date)) remainingConfirmed = 0;
        if (!remainingConfirmed || !publication || publication > doc.date) continue;
        for (const [balance, kind] of [['confirmedSim0','SIM 0'],['confirmedTop','Top Locații']] as const) {
          const quantity = Math.min(remainingConfirmed,pending[balance]);
          if (!quantity) continue;
          pending[balance] -= quantity;
          remainingConfirmed -= quantity;
          row.applied += quantity;
          allocations.push({month:row.month,kind,quantity,status:'confirmed'});
        }
      }
    }
    // Include documents in the selected month or settling rights earned in it.
    if (inScope && (visibleMonth(doc.date.slice(0,7)) || (doc.pointCode && fullyVisible(doc.pointCode) && allocations.some(row => visibleMonth(row.month))))) {
      documents.push({...doc,allocations: doc.pointCode && fullyVisible(doc.pointCode) ? allocations : []});
    }
  }
  const points: VodafoneBonusPoint[] = [];
  for (const row of positions.values()) {
    if (!visibleMonth(row.month)) continue;
    const sites = [...row.sites.entries()].filter(([site]) => allowed(site)).sort(([a],[b]) => a.localeCompare(b))
      .map(([site, counts]) => ({site,...counts}));
    if (!sites.length) continue;
    const activations = sites.reduce((total, item) => total + item.activations,0);
    const confirmedActivations = sites.reduce((total,item) => total + item.confirmed,0);
    const partial = !fullyVisible(row.pointCode);
    const sim0Bonus = partial ? null : vodafoneSim0Bonus(activations);
    const topBonus = partial ? null : row.top?.bonus ?? null;
    const totalBonus = sim0Bonus !== null && topBonus !== null ? sim0Bonus + topBonus : null;
    points.push({
      month:row.month,pointCode:row.pointCode,cui:row.cui,partner:row.partner,sites,activations,confirmedActivations,
      target:row.top?.target ?? null,topBonus,sim0Bonus,totalBonus,
      givenOnDocuments:partial ? 0 : row.given,candidateOnDocuments:partial ? 0 : row.candidate,
      applied:partial || !canConfirm(row) ? null : row.applied,
      remaining:partial || !canConfirm(row) || totalBonus === null ? null : totalBonus - row.applied,
      simulatedApplied:partial ? null : row.simulatedApplied,
      simulatedRemaining:sim0Bonus === null ? null : sim0Bonus - row.simulatedApplied,partial,
    });
  }
  points.sort((a,b) => b.month.localeCompare(a.month) || b.activations - a.activations || a.pointCode.localeCompare(b.pointCode));
  return {
    fromMonth:firstVodafoneBonusMonth,selectedMonth,revision:input.revision,
    months:[...coverage.values()],points,documents,
    unresolved:[...unresolved.values()].sort((a,b)=>b.month.localeCompare(a.month)||b.count-a.count),
    fiscalKindsComplete:!points.some(row=>row.activations !== row.confirmedActivations) && !documents.some(doc=>doc.reason==='document-unknown'),
  };
}
