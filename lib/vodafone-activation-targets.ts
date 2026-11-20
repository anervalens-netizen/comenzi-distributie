import type { ActivationPartner, CombinedActivationPartners } from './activation-types';
import { bucharestMonthKey } from './bucharest-month';
import { managerFilter } from './manager-scope';
import { normalizedCui } from './partner-company-identity';
import { partnerScope } from './partner-portfolio';
import { db, isGlobalManager } from './server';
import type { User } from './types';
import { readVodafoneTopLocations } from './vodafone-top-locations';

function targetMonths(params: URLSearchParams): Set<string> {
  return new Set(params.has('months')
    ? params.getAll('months').flatMap(value => value.split(',')).filter(Boolean)
    : [params.get('month') || bucharestMonthKey(new Date())]);
}

type PortfolioRow = { id: string; data: string };
type PortfolioCodes = { cui?: string; historyFranchises?: string[]; historyCatalog?: { franchiseCode?: string }; crm?: { franchiseCode?: string } };

async function visiblePortfolio(user: User, params: URLSearchParams, rows: ActivationPartner[]) {
  const ids = [...new Set(rows.flatMap(row => row.portfolioId ? [row.portfolioId] : []))];
  const result = new Map<string, { cui: string; points: Set<string> }>();
  if (!ids.length) return result;
  const scope = partnerScope(user);
  const filter = user.role === 'manager' ? await managerFilter(user, params).catch(() => undefined) : null;
  if (filter === undefined) return result;
  const sites = params.has('siteCode') ? [params.get('siteCode')?.trim().toUpperCase() || ''] : [];
  const warehouseFilter = filter || sites.length
    ? ` AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w
      JOIN users a ON a.role='agent' AND a.active=1 AND a.warehouse_id=w.value
      WHERE (? IS NULL OR a.id IN (SELECT value FROM json_each(?)))
      AND (?=0 OR UPPER(TRIM(a.site_code)) IN (SELECT value FROM json_each(?))))`
    : '';
  const selectedAgents = filter ? JSON.stringify(filter.agentIds) : null;
  const bind = warehouseFilter ? [selectedAgents, selectedAgents, sites.length, JSON.stringify(sites)] : [];
  const partners = await db().prepare(`SELECT c.id,c.data FROM customers c
    WHERE c.active=1 AND c.id IN (SELECT value FROM json_each(?)) AND ${scope.sql}${warehouseFilter}`)
    .bind(JSON.stringify(ids), ...scope.args, ...bind).all<PortfolioRow>();
  for (const row of partners.results) {
    const p = JSON.parse(row.data) as PortfolioCodes;
    const points = [p.crm?.franchiseCode, p.historyCatalog?.franchiseCode, ...(p.historyFranchises || [])];
    result.set(row.id, { cui: normalizedCui(p.cui || ''), points: new Set(points.filter(Boolean).map(code => code!.trim().toUpperCase())) });
  }
  return result;
}

export async function applyVodafoneActivationTargets(user: User, params: URLSearchParams, report: CombinedActivationPartners) {
  const campaigns = await readVodafoneTopLocations().catch(() => null);
  if (campaigns === null) return { ...report, vodafoneTargetStatus: 'unavailable' as const };
  const months = targetMonths(params);
  const targets = new Map<string, { month: string; units: number }[]>();
  for (const row of campaigns) {
    if (!months.has(row.month)) continue;
    const values = targets.get(row.pointCode) || [];
    values.push({ month: row.month, units: row.target });
    targets.set(row.pointCode, values);
  }
  if (!targets.size) return { ...report, vodafoneTargetStatus: 'missing' as const };
  const global = isGlobalManager(user) && !params.has('managerId') && !params.has('agentId') && !params.has('siteCode');
  const portfolio = global ? null : await visiblePortfolio(user, params, report.partners.rows);
  const rows = report.partners.rows.map(row => {
    const point = row.pointCode.trim().toUpperCase();
    if (row.kind !== 'point' || !point || !targets.has(point)) return row;
    if (portfolio) {
      const owner = portfolio.get(row.portfolioId || '');
      if (!owner || owner.cui !== normalizedCui(row.clientCode) || !owner.points.has(point)) return row;
    }
    return { ...row, vodafoneTargets: targets.get(point)!.sort((a, b) => a.month.localeCompare(b.month)) };
  });
  return { ...report, vodafoneTargetStatus: 'available' as const, partners: { ...report.partners, rows } };
}
