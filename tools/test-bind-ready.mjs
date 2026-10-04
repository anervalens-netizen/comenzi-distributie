import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { bindConfig, waitForBindAddress } from '../deploy/bind-ready.mjs';

assert.equal(bindConfig({}).host, '127.0.0.1');
for (const HOST of ['', '0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', 'localhost', 'not-an-address']) {
  assert.throws(() => bindConfig({HOST}), /specific IPv4 or IPv6/);
}
for (const value of ['', '0', '-1', 'Infinity', '1.5', '300001']) assert.throws(() => bindConfig({MOBIUP_BIND_TIMEOUT_MS:value}), /integer/);
assert.equal(bindConfig({HOST:'::1'}).host, '::1');
await waitForBindAddress(bindConfig({HOST:'127.0.0.1'}));

// Deterministic delayed-interface simulation at the actual probe boundary.
const hosts = [];
await waitForBindAddress({host:'192.0.2.10',timeoutMs:2000}, async host => {
  hosts.push(host);
  if (hosts.length < 3) throw Object.assign(new Error('not ready'), {code:'EADDRNOTAVAIL'});
});
assert.deepEqual(hosts, Array(3).fill('192.0.2.10'));
for (const code of ['EACCES', 'EADDRINUSE', 'EINVAL']) {
  let attempts = 0;
  await assert.rejects(waitForBindAddress({host:'127.0.0.1',timeoutMs:5000}, async () => {
    attempts++; throw Object.assign(new Error(code), {code});
  }), {code});
  assert.equal(attempts,1,'Non-readiness errors must fail immediately');
}
const start = performance.now();
await assert.rejects(waitForBindAddress({host:'192.0.2.10',timeoutMs:40}, async () => {
  throw Object.assign(new Error('unavailable'), {code:'EADDRNOTAVAIL'});
}), {code:'BIND_ADDRESS_TIMEOUT'});
assert.ok(performance.now()-start < 1000);
// Real kernel failure: the process exits nonzero before importing the framework.
const child = spawnSync(process.execPath,['deploy/server.mjs'],{
  env:{...process.env,HOST:'192.0.2.10',MOBIUP_BIND_TIMEOUT_MS:'50'},encoding:'utf8',timeout:5000,
});
assert.equal(child.status,1,child.stderr);
assert.match(child.stderr,/BIND_ADDRESS_TIMEOUT/);
assert.doesNotMatch(child.stderr,/Cannot find/);
console.log('PASS: exact-interface delayed readiness, bounded timeout/nonzero exit, safe defaults and no wildcard fallback.');
