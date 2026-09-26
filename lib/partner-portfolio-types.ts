import type { Client } from './types';

export type PortfolioPartner = Client & {
  contact: string;
  phone: string;
  email: string;
  latitude: number | null;
  longitude: number | null;
  positionSource: 'manual' | 'gps' | 'geocoding' | null;
  positionAccuracy: number | null;
  positionProvider: string | null;
  positionQuality?:
    | 'address'
    | 'address_approximate'
    | 'street_approximate'
    | null;
  addressFingerprint: string;
  revision: number;
  updatedAt: string | null;
  lastVisitedAt: string | null;
};
export type PartnerVisit = {
  id: string;
  customerId: string;
  agentId: string;
  agentName: string;
  visitedAt: string;
  notes: string;
  createdAt: string;
};
export type PartnerVisitsPage = {
  visits: PartnerVisit[];
  nextCursor: string | null;
};
export type PartnerDetail = PartnerVisitsPage & {
  partner: PortfolioPartner;
  visitCount: number;
};
export type PartnerPortfolio = {
  partners: PortfolioPartner[];
  observedAt: string;
};
