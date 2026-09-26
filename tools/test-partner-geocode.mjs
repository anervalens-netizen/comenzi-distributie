import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { creditCapacity, replayResults, providerLocalityMatches, dailyCapacity, structuredAddress, createWorkQueue, classifyPosition, providerStreetMatchesAddress, addressHouseNumber, batchPartners, createReview, exportPartners, importReview } from './partner-geocode.mjs';


for (const [input,expected] of [
 ['Str. Eudoxiu Hurmuzachi 8 Sc:B Et:1 Ap:27','8'],
 ['Strada Alfa 12, bl. A, ap. 77','12'],
 ['Strada 1 Decembrie 1918',''],
 ['Bulevardul 1848 nr. 45','45'],
 ['Strada 6 Martie nr. 6','6'],
 ['Strada Alfa bl. 12 ap. 9',''],
]) assert.equal(addressHouseNumber(input),expected,input);
assert.equal(addressHouseNumber('Strada Alfa 12 - Radauti','Radauti'),'12');
for (const [address,street,expected] of [
 ['Strada Alfa 12, ap. 7','Strada Alfa',true],
 ['Strada Alfa 12','Strada Alfa Noua',false],
 ['Strada Republicii 13','Bulevardul Republicii',false],
 ['Strada Belvedere 6','Bulevardul Belvedere',false],
 ['Strada Primariei 17','DJ209A',false],
 ['Strada 6 Martie nr. 6','Strada 6 Martie',true],
 ['Bdul 1848 nr. 45','Bulevardul 1848',true],
 ['Strada Bucuresti nr. 12','Strada Bucuresti',true],
]) assert.equal(providerStreetMatchesAddress({address,city:'Bucuresti'}, {street}),expected,address);

assert.equal(addressHouseNumber('Nicolae Bălcescu 82'), '82');
assert.equal(addressHouseNumber('Str.Principala.Nr.832'), '832');
assert.equal(addressHouseNumber('Strada 13 Septembrie nr. 10, bl. A, ap. 3'), '10');
assert.equal(addressHouseNumber('Strada Exemplu 1-3'), '1-3');
assert.equal(addressHouseNumber('Strada 13 Septembrie'), '');

const root = mkdtempSync(join(tmpdir(), 'partner-geocode-test-'));
const dbPath = join(root, 'fixture.sqlite');
const exportPath = join(root, 'export.json');
const resultsPath = join(root, 'results.json');
const reviewPath = join(root, 'review.json');
const dryAuditPath = join(root, 'dry-audit.json');
const auditPath = join(root, 'audit.json');

function seed() {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE customers(id TEXT PRIMARY KEY, warehouse_id TEXT NOT NULL, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);' +
    'CREATE TABLE partner_requests(id TEXT PRIMARY KEY, customer_id TEXT, status TEXT NOT NULL, payload TEXT NOT NULL, confirmed_at TEXT, updated_at TEXT);' +
    'CREATE TABLE partner_profiles(' +
    'customer_id TEXT PRIMARY KEY REFERENCES customers(id),' +
    'contact TEXT NOT NULL DEFAULT "", phone TEXT NOT NULL DEFAULT "", email TEXT NOT NULL DEFAULT "",' +
    'latitude REAL, longitude REAL, position_source TEXT, position_accuracy REAL,' +
    'position_provider TEXT, position_metadata TEXT,' +
    'address_fingerprint TEXT NOT NULL DEFAULT "", revision INTEGER NOT NULL DEFAULT 1,' +
    'updated_at TEXT NOT NULL, updated_by TEXT);');
  const add = db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)');
  const address = (line) => JSON.stringify({ name: line, cui: 'same-cui', city: 'București', county: 'București', address: line + ', nr. 12', route: 'R1', warehouseIds: ['W1', 'W2'] });
  add.run('store-a', 'W1', address('Strada Alfa'));
  add.run('store-b', 'W1', address('Strada Beta'));
  add.run('store-revision', 'W2', address('Strada Gamma'));
  add.run('store-profile', 'W2', address('Strada Delta'));
  add.run('store-manual', 'W1', address('Strada Manual'));
  add.run('store-gps', 'W2', address('Strada GPS'));
  db.prepare("INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,position_provider,position_metadata,address_fingerprint,revision,updated_at) VALUES(?,45.1,25.2,'manual',NULL,NULL,'manual-fp',3,'2026-09-24T00:00:00Z')").run('store-manual');
  db.prepare("INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,position_provider,position_metadata,address_fingerprint,revision,updated_at) VALUES(?,45.2,25.3,'gps',NULL,NULL,'gps-fp',4,'2026-09-24T00:00:00Z')").run('store-gps');
  db.prepare("INSERT INTO partner_profiles(customer_id,position_source,address_fingerprint,revision,updated_at) VALUES(?,NULL,'',7,'2026-09-24T00:00:00Z')").run('store-revision');
  db.prepare("INSERT INTO partner_profiles(customer_id,contact,phone,email,position_source,address_fingerprint,revision,updated_at,updated_by) VALUES(?,?,?, ?,NULL,'',5,'2026-09-24T00:00:00Z','contact-editor')").run('store-profile','Existing contact','0722222222','profile@example.invalid');
  db.prepare("INSERT INTO partner_requests(id,customer_id,status,payload,confirmed_at,updated_at) VALUES(?,?,'confirmed',?,?,?)").run('request-a','store-a',JSON.stringify({contact:'Contact din cerere',phone:'0712345678',email:'a@example.invalid'}),'2026-09-20T00:00:00Z','2026-09-20T00:00:00Z');
  db.close();
}
function read(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function write(file, value) { writeFileSync(file, JSON.stringify(value, null, 2)); }
function createMockFetch(immediate = false) {
  let job = 0;
  let submitted = [];
  let posts = 0;
  const snapshots=[];
  const makeResults = () => submitted.map(item => ({
    id: item.id,
    result: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          lat: 44.4322, lon: 26.1034, country_code: 'ro', result_type: 'building',
          housenumber: '12', street: item.params.text.split(',')[0], city: 'București', county: 'București',
          formatted: 'Strada Alfa 12, București, Romania',
          rank: { match_type: 'full_match', confidence: 1, confidence_street_level: 1, confidence_city_level: 1 },
          datasource: { attribution: '© OpenStreetMap contributors', sourcename: 'openstreetmap', license: 'Open Database License', url: 'https://www.openstreetmap.org/copyright' }
        },
        geometry: { type: 'Point', coordinates: [26.1034, 44.4322] }
      }]
    }
  }));
  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.geoapify.com');
    assert.equal(parsed.searchParams.get('apiKey'), 'mock-key-never-log');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.api, '/v1/geocode/search');
      assert.equal(body.priority,0.5);
      assert.ok(body.inputs.every(item => item.params.filter === 'countrycode:ro'));
      assert.ok(!options.body.includes('store-a'), 'customer IDs must never be sent to the provider');
      submitted = body.inputs;
      posts += 1;
      if (immediate) return new Response(JSON.stringify({ results: makeResults() }), { status: 200 });
      job += 1;
      return new Response(JSON.stringify({ id: 'mock-job-' + job, status: 'pending' }), { status: 202 });
    }
    const body={id:parsed.searchParams.get('id'),results:makeResults().map((item,i)=>({...item,params:submitted[i].params}))};
    snapshots.push(structuredClone(body));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  fetchMock.getPosts = () => posts;
  fetchMock.getSnapshots = () => snapshots;
  return fetchMock;
}

try {
  seed();
  const exportedSummary = exportPartners(dbPath, exportPath);
  assert.equal(exportedSummary.customerCount, 6);
  assert.equal(exportedSummary.eligibleCount, 4, 'unpositioned distinct customer IDs should be exported; manual/GPS remain protected');
  const exported = read(exportPath);
  const byId = new Map(exported.records.map(record => [record.customerId, record]));
  assert.equal(byId.get('store-a').eligible, true);
  assert.equal(byId.get('store-b').eligible, true, 'same CUI must not collapse distinct store IDs');
  assert.equal(byId.get('store-profile').profileRevision, 5);
  assert.deepEqual(byId.get('store-a').warehouseIds, ['W1', 'W2']);
  assert.equal(byId.get('store-manual').reason, 'protected_manual_or_gps');
  assert.equal(byId.get('store-gps').reason, 'protected_manual_or_gps');

  let externalCalls = 0;
  const dryBatch = await batchPartners(exportPath, resultsPath, {}, async () => { externalCalls += 1; throw new Error('network must not be called'); });
  assert.equal(dryBatch.dryRun, true);
  assert.equal(dryBatch.apiCalls, 0);
  assert.equal(externalCalls, 0, 'dry-run must never call the provider');

  const previousKey = process.env.GEOAPIFY_API_KEY;
  process.env.GEOAPIFY_API_KEY = 'mock-key-never-log';
  const mockFetch = createMockFetch();
  try {
    const firstRun = await batchPartners(exportPath, resultsPath, { execute: true, resume: true, maxAddresses: 2, timeoutMs: 10000 }, mockFetch);
    assert.equal(firstRun.pending, 2, 'a lower operator cap must leave work for a later resume');
    assert.equal(firstRun.results, 2);
    const secondRun = await batchPartners(exportPath, resultsPath, { execute: true, resume: true, maxAddresses: 2, timeoutMs: 10000 }, mockFetch);
    assert.equal(secondRun.pending, 0);
    assert.equal(secondRun.results, 4);
    assert.equal(mockFetch.getPosts(), 2, 'resume should submit only outstanding addresses');
    assert.ok(!readFileSync(resultsPath, 'utf8').includes('mock-key-never-log'), 'provider key must not be stored in output');
    const immediatePath = join(root, 'immediate-results.json');
    const immediateMock = createMockFetch(true);
    const immediate = await batchPartners(exportPath, immediatePath, { execute: true, maxAddresses: 1, timeoutMs: 10000 }, immediateMock);
    assert.equal(immediate.results, 1, 'HTTP 200 immediate batch results should be accepted');
    assert.equal(read(immediatePath).jobs[0].status, 'complete');
  } finally {
    if (previousKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = previousKey;
  }
  assert.equal(providerLocalityMatches({city:'Ulieș'}, {city:'Râciu',localities:{village:'Ulies'}}),true);
  assert.equal(providerLocalityMatches({city:'Voiniceni'}, {city:'Sântana de Mureș',localities:{district:'Bărdesti'}}),false);
  assert.equal(providerLocalityMatches({city:'Ulies'}, {city:'Râciu',localities:{municipality:'Ulies'},query:{parsed:{city:'Ulies'}}}),false,'broad region or echoed query cannot prove locality');
  for(const [address,city,street,number] of [
    ['Târgu Mureș, Strada Parângului nr17','Targu Mures','Strada Parangului','17'],
    ['Principala Glodeni','Glodeni','Strada Principala',''],
    ['Strada Bucuresti 12','Bucuresti','Strada Bucuresti','12'],
    ['Strada Brazilor NMR13','Baile Tusnad','Strada Brazilor','13'],
    ['Strada Narciselor 6/b','Miercurea Ciuc','Strada Narciselor','6b'],
    ['Strada Test nr75 B','Bucuresti','Strada Test','75b'],
    ['Strada Test nr52 parter','Bucuresti','Strada Test','52'],
    ['Strada Nicolae Balcescu Nr.','Targu Secuiesc','Strada Nicolae Balcescu','']
  ]) {
    assert.equal(addressHouseNumber(address,city),number,address);
    assert.equal(providerStreetMatchesAddress({address,city},{street}),true,address);
  }
  const snapshots=mockFetch.getSnapshots();
  snapshots[0].results[0].result.features[0].properties.village='Sat Probe';
  snapshots.forEach((raw,i)=>write(join(root,`raw-job-${i}.json`),raw));
  const replayPath=join(root,'replayed.json');
  assert.equal(replayResults(exportPath,resultsPath,root,replayPath).results,4);
  assert.equal(read(replayPath).results['store-a'].evidence.localities.village,'Sat Probe');
  const originalRaw=structuredClone(snapshots[0]);
  snapshots[0].results[0].params.text='Unrelated address';write(join(root,'raw-job-0.json'),snapshots[0]);
  assert.throws(()=>replayResults(exportPath,resultsPath,root,join(root,'bad-replay.json')),/Raw query/);
  originalRaw.id='another-job';write(join(root,'raw-job-0.json'),originalRaw);
  assert.throws(()=>replayResults(exportPath,resultsPath,root,join(root,'bad-replay.json')),/identity/);
  const reviewSummary = createReview(exportPath, resultsPath, reviewPath);
  assert.equal(reviewSummary.items, 4);
  const review = read(reviewPath);
  assert.ok(review.items.every(item => item.approved === false), 'review must never auto-approve provider results');
  const a = review.items.find(item => item.customerId === 'store-a');
  const b = review.items.find(item => item.customerId === 'store-b');
  const stale = review.items.find(item => item.customerId === 'store-revision');
  const existingProfile = review.items.find(item => item.customerId === 'store-profile');
  assert.equal(a.suggestedDecision, 'approve_recommended');
  a.approved = true;
  b.approved = true;
  stale.approved = true;
  existingProfile.approved = true;
  write(reviewPath, review);

  const candidate = structuredClone(a);
  const rehash = item => { item.evidenceHash = createHash('sha256').update(JSON.stringify({ customerId:item.customerId,addressFingerprint:item.addressFingerprint,query:item.query,evidence:item.providerEvidence })).digest('hex'); };
  candidate.providerEvidence.confidence = 0.45;
  rehash(candidate);
  assert.equal(classifyPosition(candidate, candidate.providerEvidence), 'address_approximate');
  write(reviewPath, {...review, items:[candidate]});
  assert.throws(()=>importReview(dbPath,reviewPath,auditPath,false), /Import respins/);
  assert.equal(importReview(dbPath,reviewPath,auditPath,false,true).wouldApply,1);
  assert.equal(classifyPosition({...candidate,address:'Strada Alfa nr. 12 D'},candidate.providerEvidence),'street_approximate','different house numbers fall back to the matching street pin');
  candidate.providerEvidence.resultType = 'street';
  candidate.providerEvidence.houseNumber = '';
  rehash(candidate);
  assert.equal(classifyPosition(candidate, candidate.providerEvidence), 'street_approximate');
  assert.equal(classifyPosition(candidate,{...candidate.providerEvidence,confidenceStreetLevel:0.2}),'street_approximate','identical street/locality/county support an approximate street pin despite lower provider score');
  for (const [key,value] of [['city','Ploiesti'],['county','Prahova'],['street','Strada Beta'],['countryCode','bg'],['resultType','city']]) {
    assert.equal(classifyPosition(candidate,{...candidate.providerEvidence,[key]:value}),null,`approximate rejects ${key} contradiction`);
  }
  assert.equal(classifyPosition(candidate,{...candidate.providerEvidence,houseNumber:'99'}),'street_approximate','a street/locality/county match remains usable when the returned number differs');
  const amenityStreet = {address:'zsogodi Nagy Imre',city:'Miercurea-Ciuc',county:'Harghita'};
  const amenityEvidence = {countryCode:'ro',resultType:'amenity',latitude:46.340212,longitude:25.8069291,street:'Strada Zsögödi Nagy Imre',city:'Miercurea Ciuc',county:'Harghita',houseNumber:'',matchType:'inner_part',confidence:1};
  assert.equal(classifyPosition(amenityStreet,amenityEvidence),'street_approximate','matching street, locality and county allow an approximate pin at a street POI');
  assert.equal(classifyPosition(amenityStreet,{...amenityEvidence,city:'Toplița'}),null,'approximate pin rejects another locality');
  assert.equal(classifyPosition(amenityStreet,{...amenityEvidence,county:'Neamț'}),null,'approximate pin rejects another county');
  assert.equal(classifyPosition(amenityStreet,{...amenityEvidence,street:'Strada Kossuth Lajos'}),null,'approximate pin rejects another street');
  const approxDb=join(root,'approx.sqlite');copyFileSync(dbPath,approxDb);
  write(reviewPath,{...review,items:[candidate]});
  assert.equal(importReview(approxDb,reviewPath,auditPath,true,true).applied,1);
  const approxRead=new DatabaseSync(approxDb,{readOnly:true});
  assert.equal(JSON.parse(approxRead.prepare("SELECT position_metadata FROM partner_profiles WHERE customer_id='store-a'").get().position_metadata).positionQuality,'street_approximate');
  approxRead.close();
  assert.equal(addressHouseNumber('Strada Alfa 12 blD scB et3 ap14'), '12');
  assert.deepEqual(structuredAddress({address:'Strada Alfa 12 blD scB et3 ap14',city:'Bucuresti',county:'Bucuresti'}),{housenumber:'12',street:'strada alfa',city:'Bucuresti',state:'Bucuresti',country:'Romania',lang:'ro'});
  assert.equal(structuredAddress({address:'Sat Bodoc nr291',city:'Bodoc',county:'Covasna'}).street,undefined);
  assert.equal(structuredAddress({address:'nr291',city:'Bodoc',county:'Covasna'}).housenumber,'291');
  const credits=join(root,'credits.sqlite'),creditNow=Date.now();
  assert.equal(creditCapacity(credits,1500,'3000 inputs',creditNow),1500);
  assert.equal(creditCapacity(credits,1,'submit',creditNow),1499);
  assert.equal(creditCapacity(credits,1,'poll',creditNow),1498);
  assert.equal(creditCapacity(credits,971.5,'1943 retries',creditNow),526.5);
  assert.throws(()=>creditCapacity(credits,527,'over limit',creditNow),/3000 credite/);
  assert.equal(creditCapacity(credits,0,'check',creditNow+86400001),3000);
  const ledger=join(root,'quota.sqlite'), now=Date.now();
  assert.equal(dailyCapacity(ledger,2000,now),1000);
  assert.equal(dailyCapacity(ledger,1000,now),0);
  assert.throws(()=>dailyCapacity(ledger,1,now),/Cota/);
  assert.equal(dailyCapacity(ledger,0,now+86400001),3000);
  write(reviewPath,review);
  const wrongStreet=structuredClone(review);
  const ws=wrongStreet.items.find(item=>item.customerId==='store-b');
  ws.providerEvidence.street='Strada Alfa';
  ws.evidenceHash=createHash('sha256').update(JSON.stringify({customerId:ws.customerId,addressFingerprint:ws.addressFingerprint,query:ws.query,evidence:ws.providerEvidence})).digest('hex');
  write(reviewPath,wrongStreet);
  assert.throws(()=>importReview(dbPath,reviewPath,auditPath,true),/Import respins/,'another street with same number must not import');
  write(reviewPath,review);
  const wrongHouse = structuredClone(review);
  const wrong = wrongHouse.items.find(item => item.customerId === 'store-a');
  wrong.providerEvidence.houseNumber = '99';
  wrong.evidenceHash = createHash('sha256').update(JSON.stringify({ customerId: wrong.customerId, addressFingerprint: wrong.addressFingerprint, query: wrong.query, evidence: wrong.providerEvidence })).digest('hex');
  write(reviewPath, wrongHouse);
  assert.throws(() => importReview(dbPath, reviewPath, auditPath, true), /Import respins/, 'a genuine provider result at another house number must never import');
  write(reviewPath, review);

  let db = new DatabaseSync(dbPath);
  const data = JSON.parse(db.prepare('SELECT data FROM customers WHERE id=?').get('store-b').data);
  data.address = 'Changed while geocoding';
  db.prepare('UPDATE customers SET data=? WHERE id=?').run(JSON.stringify(data), 'store-b');
  db.prepare('UPDATE partner_profiles SET revision=revision+1 WHERE customer_id=?').run('store-revision');
  db.close();

  const dry = importReview(dbPath, reviewPath, dryAuditPath, false);
  assert.equal(dry.applied, 0);
  assert.equal(dry.wouldApply, 2, 'dry-run should perform the same current-address/revision checks as apply');
  assert.equal(dry.skipped, 2);
  assert.equal(dry.outcomes.find(item => item.customerId === 'store-b').outcome, 'address_changed');
  assert.equal(dry.outcomes.find(item => item.customerId === 'store-revision').outcome, 'profile_revision_changed');
  assert.equal(dry.dryRun, true);
  db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_profiles WHERE position_source='geocoding'").get().n, 0, 'dry-run import must not write');
  db.close();

  const applied = importReview(dbPath, reviewPath, auditPath, true);
  assert.equal(applied.applied, 2, 'unchanged new and existing empty profiles should import');
  assert.equal(applied.skipped, 2);
  assert.equal(applied.outcomes.find(item => item.customerId === 'store-b').outcome, 'address_changed');
  assert.equal(applied.outcomes.find(item => item.customerId === 'store-revision').outcome, 'profile_revision_changed');

  db = new DatabaseSync(dbPath, { readOnly: true });
  const imported = db.prepare('SELECT latitude,longitude,position_source,position_provider,position_metadata,address_fingerprint,revision FROM partner_profiles WHERE customer_id=?').get('store-a');
  assert.equal(imported.position_source, 'geocoding');
  assert.equal(imported.position_provider, 'geoapify');
  const importedContacts = db.prepare('SELECT contact,phone,email FROM partner_profiles WHERE customer_id=?').get('store-a');
  assert.deepEqual({ ...importedContacts }, { contact: 'Contact din cerere', phone: '0712345678', email: 'a@example.invalid' }, 'new profiles should retain confirmed-request contact fields');
  assert.ok(imported.position_metadata.includes('full_match'));
  assert.equal(imported.revision, 1);
  assert.equal(db.prepare('SELECT position_source FROM partner_profiles WHERE customer_id=?').get('store-manual').position_source, 'manual');
  assert.equal(db.prepare('SELECT position_source FROM partner_profiles WHERE customer_id=?').get('store-gps').position_source, 'gps');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_profiles WHERE position_source='geocoding'").get().n, 2);
  const updated = db.prepare('SELECT latitude,longitude,position_source,position_provider,revision,updated_by,contact,phone,email FROM partner_profiles WHERE customer_id=?').get('store-profile');
  assert.equal(updated.latitude, 44.4322);
  assert.equal(updated.longitude, 26.1034);
  assert.equal(updated.position_source, 'geocoding');
  assert.equal(updated.position_provider, 'geoapify');
  assert.equal(updated.revision, 6);
  assert.equal(updated.updated_by, null);
  assert.equal(updated.contact, 'Existing contact');
  assert.equal(updated.phone, '0722222222');
  assert.equal(updated.email, 'profile@example.invalid');
  db.close();

  const tampered = read(reviewPath);
  tampered.items.find(item => item.customerId === 'store-a').coordinates.latitude += 0.2;
  write(reviewPath, tampered);
  assert.throws(() => importReview(dbPath, reviewPath, auditPath, true), /Import respins/);

  const queueReview=structuredClone(review);
  for(const item of queueReview.items){item.providerEvidence.street='Wrong street';rehash(item);}
  write(reviewPath,queueReview);
  const queueFile=join(root,'queue.json'),retryFile=join(root,'retry.json');
  const freshFile=join(root,'fresh.json');
  const queue=createWorkQueue(dbPath,[reviewPath],queueFile,retryFile,freshFile);
  assert.equal(read(queueFile).items.length,6,'every active location accounted for, including protected GPS');
  assert.equal(queue.retryCount,1,'retry only current unresolved attempted addresses');
  const retry=read(retryFile).records[0];
  assert.equal(retry.geocodeParams.housenumber,undefined,'street fallback ignores unavailable house number');
  assert.equal(retry.geocodeParams.type,'street');
  assert.equal(retry.customerId,'store-revision');
  assert.equal(retry.profileRevision,8,'retry refreshes revision from current DB');
  assert.equal(read(freshFile).records.length,1,'new input accounts for changed-address store separately');
  const retryResults=join(root,'retry-results.json'), retryReview=join(root,'retry-review.json');
  const oldKey=process.env.GEOAPIFY_API_KEY;process.env.GEOAPIFY_API_KEY='test-only';
  let calls=0;
  try {
    await batchPartners(retryFile,retryResults,{execute:true,maxAddresses:1},async(url,options)=>{
      calls++; const request=JSON.parse(options.body);
      assert.equal(request.inputs[0].params.text,undefined);
      assert.equal(request.inputs[0].params.housenumber,undefined);
      assert.equal(request.inputs[0].params.type,'street');
      assert.equal(request.inputs[0].params.street,'strada gamma');
      assert.equal(request.inputs[0].params.city,'București');
      return new Response(JSON.stringify([{id:'r0',result:{features:[]}}]),{status:200});
    });
  } finally {if(oldKey===undefined)delete process.env.GEOAPIFY_API_KEY;else process.env.GEOAPIFY_API_KEY=oldKey;}
  assert.equal(calls,1);
  createReview(retryFile,retryResults,retryReview,true);
  const secondQueue=createWorkQueue(dbPath,[reviewPath,retryReview],join(root,'queue-2.json'),join(root,'retry-2.json'));
  assert.equal(secondQueue.counts.retry_structured,1,'after street query fails, try separated full address once');
  assert.equal(read(join(root,'retry-2.json')).records[0].geocodeParams.housenumber,'12');
  const completedAttempts=read(retryReview);
  completedAttempts.unmatched.push({...completedAttempts.unmatched[0],query:JSON.stringify(structuredAddress(retry))});
  write(retryReview,completedAttempts);
  const thirdQueue=createWorkQueue(dbPath,[reviewPath,retryReview],join(root,'queue-3.json'),join(root,'retry-3.json'));
  assert.equal(thirdQueue.counts.targeted_review,1,'both unsuccessful query strategies require individual map research');
  assert.equal(thirdQueue.retryCount,0,'do not retry identical queries forever');
  console.log('PASS: partner geocoding export, distinct customer/CUI handling, shared warehouse IDs, API dry-run, review defaults, dry-run import, address+revision CAS, manual/GPS preservation, evidence tamper check.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
