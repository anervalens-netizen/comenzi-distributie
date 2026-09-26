import type { PortfolioPartner } from './partner-portfolio-types';
import type { FeatureCollection, Point } from 'geojson';

export type PartnerSummary = Pick<
  PortfolioPartner,
  | 'id'
  | 'name'
  | 'cui'
  | 'address'
  | 'city'
  | 'county'
  | 'route'
  | 'latitude'
  | 'longitude'
  | 'positionSource'
  | 'positionQuality'
  | 'lastVisitedAt'
>;
export type MapBounds = [number, number, number, number];
export type PartnerMapProperties = {
  id: string;
  name: string;
  approximate: boolean;
};
export type PartnerMapData = FeatureCollection<Point, PartnerMapProperties>;
export type PartnerBrowse = {
  partners: PartnerSummary[];
  total: number;
  located: number;
  geocoded: number;
  nextOffset: number | null;
  bounds: MapBounds | null;
  facets: { counties: string[]; cities: string[]; routes: string[] };
  styleUrl: string;
  observedAt: string;
};
