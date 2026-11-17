import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'notification-center-'));
const sql = new DatabaseSync(':memory:');
const sessionHash = token => createHash('sha256').update(token).digest('hex');
globalThis.__notificationDb = {
  prepare(query) {
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async all() { return { results: sql.prepare(query).all(...this.args) }; },
      async run() { return { meta: sql.prepare(query).run(...this.args) }; },
    };
  },
  async batch(statements) {
    sql.exec('BEGIN IMMEDIATE');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      sql.exec('COMMIT');
      return result;
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
  },
};
const fixtures = {
  name: 'notification-fixtures',
  setup(bundle) {
    bundle.onResolve({ filter: /^\.\/server$/ }, () => ({ path: 'server', namespace: 'notification-fixture' }));
    bundle.onLoad({ filter: /.*/, namespace: 'notification-fixture' }, () => ({
      loader: 'js',
      contents: `
        import { createHash } from 'node:crypto';
        export const sha256 = value => createHash('sha256').update(value).digest('hex');
        export const sessionToken = req => req.headers.get('Cookie')?.split('=')[1] || '';
        export const db = () => globalThis.__notificationDb;
        export const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
        export const response = data => Response.json(data, {headers: {'Cache-Control': 'no-store'}});
        export const jsonBody = req => req.json();
      `,
    }));
  },
};
const req = (id, path, body) => new Request('https://example.invalid/api/notifications/'+path, {
  method: body ? 'POST' : 'GET',
  headers: { Cookie: 'mobiup_session='+id, 'Content-Type': 'application/json' },
  body: body && JSON.stringify(body),
});
const user = (id, role = 'agent') => ({ id, role, managerScope: id === 'global' ? 'global' : 'assigned', profileVersion: '1' });
const manager = user('manager', 'manager'), global = user('global', 'manager');
const other = user('other', 'manager'), agent = user('agent'), peer = user('peer');
const ids = {
  legacyRead: '10000000-0000-0000-0000-000000000001',
  legacyUnread: '10000000-0000-0000-0000-000000000002',
  legacyOutOfScope: '10000000-0000-0000-0000-000000000003',
  legacyConfirmedByManager: '10000000-0000-0000-0000-000000000004',
};

try {
  sql.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,manager_scope TEXT,profile_revision INTEGER,must_change_password INTEGER);
    CREATE TABLE orders(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
    CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE partner_requests(id TEXT PRIMARY KEY,agent_id TEXT,confirmed_by TEXT,status TEXT,payload TEXT,created_at TEXT);
  `);
  for (const account of [manager, global, other, agent, peer, user('inactive')]) {
    sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,1,0)').run(account.id, 'Synthetic '+account.id, account.role, account.id === 'inactive' ? 0 : 1, account.managerScope);
    sql.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sessionHash(account.id), account.id, Date.now()+600_000);
  }
  sql.exec("INSERT INTO manager_agents VALUES ('manager','agent'), ('other','peer')");
  sql.exec(readFileSync('drizzle/0012_leave_notifications.sql','utf8'));
  sql.exec(readFileSync('drizzle/0013_order_limit_approvals.sql','utf8'));
  sql.exec(`
    INSERT INTO leave_requests(id,agent_id,approver_id,start_date,end_date,days,status,snapshot,created_at,updated_at)
    VALUES('synthetic-leave','agent','manager','2026-12-01','2026-12-02',2,'submitted','{}','2026-11-02','2026-11-02');
  `);
  const partner = sql.prepare('INSERT INTO partner_requests VALUES (?,?,?,?,?,?)');
  const payload = JSON.stringify({company:'Synthetic partner',location:'Synthetic city'});
  partner.run(ids.legacyRead,agent.id,agent.id,'confirmed',payload,'2026-11-01T10:00:00.000Z');
  partner.run(ids.legacyUnread,agent.id,agent.id,'confirmed',payload,'2026-11-01T11:00:00.000Z');
  partner.run(ids.legacyOutOfScope,peer.id,peer.id,'confirmed',payload,'2026-11-01T12:00:00.000Z');
  partner.run(ids.legacyConfirmedByManager,agent.id,manager.id,'confirmed',payload,'2026-11-01T13:00:00.000Z');
  partner.run('10000000-0000-0000-0000-000000000005',agent.id,agent.id,'confirmed','{invalid','2026-11-03T11:00:00.000Z');
  sql.prepare('INSERT INTO settings VALUES (?,?)').run('partner-read:'+manager.id+':'+ids.legacyRead,'2026-11-01T11:15:00.000Z');

  const entry = resolve('.');
  await build({ stdin: { contents: "export * from './lib/notification-center';", resolveDir: entry, loader: 'ts' },
    outfile: join(dir,'notifications.mjs'), bundle: true, format: 'esm', platform: 'node', plugins: [fixtures] });
  const { notificationInsert, notificationCenter } = await import(join(dir,'notifications.mjs'));
  const event = {
    eventKey: 'leave-submitted', category: 'leave', title: 'Cerere de concediu nouă', body: 'Solicitare sintetică',
    targetType: 'leave', targetId: 'synthetic-leave', createdAt: '2026-11-02T08:00:00.000Z',
  };
  const eventPredicate = { sql: 'EXISTS (SELECT 1 FROM leave_events WHERE id=?)', args: ['synthetic-domain-event'] };
  const seedEvent = globalThis.__notificationDb.prepare("INSERT INTO leave_events VALUES ('synthetic-domain-event','synthetic-leave','agent','submitted','','2026-11-02')");
  await globalThis.__notificationDb.batch([
    notificationInsert({ ...event, recipientId: manager.id }, eventPredicate),
    seedEvent,
    notificationInsert({ ...event, recipientId: manager.id }, eventPredicate),
    notificationInsert({ ...event, recipientId: manager.id, body: 'Duplicate' }, eventPredicate),
    notificationInsert({ ...event, recipientId: agent.id }),
    notificationInsert({ ...event, recipientId: global.id }),
    notificationInsert({ ...event, recipientId: other.id }),
    notificationInsert({ ...event, recipientId: peer.id }),
    notificationInsert({ ...event, recipientId: 'inactive' }),
  ]);
  assert.equal(sql.prepare('SELECT COUNT(*) count FROM notifications').get().count,5);
  const get = async (account, query = '') => {
    const response = await notificationCenter(req(account.id,'feed'+query),account,['notifications','feed']);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    return response.json();
  };
  const read = async (account, body) =>
    (await notificationCenter(req(account.id,'read',body),account,['notifications','read'])).json();

  const managerFeed = await get(manager);
  assert.equal(managerFeed.total,3);
  assert.equal(managerFeed.unread,2);
  assert.deepEqual(managerFeed.items.map(row => row.targetId),['synthetic-leave',ids.legacyUnread,ids.legacyRead]);
  assert.equal(managerFeed.items[0].body,event.body,'Retry keeps the original event');
  assert.equal(managerFeed.items[2].readAt,'2026-11-01T11:15:00.000Z','Legacy read state is preserved');
  assert.equal(managerFeed.items[1].title,'Synthetic partner');
  assert.equal(managerFeed.items[1].body,'Synthetic agent · Synthetic city');
  const agentLeave = (await get(agent)).items[0];
  const managerLeave = managerFeed.items[0];
  assert.equal((await get(global)).total,4);
  assert.deepEqual((await get(peer)).items,[],'Agents only receive their own leave records');
  assert.deepEqual((await get(other)).items.map(row=>row.targetId),[ids.legacyOutOfScope]);
  const emptyCategory = await get(manager,'?category=activation');
  assert.equal(emptyCategory.total,0);
  assert.equal(emptyCategory.categoryUnread,0);
  assert.equal(emptyCategory.unread,2,'Category filter preserves the global bell unread count');
  assert.equal((await get(manager,'?category=leave')).categoryUnread,1);
  assert.equal((await get(manager,'?category=partner&unread=1')).categoryUnread,1);
  assert.equal((await get(manager,'?category=order')).total,0);
  const page = await get(manager,'?category=partner&limit=1');
  assert.equal(page.hasMore,true);
  assert.equal(page.total,2);
  assert.equal(page.items[0].targetId,ids.legacyUnread);
  assert.equal((await get(manager,'?category=partner&limit=1&offset=1')).items[0].targetId,ids.legacyRead);
  assert.deepEqual((await get(manager,'?offset=100')).items,[]);

  await read(agent,{ids:[managerLeave.id,'partner:'+ids.legacyUnread]});
  assert.equal((await get(agent)).unread,1);
  assert.equal((await get(manager)).unread,2);
  await read(manager,{ids:[agentLeave.id,'partner:'+ids.legacyOutOfScope]});
  assert.equal((await get(agent)).unread,1);
  assert.equal(sql.prepare('SELECT value FROM settings WHERE key=?').get('partner-read:'+manager.id+':'+ids.legacyOutOfScope),undefined);
  assert.equal((await read(manager,{all:true,category:'partner',unread:true})).total,0);
  assert.ok(sql.prepare('SELECT value FROM settings WHERE key=?').get('partner-read:'+manager.id+':'+ids.legacyUnread));
  assert.equal((await get(manager)).unread,1);

  sql.exec("DELETE FROM manager_agents WHERE manager_id='manager'");
  assert.equal((await get(manager)).total,0);
  assert.equal((await read(manager,{ids:[managerLeave.id]})).total,0);
  assert.equal(sql.prepare('SELECT read_at FROM notifications WHERE id=?').get(managerLeave.id).read_at,null);
  sql.exec("INSERT INTO manager_agents VALUES ('manager','agent')");
  const marked = await read(manager,{ids:[managerLeave.id]});
  assert.equal(marked.unread,0);
  const readAt = marked.items[0].readAt;
  assert.ok(readAt);
  assert.equal((await read(manager,{ids:[managerLeave.id]})).items[0].readAt,readAt,'Repeated read keeps the first timestamp');
  assert.equal((await get(global)).unread,4,'Read state remains private to each manager');
  assert.equal((await read(agent,{all:true})).unread,0);

  const revoke = () => sql.exec("DELETE FROM sessions WHERE user_id='global'");
  const beforeRevocation = sql.prepare("SELECT COUNT(*) count FROM notifications WHERE recipient_id='global' AND read_at IS NULL").get().count;
  revoke();
  await assert.rejects(get(global),error=>error.status===409);
  await assert.rejects(read(global,{all:true}),error=>error.status===409);
  assert.equal(sql.prepare("SELECT COUNT(*) count FROM notifications WHERE recipient_id='global' AND read_at IS NULL").get().count,beforeRevocation);
  assert.equal(sql.prepare("SELECT COUNT(*) count FROM settings WHERE key LIKE 'partner-read:global:%'").get().count,0);

  await assert.rejects(get(agent,'?category=unknown'),error=>error.status===400);
  await assert.rejects(get(agent,'?limit=200'),error=>error.status===400);
  await assert.rejects(read(agent,{ids:['wrong']}),error=>error.status===400);
  await assert.rejects(read(agent,{all:true,ids:[agentLeave.id]}),error=>error.status===400);
  sql.exec(`
    INSERT INTO orders VALUES ('synthetic-order');
    INSERT INTO order_limit_approvals(id,order_id,order_revision,agent_id,agent_revision,warehouse_id,manager_ids,input_key,sales_version,mapping_version,policy_version,catalog_version,violations,status,created_at,updated_at)
    VALUES ('synthetic-order-approval','synthetic-order',1,'agent',1,'synthetic','["manager"]','synthetic','synthetic','synthetic','synthetic','synthetic','[]','pending','2026-11-02','2026-11-02');
    INSERT INTO manager_agents VALUES ('other','agent');
  `);
  const approval = {...event,eventKey:'order-approval',category:'order',targetType:'order-approval',targetId:'synthetic-order-approval'};
  await globalThis.__notificationDb.batch([agent,peer,manager,other].map(recipient =>
    notificationInsert({...approval,recipientId:recipient.id})));
  const managerApproval = (await get(manager,'?category=order')).items[0];
  assert.equal(managerApproval.targetId,approval.targetId,'Frozen and currently assigned manager sees the order approval notification');
  assert.equal((await get(other,'?category=order')).total,0,'A current but non-frozen manager cannot see a request notification');
  assert.equal((await get(agent,'?category=order')).total,1,'Agent sees an order approval notification only for their own order');
  assert.equal((await get(peer,'?category=order')).total,0);
  sql.exec("DELETE FROM manager_agents WHERE manager_id='manager' AND agent_id='agent'");
  assert.equal((await read(manager,{ids:[managerApproval.id],category:'order'})).total,0,'Unassigned managers lose feed and mark-read access');
  assert.equal(sql.prepare('SELECT read_at FROM notifications WHERE id=?').get(managerApproval.id).read_at,null);

  console.log('PASS: notification event deduplication, scoped union, pagination, private read state, and session/scope revocation');
} finally {
  sql.close();
  rmSync(dir,{recursive:true,force:true});
  delete globalThis.__notificationDb;
}
