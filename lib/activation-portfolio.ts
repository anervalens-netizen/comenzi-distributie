import {normalizedCui} from './partner-company-identity';
import type {ActivationPartner} from './activation-types';
import type {ActivationPortfolioPoint,ActivationQuery} from './activation-distribution';
import type {ActivationPartnerSort,ActivationSortDirection} from './activation-partner-sort';

export type ActivationPortfolioScope = { selected: string[]; owned: string[] | null };
export type CombinedPartnerRead = {
  userId: string; profileVersion: string; role: string; managerScope: string;
  month: string; sites: string[] | null; query: ActivationQuery; scope: ActivationPortfolioScope;
  selectionParams: (string|null)[]; crmRevision: number; showDigi: boolean; sort: ActivationPartnerSort; direction: ActivationSortDirection;
};
export type PortfolioFields = {id:string; name:string|null; cui:string|null; franchises:string|null; historyCode:string|null; crmCode:string|null};

export function portfolioSelection(scope: ActivationPortfolioScope) {
  const ids = 'SELECT customer_id FROM activation_portfolio_memberships WHERE warehouse_id IN (SELECT value FROM json_each(?))';
  const select = `SELECT c.id,json_extract(c.data,'$.name') name,json_extract(c.data,'$.cui') cui,
    json_extract(c.data,'$.historyFranchises') franchises,json_extract(c.data,'$.historyCatalog.franchiseCode') historyCode,
    json_extract(c.data,'$.crm.franchiseCode') crmCode FROM customers c WHERE c.active=1 AND c.id IN (${ids})`;
  return {
    sql: select + (scope.owned === null ? '' : ` AND c.id IN (${ids})`) + ' ORDER BY c.id',
    args: scope.owned === null ? [JSON.stringify(scope.selected)] : [JSON.stringify(scope.selected), JSON.stringify(scope.owned)],
  };
}
export function portfolioPoint(row: PortfolioFields): ActivationPortfolioPoint {
  const codes = [...(JSON.parse(row.franchises || '[]') || []),row.historyCode,row.crmCode]
    .filter(Boolean).map(value=>String(value).trim().toUpperCase());
  return {id:row.id,name:row.name||'',client:normalizedCui(row.cui||''),codes:[...new Set<string>(codes)]};
}

export function portfolioPlaceholder(p:ActivationPortfolioPoint):ActivationPartner {
  return {key:'portfolio:'+p.id,company:'',clientCode:p.client,pointCode:p.codes.length===1?p.codes[0]:'',
    label:p.name,portfolioId:p.id,total:0,lastDate:null,recent:{'7':0,'14':0,'30':0},kind:'point'};
}
