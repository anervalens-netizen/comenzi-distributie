#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 1;
const PROVIDER = 'geoapify';
const BATCH_LIMIT = 1000;
const DEFAULT_DAILY_ADDRESS_CAP = 3000;
const MAX_LAT = 90;
const MAX_LON = 180;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function addressFingerprint(record) {
  return sha256(JSON.stringify([record.address || '', record.city || '', record.county || '']));
}
function fail(message) {
  throw new Error(message);
}
function parseArgs(argv) {
  const command = argv[0] || '';
  const opts = {};
  const booleans = new Set(['--execute', '--apply', '--resume', '--help', '--accept-approximate']);
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail('Argument invalid.');
    if (booleans.has(key)) {
      opts[key.slice(2)] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail('Valoare lipsă pentru ' + key + '.');
    if (Object.hasOwn(opts, key.slice(2))) fail('Argument duplicat: ' + key + '.');
    opts[key.slice(2)] = value;
    i += 1;
  }
  return { command, opts };
}
function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail(label + ' trebuie să fie o cale absolută explicită.');
  return resolve(value);
}
function assertDistinctPaths(paths) {
  const resolved = paths.map(item => resolve(item));
  if (new Set(resolved).size !== resolved.length) fail('Căile de intrare, ieșire și bază trebuie să fie diferite.');
}
function readJson(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('Nu pot citi JSON-ul ' + label + '.');
  }
  return parsed;
}
function writeJson(file, value) {
  const target = absolutePath(file, 'Calea de ieșire');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + '.tmp-' + process.pid;
  let fd;
  try {
    fd = openSync(temp, 'w', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    throw error;
  }
  return target;
}
function openDb(file, readOnly) {
  const db = new DatabaseSync(absolutePath(file, 'Calea bazei de date'), { readOnly, enableForeignKeyConstraints: true });
  db.exec('PRAGMA busy_timeout=5000');
  if (readOnly) db.exec('PRAGMA query_only=ON');
  return db;
}
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
}
function hasPosition(row) {
  return row && (row.latitude !== null && row.latitude !== undefined || row.longitude !== null && row.longitude !== undefined);
}
function cleanString(value) {
  return typeof value === 'string' ? value : '';
}
function buildAddressQuery(address, city, county) {
  return [address.trim(), city.trim(), county.trim(), 'Romania'].filter(Boolean).join(', ');
}
function inputDigest(input) {
  const records = input.records.map(record => [
    record.customerId, record.address, record.city, record.county, record.addressFingerprint, record.profileRevision
  ]);
  return sha256(JSON.stringify(input.requestStrategy ? [records, input.requestStrategy, input.records.map(r => [r.query, r.geocodeParams])] : records));
}
export function exportPartners(dbPath, outPath) {
  const databasePath = absolutePath(dbPath, 'Calea bazei de date');
  const outputPath = absolutePath(outPath, 'Calea de ieșire');
  assertDistinctPaths([databasePath, outputPath]);
  const db = openDb(databasePath, true);
  try {
    const pcols = columns(db, 'partner_profiles');
    const records = db.prepare('SELECT id,warehouse_id,data,active FROM customers WHERE active=1 ORDER BY id').all();
    const profileQuery = pcols.has('customer_id')
      ? db.prepare('SELECT * FROM partner_profiles WHERE customer_id=?')
      : null;
    const output = [];
    for (const row of records) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        output.push({ customerId: row.id, eligible: false, reason: 'invalid_customer_json' });
        continue;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        output.push({ customerId: row.id, eligible: false, reason: 'invalid_customer_json' });
        continue;
      }
      const address = cleanString(data.address);
      const city = cleanString(data.city);
      const county = cleanString(data.county);
      const profile = profileQuery ? profileQuery.get(row.id) : null;
      const warehouses = Array.isArray(data.warehouseIds)
        ? [...new Set(data.warehouseIds.filter(value => typeof value === 'string' && value.length > 0))]
        : [];
      if (!warehouses.length && typeof row.warehouse_id === 'string') warehouses.push(row.warehouse_id);
      const currentSource = profile && typeof profile.position_source === 'string' ? profile.position_source : null;
      const currentLatitude = profile && Number.isFinite(profile.latitude) ? profile.latitude : null;
      const currentLongitude = profile && Number.isFinite(profile.longitude) ? profile.longitude : null;
      const record = {
        customerId: row.id,
        warehouseIds: warehouses,
        address,
        city,
        county,
        addressFingerprint: addressFingerprint({ address, city, county }),
        profileRevision: profile && Number.isSafeInteger(profile.revision) ? profile.revision : 0,
        positionSource: currentSource,
        latitude: currentLatitude,
        longitude: currentLongitude
      };
      const protectedSource = currentSource === 'manual' || currentSource === 'gps';
      const positioned = hasPosition(profile);
      const query = buildAddressQuery(address, city, county);
      record.query = query;
      record.eligible = !protectedSource && !positioned && Boolean(address.trim());
      if (protectedSource) record.reason = 'protected_manual_or_gps';
      else if (positioned) record.reason = 'already_positioned';
      else if (!address.trim()) record.reason = 'missing_address';
      output.push(record);
    }
    const manifest = {
      format: 'partner-geocode-export',
      version: VERSION,
      provider: PROVIDER,
      exportedAt: new Date().toISOString(),
      databaseMode: 'read-only',
      customerCount: output.length,
      eligibleCount: output.filter(record => record.eligible).length,
      records: output
    };
    manifest.inputDigest = inputDigest(manifest);
    writeJson(outputPath, manifest);
    return { customerCount: manifest.customerCount, eligibleCount: manifest.eligibleCount, out: outputPath, digest: manifest.inputDigest };
  } finally {
    db.close();
  }
}
function assertExport(input) {
  if (!input || input.format !== 'partner-geocode-export' || input.version !== VERSION || !Array.isArray(input.records)) {
    fail('Formatul exportului nu este recunoscut.');
  }
  if (inputDigest(input) !== input.inputDigest) fail('Exportul a fost schimbat după generare.');
}
function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -MAX_LAT && latitude <= MAX_LAT && longitude >= -MAX_LON && longitude <= MAX_LON;
}
function sanitizeProviderItem(item, record, index) {
  const payload = item && item.result ? item.result : item;
  let feature = null;
  if (payload && Array.isArray(payload.features)) feature = payload.features[0] || null;
  if (payload && Array.isArray(payload.results)) {
    const nested = payload.results[0];
    if (nested && nested.result) {
      const result = nested.result;
      if (Array.isArray(result.features)) feature = result.features[0] || null;
    }
  }
  const properties = feature && feature.properties ? feature.properties : (payload && typeof payload === 'object' ? payload : {});
  const geometry = feature && feature.geometry && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates : null;
  const longitude = Number.isFinite(properties.lon) ? properties.lon : geometry && geometry[0];
  const latitude = Number.isFinite(properties.lat) ? properties.lat : geometry && geometry[1];
  if (!validCoordinates(latitude, longitude)) {
    return { customerId: record.customerId, status: 'no_result', batchIndex: index, addressFingerprint: record.addressFingerprint };
  }
  const rank = properties.rank && typeof properties.rank === 'object' ? properties.rank : {};
  const datasource = properties.datasource && typeof properties.datasource === 'object' ? properties.datasource : {};
  const evidence = {
    provider: PROVIDER,
    latitude,
    longitude,
    countryCode: cleanString(properties.country_code).toLowerCase(),
    resultType: cleanString(properties.result_type),
    houseNumber: cleanString(properties.housenumber),
    street: cleanString(properties.street),
    city: cleanString(properties.city),
    localities: Object.fromEntries(['village', 'town', 'suburb', 'district', 'hamlet'].filter(k => cleanString(properties[k])).map(k => [k, properties[k]])),
    county: cleanString(properties.county || properties.state),
    formatted: cleanString(properties.formatted),
    matchType: cleanString(rank.match_type),
    confidence: Number.isFinite(rank.confidence) ? rank.confidence : null,
    confidenceStreetLevel: Number.isFinite(rank.confidence_street_level) ? rank.confidence_street_level : null,
    confidenceCityLevel: Number.isFinite(rank.confidence_city_level) ? rank.confidence_city_level : null,
    attribution: cleanString(datasource.attribution),
    dataSource: cleanString(datasource.sourcename),
    license: cleanString(datasource.license),
    sourceUrl: cleanString(datasource.url)
  };
  return {
    customerId: record.customerId,
    status: 'result',
    batchIndex: index,
    addressFingerprint: record.addressFingerprint,
    evidence,
    evidenceHash: sha256(JSON.stringify({ customerId: record.customerId, addressFingerprint: record.addressFingerprint, query: record.query, evidence }))
  };
}
function providerItemId(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id === 'string') return item.id;
  if (item.result && typeof item.result.id === 'string') return item.result.id;
  return null;
}
async function geoFetch(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) fail('Geoapify a răspuns cu HTTP ' + response.status + '.');
    try {
      return await response.json();
    } catch {
      fail('Răspuns Geoapify invalid.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Geoapify a răspuns cu HTTP')) throw error;
    fail('Apelul Geoapify a eșuat sau a expirat; relansează cu --resume pentru a continua din checkpoint.');
  } finally {
    clearTimeout(timer);
  }
}
async function pollJob(jobId, apiKey, timeoutMs, fetchImpl, creditLedger, pollIntervalMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = new URL('https://api.geoapify.com/v1/batch');
    url.searchParams.set('id', jobId);
    url.searchParams.set('apiKey', apiKey);
    let response;
    if(creditLedger)creditCapacity(creditLedger,1,'poll:'+jobId);
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.min(20000, timeoutMs)) }); }
    catch { fail('Interogarea jobului Geoapify a eșuat; relansează cu --resume.'); }
    if (response.status === 200) {
      try { return await response.json(); } catch { fail('Răspuns Geoapify invalid.'); }
    }
    if (response.status !== 202) fail('Geoapify a răspuns cu HTTP ' + response.status + '.');
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollIntervalMs));
  }
  fail('Jobul Geoapify este încă în procesare; relansează cu --resume.');
}
function mapBatchResults(items, records, requestIds) {
  const byId = new Map();
  for (const item of items) {
    const id = providerItemId(item);
    if (id !== null) byId.set(id, item);
  }
  const output = [];
  for (let i = 0; i < records.length; i += 1) {
    const item = byId.get(requestIds[i]);
    output.push(sanitizeProviderItem(item, records[i], i));
  }
  return output;
}
function addBatchResults(manifest, records, results) {
  for (const result of results) manifest.results[result.customerId] = result;
  for (const job of manifest.jobs) {
    if (job.customerIds.every(id => Object.hasOwn(manifest.results, id))) job.status = 'complete';
  }
}
export function dailyCapacity(ledgerPath, reserve = 0, now = Date.now(), reservationId = null) {
  const db = openDb(ledgerPath, false);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS geocode_budget(id TEXT PRIMARY KEY, reserved_at INTEGER NOT NULL, addresses INTEGER NOT NULL CHECK(addresses>0)); BEGIN IMMEDIATE');
    const used = Number(db.prepare('SELECT COALESCE(SUM(addresses),0) n FROM geocode_budget WHERE reserved_at>?').get(now - 86400000).n);
    if (reserve < 0 || !Number.isSafeInteger(reserve) || used + reserve > DEFAULT_DAILY_ADDRESS_CAP) fail('Cota locală de 3000 cereri/24h este epuizată. Nicio cerere nouă trimisă.');
    if (reserve) db.prepare('INSERT INTO geocode_budget VALUES(?,?,?)').run(reservationId || sha256(String(now) + ':' + process.pid + ':' + Math.random()), now, reserve);
    db.exec('COMMIT');
    chmodSync(ledgerPath, 0o600);
    return DEFAULT_DAILY_ADDRESS_CAP - used - reserve;
  } finally { db.close(); }
}
export function creditCapacity(ledgerPath, reserve = 0, label = 'geocoding', now = Date.now()) {
  const db=openDb(ledgerPath,false);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS geocode_credits(id INTEGER PRIMARY KEY, reserved_at INTEGER NOT NULL, credits REAL NOT NULL CHECK(credits>0), label TEXT NOT NULL); BEGIN IMMEDIATE');
    const used=Number(db.prepare('SELECT COALESCE(SUM(credits),0) n FROM geocode_credits WHERE reserved_at>?').get(now-86400000).n);
    if (!Number.isFinite(reserve) || reserve<0 || used+reserve>3000) fail('Bugetul gratuit local de 3000 credite/24h nu mai permite apelul.');
    if(reserve)db.prepare('INSERT INTO geocode_credits(reserved_at,credits,label) VALUES(?,?,?)').run(now,reserve,label);
    db.exec('COMMIT');chmodSync(ledgerPath,0o600);return 3000-used-reserve;
  }finally{db.close();}
}
function providerQuery(record) {
  if (!record.geocodeParams) return { text: record.query, filter: 'countrycode:ro', limit: 1 };
  const params = record.geocodeParams.type === 'street' ? streetAddress(record) : structuredAddress(record);
  if (!params || JSON.stringify(params) !== record.query) fail('Prepared query differs from address components.');
  return { ...params, filter: 'countrycode:ro', limit: 1 };
}
export async function batchPartners(inputPath, outPath, options = {}, fetchImpl = fetch) {
  const input = readJson(absolutePath(inputPath, 'Exportul'), 'export');
  assertExport(input);
  const outputPath = absolutePath(outPath, 'Calea rezultatelor');
  assertDistinctPaths([inputPath, outputPath]);
  if(options.creditLedger && options.dailyLedger)fail('Choose credit ledger; do not combine it with legacy address-count ledger.');
  const key = options.execute ? process.env.GEOAPIFY_API_KEY : '';
  if (options.execute && (!key || !key.trim())) fail('Blocat: GEOAPIFY_API_KEY nu este configurată. Nu s-a făcut nicio cerere.');
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs === undefined ? 60000 : options.pollIntervalMs;
  const creditPollBuffer = options.creditPollBuffer === undefined ? 100 : options.creditPollBuffer;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 60000 || pollIntervalMs > 300000) fail('Intervalul de polling trebuie să fie între 60000 și 300000 ms.');
  if (!Number.isSafeInteger(creditPollBuffer) || creditPollBuffer < 0 || creditPollBuffer > 100) fail('Rezerva de polling trebuie să fie între 0 și 100 credite.');
  const maxAddresses = options.maxAddresses === undefined ? DEFAULT_DAILY_ADDRESS_CAP : options.maxAddresses;
  if (!Number.isSafeInteger(maxAddresses) || maxAddresses < 1 || maxAddresses > DEFAULT_DAILY_ADDRESS_CAP) fail('Limita maximă este 3000 de adrese pe rulare; poți alege o limită mai mică.');
  let manifest;
  if (existsSync(outputPath)) {
    if (!options.resume) fail('Fișierul de rezultate există; folosește --resume sau alege alt --out.');
    manifest = readJson(outputPath, 'checkpoint');
    if (manifest.format !== 'partner-geocode-results' || manifest.inputDigest !== input.inputDigest) fail('Checkpointul nu corespunde exportului.');
  } else {
    manifest = {
      format: 'partner-geocode-results',
      version: VERSION,
      provider: PROVIDER,
      createdAt: new Date().toISOString(),
      inputDigest: input.inputDigest,
      dryRun: !options.execute,
      jobs: [],
      results: {}
    };
  }
  if (!options.execute) {
    const pending = input.records.filter(record => record.eligible && !Object.hasOwn(manifest.results, record.customerId)).length;
    writeJson(outputPath, manifest);
    return { dryRun: true, apiCalls: 0, pending, runCapacity: Math.min(pending, maxAddresses), results: Object.keys(manifest.results).length, out: outputPath };
  }
  manifest.dryRun = false;
  for (const job of manifest.jobs.filter(item => item.status === 'submitted')) {
    const body = await pollJob(job.jobId, key, timeoutMs, fetchImpl, options.creditLedger, pollIntervalMs);
    const items = Array.isArray(body.results) ? body.results : Array.isArray(body) ? body : [];
    const records = job.customerIds.map(id => input.records.find(record => record.customerId === id)).filter(Boolean);
    const requestIds = records.map((record, index) => 'r' + String(index));
    const results = mapBatchResults(items, records, requestIds);
    addBatchResults(manifest, records, results);
    writeJson(outputPath, manifest);
  }
  const pending = input.records.filter(record => record.eligible && !Object.hasOwn(manifest.results, record.customerId));
  const runLimit = Math.min(pending.length, maxAddresses, options.creditLedger ? Math.max(0,Math.floor((creditCapacity(options.creditLedger)-creditPollBuffer)/0.5)) : options.dailyLedger ? dailyCapacity(options.dailyLedger) : maxAddresses);
  for (let offset = 0; offset < runLimit; offset += BATCH_LIMIT) {
    const records = pending.slice(offset, Math.min(offset + BATCH_LIMIT, runLimit));
    const requestIds = records.map((record, index) => 'r' + String(index));
    const inputs = records.map((record, index) => ({
      id: requestIds[index],
      params: providerQuery(record)
    }));
    const postUrl = new URL('https://api.geoapify.com/v1/batch');
    postUrl.searchParams.set('apiKey', key);
    if (options.dailyLedger) dailyCapacity(options.dailyLedger, records.length);
    if (options.creditLedger) creditCapacity(options.creditLedger, records.length*0.5+1,'submit:'+records.length);
    const body = await geoFetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ api: '/v1/geocode/search', priority: 0.5, params: { limit: 1 }, inputs })
    }, timeoutMs, fetchImpl);
    let completed;
    const customerIds = records.map(record => record.customerId);
    if (typeof body.id === 'string' && body.id) {
      const job = { jobId: body.id, status: 'submitted', customerIds, submittedAt: new Date().toISOString() };
      manifest.jobs.push(job);
      writeJson(outputPath, manifest);
      completed = await pollJob(body.id, key, timeoutMs, fetchImpl, options.creditLedger, pollIntervalMs);
    } else if (Array.isArray(body) || (body && Array.isArray(body.results))) {
      manifest.jobs.push({ jobId: null, status: 'complete', customerIds, submittedAt: new Date().toISOString(), completedAt: new Date().toISOString(), immediate: true });
      completed = body;
    } else {
      fail('Geoapify nu a returnat nici rezultate imediate, nici ID-ul jobului.');
    }
    const items = Array.isArray(completed.results) ? completed.results : Array.isArray(completed) ? completed : [];
    const results = mapBatchResults(items, records, requestIds);
    addBatchResults(manifest, records, results);
    writeJson(outputPath, manifest);
  }
  return { dryRun: false, apiCalls: manifest.jobs.length, pending: Math.max(0, pending.length - runLimit), results: Object.keys(manifest.results).length, out: outputPath };
}
function normalized(value) {
  return cleanString(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function normalizedAdmin(value) {
  return normalized(value).replace(/^(?:judet|judetul|county|county of)\s+/, '').trim();
}
const STREET_TYPES = /^(?:(?:str(?:ada)?|bd(?:ul)?|blv|bulevard(?:ul)?|sos(?:eaua)?|calea|cale|piata|alee(?:a)?|intrarea)\s+)+/;
export function addressParts(address, city = '') {
 let body=cleanString(address).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const comma=body.indexOf(',');
 if(comma>=0 && normalized(body.slice(0,comma))===normalized(city))body=body.slice(comma+1).trim();
 const principalSuffix=/^(?:(?:strada|str)\.?\s*)?principala\s+(.+)$/.exec(body.trim());
 if(city && principalSuffix && normalized(principalSuffix[1])===normalized(city))body='principala';
 // Only strip a locality suffix after an explicit spaced dash, and only if it
 // equals this customer's locality. Never split a hyphenated street name.
 if(city){const suffix=/\s+[-–—]\s+([^,;]+)\s*$/.exec(body);if(suffix&&normalized(suffix[1])===normalized(city))body=body.slice(0,suffix.index);}
 body=body.split(/(?:^|[\s,;.])(?:(?:bloc|scara|etaj|apartament|camera|corp|parter)\b|(?:bl|sc|et|ap|cam)(?=[\s.:0-9]|[a-z](?:\b|[0-9])))/i)[0].trim().replace(/[,;]+$/, '').trim();
 body=body.replace(/\s+f\.?\s*\/?\s*n\.?(?:\s.*)?$/i,'').trim();
 body=body.replace(/\b(?:nr|nmr|numar)[\s.:]*$/i,'').trim();
 const explicit=/\b(?:nr|nmr|num(?:ar)?)[\s.:-]*([0-9]+(?:[ /]?[a-z])?(?:[-/][0-9]+[a-z]?)?)(?![a-z0-9])/i.exec(body);
 if(explicit)return {number:canonicalHouse(explicit[1]),street:body.slice(0,explicit.index)};
 const plain=normalized(body).replace(STREET_TYPES,'');
 if(/^\d{1,2}\s+(?:ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)(?:\s+(?:18|19|20)\d{2})?$/.test(plain))return {number:'',street:body};
 const trailing=/(?:^|[\s,;])([0-9]+(?:[ /]?[a-z])?(?:[-/][0-9]+[a-z]?)?)\s*$/i.exec(body);
 return trailing?{number:canonicalHouse(trailing[1]),street:body.slice(0,trailing.index)}:{number:'',street:body};
}
function canonicalHouse(value) { return cleanString(value).toLowerCase().replace(/^(\d+)[ /]+([a-z])$/, '$1$2'); }
export function addressHouseNumber(address, city = '') { return addressParts(address,city).number; }
function streetKind(value) {
 const prefix=normalized(value).match(STREET_TYPES)?.[0]?.trim().split(/\s+/).at(-1);
 if(!prefix)return '';
 if(/^(?:str|strada)$/.test(prefix))return 'strada';
 if(/^(?:bd|bdul|blv|bulevard|bulevardul)$/.test(prefix))return 'bulevard';
 if(/^(?:sos|soseaua)$/.test(prefix))return 'sosea';
 if(/^(?:cale|calea)$/.test(prefix))return 'cale';
 if(/^(?:alee|aleea)$/.test(prefix))return 'alee';
 return prefix;
}
export function providerStreetMatchesAddress(record,evidence) {
 const input=normalized(addressParts(record.address,record.city).street).replace(STREET_TYPES,'');
 const provider=normalized(evidence.street).replace(STREET_TYPES,'');
 const aKind=streetKind(addressParts(record.address,record.city).street),bKind=streetKind(evidence.street);
 return !!input && !!provider && input===provider && (!aKind || !bKind || aKind===bKind);
}
export function providerLocalityMatches(record, evidence) {
  if (!record.city) return false;
  const locality = normalized(record.city);
  // Village/suburb fields belong to the returned coordinate, unlike parsed input.
  return ['city', 'village', 'town', 'suburb', 'district', 'hamlet'].some(key => {
    const value = key === 'city' ? evidence.city : evidence.localities?.[key];
    return typeof value === 'string' && normalized(value) === locality;
  });
}
export function replayResults(exportPath, resultsPath, rawDirectory, outPath) {
  assertDistinctPaths([exportPath, resultsPath, outPath]);
  const input = readJson(absolutePath(exportPath,'Export'), 'export'); assertExport(input);
  const previous = readJson(absolutePath(resultsPath,'Results'), 'results');
  const rawRoot = absolutePath(rawDirectory, 'Raw response directory');
  if (previous.format !== 'partner-geocode-results' || previous.inputDigest !== input.inputDigest) fail('Results do not match export.');
  if (existsSync(outPath)) fail('Replay output already exists.');
  const records = new Map(input.records.map(r => [r.customerId,r]));
  const output = { ...previous, results: {}, replayedAt: new Date().toISOString(), replaySource: resultsPath };
  for (let index=0;index<previous.jobs.length;index++) {
    const job=previous.jobs[index];
    if (job.status !== 'complete') fail('Replay requires completed jobs.');
    const raw=readJson(join(rawRoot, 'raw-job-'+index+'.json'),'raw response');
    if (raw.id !== job.jobId || !Array.isArray(raw.results) || raw.results.length !== job.customerIds.length) fail('Raw job identity/count mismatch.');
    const ids=new Set();
    for (const item of raw.results) {
      if (!/^r(?:0|[1-9][0-9]*)$/.test(item.id) || ids.has(item.id)) fail('Raw item identity mismatch.');
      ids.add(item.id);
      const record=records.get(job.customerIds[Number(item.id.slice(1))]);
      if (!record || item.params?.text !== record.query) fail('Raw query does not match original customer query.');
      const result=sanitizeProviderItem(item, record, Number(item.id.slice(1)));
      output.results[record.customerId]=result;
    }
  }
  writeJson(outPath,output);
  return {results:Object.keys(output.results).length,apiCalls:0,out:outPath};
}
function recommendation(record, result) {
  const e = result && result.evidence;
  if (!e) return { decision: 'review', reasons: ['provider_returned_no_match'] };
  const reasons = [];
  if (e.countryCode !== 'ro') reasons.push('country_not_ro');
  if (e.resultType !== 'building') reasons.push('result_not_building');
  if (e.matchType !== 'full_match') reasons.push('match_not_full');
  if (!Number.isFinite(e.confidence) || e.confidence < 0.9) reasons.push('low_confidence');
  const inputNumber = addressHouseNumber(record.address, record.city);
  if (!inputNumber) reasons.push('input_house_number_unparsed');
  if (!cleanString(e.houseNumber) || (inputNumber && normalized(canonicalHouse(e.houseNumber)) !== normalized(inputNumber))) reasons.push('house_number_unverified');
  if (!providerStreetMatchesAddress(record,e)) reasons.push('street_missing_or_mismatch');
  if (!record.county || !e.county || normalizedAdmin(record.county) !== normalizedAdmin(e.county)) reasons.push('county_missing_or_mismatch');
  if (!providerLocalityMatches(record, e)) reasons.push('city_missing_or_mismatch');
  return { decision: reasons.length === 0 ? 'approve_recommended' : 'review', reasons };
}
// Approximate pins are allowed on a verified street when locality and county match.
// House-number disagreement and non-building POIs do not block this street-level pin.
// City/region centroids and results without exact street evidence remain ineligible.
export function classifyPosition(record, evidence) {
  const strict = recommendation(record, { evidence });
  if (strict.decision === 'approve_recommended') return 'address';
  if (!evidence || !validCoordinates(evidence.latitude, evidence.longitude)) return null;
  const allowed = new Set(['low_confidence', 'match_not_full']);
  if (evidence.resultType === 'amenity') allowed.add('result_not_building');
  if (strict.reasons.every(reason => allowed.has(reason))) return 'address_approximate';
  const streetPointTypes = new Set(['building', 'amenity', 'street']);
  const streetAndLocalityMatch = evidence.countryCode === 'ro' &&
    streetPointTypes.has(evidence.resultType) &&
    providerStreetMatchesAddress(record, evidence) &&
    providerLocalityMatches(record, evidence) &&
    Boolean(record.county && evidence.county &&
      normalizedAdmin(record.county) === normalizedAdmin(evidence.county));
  if (streetAndLocalityMatch) return 'street_approximate';
  return null;
}
export function createReview(exportPath, resultsPath, outPath, acceptApproximate = false) {
  const sourcePath = absolutePath(exportPath, 'Exportul');
  const batchPath = absolutePath(resultsPath, 'Rezultatele');
  const reviewPath = absolutePath(outPath, 'Calea de review');
  assertDistinctPaths([sourcePath, batchPath, reviewPath]);
  const input = readJson(sourcePath, 'export');
  const results = readJson(batchPath, 'rezultate');
  assertExport(input);
  if (!results || results.format !== 'partner-geocode-results' || results.provider !== PROVIDER || results.inputDigest !== input.inputDigest) {
    fail('Rezultatele nu corespund exportului.');
  }
  const items = [];
  const unmatched = [];
  for (const record of input.records.filter(item => item.eligible)) {
    const result = results.results[record.customerId];
    if (!result || result.status !== 'result' || !result.evidence || result.addressFingerprint !== record.addressFingerprint || sha256(JSON.stringify({ customerId: record.customerId, addressFingerprint: record.addressFingerprint, query: record.query, evidence: result.evidence })) !== result.evidenceHash) {
      unmatched.push({ customerId: record.customerId, address: record.address, city: record.city, county: record.county, query: record.query, status: result ? result.status : 'not_processed' });
      continue;
    }
    const rec = recommendation(record, result);
    items.push({
      customerId: record.customerId,
      warehouseIds: record.warehouseIds,
      address: record.address,
      city: record.city,
      county: record.county,
      query: record.query,
      addressFingerprint: record.addressFingerprint,
      expectedProfileRevision: record.profileRevision,
      coordinates: { latitude: result.evidence.latitude, longitude: result.evidence.longitude },
      provider: PROVIDER,
      providerEvidence: result.evidence,
      evidenceHash: result.evidenceHash,
      suggestedDecision: acceptApproximate && classifyPosition(record, result.evidence) ? 'approve_recommended' : rec.decision,
      positionQuality: classifyPosition(record, result.evidence),
      reviewReasons: rec.reasons,
      approved: false
    });
  }
  const review = {
    format: 'partner-geocode-review',
    version: VERSION,
    provider: PROVIDER,
    inputDigest: input.inputDigest,
    createdAt: new Date().toISOString(),
    instructions: 'Set approved=true only after reviewing the provider evidence. Keep coordinate/evidence fields unchanged.',
    items,
    unmatched
  };
  writeJson(reviewPath, review);
  return { items: items.length, recommended: items.filter(item => item.suggestedDecision === 'approve_recommended').length, manualReview: items.filter(item => item.suggestedDecision !== 'approve_recommended').length, unmatched: unmatched.length, out: reviewPath };
}
export function structuredAddress(record) {
  const { number, street } = addressParts(record.address, record.city);
  const streetName = street.trim().replace(/[,;.:]+$/, '').trim();
  const village = normalized(streetName).replace(/^(?:sat|satul|comuna|com)\s+/, '') === normalized(record.city);
  // Do not manufacture "Principala" for a rural number-only address.
  return {
    ...(number ? { housenumber: number } : {}),
    ...(!village && streetName ? { street: streetName } : {}),
    city: record.city, state: record.county, country: 'Romania', lang: 'ro'
  };
}
export function streetAddress(record) {
  const { housenumber: _number, ...params } = structuredAddress(record);
  if (!params.street) return null;
  return { ...params, type: 'street' };
}
export function createWorkQueue(dbPath, reviewPaths, outPath, retryPath, freshPath = null) {
  assertDistinctPaths([dbPath, ...reviewPaths, outPath, retryPath, outPath + '.snapshot.json', ...(freshPath ? [freshPath] : [])]);
  if (existsSync(retryPath) || (freshPath && existsSync(freshPath))) fail('Prepared input already exists; use new output paths.');
  exportPartners(dbPath, outPath + '.snapshot.json');
  const current = readJson(outPath + '.snapshot.json', 'snapshot');
  const history = new Map();
  for (const path of reviewPaths) {
    const review = readJson(path, 'review');
    if (review.format !== 'partner-geocode-review') fail('Queue requires review manifests.');
    for (const item of [...review.items, ...review.unmatched]) {
      if (item.status === 'not_processed') continue;
      if (item.providerEvidence && !verifyReviewItem(item)) fail('Invalid review evidence.');
      const previous = history.get(item.customerId) || [];
      previous.push(item); history.set(item.customerId, previous);
    }
  }
  const retryRecords = [], freshRecords = [], items = [];
  for (const record of current.records) {
    const attempts = (history.get(record.customerId) || []).filter(i => i.address === record.address && i.city === record.city && i.county === record.county);
    const last = attempts.at(-1);
    const params = structuredAddress(record);
    const query = JSON.stringify(params);
    const streetParams = streetAddress(record);
    const streetQuery = streetParams ? JSON.stringify(streetParams) : null;
    const usable = record.address && record.city && record.county &&
      !/^(?:inchis|inactiv|desfiintat|fara adresa|necunoscut|n a|[0-]+)$/.test(normalized(record.address)) &&
      Boolean(params.street || params.housenumber);
    let status, nextAction;
    if (record.latitude !== null && record.latitude !== undefined && record.longitude !== null) {
      status = 'positioned'; nextAction = 'field_correction_if_needed';
    } else if (!usable) {
      status = 'address_data_review'; nextAction = 'verify_original_address_or_confirm_store_activity';
    } else if (!attempts.length) {
      status = 'not_processed'; nextAction = 'first_geocoding';
      freshRecords.push({ ...record, eligible: true, query, geocodeParams: params });
    } else if (attempts.some(i => i.providerEvidence && classifyPosition(i, i.providerEvidence))) {
      status = 'pending_import'; nextAction = 'review_and_import_candidate_with_current_revision';
    } else if (streetParams && !attempts.some(i => i.query === streetQuery)) {
      status = 'retry_street'; nextAction = 'geocode_street_city_county_without_house_number';
      retryRecords.push({ ...record, eligible: true, query: streetQuery, geocodeParams: streetParams });
    } else if (attempts.some(i => i.query === query)) {
      status = 'targeted_review'; nextAction = 'check_locality_alias_and_street_in_independent_map_source';
    } else {
      status = 'retry_structured'; nextAction = 'geocode_separate_street_number_city_county';
      retryRecords.push({ ...record, eligible: true, query, geocodeParams: params });
    }
    items.push({ customerId: record.customerId, address: record.address, city: record.city, county: record.county,
      status, nextAction, attempts: attempts.length, reasons: last?.reviewReasons || (last ? [last.status] : []),
      previousFormatted: last?.providerEvidence?.formatted || null });
  }
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  writeJson(outPath, { format: 'partner-geocode-work-queue', createdAt: new Date().toISOString(), counts, items });
  const retry = { ...current, requestStrategy: 'structured-address-v2', records: retryRecords,
    customerCount: retryRecords.length, eligibleCount: retryRecords.length };
  retry.inputDigest = inputDigest(retry);
  writeJson(retryPath, retry);
  if (freshPath) {
    const fresh = { ...retry, records: freshRecords, customerCount: freshRecords.length, eligibleCount: freshRecords.length };
    fresh.inputDigest = inputDigest(fresh); writeJson(freshPath, fresh);
  }
  return { counts, retryCount: retryRecords.length, freshCount: freshRecords.length, out: outPath, retryOut: retryPath, freshOut: freshPath };
}
function verifyReviewItem(item) {
  if (!item || item.provider !== PROVIDER || !item.providerEvidence || !item.coordinates) return false;
  if (!validCoordinates(item.coordinates.latitude, item.coordinates.longitude)) return false;
  if (item.coordinates.latitude !== item.providerEvidence.latitude || item.coordinates.longitude !== item.providerEvidence.longitude) return false;
  return sha256(JSON.stringify({ customerId: item.customerId, addressFingerprint: item.addressFingerprint, query: item.query, evidence: item.providerEvidence })) === item.evidenceHash;
}
function rowAddressMatches(data, item) {
  return cleanString(data.address) === item.address &&
    cleanString(data.city) === item.city &&
    cleanString(data.county) === item.county &&
    addressFingerprint({ address: data.address, city: data.city, county: data.county }) === item.addressFingerprint;
}
function assertImportSchema(db) {
  const required = ['customer_id', 'latitude', 'longitude', 'position_source', 'position_provider', 'position_metadata', 'address_fingerprint', 'revision', 'updated_at'];
  const available = columns(db, 'partner_profiles');
  if (!tableExists(db, 'partner_profiles')) fail('Blocat: partner_profiles nu există în baza explicitată.');
  if (required.some(column => !available.has(column))) fail('Blocat: schema partner_profiles nu are încă toate coloanele necesare geocodării.');
}
function addressLevelEvidenceAccepted(item, acceptApproximate) {
  const e = item && item.providerEvidence;
  return verifyReviewItem(item) && (acceptApproximate ? Boolean(classifyPosition(item, e)) : recommendation(item, { evidence: e }).decision === 'approve_recommended');
}
export function importReview(dbPath, reviewPath, outPath, apply = false, acceptApproximate = false) {
  const databasePath = absolutePath(dbPath, 'Calea bazei de date');
  const reviewFile = absolutePath(reviewPath, 'Fișierul review');
  const auditFile = absolutePath(outPath, 'Calea auditului');
  assertDistinctPaths([databasePath, reviewFile, auditFile]);
  const review = readJson(reviewFile, 'review');
  if (!review || review.format !== 'partner-geocode-review' || review.version !== VERSION || review.provider !== PROVIDER || !Array.isArray(review.items)) {
    fail('Formatul fișierului review nu este recunoscut.');
  }
  const approved = review.items.filter(item => item.approved === true);
  const invalidApproved = approved.filter(item => !addressLevelEvidenceAccepted(item, acceptApproximate));
  if (invalidApproved.length) fail('Import respins: dovezile nu satisfac politica de potrivire a adresei/străzii și localității/județului. Pozițiile aproximative necesită --accept-approximate.');
  const db = openDb(databasePath, !apply);
  const audit = { format: 'partner-geocode-import-audit', version: VERSION, dryRun: !apply, provider: PROVIDER, startedAt: new Date().toISOString(), approved: approved.length, applied: 0, wouldApply: 0, skipped: review.items.length - approved.length, outcomes: [] };
  try {
    assertImportSchema(db);
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    const getCustomer = db.prepare('SELECT data FROM customers WHERE id=? AND active=1');
    const getProfile = db.prepare('SELECT latitude,longitude,position_source,revision FROM partner_profiles WHERE customer_id=?');
    const requestColumns = columns(db, 'partner_requests');
    const hasConfirmedRequests = ['id', 'customer_id', 'status', 'payload', 'confirmed_at', 'updated_at'].every(column => requestColumns.has(column));
    const payloadExpr = hasConfirmedRequests ? "(SELECT payload FROM partner_requests WHERE customer_id=c.id AND status='confirmed' ORDER BY confirmed_at DESC,updated_at DESC,id DESC LIMIT 1)" : 'NULL';
    const contactExpr = hasConfirmedRequests ? "COALESCE(json_extract(" + payloadExpr + ",'$.contact'),'')" : "''";
    const phoneExpr = hasConfirmedRequests ? "COALESCE(json_extract(" + payloadExpr + ",'$.phone'),'')" : "''";
    const emailExpr = hasConfirmedRequests ? "COALESCE(json_extract(" + payloadExpr + ",'$.email'),'')" : "''";
    const insertProfile = apply ? db.prepare("INSERT INTO partner_profiles(customer_id,contact,phone,email,latitude,longitude,position_source,position_provider,position_metadata,address_fingerprint,revision,updated_at) SELECT c.id," + contactExpr + "," + phoneExpr + "," + emailExpr + ",?,?,'geocoding',?,?,?,1,? FROM customers c WHERE c.id=? AND c.active=1 AND COALESCE(json_extract(c.data,'$.address'),'')=? AND COALESCE(json_extract(c.data,'$.city'),'')=? AND COALESCE(json_extract(c.data,'$.county'),'')=? AND NOT EXISTS (SELECT 1 FROM partner_profiles WHERE customer_id=c.id)") : null;
    const updateProfile = apply ? db.prepare("UPDATE partner_profiles SET latitude=?,longitude=?,position_source='geocoding',position_provider=?,position_metadata=?,address_fingerprint=?,revision=revision+1,updated_at=?,updated_by=NULL WHERE customer_id=? AND revision=? AND latitude IS NULL AND longitude IS NULL AND position_source IS NULL AND EXISTS (SELECT 1 FROM customers WHERE id=? AND active=1 AND COALESCE(json_extract(data,'$.address'),'')=? AND COALESCE(json_extract(data,'$.city'),'')=? AND COALESCE(json_extract(data,'$.county'),'')=?)") : null;
    const now = new Date().toISOString();
    for (const item of approved) {
      let outcome;
      const row = getCustomer.get(item.customerId);
      if (!row) outcome = 'customer_missing_or_inactive';
      else {
        let data;
        try { data = JSON.parse(row.data); } catch { data = null; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) outcome = 'customer_json_invalid';
        else if (!rowAddressMatches(data, item)) outcome = 'address_changed';
        else {
          const profile = getProfile.get(item.customerId);
          if (!Number.isSafeInteger(item.expectedProfileRevision) || item.expectedProfileRevision < 0) outcome = 'invalid_profile_revision';
          else if (item.expectedProfileRevision === 0 ? Boolean(profile) : (!profile || profile.revision !== item.expectedProfileRevision)) outcome = 'profile_revision_changed';
          else if (profile && (profile.position_source === 'manual' || profile.position_source === 'gps' || hasPosition(profile) || profile.position_source !== null)) outcome = 'existing_position_preserved';
          else outcome = 'would_apply';
          if (outcome === 'would_apply' && apply) {
            const metadata = JSON.stringify({
              query: item.query,
              positionQuality: classifyPosition(item, item.providerEvidence),
              reviewPolicy: 'address-or-matching-street-v2',
              formatted: item.providerEvidence.formatted,
              resultType: item.providerEvidence.resultType,
              countryCode: item.providerEvidence.countryCode,
              matchType: item.providerEvidence.matchType,
              confidence: item.providerEvidence.confidence,
              confidenceStreetLevel: item.providerEvidence.confidenceStreetLevel,
              confidenceCityLevel: item.providerEvidence.confidenceCityLevel,
              houseNumber: item.providerEvidence.houseNumber,
              street: item.providerEvidence.street,
              city: item.providerEvidence.city,
              localities: item.providerEvidence.localities,
              county: item.providerEvidence.county,
              attribution: item.providerEvidence.attribution,
              dataSource: item.providerEvidence.dataSource,
              license: item.providerEvidence.license,
              sourceUrl: item.providerEvidence.sourceUrl,
              evidenceHash: item.evidenceHash,
              geocodedAt: now
            });
            if (item.expectedProfileRevision === 0) {
              const saved = insertProfile.run(
                item.coordinates.latitude, item.coordinates.longitude, PROVIDER, metadata,
                item.addressFingerprint, now, item.customerId, item.address, item.city, item.county
              );
              outcome = Number(saved.changes) === 1 ? 'applied' : 'address_or_profile_changed';
            } else {
              const saved = updateProfile.run(
                item.coordinates.latitude, item.coordinates.longitude, PROVIDER, metadata, item.addressFingerprint, now, item.customerId,
                item.expectedProfileRevision, item.customerId, item.address, item.city, item.county
              );
              outcome = Number(saved.changes) === 1 ? 'applied' : 'address_or_profile_changed';
            }
          }
        }
      }
      audit.outcomes.push({ customerId: item.customerId, outcome });
      if (outcome === 'applied') audit.applied += 1;
      else if (outcome === 'would_apply') audit.wouldApply += 1;
      else audit.skipped += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
  audit.finishedAt = new Date().toISOString();
  writeJson(auditFile, audit);
  return audit;
}
function helpText() {
  return [
    'Usage:',
    '  node tools/partner-geocode.mjs export --db /absolute/db.sqlite --out /absolute/export.json',
    '  node tools/partner-geocode.mjs batch --input /absolute/export.json --out /absolute/results.json [--execute] [--resume] [--max-addresses 1..3000]',
    '  node tools/partner-geocode.mjs review --input /absolute/export.json --results /absolute/results.json --out /absolute/review.json',
    '  node tools/partner-geocode.mjs import --db /absolute/db.sqlite --input /absolute/review.json --out /absolute/audit.json [--apply]',
    '  node tools/partner-geocode.mjs queue --db /absolute/db.sqlite --reviews /absolute/review.json[,/absolute/retry-review.json] --out /absolute/queue.json --retry-out /absolute/retry-input.json',
    '  Review/import support --accept-approximate for matching address or street (never city centroids).',
    '',
    'Network calls require --execute and GEOAPIFY_API_KEY. Database writes require --apply.'
  ].join('\n');
}
export async function main(argv = process.argv.slice(2), fetchImpl = fetch) {
  const { command, opts } = parseArgs(argv);
  if (opts.help || command === 'help' || !command) {
    console.log(helpText());
    return 0;
  }
  let result;
  if (command === 'export') {
    if (!opts.db || !opts.out) fail('export cere --db și --out.');
    result = exportPartners(opts.db, opts.out);
  } else if (command === 'batch') {
    if (!opts.input || !opts.out) fail('batch cere --input și --out.');
    const cap = opts['max-addresses'] === undefined ? DEFAULT_DAILY_ADDRESS_CAP : Number(opts['max-addresses']);
    result = await batchPartners(opts.input, opts.out, { execute: Boolean(opts.execute), resume: Boolean(opts.resume), maxAddresses: cap, dailyLedger: opts['daily-ledger'], creditLedger: opts['credit-ledger'] }, fetchImpl);
  } else if (command === 'review') {
    if (!opts.input || !opts.results || !opts.out) fail('review cere --input, --results și --out.');
    result = createReview(opts.input, opts.results, opts.out, Boolean(opts['accept-approximate']));
  } else if (command === 'replay') {
    if (!opts.input || !opts.results || !opts['raw-dir'] || !opts.out) fail('replay requires --input --results --raw-dir --out.');
    result = replayResults(opts.input, opts.results, opts['raw-dir'], opts.out);
  } else if (command === 'queue') {
    if (!opts.db || !opts.reviews || !opts.out || !opts['retry-out']) fail('queue requires --db --reviews --out --retry-out.');
    result = createWorkQueue(opts.db, opts.reviews.split(','), opts.out, opts['retry-out'], opts['fresh-out']);
  } else if (command === 'import') {
    if (!opts.db || !opts.input || !opts.out) fail('import cere --db, --input și --out.');
    result = importReview(opts.db, opts.input, opts.out, Boolean(opts.apply), Boolean(opts['accept-approximate']));
  } else {
    fail('Comandă necunoscută.');
  }
  console.log(JSON.stringify(result));
  return 0;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error('ERROR: ' + (error instanceof Error ? error.message : 'Eroare necunoscută.'));
    process.exitCode = 1;
  });
}
