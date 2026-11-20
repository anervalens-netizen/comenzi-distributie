import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { parseVodafoneTopLocations } from '../lib/vodafone-top-locations-schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'synthetic-vodafone-targets-'));
try {
  const workbook = join(dir, 'fixture.xlsx'), output = join(dir, 'targets.json');
  function write(rows, format) {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    if (format) sheet.C2.z = format;
    XLSX.utils.book_append_sheet(book, sheet, 'Targets');
    writeFileSync(workbook, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  }
  const run = (month, path, extra = []) => spawnSync(process.execPath, [
    'tools/import-vodafone-top-locations.mjs', '--workbook', workbook, '--sheet', 'Targets',
    '--month', month, '--output', path, ...extra,
  ], { encoding: 'utf8' });
  write([['Cod Franciză', 'Target', 'SIM-uri'], ['x-01', 6, 3], ['X-02', 0, 0]]);
  const first = run('2026-10', output);
  assert.equal(first.status, 0, first.stderr);
  const raw = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(parseVodafoneTopLocations(raw), [
    { month: '2026-10', pointCode: 'X-01', target: 6, bonus: null },
    { month: '2026-10', pointCode: 'X-02', target: 0, bonus: null },
  ]);
  assert.match(raw.sources['2026-10'].sha256, /^[0-9a-f]{64}$/);
  assert.equal(run('2026-10', output).status, 1, 'preserve existing snapshots');
  const next = join(dir, 'next.json');
  const second = run('2026-11', next, ['--previous', output, '--bonus-units-column', 'SIM-uri']);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(readFileSync(next, 'utf8')).rows.map(r => [r.month, r.bonus]), [
    ['2026-10', null], ['2026-10', null], ['2026-11', 3], ['2026-11', 0],
  ]);
  for (const column of ['Bonus (lei)', 'Bonus', 'Valoare bonus SIM', 'Bonus SIM (%)', 'Bonus SIM €']) {
    write([['Cod Franciză','Target',column],['X-01',6,50]]);
    assert.match(run('2026-10',join(dir,'ambiguous.json'),['--bonus-units-column',column]).stderr,/bonus unit/i,column);
  }
  write([['Cod Franciză','Target','Bonus (lei)'],['X-01',6,50]]);
  const onlyTarget=join(dir,'target-only.json');
  assert.equal(run('2026-10',onlyTarget).status,0);
  assert.equal(JSON.parse(readFileSync(onlyTarget)).rows[0].bonus,null);
  write([['Cod Franciză','Target','Nr. SIM 5 EUR'],['X-01',6,3]]);
  assert.equal(run('2026-10',join(dir,'denomination.json'),['--bonus-units-column','Nr. SIM 5 EUR']).status,0);
  write([['Cod Franciză','Target','Bonus (bucăți)'],['X-01',6,50]],'0 "lei"');
  assert.match(run('2026-10',join(dir,'currency.json'),['--bonus-units-column','Bonus (bucăți)']).stderr,/bonus unit/i);
  write([['Cod Franciză', 'Target'], [' X-01 ', 2], ['x-01', 3]]);
  assert.match(run('2026-10', join(dir, 'duplicate.json')).stderr, /Duplicate work point/);
  write([['Cod Franciză', 'Target'], ['X-01', 1.5]]);
  assert.match(run('2026-10', join(dir, 'fraction.json')).stderr, /Invalid Vodafone Top Locations values/);
  console.log('Vodafone Top Locations XLSX normalization and immutable staging: OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
