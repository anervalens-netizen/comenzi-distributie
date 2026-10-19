import assert from 'node:assert/strict';
import {canViewUsageReport} from '../lib/usage-access.ts';
const prior=process.env.MOBIUP_USAGE_REPORT_OWNER_ID;
try {
  delete process.env.MOBIUP_USAGE_REPORT_OWNER_ID;
  assert.equal(canViewUsageReport({id:'owner',role:'manager',active:1}),false);
  process.env.MOBIUP_USAGE_REPORT_OWNER_ID='owner';
  assert.equal(canViewUsageReport({id:'owner',role:'manager',active:1}),true);
  assert.equal(canViewUsageReport({id:'other',role:'manager',active:1}),false);
  assert.equal(canViewUsageReport({id:'owner',role:'agent',active:1}),false);
  assert.equal(canViewUsageReport({id:'owner',role:'manager',active:0}),false);
  process.env.MOBIUP_USAGE_REPORT_OWNER_ID='  owner  ';
  assert.equal(canViewUsageReport({id:'owner',role:'manager',active:1}),true);
  console.log('PASS: owner-only usage report access, denied by default');
} finally {
  if(prior===undefined)delete process.env.MOBIUP_USAGE_REPORT_OWNER_ID;
  else process.env.MOBIUP_USAGE_REPORT_OWNER_ID=prior;
}
