import {db, fail} from './server';
import type {DistributionRules,Territory} from './distribution-rules';
import {focusSiteScope,focusTerritories,type FocusKind,type FocusQuery} from './vodafone-focus';

const detailKinds: readonly FocusKind[] = ['regional', 'attributed', 'possibleStock'];

export function isVodafoneFocusView(view: string | null) {
  return view === 'focus' || view === 'focus-export';
}

export function vodafoneFocusTerritory(params: URLSearchParams): Territory {
  const territory=params.get('focusTerritory') ?? 'sud';
  if (!focusTerritories.includes(territory as Territory)) fail(400, 'Teritoriul Focus este invalid.');
  return territory as Territory;
}

export async function vodafoneFocusQuery(rules: DistributionRules, territory: Territory, params: URLSearchParams, sites: string[] | null, manager: boolean): Promise<FocusQuery> {
  const detail = params.get('focusKind');
  if (detail !== null && !detailKinds.includes(detail as FocusKind)) fail(400, 'Selecția Focus este invalidă.');
  if (detail === 'regional' && sites !== null) fail(403, 'Detaliul regional Focus necesită acces național.');
  const detailSite = params.get('focusSite')?.trim().toUpperCase();
  const exportAll=params.get('view')==='focus-export';
  const requestedMonths=new Set(params.getAll('months').flatMap(value=>value.split(',')).filter(Boolean));
  if(exportAll&&detail&&requestedMonths.size>3)fail(400,'Alege cel mult trei luni pentru un export cu detalii.');
  if (detailSite && (!detail || detail === 'regional' || detailSite.length > 100)) fail(400, 'Gestiunea Focus este invalidă.');
  const stored = await db().prepare("SELECT value FROM settings WHERE key=?").bind('vodafone-focus-historical-sites:' + territory).first<{value:string}>();
  const history = stored?.value ?? (territory === 'sud' ? process.env.MOBIUP_VODAFONE_FOCUS_SOUTH_HISTORICAL_SITES : undefined) ?? '';
  const historicalSites = [...new Set(history.split(',').map(site => site.trim().toUpperCase()).filter(Boolean))].sort();
  if (detailSite && !focusSiteScope(rules, territory, historicalSites, sites, manager).visible.has(detailSite)) {
    fail(403, 'Gestiunea nu este disponibilă.');
  }
  return {
    territory, historicalSites, includeSerials: manager, detail: detail ? detail as FocusKind : undefined,
    detailSite: detailSite || undefined, exportAll,
  };
}
