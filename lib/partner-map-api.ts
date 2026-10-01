import {portfolioSummary} from './partner-portfolio';
import {pagedBrowse,readyReadModel,selectedSql,selectedSummaries} from './portfolio-read-model';
import {aggregateMapPoints} from './partner-map-aggregation';
import {readActivitySnapshot} from './partner-activity-snapshot';
import {validBillingPeriod,selectBillingPeriod} from './partner-billing-period';
import { db, fail } from './server';
import { managerFilter } from './manager-scope';
import type { User } from './types';
import type {
  MapBounds,
  PartnerBrowse,
  PartnerMapData,
  PartnerSummary,
} from './partner-map-types';

export const DEFAULT_MAP_STYLE =
  'https://tiles.openfreemap.org/styles/positron';
function integer(
  params: URLSearchParams,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) fail(400, 'Pagina este invalidă.');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    fail(400, 'Pagina este invalidă.');
  return n;
}
export function parseBounds(raw: string | null): MapBounds | undefined {
  if (raw === null) return undefined;
  const parts = raw.split(',');
  const b = parts.map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !p.trim()) ||
    b.some((n) => !Number.isFinite(n)) ||
    Math.abs(b[0]) > 180 ||
    Math.abs(b[2]) > 180 ||
    Math.abs(b[1]) > 90 ||
    Math.abs(b[3]) > 90 ||
    b[1] > b[3]
  )
    fail(400, 'Zona hărții este invalidă.');
  return b as MapBounds;
}
export function partnerBounds(partners: PartnerSummary[]): MapBounds | null {
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const p of partners)
    if (p.latitude !== null && p.longitude !== null) {
      west = Math.min(west, p.longitude);
      east = Math.max(east, p.longitude);
      south = Math.min(south, p.latitude);
      north = Math.max(north, p.latitude);
    }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}
function billingSelection(partners:PartnerSummary[],params:URLSearchParams) {
  const period=params.get('salesPeriod')||'';
  if(!validBillingPeriod(period))fail(400,'Perioada de facturare este invalidă.');
  if(!period)return partners;
  const snapshot=readActivitySnapshot(partners,undefined,undefined,{period,scope:'company'});
  if(snapshot.state!=='ready')fail(409,snapshot.message);
  return selectBillingPeriod(partners,snapshot,period);
}
export async function browsePartners(
  user: User,
  params: URLSearchParams,
): Promise<PartnerBrowse> {
  if(!(db() as D1Database&{portfolioReadVersion?:unknown}).portfolioReadVersion)return legacyBrowse(user,params);
  const limit = integer(params, 'limit', 100, 1, 200),
    offset = integer(params, 'offset', 0, 0, 10000000);
  const scope = await managerFilter(user, params);
  const period=params.get('salesPeriod')||'';if(!validBillingPeriod(period))fail(400,'Perioada de facturare este invalidă.');
  const ids=period?billingSelection(await selectedSummaries(user,params,scope?.warehouseIds),params).map(p=>p.id):undefined;
  return pagedBrowse(user,params,scope?.warehouseIds,offset,limit,ids);
}

export async function mapPartners(
  user: User,
  params: URLSearchParams,
): Promise<PartnerMapData> {
  if(!(db() as D1Database&{portfolioReadVersion?:unknown}).portfolioReadVersion)return legacyMap(user,params);
  const bbox = parseBounds(params.get('bbox'));
  const scope = await managerFilter(user, params);
  const rawZoom=params.get('zoom');const zoom=rawZoom===null?undefined:integer(params,'zoom',0,0,22);
  const period=params.get('salesPeriod')||'';if(!validBillingPeriod(period))fail(400,'Perioada de facturare este invalidă.');
  await readyReadModel();const query=selectedSql(user,params,scope?.warehouseIds,bbox);query.where+=' AND m.latitude IS NOT NULL AND m.longitude IS NOT NULL';
  if(period){const ids=billingSelection(await selectedSummaries(user,params,scope?.warehouseIds,bbox),params).map(p=>p.id);query.where+=' AND m.id IN (SELECT value FROM json_each(?))';query.args.push(JSON.stringify(ids));}
  const points=(await db().prepare(`SELECT m.id,m.name,m.latitude,m.longitude,json_extract(m.summary,'$.positionQuality') quality FROM ${query.from} WHERE ${query.where} ORDER BY m.id`).bind(...query.args).all<{id:string;name:string;latitude:number;longitude:number;quality:string|null}>()).results;
  if(zoom===undefined&&points.length>50000)fail(413,'Prea multe puncte în această zonă. Mărește harta sau restrânge filtrele.');
  const data:PartnerMapData={type:'FeatureCollection',features:points.map(p=>({type:'Feature',id:p.id,geometry:{type:'Point',coordinates:[p.longitude,p.latitude]},properties:{id:p.id,name:p.name,approximate:!!p.quality?.endsWith('_approximate')}}))};
  return zoom===undefined?data:aggregateMapPoints(data,zoom);
}

const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function legacyFilters(params: URLSearchParams) {
  for (const key of ['q', 'county', 'city', 'route'])
    if ((params.get(key)?.length || 0) > 300)
      fail(400, 'Filtrul este prea lung.');
  const position = params.get('position') || '',
    days = params.get('days') || '';
  if (
    !['', 'yes', 'no'].includes(position) ||
    !['', 'never', '7', '14', '30', '60', '90'].includes(days)
  )
    fail(400, 'Filtrul este invalid.');
  const q = normalize(params.get('q') || ''),
    city = normalize((params.get('city') || '').trim());
  const county = params.get('county') || '',
    route = params.get('route') || '',
    now = Date.now();
  return (p: PartnerSummary) =>
    (!q ||
      normalize(
        [p.id, p.name, p.cui, p.city, p.county, p.address].join(' '),
      ).includes(q)) &&
    (!county || p.county === county) &&
    (!city || normalize(p.city).includes(city)) &&
    (!route || p.route === route) &&
    (!position ||
      (position === 'yes' ? p.latitude !== null : p.latitude === null)) &&
    (!days ||
      (days === 'never'
        ? !p.lastVisitedAt
        : !!p.lastVisitedAt &&
          now - Date.parse(p.lastVisitedAt) >= Number(days) * 86400000));
}
const legacyUnique = (values: string[]) =>
  [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ro'));

async function legacyBrowse(
  user: User,
  params: URLSearchParams,
): Promise<PartnerBrowse> {
  const match = legacyFilters(params),
    limit = integer(params, 'limit', 100, 1, 200),
    offset = integer(params, 'offset', 0, 0, 10000000);
  const scope = await managerFilter(user, params);
  const all = await portfolioSummary(user, undefined, scope?.warehouseIds),
    selected = billingSelection(all.filter(match),params);
  const inCounty = all.filter(
    (p) => !params.get('county') || p.county === params.get('county'),
  );
  const configured = await db()
    .prepare("SELECT value FROM settings WHERE key='partner-map-style-url'")
    .first<{ value: string }>();
  const styleUrl = configured?.value?.trim() || DEFAULT_MAP_STYLE;
  // Provider changes require only this server setting, never a browser rebuild/API key.
  if (!styleUrl.startsWith('https://') && !/^\/(?!\/)/.test(styleUrl))
    fail(500, 'Configurația hărții este invalidă.');
  return {
    partners: selected.slice(offset, offset + limit),
    total: selected.length,
    located: selected.filter((p) => p.latitude !== null).length,
    geocoded: selected.filter((p) => p.positionSource === 'geocoding').length,
    nextOffset: offset + limit < selected.length ? offset + limit : null,
    bounds: partnerBounds(selected),
    facets: {
      counties: legacyUnique(all.map((p) => p.county)),
      cities: legacyUnique(inCounty.map((p) => p.city)),
      routes: legacyUnique(inCounty.map((p) => p.route)),
    },
    styleUrl,
    observedAt: new Date().toISOString(),
  };
}
async function legacyMap(
  user: User,
  params: URLSearchParams,
): Promise<PartnerMapData> {
  const match = legacyFilters(params),
    bbox = parseBounds(params.get('bbox'));
  const scope = await managerFilter(user, params);
  const partners = billingSelection((await portfolioSummary(user, bbox, scope?.warehouseIds)).filter(
    (p) => p.latitude !== null && p.longitude !== null && match(p),
  ),params);
  // Do not silently truncate or mislabel cluster totals. Above this measured tier,
  // narrow the viewport/filters; a future MVT implementation can replace this API.
  if (partners.length > 50000)
    fail(
      413,
      'Prea multe puncte în această zonă. Mărește harta sau restrânge filtrele.',
    );
  return {
    type: 'FeatureCollection',
    features: partners.map((p) => ({
      type: 'Feature',
      id: p.id,
      geometry: { type: 'Point', coordinates: [p.longitude!, p.latitude!] },
      properties: {
        id: p.id,
        name: p.name,
        approximate:
          !!p.positionQuality?.endsWith('_approximate'),
      },
    })),
  };
}
