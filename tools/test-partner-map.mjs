import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const root = 'http://127.0.0.1:3000/api/partner';
const db = new DatabaseSync('work/qa/mobiup.sqlite');
const hash = s => createHash('sha256').update(s).digest('hex');
const sessions = {}, cookies = {}; let checks = 0;
for (const id of ['qa-agent1','qa-agent2','qa-regional','qa-manager']) {
  const token = randomUUID(); sessions[id] = hash(token); cookies[id] = `mobiup_session=${token}`;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token),id,Date.now()+3600000);
}
async function call(path, user='qa-agent1', status=200) {
  const start = performance.now();
  const r = await fetch(root+path,{headers:{Cookie:cookies[user]||''}});
  const raw = await r.text(); const data = JSON.parse(raw);
  assert.equal(r.status,status,`${path}: ${raw.slice(0,300)}`); checks++;
  return {data,raw,ms:performance.now()-start};
}
const insert = db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)');
const profile = db.prepare("INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,address_fingerprint,revision,updated_at) VALUES(?,?,?,'manual',?,1,'2026-09-25T00:00:00Z')");
const coords = [];
try {
  db.exec('BEGIN');
  for(let i=0;i<25000;i++) {
    const id=`map-scale-${String(i).padStart(5,'0')}`, address='Strada Test 1',city='Brașov',county='Brașov';
    insert.run(id,'g-5',JSON.stringify({id,warehouseId:'g-5',warehouseIds:['g-5'],name:`Map scale ${String(i).padStart(5,'0')}`,cui:'SAME-CUI',address,city,county,route:'scale'}));
    const lat=44+(i%100)/100,lon=21+Math.floor(i/100)/100;
    coords.push([lon,lat]);profile.run(id,lat,lon,hash(JSON.stringify([address,city,county])));
  }
  db.prepare("UPDATE partner_profiles SET position_source='geocoding',position_provider='geoapify',position_metadata=? WHERE customer_id='map-scale-00000'").run(JSON.stringify({positionQuality:'street_approximate'}));
  db.exec('COMMIT');
  const coordinatePlan=db.prepare('EXPLAIN QUERY PLAN SELECT c.id FROM customers c LEFT JOIN partner_profiles p ON p.customer_id=c.id WHERE c.active=1 AND p.latitude BETWEEN 44.2 AND 44.4 AND p.longitude BETWEEN 21.5 AND 21.7').all().map(p=>p.detail);
  assert(coordinatePlan.some(s=>s.includes('idx_partner_profiles_coordinates')),'bbox query uses coordinate index');
  await call('/map?q=Map+scale','anonymous',401);
  const whole=await call('/map?q=Map+scale&bbox=20,43,29,49');
  assert.equal(whole.data.features.length,25000,'all 25k distinct work locations, never 100-marker truncation');
  assert.equal(new Set(whole.data.features.map(p=>p.id)).size,25000);
  assert.equal(whole.data.features[0].properties.approximate,true);
  assert.deepEqual(Object.keys(whole.data.features[0].properties).sort(),['approximate','id','name']);
  assert.deepEqual(whole.data.features[0].geometry.coordinates,coords[0],'GeoJSON uses longitude then latitude');
  const page1=await call('/browse?q=Map+scale&city=brasov');
  assert.equal(page1.data.total,25000);assert.equal(page1.data.located,25000);assert.equal(page1.data.partners.length,100);assert.equal(page1.data.nextOffset,100);
  assert(!('contact' in page1.data.partners[0])); assert(!('addressFingerprint' in page1.data.partners[0]));
  const page2=await call('/browse?q=Map+scale&offset=100');
  assert.equal(new Set([...page1.data.partners,...page2.data.partners].map(p=>p.id)).size,200);
  assert.equal((await call('/map?q=Map+scale','qa-agent2')).data.features.length,0);
  assert.equal((await call('/browse?q=Map+scale','qa-agent2')).data.total,0);
  assert.equal((await call('/map?q=Map+scale','qa-regional')).data.features.length,25000);
  const local=await call('/map?q=Map+scale&bbox=21.5,44.2,21.7,44.4');
  const expected=coords.filter(([x,y])=>x>=21.5&&x<=21.7&&y>=44.2&&y<=44.4).length;
  assert.equal(local.data.features.length,expected);
  assert.equal((await call('/map?q=Map+scale&bbox=179,-90,-179,90')).data.features.length,0,'dateline bbox does not include Romania');
  for(const bbox of ['','1,2,3','NaN,2,3,4','-181,0,1,2','0,3,1,2','1,,2,3'])await call('/map?bbox='+encodeURIComponent(bbox),'qa-agent1',400);
  for(const suffix of ['limit=201','limit=0','offset=-1','offset=foo','position=bad','days=foo'])await call('/browse?'+suffix,'qa-agent1',400);
  assert.equal((await call('/map?q=Map+scale&position=no')).data.features.length,0);
  assert.equal((await call('/browse?q='+encodeURIComponent("' OR 1=1 --"))).data.total,0);
  db.prepare("UPDATE customers SET data=json_set(data,'$.address','New address') WHERE id='map-scale-00000'").run();
  const stale=await call('/browse?q=Map+scale');assert.equal(stale.data.located,24999);assert.equal(stale.data.total,25000);
  assert.equal((await call('/map?q=Map+scale')).data.features.length,24999,'changed address invalidates old geocoding');
  db.prepare("UPDATE users SET warehouse_id='g-3' WHERE id='qa-agent1'").run();
  assert.equal((await call('/map?q=Map+scale')).data.features.length,0,'no cross-scope cache after role/warehouse changes');
  db.prepare("UPDATE users SET warehouse_id='g-5' WHERE id='qa-agent1'").run();
  const gzipBytes=gzipSync(whole.raw).length;
  assert(gzipBytes<1024*1024,'25k map response under 1MiB gzipped');
  assert(Buffer.byteLength(page1.raw)<100000,'first browse page below 100kB');
  const metrics={points:25000,mapMs:Math.round(whole.ms),browseMs:Math.round(page1.ms),bboxMs:Math.round(local.ms),bboxPoints:expected,mapBytes:Buffer.byteLength(whole.raw),mapGzipBytes:gzipBytes,browseBytes:Buffer.byteLength(page1.raw),coordinatePlan,checks};
  writeFileSync('work/partner-map-benchmark.json',JSON.stringify(metrics,null,2));
  console.log('PASS: partner map/browse scope, bbox, diacritics, pagination, privacy, invalidation, 25k scale.',JSON.stringify(metrics));
} finally {
  if(db.isTransaction)db.exec('ROLLBACK');
  db.prepare("UPDATE users SET warehouse_id='g-5' WHERE id='qa-agent1'").run();
  db.prepare("DELETE FROM partner_profiles WHERE customer_id LIKE 'map-scale-%'").run();
  db.prepare("DELETE FROM customers WHERE id LIKE 'map-scale-%'").run();
  for(const token of Object.values(sessions))db.prepare('DELETE FROM sessions WHERE token_hash=?').run(token);
  db.close();
}
