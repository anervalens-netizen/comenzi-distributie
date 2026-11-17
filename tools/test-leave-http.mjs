import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
const data = mkdtempSync(join(tmpdir(), 'leave-http-'));
const probe = createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, [resolve('dist/standalone/server.js')], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MOBIUP_DATA_DIR: data,
    NODE_ENV: 'production',
  },
  stdio: 'ignore',
});
let db;
try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(origin + '/api/bootstrap')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, 'isolated server ready');
  assert.equal((await fetch(origin + '/api/leave')).status, 401);
  db = new DatabaseSync(join(data, 'mobiup.sqlite'));
  const tokens = {};
  for (const [id, role, scope] of [
    ['leave-agent', 'agent', 'assigned'],
    ['leave-other', 'agent', 'assigned'],
    ['leave-manager', 'manager', 'assigned'],
    ['leave-manager-two', 'manager', 'assigned'],
    ['leave-foreign', 'manager', 'assigned'],
    ['leave-global', 'manager', 'global'],
  ]) {
    db.prepare(
      'INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active) VALUES(?,?,?,?,?,?,0,1)',
    ).run(id, id, 'Synthetic ' + id, role, scope, 'disabled');
    tokens[id] = randomUUID();
    db.prepare(
      'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
    ).run(
      createHash('sha256').update(tokens[id]).digest('hex'),
      id,
      Date.now() + 3600000,
    );
  }
  db.prepare('INSERT INTO manager_agents VALUES(?,?)').run(
    'leave-manager',
    'leave-agent',
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM employee_profiles WHERE user_id LIKE 'leave-%'",
      )
      .get().n,
    2,
    'new agents get real profile entities via trigger',
  );
  async function request(user, path, method = 'GET', body) {
    const response = await fetch(origin + '/api/' + path, {
      method,
      headers: {
        Cookie: 'mobiup_session=' + tokens[user],
        'X-Operation-User': user,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, result: await response.json() };
  }
  async function call(user, path, method = 'GET', body, expected = 200) {
    const { status, result } = await request(user, path, method, body);
    assert.equal(
      status,
      expected,
      method + ' ' + path + ' ' + JSON.stringify(result),
    );
    return result;
  }
  const agent = 'leave-agent',
    manager = 'leave-manager',
    second = 'leave-manager-two',
    global = 'leave-global',
    other = 'leave-other',
    foreign = 'leave-foreign';
  await call(agent, 'leave/profiles/' + agent, 'PUT', {}, 403);
  const profile = (await call(manager, 'leave/profiles')).profiles.find(
    (p) => p.userId === agent,
  );
  assert.ok(profile && !profile.verified);
  assert.equal((await call(foreign, 'leave/profiles')).profiles.length, 0);
  await call(
    agent,
    'leave',
    'POST',
    { id: randomUUID(), startDate: '2026-11-23', endDate: '2026-11-27' },
    409,
  );
  await call(manager, 'leave/config', 'PUT', { to: 'hr@example.test' }, 403);
  await call(global, 'leave/config', 'PUT', { to: 'hr@example.test' });
  const legacyProfile = { ...profile };
  delete legacyProfile.approvers;
  const profileBody = {
    ...legacyProfile,
    legalName: 'Synthetic Ștefan Țest',
    employer: 'Synthetic Employer SRL',
    email: 'agent@example.test',
    approverId: manager,
    approverEmail: 'manager@example.test',
    holidayCalendar: 'orthodox',
    extraHolidays: [],
    verified: true,
  };
  await call(manager, 'leave/profiles/' + agent, 'PUT', profileBody);
  await call(manager, 'leave/profiles/' + agent, 'PUT', profileBody, 409);
  await call(
    agent,
    'leave',
    'POST',
    { id: randomUUID(), startDate: '2026-11-23x', endDate: '2026-11-27' },
    400,
  );
  assert.equal(
    (await call(agent, 'leave/calendar?start=2026-11-27&end=2026-12-02')).days,
    2,
    'weekends + Nov30 + Dec1 excluded',
  );
  const id = randomUUID(),
    created = (
      await call(
        agent,
        'leave',
        'POST',
        { id, startDate: '2026-11-23', endDate: '2026-11-27' },
        201,
      )
    ).request;
  assert.equal(created.days, 5);
  assert.equal(created.status, 'draft');
  assert.equal(
    (
      await call(agent, 'leave', 'POST', {
        id,
        startDate: '2026-11-23',
        endDate: '2026-11-27',
      })
    ).request.id,
    id,
    'create retry idempotent',
  );
  await call(other, 'leave/' + id, 'GET', undefined, 404);
  await call(foreign, 'leave/' + id, 'GET', undefined, 404);
  const info = await call(agent, 'leave/' + id);
  assert.equal(info.mail.to, 'hr@example.test');
  assert.deepEqual(info.mail.cc, ['manager@example.test']);
  assert.match(info.mail.mailto, /cc=manager%40example.test/);
  assert.match(info.mail.filename, /\.pdf$/);
  const response = await fetch(origin + '/api/leave/' + id + '/pdf', {
    headers: { Cookie: 'mobiup_session=' + tokens[agent] },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /pdf/);
  assert.equal(
    Buffer.from(await response.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    '%PDF',
  );
  await call(
    agent,
    'leave/' + id + '/submit',
    'POST',
    { revision: 1, signature: [] },
    400,
  );
  const signature = [
    [
      { x: 0.1, y: 0.6 },
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.7 },
      { x: 0.4, y: 0.3 },
      { x: 0.7, y: 0.6 },
    ],
  ];
  const submitted = (
    await call(agent, 'leave/' + id + '/submit', 'POST', {
      revision: 1,
      signature,
    })
  ).request;
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.revision, 2);
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM leave_documents WHERE request_id=?')
      .get(id).n,
    1,
  );
  assert.equal(
    db.prepare('SELECT count(*) n FROM notifications WHERE target_id=?').get(id)
      .n,
    1,
  );
  const signedDigest = db
    .prepare('SELECT digest FROM leave_documents WHERE request_id=?')
    .get(id).digest;
  await call(
    agent,
    'leave/' + id + '/submit',
    'POST',
    { revision: 1, signature },
    409,
  );
  await call(
    agent,
    'leave/' + id,
    'PUT',
    { revision: 2, startDate: '2026-11-24', endDate: '2026-11-27' },
    403,
  );
  const overlappingId = randomUUID();
  await call(
    agent,
    'leave',
    'POST',
    { id: overlappingId, startDate: '2026-11-24', endDate: '2026-11-26' },
    201,
  );
  await call(
    agent,
    'leave/' + overlappingId + '/submit',
    'POST',
    { revision: 1, signature },
    409,
  );
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM leave_documents WHERE request_id=?')
      .get(overlappingId).n,
    0,
    'overlap produces no document',
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM leave_events WHERE request_id=? AND action='submitted'",
      )
      .get(overlappingId).n,
    0,
    'overlap produces no submission event',
  );
  await call(
    other,
    'leave/' + id + '/decision',
    'POST',
    { revision: 2, status: 'approved' },
    404,
  );
  await call(
    agent,
    'leave/' + id + '/decision',
    'POST',
    { revision: 2, status: 'approved' },
    403,
  );
  await call(
    manager,
    'leave/' + id + '/decision',
    'POST',
    { revision: 1, status: 'approved' },
    409,
  );
  const approved = (
    await call(manager, 'leave/' + id + '/decision', 'POST', {
      revision: 2,
      status: 'approved',
    })
  ).request;
  assert.equal(approved.status, 'approved');
  assert.equal(
    db.prepare('SELECT digest FROM leave_documents WHERE request_id=?').get(id)
      .digest,
    signedDigest,
    'approval retains original signed PDF',
  );
  const afeed = await call(agent, 'notifications/feed');
  assert.ok(afeed.items.some((x) => x.targetId === id));
  assert.equal(
    (await call(other, 'notifications/feed')).items.filter(
      (x) => x.targetId === id,
    ).length,
    0,
  );
  db.prepare(
    'DELETE FROM manager_agents WHERE manager_id=? AND agent_id=?',
  ).run(manager, agent);
  await call(manager, 'leave/' + id, 'GET', undefined, 404);
  const mfeed = await call(manager, 'notifications/feed');
  assert.equal(
    mfeed.items.filter((x) => x.targetId === id).length,
    0,
    'reassignment removes old manager sensitive access',
  );
  await call(global, 'leave/' + id + '/decision', 'POST', {
    revision: 3,
    status: 'cancelled',
    note: 'Synthetic correction',
  });
  db.prepare('INSERT INTO manager_agents VALUES(?,?)').run(manager, agent);
  await call(agent, 'leave/' + overlappingId + '/submit', 'POST', {
    revision: 1,
    signature,
  });
  const staleId = randomUUID();
  await call(
    agent,
    'leave',
    'POST',
    { id: staleId, startDate: '2026-12-07', endDate: '2026-12-08' },
    201,
  ).catch((e) => {
    throw e;
  });
  db.prepare(
    'UPDATE employee_profiles SET revision=revision+1 WHERE user_id=?',
  ).run(agent);
  await call(
    agent,
    'leave/' + staleId + '/submit',
    'POST',
    { revision: 1, signature },
    409,
  );
  await call(agent, 'leave/' + staleId, 'PUT', {
    revision: 1,
    startDate: '2026-12-07',
    endDate: '2026-12-08',
  });
  await call(agent, 'leave/' + staleId + '/submit', 'POST', {
    revision: 2,
    signature,
  });
  assert.equal((await call(manager, 'leave?month=2026-12')).items.length, 1);
  assert.equal((await call(foreign, 'leave?agentId=' + agent)).items.length, 0);
  const sharedDraft = randomUUID(),
    sharedDates = {
      id: sharedDraft,
      startDate: '2026-12-14',
      endDate: '2026-12-15',
    };
  const simultaneous = await Promise.all([
    request(agent, 'leave', 'POST', sharedDates),
    request(agent, 'leave', 'POST', sharedDates),
  ]);
  assert.deepEqual(
    simultaneous.map((x) => x.status).sort((a, b) => a - b),
    [200, 201],
    JSON.stringify(simultaneous),
  );
  assert.ok(simultaneous.every((x) => x.result.request.id === sharedDraft));
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM leave_events WHERE request_id=? AND action='created'",
      )
      .get(sharedDraft).n,
    1,
  );
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM leave_requests WHERE id=?')
      .get(sharedDraft).n,
    1,
  );

  db.prepare('INSERT INTO manager_agents VALUES(?,?)').run(second, agent);
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(
    'manager-mail:' + second,
    JSON.stringify({
      partner: 'Manager2@example.test',
      accessories: 'manager2@example.test',
    }),
  );
  const changed = await call(manager, 'leave/profiles?agentId=' + agent);
  const changedProfile = changed.profiles.find((p) => p.userId === agent);
  assert.equal(
    changedProfile.verified,
    false,
    'added managers invalidate old profile confirmation',
  );
  assert.deepEqual(changedProfile.approvers, [
    { id: manager, email: 'manager@example.test' },
    { id: second, email: 'Manager2@example.test' },
  ]);
  assert.deepEqual(
    changed.managers.map(({ id, agentIds }) => ({ id, agentIds })),
    [
      { id: manager, agentIds: [agent] },
      { id: second, agentIds: [agent] },
    ],
  );
  await call(
    agent,
    'leave/' + sharedDraft + '/submit',
    'POST',
    { revision: 1, signature },
    409,
  );
  await call(
    agent,
    'leave',
    'POST',
    { id: randomUUID(), startDate: '2026-12-14', endDate: '2026-12-15' },
    409,
  );
  await call(
    manager,
    'leave/profiles/' + agent,
    'PUT',
    {
      ...changedProfile,
      approvers: changedProfile.approvers.slice(0, 1),
      verified: true,
    },
    400,
  );
  await call(
    manager,
    'leave/profiles/' + agent,
    'PUT',
    {
      ...changedProfile,
      approvers: [
        changedProfile.approvers[0],
        { id: foreign, email: 'foreign@example.test' },
      ],
      verified: true,
    },
    400,
  );
  const multiProfile = (
    await call(second, 'leave/profiles/' + agent, 'PUT', {
      ...changedProfile,
      verified: true,
    })
  ).profile;
  assert.equal(multiProfile.verified, true);
  const shared = (
    await call(agent, 'leave/' + sharedDraft, 'PUT', {
      revision: 1,
      startDate: sharedDates.startDate,
      endDate: sharedDates.endDate,
    })
  ).request;
  assert.deepEqual(
    shared.snapshot.approvers.map(({ id }) => id),
    [manager, second],
  );
  const sharedMail = (await call(agent, 'leave/' + sharedDraft)).mail;
  assert.deepEqual(sharedMail.cc, [
    'manager@example.test',
    'Manager2@example.test',
  ]);
  assert.match(
    sharedMail.mailto,
    /cc=manager%40example.test%2CManager2%40example.test/,
  );
  await call(agent, 'leave/' + sharedDraft + '/submit', 'POST', {
    revision: 2,
    signature,
  });
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM notifications WHERE target_id=?')
      .get(sharedDraft).n,
    2,
    'both managers have submission notifications',
  );
  assert.equal(
    (await call(second, 'leave/' + sharedDraft)).request.canDecide,
    true,
  );
  const secondDecision = (
    await call(second, 'leave/' + sharedDraft + '/decision', 'POST', {
      revision: 3,
      status: 'approved',
    })
  ).request;
  assert.equal(
    secondDecision.status,
    'approved',
    'second non-primary manager can approve',
  );
  assert.ok(
    (await call(manager, 'notifications/feed')).items.some(
      (x) => x.targetId === sharedDraft && x.body.includes('Aprobată'),
    ),
    'the other manager sees new decision',
  );
  await call(
    manager,
    'leave/' + sharedDraft + '/decision',
    'POST',
    { revision: 3, status: 'rejected', note: 'Synthetic superseded decision' },
    409,
  );

  const raceId = randomUUID();
  await call(
    agent,
    'leave',
    'POST',
    { id: raceId, startDate: '2026-12-16', endDate: '2026-12-17' },
    201,
  );
  await call(agent, 'leave/' + raceId + '/submit', 'POST', {
    revision: 1,
    signature,
  });
  const choices = await Promise.all([
    request(manager, 'leave/' + raceId + '/decision', 'POST', {
      revision: 2,
      status: 'approved',
    }),
    request(second, 'leave/' + raceId + '/decision', 'POST', {
      revision: 2,
      status: 'rejected',
      note: 'Synthetic decision',
    }),
  ]);
  assert.deepEqual(
    choices.map((x) => x.status).sort((a, b) => a - b),
    [200, 409],
    JSON.stringify(choices),
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM leave_events WHERE request_id=? AND action IN ('approved','rejected')",
      )
      .get(raceId).n,
    1,
  );
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM notifications WHERE target_id=?')
      .get(raceId).n,
    4,
    'no duplicate decision notifications',
  );
  const hrDraft = randomUUID(),
    hrDates = { startDate: '2026-12-21', endDate: '2026-12-22' };
  await call(agent, 'leave', 'POST', { id: hrDraft, ...hrDates }, 201);
  await call(global, 'leave/config', 'PUT', { to: 'new-hr@example.test' });
  await call(
    agent,
    'leave/' + hrDraft + '/submit',
    'POST',
    { revision: 1, signature },
    409,
  );
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM leave_documents WHERE request_id=?')
      .get(hrDraft).n,
    0,
  );
  assert.equal(
    (await call(agent, 'leave/' + sharedDraft)).mail.to,
    'hr@example.test',
    'already submitted requests retain the captured HR address',
  );
  await call(agent, 'leave/' + hrDraft, 'PUT', { revision: 1, ...hrDates });
  assert.equal(
    (await call(agent, 'leave/' + hrDraft)).mail.to,
    'new-hr@example.test',
  );
  const staleScan = await fetch(
    origin + '/api/leave/' + hrDraft + '/scan?revision=1',
    {
      method: 'POST',
      headers: {
        Cookie: 'mobiup_session=' + tokens[agent],
        Origin: origin,
        'Content-Type': 'image/jpeg',
      },
      body: 'not an image',
    },
  );
  assert.equal(
    staleScan.status,
    409,
    'a stale scan fails before attempting to decode the body',
  );
  await call(agent, 'leave/' + hrDraft + '/submit', 'POST', {
    revision: 2,
    signature,
  });
  await call(agent, 'leave/' + hrDraft + '/decision', 'POST', {
    revision: 3,
    status: 'cancelled',
    note: 'Synthetic employee cancellation',
  });
  assert.deepEqual(
    db
      .prepare(
        "SELECT recipient_id FROM notifications WHERE target_id=? AND title='Cerere de concediu actualizată' ORDER BY recipient_id",
      )
      .all(hrDraft)
      .map((x) => x.recipient_id),
    [manager, second],
  );
  db.prepare(
    'DELETE FROM manager_agents WHERE manager_id=? AND agent_id=?',
  ).run(second, agent);
  assert.equal(
    (await call(manager, 'leave/profiles?agentId=' + agent)).profiles[0]
      .verified,
    false,
    'removing a manager requires reconfirmation',
  );
  await call(second, 'leave/' + sharedDraft, 'GET', undefined, 404);
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(agent);
  await call(agent, 'leave', 'GET', undefined, 401);
  console.log(
    'PASS leave HTTP lifecycle, calendar, authorization, immutable PDF, concurrent idempotency, multi-manager decision CAS, HR changes, notification scope and overlap.',
  );
} finally {
  if (db) db.close();
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  rmSync(data, { recursive: true, force: true });
}
