import { catalog, db, fail, isGlobalManager, readLimited, requireManager, response } from './server';
import type { User } from './types';
import { readCatalog } from './catalog';
import { salesHash, SALES_FILE_LIMIT } from './sales-file';
import { parseSalesFileRuntime } from './sales-parser-runtime';
import { currentSalesImport, importSalesRows, latestSalesImport, latestSalesMonth, salesCoverage, salesRevision, saveSalesOriginal } from './sales-store';
import { getSalesViewRuntime } from './sales-view-runtime';
import type { SalesView } from './sales-types';
import type { SalesAgentMapping } from './sales-types';

type AgentRecord = { id: string; name: string; siteCode: string };

async function activeAgents() {
  const result = await db().prepare("SELECT id,name,site_code FROM users WHERE role='agent' AND active=1 ORDER BY name,id").all<Record<string, unknown>>();
  return result.results.map(row => ({ id: String(row.id), name: String(row.name), siteCode: typeof row.site_code === 'string' ? row.site_code.trim() : '' }));
}

function mappingKey(siteCode: string) { return siteCode.trim().toUpperCase(); }

async function mappingSnapshot() {
  const agents = await activeAgents();
  const grouped = new Map<string, AgentRecord[]>();
  for (const agent of agents) if (agent.siteCode) {
    const list = grouped.get(mappingKey(agent.siteCode)) || [];
    list.push(agent);
    grouped.set(mappingKey(agent.siteCode), list);
  }
  const canonical = agents.map(agent => [agent.id, agent.name, mappingKey(agent.siteCode)]);
  return { agents, grouped, hash: salesHash(JSON.stringify(canonical)) };
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

function mappingsFor(siteCodes: string[], snapshot: Awaited<ReturnType<typeof mappingSnapshot>>) {
  const unique = new Map<string, string>();
  for (const site of siteCodes) { const trimmed = site.trim(); if (!unique.has(mappingKey(trimmed))) unique.set(mappingKey(trimmed), trimmed); }
  return [...unique.values()].sort((a, b) => a.localeCompare(b, 'ro')).map((siteCode): SalesAgentMapping => {
    const candidates = snapshot.grouped.get(mappingKey(siteCode)) || [];
    if (candidates.length === 1) return { siteCode, userId: candidates[0].id, name: candidates[0].name, status: 'mapped' };
    if (candidates.length > 1) return { siteCode, userId: null, name: null, status: 'duplicate', candidates: candidates.map(item => ({ id: item.id, name: item.name })) };
    return { siteCode, userId: null, name: null, status: 'missing' };
  });
}

function decoratedView(view: SalesView, snapshot: Awaited<ReturnType<typeof mappingSnapshot>>) {
  return { ...view, sites: view.sites.map(site => {
    const match = snapshot.grouped.get(mappingKey(site.siteCode)) || [];
    return { ...site, agent: match.length === 1 ? match[0].name : '' };
  }) };
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
  let siteScope:string|string[]|undefined=requestedSite;
  if (user.role === 'agent') {
    const own = snapshot.grouped.get(mappingKey(user.siteCode)) || [];
    if (!user.siteCode.trim()) fail(409, 'Contul tău nu are un SiteCode configurat.');
    if (own.length !== 1 || own[0].id !== user.id) fail(409, 'SiteCode-ul contului nu este asociat unui singur agent activ.');
    siteScope = user.siteCode.trim();
  } else if (!isGlobalManager(user)) {
    const assigned=await db().prepare("SELECT a.id,a.site_code siteCode FROM manager_agents ma JOIN users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.role='agent' AND a.active=1 ORDER BY a.id").bind(user.id).all<{id:string;siteCode:string}>();
    for(const agent of assigned.results){
      const key=mappingKey(agent.siteCode||'');
      if(!key)continue;
      const matches=snapshot.grouped.get(key)||[];
      if(matches.length!==1||matches[0].id!==agent.id)fail(409,'Un SiteCode din aria ta nu este asociat unui singur agent activ.');
    }
    const siteCodes=[...new Map(assigned.results.map(row=>row.siteCode?.trim()).filter(Boolean).map(site=>[mappingKey(site),site])).values()];
    if(requestedSite&&!siteCodes.some(site=>mappingKey(site)===mappingKey(requestedSite)))fail(404,'Gestiunea nu a fost găsită.');
    siteScope=requestedSite||siteCodes;
  }
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
  const mappings = mappingsFor(rows.map(row => row.siteCode), snapshot);
  const historical = !!latestSalesMonth() && month < String(latestSalesMonth());
  const firstDate = rows.reduce((earliest, row) => row.date < earliest ? row.date : earliest, rows[0].date);
  const lastDate = rows.reduce((latest, row) => row.date > latest ? row.date : latest, rows[0].date);
  const currentCoverage=salesCoverage(month);
  const incomingSiteCodes=new Set(rows.map(row=>mappingKey(row.siteCode)).filter(Boolean));
  const missingSiteCodes=currentCoverage.siteCodes.filter(siteCode=>!incomingSiteCodes.has(siteCode));
  const rowDelta=rows.length-currentCoverage.rowCount;
  const requiresRegressionAcknowledgement=currentCoverage.rowCount>0&&(rowDelta<0||!!currentCoverage.firstDate&&firstDate>currentCoverage.firstDate||!!currentCoverage.lastDate&&lastDate<currentCoverage.lastDate||missingSiteCodes.length>0);
  const coverageChange={previousRowCount:currentCoverage.rowCount,rowDelta,previousFirstDate:currentCoverage.firstDate,previousLastDate:currentCoverage.lastDate,missingSiteCodes};
  const currentRevision = salesRevision();
  if (!apply) {
    const sitesInCents = rows.reduce((result, row) => {
      const found = result.find(item => mappingKey(item.siteCode) === mappingKey(row.siteCode));
      if (found) { found.rows++; found.quantity += row.quantity; found.valueCents += row.valueCents; }
      else result.push({ siteCode: row.siteCode, location: row.location, agent: mappings.find(m => mappingKey(m.siteCode) === mappingKey(row.siteCode))?.name || '', rows: 1, quantity: row.quantity, valueCents: row.valueCents });
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