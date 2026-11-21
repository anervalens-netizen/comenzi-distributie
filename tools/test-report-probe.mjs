import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync,mkdtempSync,openSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {reference,runProbe} from './probe-report-browser.mjs';
import {bonusReferenceError} from './performance/report-browser.mjs';

const base = {origin:'https://example.invalid',role:'manager',release:'a'.repeat(40),shellVersion:'b'.repeat(16),referenceId:'c'.repeat(32)};
const annual = {...base,scenario:'annual',month:'2025-08',expected:{vodafone:1234,digi:0,simZero:400,simCredit:499,coverage:'partial',eligible:0}};
const bonus = {...base,scenario:'bonus',month:'2026-06',expected:{rows:2,pointCode:'EXAMPLE-1',sim0Bonus:0,totalBonus:1234}};

const months = reference(annual).months;
assert.deepEqual(months,['2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07']);
assert.deepEqual(reference({...annual,role:'agent'}).scope.projects,[]);
for (const invalid of [
  {...annual,month:'2026-13'}, {...annual,release:'latest'}, {...annual,samples:0},
  {...annual,role:'agent',scope:{agentId:'EXAMPLE'}}, {...bonus,role:'agent'}, {...bonus,month:'2099-12'},
  {...bonus,expected:{rows:1,sim0Bonus:0}}, {...bonus,expected:{rows:0,sim0Bonus:1}},
  {...annual,expected:{...annual.expected,coverage:'complete',eligible:null}},
]) assert.throws(() => reference(invalid));
const {expected} = reference(bonus);
const values = {sim0Bonus:'0',totalBonus:(1234).toLocaleString('ro-RO')};
assert.equal(bonusReferenceError(expected,2,1,values),undefined);
assert.equal(bonusReferenceError(expected,2,1,{...values,sim0Bonus:'—'}),'bonus_amount_mismatch');
assert.equal(bonusReferenceError(expected,2,1,{...values,totalBonus:'4'}),'bonus_amount_mismatch');
assert.equal(bonusReferenceError(expected,2,0,values),'bonus_reference_row_missing');
assert.equal(bonusReferenceError(expected,3,1,values),'bonus_row_count_mismatch');
assert.equal(bonusReferenceError(expected,0,0,{}),'bonus_unexpected_empty');
assert.equal(bonusReferenceError({rows:0,sim0Bonus:0},0,0,{}),undefined);

// Execute the same serialized browser entry through preflight, with no browser or network.
const reads = [];
const preflight = async (config, role, shell) => runProbe(reference(config), expression => runInNewContext(expression,{
  location:{origin:base.origin},AbortSignal,URL,performance:{getEntriesByType:() => []},
  fetch:async path => {
    reads.push(path);
    return {ok:true,json:async () => ({user:{role,id:'fixture-account',canViewActivations:true}}),text:async () => shell};
  },
  window:{removeEventListener(){}},
}));
assert.equal((await preflight(bonus,'agent','')).runs[0].code,'session_mismatch');
assert.deepEqual(reads,['/api/auth/session']);
assert.equal((await preflight(annual,'manager','unexpected')).runs[0].code,'release_mismatch');
assert.equal((await preflight(annual,'manager',`const CACHE='mobiup-shell-v3-${base.shellVersion}';`)).runs[0].code,'page_build_mismatch');

for (const samples of [1,29,30]) {
  let n = 0;
  const receipt = await runProbe(reference({...annual,samples}),async () => ({outcome:'pass',timingsMs:{digiTotal:++n},apiMs:{}}));
  assert.equal(receipt.uiMs.digiTotal.p95,samples === 30 ? 29 : undefined);
  assert.equal(receipt.runs.length,samples);
}
let attempts = 0;
const failed = await runProbe(reference({...bonus,samples:30}),async () => {
  if (++attempts === 2) throw Error('private-transport-detail');
  return {outcome:'pass',timingsMs:{bonusVerified:10},apiMs:{}};
});
assert.equal(failed.outcome,'error');
assert.equal(failed.runs.length,2);
assert.equal(failed.uiMs.bonusVerified.n,1);
assert.equal(failed.uiMs.bonusVerified.p95,undefined);
const output = JSON.stringify(failed);
for (const excluded of ['private-transport-detail','EXAMPLE-1',base.origin,'pointCode','sim0Bonus']) assert(!output.includes(excluded));

const scratch = mkdtempSync(join(tmpdir(),'report-probe-cli-'));
try {
  for (const input of ['not JSON', JSON.stringify({...bonus,role:'agent'}), JSON.stringify(bonus)]) {
    const path = join(scratch,'reference.json');
    writeFileSync(path,input,{mode:0o600});
    const output = join(scratch,'result.json'), errors = join(scratch,'stderr');
    const files = [openSync(path,'r'),openSync(output,'w'),openSync(errors,'w')];
    try {
      const cli = spawnSync(process.execPath,['tools/probe-report-browser.mjs'],{stdio:files,timeout:5000,env:{REPORT_PAGE_WS:'invalid'}});
      assert.equal(cli.status,1);
      const json = readFileSync(output,'utf8');
      assert.equal(JSON.parse(json).outcome,'error');
      assert.equal(readFileSync(errors,'utf8'),'');
      assert(!json.includes(base.origin));
    } finally { files.forEach(fd => closeSync(fd)); }
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
console.log('PASS: role, release and month pins, independent bonus values, empty states, redaction, percentile eligibility and nonzero CLI failures.');
