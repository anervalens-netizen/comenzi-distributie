import assert from 'node:assert/strict';
import {canViewActivations} from '../lib/activation-access.ts';

const keys=['MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID','MOBIUP_ACTIVATIONS_PILOT_AGENT_ID','MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS'];
const prev=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
try {
  process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID='manager-original';
  process.env.MOBIUP_ACTIVATIONS_PILOT_AGENT_ID='agent-original';
  process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS=' manager-second ,manager-third, ';
  const allowed=(id,role,active=1)=>canViewActivations({id,role,active});
  assert.equal(allowed('manager-original','manager'),true);
  assert.equal(allowed('manager-second','manager'),true);
  assert.equal(allowed('manager-third','manager'),true);
  assert.equal(allowed('agent-original','agent'),true);
  assert.equal(allowed('manager-second','agent'),false);
  assert.equal(allowed('agent-original','manager'),false);
  assert.equal(allowed('manager-random','manager'),false);
  assert.equal(allowed('agent-random','agent'),false);
  assert.equal(allowed('manager-second','manager',0),false);
  assert.equal(allowed('','manager'),false);
  delete process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS;
  assert.equal(allowed('manager-original','manager'),true);
  assert.equal(allowed('manager-second','manager'),false);
  delete process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID;
  delete process.env.MOBIUP_ACTIVATIONS_PILOT_AGENT_ID;
  assert.equal(allowed('manager-original','manager'),false);
  assert.equal(allowed('agent-original','agent'),false);
  console.log('PASS: activation allowlist and deny-by-default (13 assertions)');
} finally {
  for(const k of keys){if(prev[k]===undefined) delete process.env[k];else process.env[k]=prev[k];}
}
