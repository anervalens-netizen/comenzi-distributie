import {territories,type DistributionProject,type DistributionRules,type Territory} from './distribution-rules';
import {isConsumerAccountCode} from './partner-company-identity';
import {canonicalCounty} from './portfolio-facets';

export const focusTerritories = ['sud', 'nord_a', 'nord_b'] as const satisfies readonly Territory[];
export const focusProjects: Record<Territory, DistributionProject> = {
  sud: 'vodafone_sud', nord_a: 'vodafone_nord', nord_b: 'vodafone_nord',
};

export const focusCategories = ['zero3', 'zero5', 'credit', 'package'] as const;
export type FocusCategory = typeof focusCategories[number];
export type FocusKind = 'regional' | 'attributed' | 'possibleStock';
export type FocusDocument = {
  site: string;
  tr: boolean;
  date: string;
  quantity: number;
  source: 'erp' | 'slip';
  reference: string;
  clientCode?: string;
  pointCode?: string;
  company?: string;
  itemCode?: string;
};
export type FocusCounts = {attributed: number; possibleStock: number};
export type FocusSite = FocusCounts & {site: string; label: string};
export type FocusRegional = {
  total: number;
  otherTR: number;
  otherChannels: number;
  unassigned: number;
  unassignedCounty: number;
  consumerCountyUnconfirmed: number;
  sourceConflicts: number;
};
export type FocusMonth = FocusCounts & {
  month: string;
  coveredThrough: string | null;
  complete: boolean;
  regional?: FocusRegional;
};
export type FocusRow = {
  id: string;
  serial?: string;
  date: string;
  county: string;
  category: FocusCategory;
  kind: 'attributed' | 'possibleStock' | 'otherTR' | 'otherChannel' | 'unassigned' | 'consumerCountyUnconfirmed';
  site?: string;
  document?: {date: string; source: FocusDocument['source']; reference?: string};
  clientCode?: string;
  pointCode?: string;
};
export type FocusReport = FocusCounts & {
  revision: string;
  territory: Territory;
  regionalDetails: boolean;
  regional?: FocusRegional;
  months: FocusMonth[];
  sites: FocusSite[];
  detail?: {rows: FocusRow[]; total: number; page: number; hasMore: boolean};
};
export type FocusQuery = {
  territory: Territory;
  historicalSites: string[];
  detail?: FocusKind;
  detailSite?: string;
  includeSerials: boolean;
  exportAll?: boolean;
};

export function focusSiteScope(
  rules: DistributionRules, territory: Territory, historicalSites: string[], sites: string[] | null, manager: boolean,
) {
  const configuredSites = rules.assignments.filter(row => row.territoryId === territory).map(row => row.siteCode.toUpperCase());
  const territorySites = new Set(configuredSites);
  const assigned = new Set(rules.assignments.map(row => row.siteCode.toUpperCase()));
  for (const site of historicalSites) {
    if (!assigned.has(site)) territorySites.add(site);
  }
  const allowed = new Set(sites?.map(site => site.toUpperCase()));
  const regionalDetails = manager && sites === null;
  // Team managers covering the entire configured roster also need the regional
  // aggregate and the territory's closed warehouses.
  const regionalVisible = regionalDetails || (manager && configuredSites.length > 0 &&
    configuredSites.every(site => allowed.has(site)));
  const visible = regionalVisible ? territorySites : new Set([...allowed].filter(site => territorySites.has(site)));
  return {territorySites, visible, regionalDetails, regionalVisible};
}

const southThree = new Set(['AG', 'TR', 'OT', '<UNASSIGNED>']);
export function focusCounty(county: string) {
  return /^<UNASSIGNED>$/i.test(county.trim())
    ? '<UNASSIGNED>'
    : canonicalCounty(county).id?.slice(3) ?? '';
}

export function focusCategory(territory: Territory, county: string, handset: string, simType: string, rechargeValue: unknown): FocusCategory | null {
  const south = territory === 'sud';
  if (!(territories[territory] as readonly string[]).includes(county) && !(south && county === '<UNASSIGNED>')) return null;
  const amount = typeof rechargeValue === 'number' ? rechargeValue :
    typeof rechargeValue === 'string' && /^\d+(?:[.,]\d+)?$/.test(rechargeValue.trim()) ?
      Number(rechargeValue.trim().replace(',', '.')) : NaN;
  if (['SIM_ZERO', 'FREE_SIM'].includes(simType) && amount >= (!south || southThree.has(county) ? 3 : 5)) {
    return amount < 5 ? 'zero3' : 'zero5';
  }
  if (handset === 'SIM with initial credit >= 3 EUR' && (south || simType === 'SIM_5EUR')) return 'credit';
  if (south && handset === 'PACK_SIM') return 'package';
  return null;
}

const documentSite = (document: FocusDocument) => (document.tr ? 'TR:' : 'other:') + document.site;
export function focusAttribution(date: string, documents: FocusDocument[]) {
  const prior = documents.filter(document => document.date <= date);
  let positive = prior.filter(document => document.quantity > 0);
  // A positive document from the only site establishes the historical seller
  // even if a later return cancelled the commercial quantity.
  if (new Set(prior.map(documentSite)).size > 1) {
    positive = [];
    for (const document of prior.sort((a, b) => a.date.localeCompare(b.date))) {
      if (document.quantity > 0) {
        positive.push(document);
        continue;
      }
      // When sites compete, a return can eliminate only an identified earlier
      // ERP sale at the same site, company, customer, point and product.
      if (!document.company || !document.clientCode || !document.pointCode || !document.itemCode) return null;
      const matches = positive.filter(sale => sale.source === 'erp' && sale.date < document.date &&
        sale.company === document.company && sale.clientCode === document.clientCode && sale.pointCode === document.pointCode &&
        sale.itemCode === document.itemCode && documentSite(sale) === documentSite(document));
      if (matches.length !== 1) return null;
      positive = positive.filter(sale => sale !== matches[0]);
    }
  }
  if (positive.length && new Set(positive.map(documentSite)).size === 1) {
    // Multiple documents can establish a single site but leave the work point
    // uncertain. Show client/point identity only if the documents agree.
    const identities = new Set(positive.map(row => JSON.stringify([row.company, row.clientCode, row.pointCode])));
    const document = positive.reduce((latest, row) => row.date > latest.date ? row : latest);
    return {attributed: true, document, uniqueLocation: identities.size === 1,
      consumer: positive.some(sale => isConsumerAccountCode(sale.clientCode || ''))};
  }
  if (prior.length) return null;

  const later = documents.filter(document => document.quantity > 0);
  if (later.length && new Set(later.map(documentSite)).size === 1 && later[0].tr && later[0].site) {
    const document = later.reduce((first, row) => row.date < first.date ? row : first);
    return {attributed: false, document, uniqueLocation: false, consumer: false};
  }
  return null;
}
