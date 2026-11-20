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
