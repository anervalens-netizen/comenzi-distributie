import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';

// Runs only against the synthetic localhost acceptance instance prepared by
// prepare-sales-qa.mjs. Never accept a remote URL or production data directory.
const origin = 'http://127.0.0.1:3026';
const appDb = new DatabaseSync(resolve('work/sales-acceptance-20260914/mobiup.sqlite'));
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
async function call(path, { method = 'GET', cookie, body, headers = {} } = {}, status = 200) {
  const options = { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } };
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) options.body = body;
  const result = await fetch(`${origin}/api/${path}`, options);
  const data = await result.json();
  assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(data).slice(0,300)}`); checks++;
  return { data, cookie: result.headers.get('set-cookie')?.split(';')[0] };
}
async function login(username) {
  return (await call('auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'Sales-QA-2026-only' }) })).cookie;
}
const columns = ['Data','SiteCode','ItemCode','ItemName','Cantitate','Brand','Pret','Valoare','Locatie','Firma','ASM','Regional','Nr','Categorie','SubCategorie','Agent'];
const row = (site, quantity, value, date = '2026-09-01', location = 'TR Gestiune') => [date,site,'P1','Produs verificare',quantity,'Brand',10,value,location,'MobiUp','-','-','BON-1','Cartele','SIM','SURSA'];
function excel(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns,...rows]), 'Vanzari');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
const fileHeaders = { 'Content-Type': 'application/octet-stream', 'X-Sales-Filename': 'vanzari-qa.xlsx' };
async function preview(bytes, cookie) { return (await call('sales/preview', { method: 'POST', cookie, body: bytes, headers: fileHeaders })).data; }
async function apply(bytes, p, cookie, status = 200, allowRegression = false) {
  return (await call('sales/import', { method: 'POST', cookie, body: bytes, headers: { ...fileHeaders, 'X-Sales-Hash': p.fileHash, 'X-Sales-Revision': String(p.revision), 'X-Sales-Mapping-Hash': p.mappingHash, 'X-Sales-Allow-Historical': '1', 'X-Sales-Month': p.month, ...(allowRegression ? { 'X-Sales-Allow-Regression': '1' } : {}) } }, status)).data;
}
try {
  await call('sales?month=2026-09', {}, 401);
  const manager = await login('sales.manager'), regional = await login('sales.regional'), agent = await login('sales.agent'), pending = await login('sales.pending');
  const responsivenessRows=Array.from({length:12000},(_,index)=>row('DAVIDD',1,10,'2026-09-01',index%3===0?'TR Gestiune':'Magazin normal'));
  const responsivenessFile=excel(responsivenessRows);
  ok(responsivenessFile.length<8_000_000,'Responsiveness fixture remains inside accepted upload limit');
  const largePreviewPromise=preview(responsivenessFile,manager);
  await new Promise(resolve=>setTimeout(resolve,30));
  const healthStarted=performance.now();await call('health');const healthElapsed=performance.now()-healthStarted;
  const largePreview=await largePreviewPromise;
  ok(largePreview.rowCount===4000,'Large preview still returns all TR rows through isolated parser');
  ok(healthElapsed<500,`Health remains responsive during heavy preview (${Math.round(healthElapsed)} ms)`);
  const regionalAgent=(await call('bootstrap',{cookie:regional})).data.users.find(user=>user.id==='sales-agent');
  await call('admin/users/sales-agent',{method:'PUT',cookie:regional,headers:{'Content-Type':'application/json'},body:JSON.stringify({name:regionalAgent.name,warehouseName:regionalAgent.warehouseName,siteCode:'TR01PH',version:regionalAgent.profileVersion})},403);
  const bytes = excel([row('DAVIDD',2,20),row('DAVIDD',2,20),row('DAVIDD',-1,-10),row('TR01PH',7,70),row('FUTURE',5,50),row('STORE',100,1000,'2026-09-01','Magazin normal')]);
  await call('sales/preview', { method: 'POST', cookie: agent, body: bytes, headers: fileHeaders }, 403);
  await call('sales/import', { method: 'POST', cookie: agent, body: bytes, headers: fileHeaders }, 403);
  await call('sales/preview', { method: 'POST', cookie: manager, body: bytes, headers: { ...fileHeaders, Origin: 'https://other.invalid' } }, 403);
  const p = await preview(bytes, regional);
  ok(p.rowCount === 5 && p.summary.quantity === 15, 'Regional manager can preview the shared sales import; TR scope, duplicate lines and negative quantities are preserved');
  ok(p.mappings.some(m => m.siteCode === 'FUTURE' && m.status === 'missing'), 'Future agent site retained in preview');
  await apply(bytes, p, regional, 200, true);
  const importStatus=(await call('admin/imports/status',{cookie:regional})).data.sales;
  ok(importStatus?.filename==='vanzari-qa.xlsx'&&importStatus.month==='2026-09'&&importStatus.rows===5&&!!importStatus.importedAt,'Import status exposes latest successful sales file, month and timestamp');
  const duplicatePreview=await call('sales/preview',{method:'POST',cookie:manager,body:bytes,headers:fileHeaders},409);
  ok(duplicatePreview.data.error.includes('Manager regional verificare')&&duplicatePreview.data.error.includes('deja importate'),'Another manager gets a clear already-imported sales message');
  let all = (await call('sales?month=2026-09', { cookie: manager })).data;
  ok(all.summary.quantity === 15 && all.summary.value === 150, 'Manager summary excludes non-TR and retains unassigned TR');
  const regionalAll=(await call('sales?month=2026-09', {cookie:regional})).data;
  ok(regionalAll.summary.quantity===3&&regionalAll.sites.every(site=>site.siteCode==='DAVIDD'),'Regional manager sees aggregate only for assigned agents');
  await call('sales?month=2026-09&siteCode=TR01PH',{cookie:regional},404);
  const own = (await call('sales?month=2026-09&siteCode=TR01PH', { cookie: agent })).data;
  ok(own.summary.quantity === 3 && own.sites.every(s => s.siteCode === 'DAVIDD'), 'Agent cannot select another site');
  await call('sales?month=2026-09', { cookie: pending }, 409);
  const again = await apply(bytes, await preview(bytes, regional), regional);
  ok(again.idempotent === true, 'Same manager can safely retry the same file idempotently');
  const old = excel([row('DAVIDD',4,40,'2026-08-03')]);
  await apply(old, await preview(old, manager), manager, 200, true);
  const currentOnly=(await call('sales?month=2026-09',{cookie:manager})).data;
  ok(currentOnly.monthly.every(item=>item.month==='2026-09'),'Current sales view aggregates only the requested month by default');
  const explicitHistory=(await call('sales?month=2026-09&fromMonth=2026-08&toMonth=2026-09',{cookie:manager})).data;
  ok(explicitHistory.monthly.some(item=>item.month==='2026-08')&&explicitHistory.monthly.some(item=>item.month==='2026-09'),'Sales history aggregates the explicitly requested interval');
  const replace = excel([row('DAVIDD',9,90),row('FUTURE',5,50)]);
  const stale = await preview(replace, manager);
  ok(stale.requiresRegressionAcknowledgement===true,'Reduced row/site coverage requires explicit confirmation even with the same cutoff');
  await apply(replace, stale, manager,409);
  await apply(replace, stale, manager,200,true);
  await apply(bytes, { ...p, revision: stale.revision }, manager, 409);
  all = (await call('sales?month=2026-09', { cookie: manager })).data;
  ok(all.summary.quantity === 14, 'Month replaced rather than appended');
  ok((await call('sales?month=2026-08', { cookie: manager })).data.summary.quantity === 4, 'Other month unchanged');
  const changedMappingPreview = await preview(bytes, manager);
  appDb.prepare("UPDATE users SET site_code='FUTURE' WHERE id='sales-pending'").run();
  await apply(bytes, changedMappingPreview, manager, 409);
  ok((await call('sales?month=2026-09', { cookie: pending })).data.summary.quantity === 5, 'New agent receives existing data without reimport');
  appDb.prepare("UPDATE users SET site_code='davidd' WHERE id='sales-agent'").run();
  ok((await call('sales?month=2026-09', { cookie: agent })).data.summary.quantity === 9, 'SiteCode comparison consistently handles letter case');
  let duplicateSiteRejected=false;
  try { appDb.prepare("UPDATE users SET site_code='DAVIDD' WHERE id='sales-pending'").run(); }
  catch(error) { duplicateSiteRejected=error instanceof Error&&/UNIQUE constraint failed/.test(error.message); }
  ok(duplicateSiteRejected,'Database invariant rejects duplicate active SiteCode case-insensitively');
  appDb.prepare("UPDATE users SET site_code='' WHERE id='sales-pending'").run();
  appDb.prepare("UPDATE users SET site_code='DAVIDD' WHERE id='sales-agent'").run();
  const mixed = excel([row('DAVIDD',1,10),row('DAVIDD',1,10,'2026-08-01')]);
  await call('sales/preview', { method: 'POST', cookie: manager, body: mixed, headers: fileHeaders }, 400);
  const empty = excel([row('STORE',1,10,'2026-09-01','Magazin normal')]);
  await call('sales/preview', { method: 'POST', cookie: manager, body: empty, headers: fileHeaders }, 400);
  ok((await call('sales?month=2026-09', { cookie: manager })).data.summary.quantity === 14, 'Invalid file leaves saved data unchanged');
  const later = excel([row('DAVIDD',11,110,'2026-09-05')]);
  const laterPreview=await preview(later,manager);
  ok(laterPreview.requiresRegressionAcknowledgement===true,'Fewer rows still require confirmation even when the cutoff advances');
  await apply(later,laterPreview,manager,409);
  await apply(later,laterPreview,manager,200,true);
  const regression = await preview(replace, manager);
  ok(regression.requiresRegressionAcknowledgement === true, 'Older cutoff is explicit in preview');
  await apply(replace, regression, manager, 409);
  ok((await call('sales?month=2026-09', { cookie: manager })).data.summary.quantity === 11, 'Unconfirmed older cutoff preserves latest data');
  await apply(replace, regression, manager, 200, true);
  const partialSameCutoff=excel([row('DAVIDD',9,90)]);
  const coverageRegression=await preview(partialSameCutoff,manager);
  ok(coverageRegression.requiresRegressionAcknowledgement===true&&coverageRegression.coverageChange.missingSiteCodes.includes('FUTURE'),'Same cutoff with missing SiteCode is an explicit coverage regression');
  await apply(partialSameCutoff,coverageRegression,manager,409);
  ok((await call('sales?month=2026-09',{cookie:manager})).data.sites.some(site=>site.siteCode==='FUTURE'),'Unconfirmed partial export leaves current month intact');
  await apply(partialSameCutoff,coverageRegression,manager,200,true);
  await call('sales?month=invalid', { cookie: manager }, 400);
  await call('orders', {}, 401);
  await call('health');
  const realFile = process.argv.find(value => value.startsWith('--real-file='))?.slice('--real-file='.length);
  if (realFile) {
    const source = readFileSync(realFile);
    const started = performance.now();
    const realPreview = await preview(source, manager);
    await apply(source, realPreview, manager);
    const realView = (await call(`sales?month=${realPreview.month}`, { cookie: manager })).data;
    ok(realView.summary.rows === realPreview.rowCount && realView.summary.quantity === realPreview.summary.quantity && realView.summary.value === realPreview.summary.value, 'Real monthly Excel preview/import/read reconcile');
    console.log(`Real monthly file: ${realView.summary.rows} TR lines; preview + import + read ${Math.round(performance.now() - started)} ms.`);
  }
  console.log(`Sales HTTP acceptance: ${checks} checks passed.`);
} finally {
  appDb.prepare("UPDATE users SET site_code='' WHERE id='sales-pending'").run();
  appDb.prepare("UPDATE users SET site_code='DAVIDD' WHERE id='sales-agent'").run();
  appDb.close();
}
