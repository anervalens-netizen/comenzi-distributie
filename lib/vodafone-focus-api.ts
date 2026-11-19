import {db, fail} from './server';
import type {Territory} from './distribution-rules';
import {focusTerritories,type FocusDocument,type FocusKind,type FocusQuery} from './vodafone-focus';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
});
const detailKinds: readonly FocusKind[] = ['regional', 'attributed', 'possibleStock'];
type Slip = {site: string; finalized: string; reference: string; serial: string; clientCode: string | null};

export function isVodafoneFocusView(view: string | null) {
  return view === 'focus' || view === 'focus-export';
}

export function vodafoneFocusTerritory(params: URLSearchParams): Territory {
  const territory=params.get('focusTerritory') ?? 'sud';
  if (!focusTerritories.includes(territory as Territory)) fail(400, 'Teritoriul Focus este invalid.');
  return territory as Territory;
}

export async function vodafoneFocusQuery(territory: Territory, params: URLSearchParams, sites: string[] | null, manager: boolean): Promise<FocusQuery> {
  const detail = params.get('focusKind');
  if (detail !== null && !detailKinds.includes(detail as FocusKind)) fail(400, 'Selecția Focus este invalidă.');
  if (detail === 'regional' && sites !== null) fail(403, 'Detaliul regional Focus necesită acces național.');
  const detailSite = params.get('focusSite')?.trim().toUpperCase();
  const exportAll=params.get('view')==='focus-export';
  const requestedMonths=new Set(params.getAll('months').flatMap(value=>value.split(',')).filter(Boolean));
  if(exportAll&&detail&&requestedMonths.size>3)fail(400,'Alege cel mult trei luni pentru un export cu detalii.');
  if (detailSite && (!detail || detail === 'regional' || detailSite.length > 100)) fail(400, 'Gestiunea Focus este invalidă.');
  if (detailSite && sites !== null && !sites.some(site => site.toUpperCase() === detailSite)) fail(403, 'Gestiunea nu este disponibilă.');
  const stored = await db().prepare("SELECT value FROM settings WHERE key=?").bind('vodafone-focus-historical-sites:' + territory).first<{value:string}>();
  const history = stored?.value ?? (territory === 'sud' ? process.env.MOBIUP_VODAFONE_FOCUS_SOUTH_HISTORICAL_SITES : undefined) ?? '';
  const historicalSites = [...new Set(history.split(',').map(site => site.trim().toUpperCase()).filter(Boolean))].sort();
  // A slip proves the site only if the stored order warehouse still resolves
  // unambiguously to its agent. The finalized snapshot provides customer data.
  const rows = (await db().prepare(`SELECT UPPER(TRIM(u.site_code)) site,o.finalized_at finalized,
    o.number reference,s.value serial,JSON_EXTRACT(o.payload,'$.client.cui') clientCode
    FROM orders o JOIN users u ON u.id=o.user_id
    JOIN json_each(o.payload,'$.serials') s
    WHERE o.status='finalized' AND o.kind IN ('sim','stand_client','combined')
    AND o.finalized_at IS NOT NULL AND u.role='agent' AND u.warehouse_id=o.warehouse_id
    AND TRIM(u.site_code)<>'' AND s.type='text'
    AND NOT EXISTS(SELECT 1 FROM users conflict WHERE conflict.role='agent' AND conflict.id<>u.id
      AND UPPER(TRIM(conflict.site_code))=UPPER(TRIM(u.site_code)))
    ORDER BY s.value,o.finalized_at,o.number`).all<Slip>()).results;
  const slips: Record<string, FocusDocument[]> = Object.create(null);
  for (const row of rows) {
    if (!/^\d{18,19}$/.test(row.serial)) continue;
    const timestamp = new Date(row.finalized);
    if (!Number.isFinite(timestamp.getTime())) continue;
    const serial = row.serial.slice(0, 18);
    (slips[serial] ??= []).push({
      site: row.site, tr: true, date: dateFormatter.format(timestamp), quantity: 1,
      source: 'slip', reference: row.reference, clientCode: row.clientCode || undefined,
    });
  }
  return {
    territory, historicalSites, slips, includeSerials: manager, detail: detail ? detail as FocusKind : undefined,
    detailSite: detailSite || undefined, exportAll,
  };
}
