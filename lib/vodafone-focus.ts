import {territories,type DistributionProject,type Territory} from './distribution-rules';
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
};
export type FocusCounts = {attributed: number; possibleStock: number};
export type FocusSite = FocusCounts & {site: string; label: string};
export type FocusRegional = {
  total: number;
  otherTR: number;
  otherChannels: number;
  unassigned: number;
  unassignedCounty: number;
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
  kind: 'attributed' | 'possibleStock' | 'otherTR' | 'otherChannel' | 'unassigned';
  site?: string;
  document?: {date: string; source: FocusDocument['source']; reference?: string};
  clientCode?: string;
  pointCode?: string;
};
export type FocusReport = FocusCounts & {
  revision: string;
  territory: Territory;
  regional?: FocusRegional;
  months: FocusMonth[];
  sites: FocusSite[];
  detail?: {rows: FocusRow[]; total: number; page: number; hasMore: boolean};
};
export type FocusQuery = {
  territory: Territory;
  historicalSites: string[];
  slips: Record<string, FocusDocument[]>;
  detail?: FocusKind;
  detailSite?: string;
  includeSerials: boolean;
  exportAll?: boolean;
};

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
  const positive = prior.filter(document => document.quantity > 0);
  const positiveSites = new Set(positive.map(documentSite));
  const priorSites = new Set(prior.map(documentSite));
  const net = new Map<string, number>();
  const slips = new Set<string>();
  for (const document of prior) {
    const site = documentSite(document);
    if (document.source === 'slip') slips.add(site);
    else net.set(site, (net.get(site) ?? 0) + document.quantity);
  }

  let owner: string | undefined;
  if (positiveSites.size === 1 && priorSites.size === 1) {
    owner = positiveSites.values().next().value;
  } else if (positiveSites.size) {
    const candidates = [...positiveSites].filter(site => (net.get(site) ?? 0) > 0 || slips.has(site));
    if (candidates.length === 1 && [...priorSites].every(site => site === candidates[0] || (net.get(site) ?? 0) === 0)) {
      owner = candidates[0];
    }
  }
  if (owner !== undefined) {
    const matches = positive.filter(document => documentSite(document) === owner);
    // A single site can be proven even when several customers or locations
    // appear on its documents. Do not pick a customer from competing evidence.
    const identities = new Set(matches.map(row => JSON.stringify([row.clientCode, row.pointCode])));
    const document = matches.reduce((latest, row) => row.date > latest.date ? row : latest);
    return {attributed: true, document, uniqueLocation: identities.size === 1};
  }
  if (prior.length) return null;

  const later = documents.filter(document => document.quantity > 0);
  if (later.length && new Set(later.map(documentSite)).size === 1 && later[0].tr && later[0].site) {
    const document = later.reduce((first, row) => row.date < first.date ? row : first);
    return {attributed: false, document, uniqueLocation: false};
  }
  return null;
}
