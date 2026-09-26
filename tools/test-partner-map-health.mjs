import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createMapResourceHealth, mapResourceKey } from '../lib/partner-map-health.ts';

mock.timers.enable({ apis: ['setTimeout'] });
let degraded = false, retries = 0, notifications = 0;
const health = createMapResourceHealth(value => { degraded = value; notifications++; });
try {
  health.fail('basemap:tile-a', () => { retries++; health.recover('basemap:tile-a'); });
  mock.timers.tick(749);
  assert.equal(retries, 0);
  mock.timers.tick(1);
  assert.equal(retries, 1);
  mock.timers.tick(5000);
  assert.equal(degraded, false, 'confirmed transient failure does not leave a warning');

  health.fail('basemap:tile-b', () => { retries++; });
  mock.timers.tick(1000);
  health.fail('basemap:tile-b', () => { retries++; });
  health.recover('basemap:unrelated-tile');
  health.recover('partners:tile-b');
  mock.timers.tick(2999);
  assert.equal(degraded, false, 'grace period precedes degraded-map notice');
  mock.timers.tick(1);
  assert.equal(degraded, true, 'persistent failure is reported even without more errors');
  assert.equal(retries, 2, 'repeated failures get only one automatic retry per episode');

  health.fail('basemap:tile-c');
  mock.timers.tick(4000);
  health.recover('basemap:tile-b');
  assert.equal(degraded, true, 'a different outstanding resource keeps its warning');
  health.recover('basemap:tile-c');
  assert.equal(degraded, false, 'the last matching successful resource clears the notice');

  health.fail('style:metadata', () => { throw new Error('source removed'); });
  mock.timers.tick(4000);
  assert.equal(degraded, true, 'a failed retry still exposes user recovery');
  health.recover('style:metadata');
  health.fail('basemap:tile-d', () => { retries++; });
  const beforeDispose = notifications;
  health.dispose();
  mock.timers.tick(10000);
  health.fail('after-dispose', () => { retries++; });
  mock.timers.tick(10000);
  assert.equal(notifications, beforeDispose, 'unmount cancels all notifications');
  assert.equal(retries, 2, 'unmount cancels pending network retries');

  const tile = { tileID: { key: '7/81/53', canonical: { z: 7, x: 81, y: 53 } } };
  assert.equal(mapResourceKey({ sourceId: 'osm', tile }), 'osm:7/81/53');
  assert.notEqual(mapResourceKey({ sourceId: 'osm', tile }), mapResourceKey({ sourceId: 'partners', tile }));
  assert.equal(mapResourceKey({ sourceId: 'osm' }), 'osm:metadata');
  assert.equal(mapResourceKey({}), 'style:metadata');
  console.log('PASS: 17 map resource health assertions (transient, persistent, matching recovery, bounded retry, teardown).');
} finally {
  health.dispose();
  mock.timers.reset();
}
