import {createHash} from 'node:crypto';
import type {DatabaseSync, StatementSync} from 'node:sqlite';
import type {ActivationQuery} from './activation-distribution';
import {
  focusAttribution, focusCounty, focusCategory, focusProjects, focusSiteScope,
  type FocusCounts, type FocusDocument, type FocusMonth, type FocusRegional, type FocusReport, type FocusRow,
} from './vodafone-focus';

type SourceFile = {id: number; source_at: string; period_start: string; period_end: string};
type Observation = {serial: string; activation_date: string; county: string; handset: string; raw_json: string};
type ObservationFact = {
  serial: string; date: string; county: string; handset: string; simType: string; recharge: unknown;
  signature: string; conflict: boolean;
};
type FocusSource = {
  months: Pick<FocusMonth, 'month'|'coveredThrough'|'complete'>[];
  observations: Map<string, ObservationFact>;
};
type Selection = {fact: ObservationFact; category: ReturnType<typeof focusCategory>};
type Movement = {
  movement_id: number; serial: string; reported_serial: string | null; imei: string; item_type: string; site: string; is_tr: number;
  movement_date: string | null; quantity: number | null;
  company: string; raw_json: string; conflict: number;
};
const blankCounts = (): FocusCounts => ({attributed: 0, possibleStock: 0});
const blankRegional = (): FocusRegional => ({
  total: 0, otherTR: 0, otherChannels: 0, unassigned: 0, unassignedCounty: 0, sourceConflicts: 0,
});
const dealer = 'MOBIUP DISTRIBUTION SRL - CONSIGNATIE';
const pageSize = 50;

function daysIn(month: string) {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value, 0)).getUTCDate();
}

function sourceOrder(a: SourceFile, b: SourceFile) {
  return b.source_at.localeCompare(a.source_at) ||
    b.period_end.localeCompare(a.period_end) || a.period_start.localeCompare(b.period_start) || b.id - a.id;
}

function evidence(row: Movement): FocusDocument {
  const raw = JSON.parse(row.raw_json);
  return {
    site: row.site.trim().toUpperCase(), tr: !!row.is_tr,
    date: row.movement_date || '', quantity: row.quantity ?? 0,
    source: 'erp', reference: String(raw.Nr || raw.DocumentId || raw.DocumentDetailId || ''),
    company: row.company, itemCode: raw.ItemCode || undefined, clientCode: raw.CIF || undefined, pointCode: raw.CodPunctDeLucru || undefined,
  };
}

// All territory summaries in one worker read the same certified snapshot. Keep
// only the facts needed for attribution and conflict checks, not the raw JSON.
export function selectFocusSource(source: DatabaseSync, requestedMonths: string[]): FocusSource {
  const files = (source.prepare(`SELECT id,source_at,period_start,period_end
    FROM activation_imports WHERE operator='vodafone' AND status='complete' AND source_kind='operator'
    AND UPPER(TRIM(company)) IN ('VODAFONE','MOBIUP','MOBIUP DISTRIBUTION SRL')
    AND period_start<>'' AND period_end<>''
    AND EXISTS(SELECT 1 FROM activation_observations o WHERE o.import_id=activation_imports.id
      AND UPPER(TRIM(JSON_EXTRACT(o.raw_json,'$.DEALER_NAME')))=?)`).all(dealer) as unknown as SourceFile[]).sort(sourceOrder);
  const observations = source.prepare(`SELECT serial,activation_date,county,handset,raw_json
    FROM activation_observations WHERE import_id=? AND activation_date BETWEEN ? AND ?`);
  const months: FocusSource['months'] = [];
  const days = new Map<string, number>();
  for (const month of requestedMonths) {
    const size = daysIn(month);
    let daysCovered = 0;
    let coveredThrough: string | null = null;
    for (let day = 1; day <= size; day++) {
      const date = month + '-' + String(day).padStart(2, '0');
      const latest = files.find(file => file.period_start <= date && file.period_end >= date);
      if (!latest) continue;
      days.set(date, latest.id);
      daysCovered++;
      coveredThrough = date;
    }
    months.push({month, coveredThrough, complete: daysCovered === size});
  }
  const selected = new Map<string, ObservationFact>();
  const requestedDays = [...days.keys()].sort();
  for (const file of new Set(days.values())) {
    for (const row of observations.iterate(file, requestedDays[0], requestedDays[requestedDays.length - 1]) as Iterable<Observation>) {
      if (days.get(row.activation_date) !== file) continue;
      const raw = JSON.parse(row.raw_json);
      if (String(raw.DEALER_NAME ?? '').trim().toUpperCase() !== dealer || !/^\d{18}$/.test(row.serial)) continue;
      const county = focusCounty(row.county);
      const signature = JSON.stringify([county, row.handset, raw.SIM_TYPE, raw.FIRST_RECHARGE_VALUE]);
      const previous = selected.get(row.serial);
      if (previous) {
        previous.conflict ||= row.activation_date !== previous.date || signature !== previous.signature;
      } else selected.set(row.serial, {serial: row.serial, date: row.activation_date, county, handset: row.handset,
        simType: raw.SIM_TYPE, recharge: raw.FIRST_RECHARGE_VALUE, signature, conflict: false});
    }
  }
  return {months, observations: selected};
}

function* matchedMovements(input: FocusSource, territory: FocusReport['territory'], sold: StatementSync, physical: StatementSync) {
  const entries = input.observations.values();
  for (;;) {
    // Bound movement rows held in memory, including for an all-period export.
    const batch: Selection[] = [];
    while (batch.length < 256) {
      const next = entries.next();
      if (next.done) break;
      const fact = next.value;
      batch.push({fact, category: focusCategory(territory, fact.county, fact.handset, fact.simType, fact.recharge)});
    }
    if (!batch.length) return;
    const serials = batch.filter(item => !item.fact.conflict && item.category).map(item => item.fact.serial);
    const bySerial = new Map<string, Map<number, Movement>>();
    if (serials.length) {
      const keys = JSON.stringify(serials);
      for (const statement of [sold, physical]) {
        for (const move of statement.iterate(keys) as Iterable<Movement & {matched: string}>) {
          let matches = bySerial.get(move.matched);
          if (!matches) { matches = new Map(); bySerial.set(move.matched, matches); }
          matches.set(move.movement_id, move);
        }
      }
    }
    for (const item of batch) yield {item, movements: [...(bySerial.get(item.fact.serial)?.values() ?? [])]};
  }
}

export function vodafoneFocusReport(
  source: DatabaseSync, labels: ReadonlyMap<string, string>, sites: string[] | null,
  query: ActivationQuery, generation: string, slips: Readonly<Record<string, FocusDocument[]>>, prepared?: FocusSource,
): FocusReport | undefined {
  const focus = query.focus;
  if (!focus || !query.projects.includes(focusProjects[focus.territory])) return undefined;
  const {territory} = focus;
  const {territorySites, visible, regionalDetails, regionalVisible} =
    focusSiteScope(query.rules, territory, focus.historicalSites, sites, query.policy === 'manager');
  if (!regionalVisible && !visible.size) return undefined;
  const hasConflicts = !!source.prepare("SELECT 1 FROM activation_meta WHERE key GLOB 'conflict:*' LIMIT 1").get();
  const conflict = hasConflicts
    ? `EXISTS(SELECT 1 FROM activation_movements original JOIN activation_meta issue
      ON issue.key='conflict:'||original.movement_key WHERE original.id=m.movement_id)`
    : '0';
  const movementColumns = `m.movement_id,m.serial,m.imei,json_extract(m.raw_json,'$.Activat') reported_serial,
    UPPER(TRIM(json_extract(m.raw_json,'$.ItemType'))) item_type,
    m.site,m.is_tr,m.movement_date,m.quantity,m.company,m.raw_json,${conflict} conflict`;
  const companies = "m.company IN ('MobiUp','MobiCell') AND m.provider='vodafone'";
  // Drive the existing (company,provider,serial/imei) indexes once per batch.
  // A movement may match its reported serial and another physical SIM, so keep
  // the lookup serial distinct from the serial recorded on the movement.
  const candidates = `SELECT p.value matched,${movementColumns}
    FROM json_each(?) p CROSS JOIN activation_effective_movements m WHERE ${companies}`;
  const sold = source.prepare(candidates + ' AND m.serial=p.value');
  const sim = source.prepare(candidates + ` AND m.imei>=p.value||'0' AND m.imei<p.value||':'
    AND LENGTH(m.imei)=19 AND UPPER(TRIM(json_extract(m.raw_json,'$.ItemType')))='SIM'`);
  const revision = createHash('sha256').update(JSON.stringify([
    generation, territory, query.months, query.projects, query.rules.revision, [...territorySites].sort(), [...visible].sort(), regionalDetails, regionalVisible,
    focus.includeSerials, focus.detail, focus.detailSite,
  ]));
  const report: FocusReport = {...blankCounts(), revision: '', territory, regionalDetails, months: [], sites: [], ...(regionalVisible ? {regional: blankRegional()} : {})};
  const counts = new Map([...visible].map(site => [site, blankCounts()]));
  const details: FocusRow[] = [];
  const input = prepared ?? selectFocusSource(source, query.months);
  const months = new Map(input.months.map(row => [row.month, {
    ...row, ...blankCounts(), ...(regionalVisible ? {regional: blankRegional()} : {}),
  }]));
  if (!input.months.some(month => month.coveredThrough)) {
    report.months = [...months.values()];
    report.revision = revision.update(JSON.stringify(report)).digest('hex');
    return report;
  }
  for (const {item: {fact, category}, movements: matchingMovements} of matchedMovements(input, territory, sold, sim)) {
    const {date, serial, county, conflict} = fact;
    const month = months.get(date.slice(0, 7))!;
    if (conflict || !county) {
      if (report.regional && month.regional) {
        report.regional.sourceConflicts++;
        month.regional.sourceConflicts++;
      }
      continue;
    }
    if (!category) continue;
    const documents = matchingMovements.map(evidence).concat(slips[serial] ?? []);
    // ERP can disagree with the physical SIM identifier in either direction:
    // a matching reported activation on another SIM, or the same SIM carrying
    // another reported activation. Preserve regional count and withhold TR credit.
    const invalid = matchingMovements.some(move => !!move.conflict || (move.item_type === 'SIM' &&
      (!/^\d{19}$/.test(move.imei) || move.imei.slice(0, 18) !== serial || (!!move.serial && move.serial !== serial) ||
       (!!move.reported_serial && move.reported_serial !== serial)))) ||
      documents.some(doc => !doc.date || !doc.quantity || (doc.tr && !doc.site));
    const attribution = invalid ? null : focusAttribution(date, documents);
    const document = attribution?.document;
    const site = document?.tr ? document.site : undefined;
    const kind = attribution?.attributed
      ? document?.tr ? territorySites.has(site!) ? 'attributed' : 'otherTR' : 'otherChannel'
      : attribution && site && territorySites.has(site) ? 'possibleStock' : 'unassigned';
    if (report.regional && month.regional) {
      for (const regional of [report.regional, month.regional]) {
        regional.total++;
        if (county === '<UNASSIGNED>') regional.unassignedCounty++;
        if (kind === 'otherTR') regional.otherTR++;
        if (kind === 'otherChannel') regional.otherChannels++;
        if (kind === 'unassigned' || kind === 'possibleStock') regional.unassigned++;
      }
    }
    const scopedSite = site && visible.has(site) ? counts.get(site) : undefined;
    if (scopedSite && (kind === 'attributed' || kind === 'possibleStock')) {
      scopedSite[kind]++;
      report[kind]++;
      month[kind]++;
    }
    if (!focus.detail || (focus.detailSite && site !== focus.detailSite)) continue;
    if (focus.detail !== 'regional' && (!scopedSite || focus.detail !== kind)) continue;
    if (focus.detail === 'regional' && !regionalDetails) continue;
    details.push({
      id: createHash('sha256').update(serial + '|' + date).digest('hex'),
      ...(focus.includeSerials ? {serial} : {}), date, county, category, kind, site,
      ...(document && (regionalDetails || scopedSite) ? {
        document: {date: document.date, source: document.source, ...(focus.includeSerials ? {reference: document.reference} : {})},
      } : {}),
      ...(attribution?.uniqueLocation && attribution.attributed && (regionalDetails || scopedSite) ? {
        clientCode: document?.clientCode, pointCode: document?.pointCode,
      } : {}),
    });
  }
  report.months = [...months.values()];
  report.sites = [...counts].map(([site, siteCounts]) => ({
    site, label: labels.get(site) || site, ...siteCounts,
  })).sort((a, b) => b.attributed - a.attributed || a.site.localeCompare(b.site));
  // Hash the report's scoped output, independent of pagination and export mode.
  // Avize which cannot change this report should not invalidate its download.
  revision.update(JSON.stringify(report));
  if (focus.detail) {
    details.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    for (const row of details) revision.update(JSON.stringify(row));
    const page = query.page ?? 0;
    const offset = focus.exportAll ? 0 : page * pageSize;
    const picked = focus.exportAll ? details : details.slice(offset, offset + pageSize);
    const rows = focus.includeSerials ? picked : picked.map((row, index) => ({...row, id: String(offset + index)}));
    report.detail = {rows,
      total: details.length, page, hasMore: !focus.exportAll && (page + 1) * pageSize < details.length};
  }
  report.revision = revision.digest('hex');
  return report;
}
