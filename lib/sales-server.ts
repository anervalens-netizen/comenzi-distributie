import { catalog, db, fail, isGlobalManager, readLimited, requireManager, response } from './server';
import type { User } from './types';
import { readCatalog } from './catalog';
import { salesHash, SALES_FILE_LIMIT } from './sales-file';
import { parseSalesFileRuntime } from './sales-parser-runtime';
import { currentSalesImport, importSalesRows, latestSalesImport, latestSalesMonth, salesCoverageChange, salesRevision, saveSalesOriginal } from './sales-store';
import { getSalesViewRuntime } from './sales-view-runtime';
import { managerFilter } from './manager-scope';
import type { SalesView } from './sales-types';
import type { SalesAgentMapping } from './sales-types';
import { salesLocationKey, salesSiteKey as mappingKey, salesPairKey, type SalesScope } from './sales-location';

type SalesActor = { id: string; name: string; siteCode: string; warehouseName: string };

async function mappingSnapshot() {
  const result = await db().prepare("SELECT id,name,role,site_code,warehouse_name FROM users WHERE active=1 AND (role='agent' OR (role='manager' AND TRIM(site_code)<>'')) ORDER BY name,id").all<{ id: string; name: string; role: string; site_code: string | null; warehouse_name: string | null }>();
  const actors: SalesActor[] = result.results.map(row => ({ id: String(row.id), name: String(row.name), siteCode: row.site_code?.trim() || '', warehouseName: row.role === 'agent' ? row.warehouse_name?.trim() || '' : '' }));
  const grouped = new Map<string, SalesActor[]>(), locations = new Map<string, SalesActor[]>();
  for (const actor of actors) {
    for (const [key, index] of [[mappingKey(actor.siteCode), grouped], [salesLocationKey(actor.warehouseName), locations]] as const) {
      if (key) index.set(key, [...(index.get(key) || []), actor]);
    }
  }
  const canonical = actors.map(actor => [actor.id, actor.name, mappingKey(actor.siteCode), salesLocationKey(actor.warehouseName)]);
  return { actors, grouped, locations, hash: salesHash(JSON.stringify(canonical)) };
}

function validateMonth(value: string | null) {
  if (!value || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) fail(400, 'Luna trebuie să fie în formatul AAAA-LL.');
  return value;
}

function filenameFrom(req: Request) {
  let filename = '';
  try { filename = decodeURIComponent(req.headers.get('X-Sales-Filename') || ''); } catch { fail(400, 'Numele fișierului este invalid.'); }
  if (!filename || filename.length > 250 || /[\\/]/.test(filename) || filename.split('').some(c => c.charCodeAt(0) < 32)) fail(400, 'Numele fișierului este invalid.');
  return filename;
}

function mappingFor(site: { siteCode: string; location: string }, snapshot: Awaited<ReturnType<typeof mappingSnapshot>>): SalesAgentMapping {
  const locationMatches = snapshot.locations.get(salesLocationKey(site.location)) || [];
  const candidates = locationMatches.length === 1 ? locationMatches : snapshot.grouped.get(mappingKey(site.siteCode)) || [];
  // A historical location is not evidence that the current warehouse sold there.
  const owner = candidates.length === 1 ? candidates[0] : undefined;
  if (owner && (locationMatches.length === 1 || !owner.warehouseName || salesLocationKey(owner.warehouseName) === salesLocationKey(site.location))) return { ...site, userId: owner.id, name: owner.name, status: 'mapped' };
  if (candidates.length > 1) return { ...site, userId: null, name: null, status: 'duplicate', candidates: candidates.map(item => ({ id: item.id, name: item.name })) };
  return { ...site, userId: null, name: null, status: 'missing' };
}

function mappingsFor(sites: { siteCode: string; location: string }[], snapshot: Awaited<ReturnType<typeof mappingSnapshot>>) {
  const unique = new Map(sites.map(site => [salesPairKey(site), { siteCode: site.siteCode, location: site.location }]));
  return [...unique.values()].sort((a, b) => a.siteCode.localeCompare(b.siteCode, 'ro') || a.location.localeCompare(b.location, 'ro')).map(site => mappingFor(site, snapshot));
}

function decoratedView(view: SalesView, snapshot: Awaited<ReturnType<typeof mappingSnapshot>>) {
  return { ...view, sites: view.sites.map(site => ({ ...site, agent: mappingFor(site, snapshot).name || '' })) };
}

function actorScope(actorIds: string[], snapshot: Awaited<ReturnType<typeof mappingSnapshot>>, siteCode?: string): SalesScope {
  const actors = snapshot.actors.filter(actor => actorIds.includes(actor.id));
  const warehouseNames: string[] = [], siteCodes: string[] = [];
  for (const actor of actors) {
    if (actor.warehouseName) {
      if (snapshot.locations.get(salesLocationKey(actor.warehouseName))?.length !== 1) fail(409, 'Gestiunea nu este asociată unui singur agent activ.');
      warehouseNames.push(actor.warehouseName);
    } else if (actor.siteCode) {
      if (snapshot.grouped.get(mappingKey(actor.siteCode))?.length !== 1) fail(409, 'SiteCode-ul nu este asociat unui singur utilizator activ.');
      siteCodes.push(mappingKey(actor.siteCode));
    }
  }
  return { warehouseNames, siteCodes, excludedWarehouseNames: [...snapshot.locations].filter(([, matches]) => matches.length === 1).map(([key]) => key), siteCode };
}

async function salesCatalog() {
  try { return (await readCatalog()).products; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return catalog;
  }
}

async function duplicateImportMessage(kind:'Vânzările'|'Stocurile',userId:string) {
  const row=await db().prepare('SELECT name FROM users WHERE id=?').bind(userId).first<{name:string}>();
  return `${kind} din acest fișier au fost deja importate de ${row?.name||'un alt manager'}. Nu este nevoie să le imporți din nou.`;
}

export async function salesView(req: Request, user: User) {
  const query = new URL(req.url).searchParams;
  const month = validateMonth(query.get('month'));
  // The current-month view must not aggregate the complete imported history.
  // History callers opt into a range explicitly.
  const fromMonth = validateMonth(query.get('fromMonth') || query.get('from') || month);
  const toMonth = validateMonth(query.get('toMonth') || query.get('to') || month);
  if (fromMonth > toMonth) fail(400, 'Intervalul lunar este invalid.');
  const snapshot = await mappingSnapshot();
  const requestedSite = query.get('siteCode')?.trim() || undefined;
  let siteScope: SalesScope | undefined = requestedSite;
  let actorIds: string[] | undefined;
  if (user.role === 'agent') {
    const own = snapshot.actors.find(actor => actor.id === user.id);
    if (!own || (!own.warehouseName && !own.siteCode)) fail(409, 'Contul tău nu are o gestiune sau un SiteCode configurat.');
    actorIds = [user.id];
  } else if (!isGlobalManager(user)) {
    const assigned = await db().prepare("SELECT a.id FROM manager_agents ma JOIN users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.role='agent' AND a.active=1 ORDER BY a.id").bind(user.id).all<{ id: string }>();
    actorIds = [...assigned.results.map(actor => actor.id), user.id];
  }
  const selected = await managerFilter(user, query);
  if (selected) {
    const selectedIds = [...selected.agentIds];
    // Manager seller identity belongs only to sales, never to operational agent/warehouse scope.
    const managerId = query.get('managerId');
    if (!query.get('agentId')) {
      if (managerId && managerId !== '__unassigned') selectedIds.push(managerId);
      else if (!managerId && !isGlobalManager(user)) selectedIds.push(user.id);
    }
    const allowedIds = actorIds;
    actorIds = allowedIds ? selectedIds.filter(id => allowedIds.includes(id)) : selectedIds;
  }
  if (actorIds) siteScope = actorScope(actorIds, snapshot, user.role === 'agent' ? undefined : requestedSite);
  return response(decoratedView(await getSalesViewRuntime(month, siteScope, fromMonth, toMonth, await salesCatalog()), snapshot));
}

export function salesImportStatus() {
  const latest=latestSalesImport();
  return latest?{month:String(latest.month),filename:String(latest.filename),importedAt:String(latest.importedAt),rows:Number(latest.rows||0)}:null;
}

export async function salesUpload(req: Request, user: User, apply: boolean) {
  requireManager(user);
  if (Number(req.headers.get('content-length') || 0) > SALES_FILE_LIMIT) fail(413, 'Fișierul depășește limita de 8 MB.');
  const filename = filenameFrom(req);
  const bytes = await readLimited(req, SALES_FILE_LIMIT);
  let rows;
  try { rows = await parseSalesFileRuntime(bytes, filename); } catch (error) { fail(400, error instanceof Error ? error.message : 'Fișier Excel invalid.'); }
  const month = rows[0].month;
  const requestedMonth = req.headers.get('X-Sales-Month');
  if (requestedMonth && requestedMonth !== month) fail(400, 'Luna selectată nu corespunde datelor din fișier.');
  const fileHash = salesHash(bytes);
  const existing=currentSalesImport(month);
  if(existing?.file_hash===fileHash&&existing.imported_by!==user.id)fail(409,await duplicateImportMessage('Vânzările',String(existing.imported_by)));
  let snapshot = await mappingSnapshot();
  const mappings = mappingsFor(rows, snapshot);
  const historical = !!latestSalesMonth() && month < String(latestSalesMonth());
  const firstDate = rows.reduce((earliest, row) => row.date < earliest ? row.date : earliest, rows[0].date);
  const lastDate = rows.reduce((latest, row) => row.date > latest ? row.date : latest, rows[0].date);
  const coverageChange = salesCoverageChange(month, rows);
  const { requiresRegressionAcknowledgement } = coverageChange;
  const currentRevision = salesRevision();
  if (!apply) {
    const sitesInCents = rows.reduce((result, row) => {
      const found = result.find(item => salesPairKey(item) === salesPairKey(row));
      if (found) { found.rows++; found.quantity += row.quantity; found.valueCents += row.valueCents; }
      else result.push({ siteCode: row.siteCode, location: row.location, agent: mappings.find(m => salesPairKey({ siteCode: m.siteCode, location: m.location || '' }) === salesPairKey(row))?.name || '', rows: 1, quantity: row.quantity, valueCents: row.valueCents });
      return result;
    }, [] as { siteCode: string; location: string; agent: string; rows: number; quantity: number; valueCents: number }[]);
    const sites = sitesInCents.sort((a, b) => b.valueCents - a.valueCents || a.siteCode.localeCompare(b.siteCode)).map(({ valueCents, ...site }) => ({ ...site, value: valueCents / 100 }));
    return response({ month, firstDate, lastDate, fileHash, filename, revision: currentRevision, mappingHash: snapshot.hash, rowCount: rows.length, summary: { rows: rows.length, quantity: rows.reduce((sum, row) => sum + row.quantity, 0), value: rows.reduce((sum, row) => sum + row.valueCents, 0) / 100 }, sites, mappings, historical, requiresHistoricalAcknowledgement: historical, requiresRegressionAcknowledgement, coverageChange });
  }
  const expectedRevision = Number(req.headers.get('X-Sales-Revision') || req.headers.get('X-Sales-Version') || NaN);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(409, 'Previzualizarea importului lipsește sau este expirată.');
  if (req.headers.get('X-Sales-Hash') !== fileHash) fail(409, 'Fișierul diferă de previzualizare. Reîncarcă previzualizarea.');
  const latestSnapshot = await mappingSnapshot();
  if (req.headers.get('X-Sales-Mapping-Hash') !== snapshot.hash || latestSnapshot.hash !== snapshot.hash) fail(409, 'Maparea agenților s-a modificat. Reîncarcă previzualizarea.');
  snapshot = latestSnapshot;
  if (historical && req.headers.get('X-Sales-Allow-Historical') !== '1') fail(409, 'Fișierul este pentru o lună mai veche. Confirmă explicit importul istoric.');
  if (requiresRegressionAcknowledgement && req.headers.get('X-Sales-Allow-Regression') !== '1') fail(409, 'Fișierul reduce acoperirea lunii existente. Confirmă explicit înlocuirea.');
  const originalPath = await saveSalesOriginal(fileHash, filename, bytes);
  const finalSnapshot = await mappingSnapshot();
  if (finalSnapshot.hash !== snapshot.hash) fail(409, 'Maparea agenților s-a modificat. Reîncarcă previzualizarea.');
  try {
    const result = importSalesRows({ rows, month, fileHash, filename, importedBy: user.id, originalPath, expectedRevision, expectedMappingHash: snapshot.hash, currentMappingHash: finalSnapshot.hash, historicalAcknowledged: req.headers.get('X-Sales-Allow-Historical') === '1', regressionAcknowledged: req.headers.get('X-Sales-Allow-Regression') === '1' });
    if(result.idempotent&&result.importedBy&&result.importedBy!==user.id)fail(409,await duplicateImportMessage('Vânzările',result.importedBy));
    return response(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'STALE_REVISION') fail(409, 'Un alt import a fost salvat între timp. Reîncarcă previzualizarea.');
    if (code === 'STALE_MAPPING') fail(409, 'Maparea agenților s-a modificat. Reîncarcă previzualizarea.');
    if (code === 'HISTORICAL_ACK') fail(409, 'Confirmă explicit importul istoric.');
    if (code === 'REGRESSION_ACK') fail(409, 'Confirmă explicit regresul de acoperire.');
    throw error;
  }
}