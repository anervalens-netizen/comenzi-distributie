import type { PortfolioPartner } from './partner-portfolio-types';
import type { FeatureCollection, Point } from 'geojson';

export type PartnerSummary = Pick<
  PortfolioPartner,
  | 'warehouseIds'
  | 'historyCatalog'
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
  cluster?:boolean;point_count?:number;point_count_abbreviated?:string;expansionZoom?:number;bounds?:MapBounds;
};
export type PartnerMapData = FeatureCollection<Point, PartnerMapProperties>&{serverAggregated?:boolean;zoom?:number;totalPoints?:number};
export type PartnerBrowse = {
  facetVersion?:number;
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
