export const firstVodafoneBonusMonth = '2026-06';
export type VodafoneBonusScope = readonly string[] | null;
export type VodafoneTopLocation = {month: string; pointCode: string; target: number; bonus: number | null};
export type VodafoneBonusReason = 'commercial' | 'document-unknown' | 'client-missing' | 'point-unknown' | 'conflict' | 'return' | 'unmatched' | 'mixed';
export type VodafoneBonusContribution = {site: string; activations: number; confirmed: number};
export type VodafoneBonusMonth = {
  month: string;
  sourceThrough: string | null;
  publishedOn: string | null;
  activations: number;
  confirmedActivations: number;
  unresolvedActivations: number;
};
export type VodafoneBonusPoint = {
  month: string;
  pointCode: string;
  cui: string;
  partner: string;
  sites: VodafoneBonusContribution[];
  activations: number;
  confirmedActivations: number;
  target: number | null;
  topBonus: number | null;
  sim0Bonus: number | null;
  totalBonus: number | null;
  givenOnDocuments: number;
  candidateOnDocuments: number;
  applied: number | null;
  remaining: number | null;
  simulatedApplied: number | null;
  simulatedRemaining: number | null;
  partial: boolean;
};
export type VodafoneBonusAllocation = {month: string; kind: 'SIM 0' | 'Top Locații'; quantity: number; status: 'confirmed' | 'simulation'};
export type VodafoneBonusDocument = {
  date: string;
  number: string;
  company: string;
  siteId: string;
  sites: string[];
  pointCode: string | null;
  cui: string;
  partner: string;
  quantity: number | null;
  reason: VodafoneBonusReason;
  allocations: VodafoneBonusAllocation[];
};
export type VodafoneBonusUnresolved = {
  month: string;
  site: string;
  cui: string;
  partner: string;
  reason: VodafoneBonusReason;
  count: number;
};
export type VodafoneBonusReport = {
  fromMonth: string;
  selectedMonth: string | null;
  revision: string;
  months: VodafoneBonusMonth[];
  points: VodafoneBonusPoint[];
  documents: VodafoneBonusDocument[];
  unresolved: VodafoneBonusUnresolved[];
  fiscalKindsComplete: boolean;
};

export const vodafoneBonusReasonLabels: Record<VodafoneBonusReason,string> = {
  commercial:'Factură verificată',
  'document-unknown':'Tip fiscal neconfirmat',
  'client-missing':'Client neidentificat',
  'point-unknown':'Punct de lucru neidentificat',
  conflict:'Identificatori în conflict',
  return:'Retur de verificat',
  unmatched:'Linii nereconciliate',
  mixed:'Document mixt',
};


// The monthly source coverage describes the entire selected portfolio. Search
// narrows the same three sets of detail rows on screen and in both exports.
export function filterVodafoneBonusRows(report: VodafoneBonusReport, search: string) {
  const query = search.trim().toLocaleLowerCase('ro');
  if (!query) return {points:report.points,documents:report.documents,unresolved:report.unresolved};
  const matches = (...values: (string|null)[]) => values.some(value=>value?.toLocaleLowerCase('ro').includes(query));
  return {
    points:report.points.filter(row=>matches(row.partner,row.pointCode,row.cui,...row.sites.map(site=>site.site))),
    documents:report.documents.filter(row=>matches(row.partner,row.pointCode,row.cui,row.number,...row.sites)),
    unresolved:report.unresolved.filter(row=>matches(row.partner,row.cui,row.site)),
  };
}

export const vodafoneBonusPageSize = 50;
export type VodafoneBonusScreen = VodafoneBonusReport & {
  preview?: {
    counts: {points:number; documents:number; unresolved:number};
    hasPartialPoints: boolean;
    hasUnknownTopBonus: boolean;
  };
};

export function vodafoneBonusPreview(report: VodafoneBonusReport): VodafoneBonusScreen {
  const {points, documents, unresolved} = report;
  const counts = {points:points.length, documents:documents.length, unresolved:unresolved.length};
  if (Object.values(counts).every(count=>count<=vodafoneBonusPageSize)) return report;
  return {
    ...report,
    points:points.slice(0,vodafoneBonusPageSize),
    documents:documents.slice(0,vodafoneBonusPageSize),
    unresolved:unresolved.slice(0,vodafoneBonusPageSize),
    preview:{counts,hasPartialPoints:points.some(row=>row.partial),hasUnknownTopBonus:points.some(row=>row.topBonus===null)},
  };
}
