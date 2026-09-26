export type SalesRow = {
  rowNumber: number;
  date: string;
  month: string;
  siteCode: string;
  itemCode: string;
  itemName: string;
  quantity: number;
  brand: string;
  priceCents: number;
  valueCents: number;
  location: string;
  company: string;
  asm: string;
  regional: string;
  orderNumber: string;
  category: string;
  subCategory: string;
  agent: string;
};

export type SalesAgentMapping = {
  siteCode: string;
  userId: string | null;
  name: string | null;
  status: 'mapped' | 'missing' | 'duplicate';
  candidates?: { id: string; name: string }[];
};

export type SalesAggregate = {
  rows: number;
  quantity: number;
  value: number;
};

export type SalesSite = SalesAggregate & {
  siteCode: string;
  location: string;
  agent: string;
};

export type SalesDaily = SalesAggregate & { date: string };

export type SalesProduct = SalesAggregate & {
  itemCode: string;
  itemName: string;
  brand: string;
  category: string;
  subCategory: string;
  segment?: 'accessories' | 'cardsSim' | 'phones' | 'unclassified';
  subsegment?: 'cards' | 'sim' | 'vouchers';
};

export type SalesSegment = {
  summary: SalesAggregate;
  products: SalesProduct[];
};

export type SalesCardsSim = SalesSegment & {
  subsegments: { cards: SalesAggregate; sim: SalesAggregate; vouchers: SalesAggregate; valueVouchers: SalesAggregate };
};

export type SalesSegments = {
  accessories: SalesSegment;
  cardsSim: SalesCardsSim;
  phones: SalesSegment;
  unclassified: SalesSegment;
};

export type SalesMonthly = SalesAggregate & {
  month: string;
  segments: { accessories: SalesAggregate; cardsSim: SalesAggregate; phones: SalesAggregate; unclassified: SalesAggregate };
};

export type SalesView = {
  month: string;
  importedAt: string | null;
  filename: string | null;
  fileHash: string | null;
  revision: number;
  summary: SalesAggregate;
  sites: SalesSite[];
  daily: SalesDaily[];
  products: SalesProduct[];
  months: { month: string; importedAt: string; filename: string; fileHash: string; revision: number; rowCount: number }[];
  segments: SalesSegments;
  monthly: SalesMonthly[];
};

export type SalesPreview = {
  month: string;
  firstDate: string;
  lastDate: string;
  fileHash: string;
  filename: string;
  revision: number;
  mappingHash: string;
  rowCount: number;
  summary: SalesAggregate;
  sites: SalesSite[];
  mappings: SalesAgentMapping[];
  historical: boolean;
  requiresHistoricalAcknowledgement: boolean;
  requiresRegressionAcknowledgement: boolean;
  coverageChange: { previousRowCount: number; rowDelta: number; previousFirstDate: string | null; previousLastDate: string | null; missingSiteCodes: string[] };
};
