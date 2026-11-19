import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {read, utils} from 'xlsx';

const {outputFiles} = await build({
  stdin: {resolveDir: process.cwd(), contents: "export * from './lib/vodafone-focus-node.ts'; export * from './lib/vodafone-focus.ts'; export * from './lib/vodafone-focus-export.ts'; export * from './lib/vodafone-focus-overview.ts';"},
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const {vodafoneFocusReport, focusCategory, focusAttribution, vodafoneFocusWorkbook, applyVodafoneFocusOverview} =
  await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const ledger = new DatabaseSync(':memory:');
const rules = {revision: 'synthetic', assignments: [
  {siteCode: 'S', territoryId: 'sud'},
  {siteCode: 'T', territoryId: 'sud'},
  {siteCode: 'N', territoryId: 'nord_a'},
]};
const document = (site, date, quantity = 1) => ({site, date, quantity, tr: true, source: 'erp', reference: 'EXAMPLE', company: 'ExampleCo', clientCode: '12345', pointCode: 'P-1', itemCode: 'ITEM'});
const serial = n => String(n).padStart(18, '0');
const sharedHistory = ['sud','nord_a','nord_b'].map((territory,index) => {
  const attributed = [2,3,0][index];
  return {
    territory,
    sites: [{site: 'H', label: 'Synthetic historical warehouse', attributed, possibleStock: 0}],
    months: [{month: '2026-10', coveredThrough: '2026-10-31', complete: true, attributed, possibleStock: 0}],
  };
});
const overview = applyVodafoneFocusOverview({sites: [], totals: {}, history: []}, sharedHistory);
assert.deepEqual([overview.totals.eligible,overview.sites[0].eligible,overview.history[0].eligible],[5,5,5]);
const later = document('S', '2026-10-25');
const prior = document('S', '2026-10-12');
assert.equal(focusCategory('sud', 'AG', '', 'FREE_SIM', '3,00'), 'zero3');
assert.equal(focusCategory('sud', 'PH', '', 'SIM_ZERO', '4.99'), null);
assert.equal(focusCategory('sud', '<UNASSIGNED>', '', 'SIM_ZERO', 3), 'zero3');
assert.equal(focusCategory('sud', '', '', 'SIM_ZERO', 5), null);
assert.equal(focusCategory('sud', 'OT', 'Other Paid SIMs', 'SIM3', 5), null);
assert.equal(focusCategory('nord_a', 'CV', '', 'SIM_ZERO', 3), 'zero3');
assert.equal(focusCategory('nord_a', 'CV', 'SIM with initial credit >= 3 EUR', 'SIM_5EUR', ''), 'credit');
assert.equal(focusCategory('nord_a', 'CV', 'SIM with initial credit >= 3 EUR', 'SIM3', ''), null);
assert.equal(focusCategory('nord_a', 'CV', 'PACK_SIM', 'PACK_SIM', ''), null);
assert.equal(focusCategory('nord_a', '<UNASSIGNED>', '', 'SIM_ZERO', 5), null);
assert.equal(focusCategory('nord_b', 'CV', '', 'SIM_ZERO', 5), null);
assert.equal(focusAttribution('2026-10-20', [prior, {...prior, quantity: -1}]).attributed, true);
assert.equal(focusAttribution('2026-10-20', [prior, {...prior, site: 'T'}]), null);
assert.equal(focusAttribution('2026-10-20', [prior, {...prior, site: 'T'}, {...prior, site: 'T', date: '2026-10-13', quantity: -1}]).document.site, 'S');
assert.equal(focusAttribution('2026-10-20', [prior, {...prior, site: 'T'}, {...prior, site: 'T', quantity: -1}]), null);
assert.equal(focusAttribution('2026-10-20', [prior, {...prior, site: 'T'}, {...prior, site: 'T', date: '2026-10-11', quantity: -1}]), null);
assert.equal(focusAttribution('2026-10-20', [prior, {...prior, site: 'T'}, {...prior, site: 'T', date: '2026-10-13', clientCode: '67890', quantity: -1}]), null);
assert.equal(focusAttribution('2026-10-20', [later, {...later, site: 'T'}]), null);
assert.equal(focusAttribution('2026-10-20', [later]).attributed, false);

try {
  ledger.exec(`CREATE TABLE activation_imports(id INTEGER PRIMARY KEY,operator TEXT,status TEXT,source_kind TEXT,
    company TEXT,source_at TEXT,period_start TEXT,period_end TEXT);
    CREATE TABLE activation_observations(import_id INTEGER,serial TEXT,activation_date TEXT,county TEXT,handset TEXT,raw_json TEXT);
    CREATE TABLE activation_movements(id INTEGER PRIMARY KEY,movement_key TEXT);
    CREATE TABLE activation_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE activation_effective_movements(movement_id INTEGER PRIMARY KEY,company TEXT,provider TEXT,
      serial TEXT,imei TEXT,site TEXT,is_tr INTEGER,movement_date TEXT,quantity INTEGER,raw_json TEXT);`);
  const addImport = ledger.prepare("INSERT INTO activation_imports VALUES(?,'vodafone','complete','operator',?,?,?,?)");
  addImport.run(1, 'Vodafone', '2026-10-19', '2026-10-01', '2026-10-18');
  addImport.run(2, 'MobiUp', '2026-11-02', '2026-10-01', '2026-10-31');
  addImport.run(3, 'MobiUp', '2026-11-12', '2026-11-01', '2026-11-11');
  addImport.run(4, 'Vodafone', '2026-11-18', '2026-10-01', '2026-10-31');
  const addObservation = ledger.prepare('INSERT INTO activation_observations VALUES(?,?,?,?,?,?)');
  const observe = (file, n, county, handset, type, recharge, date = '2026-10-15', dealer = 'MOBIUP DISTRIBUTION SRL - CONSIGNATIE') =>
    addObservation.run(file, serial(n), date, county, handset, JSON.stringify({
      DEALER_NAME: dealer, SIM_TYPE: type, FIRST_RECHARGE_VALUE: recharge,
    }));
  const credit = 'SIM with initial credit >= 3 EUR';
  observe(1, 1, 'AG', credit, 'SIM5', '');
  observe(1, 99, 'AG', credit, 'SIM5', '');
  observe(2, 1, 'AG', '', 'SIM_ZERO', 3);
  observe(2, 1, 'AG', '', 'SIM_ZERO', 3);
  observe(2, 2, 'PH', '', 'SIM_ZERO', 4);
  observe(2, 3, '<UNASSIGNED>', '', 'SIM_ZERO', 3);
  observe(2, 4, 'DB', 'PACK_SIM', 'TELSIM', '');
  observe(2, 5, 'OT', credit, 'SIM5', 0);
  observe(2, 6, 'TR', credit, 'SIM5', 0);
  observe(2, 7, 'GR', credit, 'SIM5', 0);
  observe(2, 8, 'CV', credit, 'SIM5', 0);
  observe(2, 9, 'UNKNOWN', credit, 'SIM5', 0);
  observe(2, 10, 'AG', credit, 'SIM5', 0);
  observe(2, 10, 'AG', credit, 'SIM5', 0, '2026-10-16');
  observe(3, 11, 'AG', credit, 'SIM5', 0, '2026-11-02');
  observe(4, 12, 'AG', credit, 'SIM5', 0, '2026-10-15', 'Another dealer');
  const sale = ledger.prepare("INSERT INTO activation_effective_movements VALUES(?,'MobiUp','vodafone',?,?,?,?,?,?,?)");
  const movement = ledger.prepare('INSERT INTO activation_movements VALUES(?,?)');
  const addSale = (id, n, site, tr, date, exact = true) => {
    movement.run(id, String(id));
    sale.run(
    id, exact ? serial(n) : '', serial(n) + '7', site, tr, date, 1, JSON.stringify({
      ItemType: 'SIM', Nr: '=EXAMPLE', CIF: '12345', CodPunctDeLucru: 'P-1',
    }),
    );
  };
  addSale(1, 1, 'S', 1, '2026-10-15', false);
  addSale(2, 4, 'H', 1, '2026-10-10');
  addSale(3, 5, 'N', 1, '2026-10-09');
  addSale(4, 6, 'STORE', 0, '2026-10-08');
  addSale(5, 7, 'T', 1, '2026-10-19');
  const options = {territory: 'sud', historicalSites: ['H'], includeSerials: true};
  const query = {rules, projects: ['vodafone_sud'], months: ['2026-09', '2026-10', '2026-11'], policy: 'manager'};
  const result = (sites, {slips = {}, ...override} = {}) => vodafoneFocusReport(
    ledger, new Map([['H', 'Synthetic closed warehouse']]), sites, {...query, focus: {...options, ...override}}, 'generation', slips,
  );
  const manager = result(null, {detail: 'regional', exportAll: true});
  assert.deepEqual(manager.regional, {total: 7, otherTR: 1, otherChannels: 1, unassigned: 3, unassignedCounty: 1, sourceConflicts: 2});
  assert.equal(manager.attributed, 2);
  assert.equal(manager.possibleStock, 1);
  assert.deepEqual(manager.months.map(m => [m.complete, m.coveredThrough]), [[false, null], [true, '2026-10-31'], [false, '2026-11-11']]);
  assert.equal(manager.sites.find(site => site.site === 'H').attributed, 1);
  assert.equal(manager.detail.rows.find(row => row.serial === serial(1)).document.date, '2026-10-15');
  const agent = result(['S'], {detail: 'attributed', includeSerials: false});
  assert.equal(agent.regional, undefined);
  assert.deepEqual(agent.sites.map(row => row.site), ['S']);
  assert.deepEqual(agent.detail.rows.map(row => [row.site, row.serial, row.document.reference]), [['S', undefined, undefined]]);
  assert.equal(result(['S'], {detail: 'regional'}).detail.total, 0);
  const regionalManager = result(['S','T'], {detail: 'regional'});
  assert.equal(regionalManager.regional.total, manager.regional.total);
  assert.equal(regionalManager.attributed, manager.attributed);
  assert.equal(regionalManager.regionalDetails, false);
  assert.equal(regionalManager.detail.total, 0);
  const historyDetail = result(['S','T'], {detail: 'attributed', detailSite: 'H'});
  assert.equal(historyDetail.detail.total, 1);
  assert.equal(historyDetail.detail.rows[0].site, 'H');
  ledger.exec("INSERT INTO activation_meta VALUES('conflict:1','1')");
  const disputed = result(null, {detail: 'regional'});
  assert.equal(disputed.regional.total, manager.regional.total);
  assert.equal(disputed.attributed, manager.attributed - 1);
  assert.equal(disputed.detail.rows.find(row => row.serial === serial(1)).kind, 'unassigned');
  ledger.exec("DELETE FROM activation_meta WHERE key='conflict:1'");
  const setIdentity = ledger.prepare('UPDATE activation_effective_movements SET serial=?,imei=? WHERE movement_id=1');
  for (const [reported, physical] of [[serial(1), serial(99) + '7'], [serial(99), serial(1) + '7']]) {
    setIdentity.run(reported, physical);
    const inconsistent = result(null, {detail: 'regional'});
    assert.equal(inconsistent.regional.total, manager.regional.total);
    assert.equal(inconsistent.detail.rows.find(row => row.serial === serial(1)).kind, 'unassigned');
  }
  setIdentity.run(serial(1), serial(1) + '7');
  const reported = ledger.prepare("UPDATE activation_effective_movements SET raw_json=json_set(raw_json,'$.Activat',?) WHERE movement_id=1");
  reported.run(serial(99));
  assert.equal(result(null).attributed, manager.attributed - 1, 'a reconciled effective serial cannot hide conflicting source evidence');
  reported.run('');
  setIdentity.run('', serial(1) + '7');
  assert.equal(result(['N']), undefined);
  const detailQuery = {detail: 'regional'};
  const unrelated = {[serial(99)]: [{...document('T', '2026-10-14'), source: 'slip'}]};
  assert.equal(result(null, {...detailQuery, slips: unrelated}).revision, manager.revision);
  assert.equal(result(null, detailQuery).revision, manager.revision);
  const related = {[serial(7)]: [{...document('T', '2026-10-14'), source: 'slip'}]};
  assert.notEqual(result(null, {...detailQuery, slips: related}).revision, manager.revision);
  const reclassified = result(null, {slips: related});
  assert.equal(reclassified.regional.total, manager.regional.total);
  assert.equal(reclassified.attributed, manager.attributed + 1);
  assert.equal(reclassified.possibleStock, manager.possibleStock - 1);
  const workbook = read(vodafoneFocusWorkbook(manager), {type: 'base64'});
  assert(utils.sheet_to_json(workbook.Sheets['Focus SUD'], {header: 1})
    .some(([label]) => label?.includes('și în „Fără atribuire sigură”')));
  const exported = utils.sheet_to_json(workbook.Sheets['Detaliu activări']);
  assert.equal(exported.length, 7);
  assert.equal(exported.find(row => row.ICCID === serial(1))['Referință document'], '=EXAMPLE');
  assert.equal(read(vodafoneFocusWorkbook(agent), {type: 'base64'}).Sheets['Detaliu activări'].F1.v, 'CIF');
  console.log('Vodafone Focus source precedence, commercial attribution, history, scope and workbook passed.');
} finally {
  ledger.close();
}
