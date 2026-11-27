// These refusals must occur before a Pool is constructed or a socket is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const target = 'comenzi_finalization_fixture_fictional001';
const validUrl = 'postgresql://fictional:synthetic@localhost/' + target + '?host=%2Ffictional-fixture-socket';
/** @type {Array<[string, Record<string, string>, RegExp]>} */
const cases = [
  ['missing_explicit_database', { COMENZI_PG_TEST_URL: validUrl }, /Explicit disposable finalization database required/],
  ['missing_explicit_url', { COMENZI_PG_TEST_DATABASE: target }, /Explicit fixture URL required/],
  ['wrong_database_namespace', { COMENZI_PG_TEST_DATABASE: 'business', COMENZI_PG_TEST_URL: validUrl }, /Explicit disposable finalization database required/],
  ['database_url_mismatch', { COMENZI_PG_TEST_DATABASE: target, COMENZI_PG_TEST_URL: validUrl.replace(target, target + 'other') }, /AssertionError/],
  ['remote_host_refused', { COMENZI_PG_TEST_DATABASE: target, COMENZI_PG_TEST_URL: validUrl.replace('@localhost/', '@fictional.invalid/') }, /explicitly isolated Unix socket/],
  ['relative_socket_refused', { COMENZI_PG_TEST_DATABASE: target, COMENZI_PG_TEST_URL: validUrl.replace('%2Ffictional-fixture-socket', 'relative-socket') }, /explicitly isolated Unix socket/],
  ['extra_connection_option_refused', { COMENZI_PG_TEST_DATABASE: target, COMENZI_PG_TEST_URL: validUrl + '&options=unreviewed' }, /AssertionError/],
  ['non_postgres_protocol_refused', { COMENZI_PG_TEST_DATABASE: target, COMENZI_PG_TEST_URL: validUrl.replace('postgresql:', 'https:') }, /AssertionError/],
];
for (const [id, variables, message] of cases) {
  const result = spawnSync(process.execPath, [resolve('tools/test-order-finalization-postgres.mjs')], {
    env: { PATH: dirname(process.execPath), TZ: 'UTC', ...variables }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined, id); assert.equal(result.signal, null, id);
  assert.equal(result.status, 1, id); assert.equal(result.stdout, '', id);
  assert.match(result.stderr, message, id);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|ENOTFOUND|connect ENOENT|Connection terminated/, id);
}
console.log(JSON.stringify({ kind: 'finalization-fixture-input-guards', passed: true,
  case_count: cases.length, case_ids: cases.map(([id]) => id), postgresql_executed: false }));
