// Real order routes and both SQLite adapters with isolated synthetic data.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

mkdirSync('work', { recursive: true });
const scratch = mkdtempSync(resolve('work/order-limit-approvals-'));
const previous = Object.fromEntries(
  [
    'MOBIUP_DATA_DIR',
    'MOBIUP_USAGE_DISABLED',
    'MOBIUP_ORDER_LIMIT_MANAGER_ID',
    'MOBIUP_ORDER_LIMIT_ADDITIONAL_MANAGER_IDS',
  ].map((key) => [key, process.env[key]]),
);
const data = join(scratch, 'data');
process.env.MOBIUP_DATA_DIR = data;
process.env.MOBIUP_USAGE_DISABLED = '1';
let sql, sales;
try {
  const bundle = join(scratch, 'route.mjs');
  await build({
    stdin: {
      contents:
        "export * from './app/api/[...path]/route'; export {env} from './lib/runtime'; export {readCatalog} from './lib/catalog'; export {orderLimitPeriod,orderLimitWindow} from './lib/order-limits'; export {orderLimitSalesVersion} from './lib/sales-store';",
      loader: 'ts',
      resolveDir: resolve('.'),
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    plugins: [
      {
        name: 'actual-node-runtime',
        setup(build) {
          build.onResolve({ filter: /^#mobiup-/ }, (args) => ({
            path: resolve(
              'lib/' + args.path.slice('#mobiup-'.length) + '-node.ts',
            ),
          }));
          build.onResolve({ filter: /\.sql\?raw$/ }, (args) => ({
            path: resolve(args.path.replace(/^@\//, '').replace(/\?raw$/, '')),
            namespace: 'raw',
          }));
          build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
            contents: readFileSync(args.path, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
  });
  const route = await import(pathToFileURL(bundle).href);
  await route.env.DB.prepare('SELECT 1').first();
  sql = new DatabaseSync(join(data, 'mobiup.sqlite'));
  sql.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  sql.prepare("INSERT OR IGNORE INTO settings VALUES('seed-v1','1')").run();
  sql
    .prepare("INSERT INTO settings VALUES('app',?)")
    .run(JSON.stringify({ weeklyLimit: 20 }));
  const users = [
    [
      'agent',
      'agent',
      'assigned',
      'test-warehouse',
      'Synthetic warehouse',
      'TRTST01',
    ],
    [
      'other',
      'agent',
      'assigned',
      'test-other-warehouse',
      'Synthetic other warehouse',
      'TRTST02',
    ],
    ['manager-one', 'manager', 'assigned', null, null, ''],
    ['manager-two', 'manager', 'assigned', null, null, ''],
    ['manager-new', 'manager', 'assigned', null, null, ''],
    ['manager-global', 'manager', 'global', null, null, ''],
  ];
  const tokens = new Map();
  for (const [id, role, scope, warehouse, warehouseName, siteCode] of users) {
    sql
      .prepare(
        'INSERT INTO users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,?,?,?,?,?,?,0,1,1)',
      )
      .run(
        id,
        id,
        'Synthetic ' + id,
        role,
        scope,
        warehouse,
        warehouseName,
        siteCode,
        'disabled',
      );
    const token = randomUUID();
    tokens.set(id, token);
    sql
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(
        createHash('sha256').update(token).digest('hex'),
        id,
        Date.now() + 3_600_000,
      );
  }
  const assign = (manager, agent = 'agent') =>
    sql.prepare('INSERT INTO manager_agents VALUES(?,?)').run(manager, agent);
  const remove = (manager, agent = 'agent') =>
    sql
      .prepare('DELETE FROM manager_agents WHERE manager_id=? AND agent_id=?')
      .run(manager, agent);
  assign('manager-one');
  assign('manager-two');

  function product(id, code, category, kind = 'accessories') {
    return {
      id,
      code,
      category,
      kind,
      name: 'Synthetic product ' + id,
      brand: 'Synthetic',
      price: 10,
      netPrice: 8.4,
      sourceRow: 0,
      image: null,
    };
  }
  const catalogProducts = [
    product('cap-charger', 'SYNTH-CHARGE', 'Încărcătoare'),
    product('cap-case', 'SYNTH-CASE', 'Huse & folii'),
    product('cap-cable', 'SYNTH-CABLE', 'Cabluri & adaptoare'),
    product('cap-card', 'SYNTH-CARD', 'Cartele', 'stands'),
    product('nocap-audio', 'SYNTH-AUDIO', 'Audio'),
    product('dual-capped', 'SYNTH-SHARED', 'Huse & folii'),
    product('dual-uncapped', 'synth-shared', 'Audio'),
    product('stand-note-peer', 'synth-shared', 'Standuri', 'stands'),
  ];
  sql.prepare("INSERT INTO settings VALUES('catalog',?)").run(
    JSON.stringify({
      overrides: Object.fromEntries(catalogProducts.map((p) => [p.id, p])),
    }),
  );
  const effectiveCatalog = (await route.readCatalog()).products;
  const period = route.orderLimitPeriod();
  assert.deepEqual(route.orderLimitPeriod(new Date('2027-01-31T22:15:00Z')), {
    from: '2026-11',
    to: '2027-01',
  });
  route.orderLimitSalesVersion(period.from, period.to);
  sales = new DatabaseSync(join(data, 'sales.sqlite'));
  sales.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const monthAt = (offset) => {
    const date = new Date(period.from + '-01T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + offset);
    return date.toISOString().slice(0, 7);
  };
  function importMonth(month, quantity, covered = true, active = true) {
    const importedAt = month + '-15T12:00:00Z';
    const importId = sales
      .prepare(
        'INSERT INTO sales_imports(month,file_hash,filename,imported_at,imported_by,row_count,original_path,revision) VALUES(?,?,?,?,?,2,?,1)',
      )
      .run(
        month,
        randomUUID(),
        'synthetic.xlsx',
        importedAt,
        'agent',
        'synthetic',
      ).lastInsertRowid;
    function add(n, site, location, code, q) {
      sales
        .prepare(
          'INSERT INTO sales_rows(import_id,row_number,date,month,site_code,item_code,item_name,quantity,brand,price_cents,value_cents,location,company,asm,regional,order_number,category,sub_category,agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          importId,
          n,
          month + '-07',
          month,
          site,
          code,
          'Synthetic line',
          q,
          'Synthetic',
          1000,
          q * 1000,
          location,
          'Synthetic',
          '',
          '',
          'SYN-' + n,
          'Instrument',
          '',
          'Synthetic',
        );
    }
    if (covered)
      add(1, 'TRTST01', 'Synthetic warehouse', 'SYNTH-CHARGE', quantity);
    add(2, 'TRTST02', 'Synthetic other warehouse', 'SYNTH-CHARGE', 900);
    if (active)
      sales
        .prepare(
          'INSERT INTO sales_months(month,import_id,imported_at,filename,file_hash,revision) VALUES(?,?,?,?,?,1) ON CONFLICT(month) DO UPDATE SET import_id=excluded.import_id',
        )
        .run(month, importId, importedAt, 'synthetic.xlsx', randomUUID());
    return importId;
  }
  importMonth(monthAt(0), 900, true, false); // Superseded candidate must not contribute.
  importMonth(monthAt(0), 12);
  importMonth(monthAt(1), 24);
  importMonth(monthAt(2), -6);
  importMonth(monthAt(3), 850); // Current partial month must not contribute.

  function order(lines, owner = 'agent', kind = 'combined') {
    const id = randomUUID();
    const warehouseId =
      owner === 'agent' ? 'test-warehouse' : 'test-other-warehouse';
    const warehouseName =
      owner === 'agent' ? 'Synthetic warehouse' : 'Synthetic other warehouse';
    const all = lines.map(([key, quantity]) => ({
      ...effectiveCatalog.find((p) => p.id === key),
      quantity,
    }));
    const items = all.filter((line) => line.kind === 'accessories');
    const standItems = all.filter((line) => line.kind === 'stands');
    const now = new Date().toISOString();
    const payload = {
      id,
      number: 'SYN-' + id.slice(0, 8),
      userId: owner,
      agentName: 'Synthetic ' + owner,
      warehouseId,
      warehouseName,
      kind,
      status: 'draft',
      items,
      standItems: kind === 'combined' ? standItems : undefined,
      serials: [],
      client: null,
      notes: '',
      createdAt: now,
      finalizedAt: null,
      sourceOrderId: null,
      revision: 1,
      total: items.reduce((sum, line) => sum + line.price * line.quantity, 0),
      pieces: all.reduce((sum, line) => sum + line.quantity, 0),
    };
    sql
      .prepare(
        "INSERT INTO orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,revision) VALUES(?,?,?,?,?,'draft',?,?,1)",
      )
      .run(
        id,
        payload.number,
        owner,
        warehouseId,
        payload.kind,
        JSON.stringify(payload),
        now,
      );
    return id;
  }
  async function request(method, path, actor, body) {
    const req = new Request('http://synthetic.invalid/api/' + path, {
      method,
      headers: {
        Cookie: 'mobiup_session=' + tokens.get(actor),
        'X-Operation-User': actor,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await route[method](req);
    return { code: response.status, value: await response.json() };
  }
  async function call(method, path, actor, body, expected = 200) {
    const { code, value } = await request(method, path, actor, body);
    assert.equal(
      code,
      expected,
      method + ' ' + path + ' ' + JSON.stringify(value),
    );
    return value;
  }
  const limits = (id) => call('GET', 'orders/' + id + '/limits', 'agent');
  const ask = (id, revision, expected = 201) =>
    call(
      'POST',
      'orders/' + id + '/limit-approval',
      'agent',
      { revision, reason: 'Synthetic reason' },
      expected,
    );
  const finalize = (id, revision, expected = 200) =>
    call('POST', 'orders/' + id + '/finalize', 'agent', { revision }, expected);
  const decide = (
    id,
    actor,
    decision = 'approved',
    revision = 1,
    expected = 200,
  ) =>
    call(
      'POST',
      'order-limit-approvals/' + id + '/decision',
      actor,
      { revision, decision, comment: 'Synthetic decision' },
      expected,
    );

  delete process.env.MOBIUP_ORDER_LIMIT_MANAGER_ID;
  delete process.env.MOBIUP_ORDER_LIMIT_ADDITIONAL_MANAGER_IDS;
  const disabled = order([['cap-case', 40]]);
  assert.equal(
    (await limits(disabled)).enabled,
    false,
    'quantity limits are disabled without private configuration',
  );
  assert.equal((await finalize(disabled, 1)).order.status, 'finalized');

  process.env.MOBIUP_ORDER_LIMIT_MANAGER_ID = 'manager-one';
  const nonteam = order([['cap-case', 40]], 'other');
  const outside = await call('GET', 'orders/' + nonteam + '/limits', 'other');
  assert.equal(outside.enabled, false);
  assert.deepEqual(outside.products, []);
  await call(
    'POST',
    'orders/' + nonteam + '/limit-approval',
    'other',
    { revision: 1 },
    403,
  );
  const putOutside = route.env.FILES.put;
  route.env.FILES.put = async (...args) => {
    const result = await putOutside.apply(route.env.FILES, args);
    assign('manager-one', 'other');
    return result;
  };
  try {
    await call(
      'POST',
      'orders/' + nonteam + '/finalize',
      'other',
      { revision: 1 },
      409,
    );
  } finally {
    route.env.FILES.put = putOutside;
  }
  assert.equal(
    (await call('GET', 'orders/' + nonteam + '/limits', 'other')).enabled,
    true,
  );
  await call(
    'POST',
    'orders/' + nonteam + '/finalize',
    'other',
    { revision: 1 },
    409,
  );
  remove('manager-one', 'other');
  assert.equal(
    (
      await call('POST', 'orders/' + nonteam + '/finalize', 'other', {
        revision: 1,
      })
    ).order.status,
    'finalized',
  );

  const own = order([['cap-charger', 30]]);
  let view = await limits(own);
  assert.equal(view.enabled, true);
  const allowance = (id) => view.products.find((p) => p.productId === id);
  assert.equal(
    allowance('cap-charger').limit,
    30,
    'signed returns, active versions and closed-month scope',
  );
  assert.equal(allowance('cap-charger').salesQuantity, 30);
  assert.equal(allowance('cap-case').limit, 5);
  assert.equal(allowance('cap-cable').limit, 10);
  assert.equal(allowance('cap-card').limit, 250);
  assert.equal(allowance('nocap-audio'), undefined);
  assert.equal(view.violations.length, 0);
  await ask(own, 1, 400);
  await finalize(own, 1); // Equality does not require an approval.
  assert.equal(
    (await finalize(order([['nocap-audio', 999]]), 1)).order.status,
    'finalized',
  );

  importMonth(monthAt(0), 30);
  importMonth(monthAt(1), 0, false);
  importMonth(monthAt(2), 0, false);
  const zeroMonths = order([['cap-charger', 30]]);
  view = await limits(zeroMonths);
  assert.equal(
    allowance('cap-charger').limit,
    30,
    'covered closed months with no agent rows are zero months',
  );
  sales.prepare('DELETE FROM sales_months WHERE month=?').run(monthAt(2));
  view = await limits(zeroMonths);
  assert.equal(allowance('cap-charger').source, 'partial');
  assert.equal(
    allowance('cap-charger').limit,
    10,
    'missing global month uses floor',
  );
  importMonth(monthAt(2), 0, false);

  const overlap = order([
    ['dual-capped', 3],
    ['dual-uncapped', 3],
  ]);
  view = await limits(overlap);
  assert.equal(allowance('dual-capped').salesQuantity, null);
  assert.equal(
    allowance('dual-uncapped').floor,
    5,
    'uncapped duplicate cannot bypass the configured code cap',
  );
  assert.deepEqual(
    view.violations.map((x) => [x.code.toUpperCase(), x.requested, x.limit]),
    [['SYNTH-SHARED', 6, 5]],
  );
  await finalize(overlap, 1, 409);
  await finalize(order([['dual-uncapped', 6]]), 1, 409);
  const aviz = order([['stand-note-peer', 20]]);
  const client = {
    id: 'synthetic-partner',
    warehouseId: 'test-warehouse',
    warehouseIds: ['test-warehouse'],
    name: 'Synthetic partner',
    cui: 'SYNTHETIC',
    city: 'Synthetic',
    county: 'Synthetic',
    address: 'Synthetic',
    route: '',
  };
  sql
    .prepare(
      'INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)',
    )
    .run(client.id, client.warehouseId, JSON.stringify(client));
  sql
    .prepare(
      "UPDATE orders SET kind='stand_client',payload=json_set(payload,'$.kind','stand_client','$.items',json_extract(payload,'$.standItems'),'$.standItems',json('[]'),'$.client',json(?)) WHERE id=?",
    )
    .run(JSON.stringify(client), aviz);
  assert.equal((await limits(aviz)).violations.length, 0);
  assert.equal(
    (await finalize(aviz, 1)).order.status,
    'finalized',
    'delivery note remains exempt despite duplicate capped code',
  );

  const protectedOrder = order([['cap-charger', 31]]);
  assert.equal((await limits(protectedOrder)).violations[0].requested, 31);
  await finalize(protectedOrder, 1, 409);
  await call(
    'GET',
    'orders/' + protectedOrder + '/limits',
    'other',
    undefined,
    404,
  );
  await call(
    'POST',
    'orders/' + protectedOrder + '/limit-approval',
    'manager-one',
    { revision: 1 },
    403,
  );
  const concurrent = await Promise.all([
    request('POST', 'orders/' + protectedOrder + '/limit-approval', 'agent', {
      revision: 1,
    }),
    request('POST', 'orders/' + protectedOrder + '/limit-approval', 'agent', {
      revision: 1,
    }),
  ]);
  assert.deepEqual(
    concurrent.map((x) => x.code).sort((a, b) => a - b),
    [200, 201],
  );
  const id = concurrent[0].value.request.id;
  assert.equal(concurrent[1].value.request.id, id);
  const recipients = sql
    .prepare(
      "SELECT recipient_id FROM notifications WHERE target_type='order-approval' AND target_id=? ORDER BY recipient_id",
    )
    .all(id)
    .map((row) => row.recipient_id);
  assert.deepEqual(recipients, ['manager-one', 'manager-two']);
  await call('GET', 'order-limit-approvals/' + id, 'other', undefined, 404);
  await call(
    'GET',
    'order-limit-approvals/' + id,
    'manager-new',
    undefined,
    404,
  );
  const globalView = (
    await call('GET', 'order-limit-approvals/' + id, 'manager-global')
  ).request;
  assert.equal(globalView.canDecide, false);
  await decide(id, 'manager-global', 'approved', 1, 403);
  const pending = await call(
    'GET',
    'order-limit-approvals?status=pending&limit=1',
    'manager-two',
  );
  assert.deepEqual(
    pending.items.map((x) => x.id),
    [id],
  );
  assert.equal(pending.items[0].canDecide, true);

  const decisions = await Promise.all([
    request(
      'POST',
      'order-limit-approvals/' + id + '/decision',
      'manager-one',
      { revision: 1, decision: 'approved' },
    ),
    request(
      'POST',
      'order-limit-approvals/' + id + '/decision',
      'manager-two',
      { revision: 1, decision: 'approved' },
    ),
  ]);
  assert.deepEqual(
    decisions.map((x) => x.code).sort((a, b) => a - b),
    [200, 409],
  );
  const accepted = decisions.find((x) => x.code === 200).value.request;
  assert.equal(accepted.status, 'approved');
  assert.equal(accepted.revision, 2);
  assert.ok(accepted.decidedAt);
  assert.equal(
    sql
      .prepare('SELECT COUNT(*) count FROM notifications WHERE target_id=?')
      .get(id).count,
    4,
  );
  const unchanged = await call('PUT', 'orders/' + protectedOrder, 'agent', {
    revision: 1,
    items: [{ id: 'cap-charger', quantity: 31 }],
    standItems: [],
    serials: [],
    notes: '',
  });
  assert.equal(
    unchanged.order.revision,
    1,
    'unchanged validated save preserves the approved revision',
  );

  // An unmodified single-kind order must not lose manager approval upon review.
  const approvedSingleOrder = order([['cap-charger', 31]], 'agent', 'accessories');
  const singleApproval = (await ask(approvedSingleOrder, 1)).request;
  await decide(singleApproval.id, 'manager-one');
  const singleResave = await call('PUT', 'orders/' + approvedSingleOrder, 'agent', {
    revision: 1,
    items: [{ id: 'cap-charger', quantity: 31 }],
    serials: [],
    notes: '',
  });
  assert.equal(singleResave.order.revision, 1, 'unchanged single-kind draft must retain its approved revision');
  assert.equal((await limits(approvedSingleOrder)).request.status, 'approved');
  assert.equal((await finalize(approvedSingleOrder, 1)).order.status, 'finalized');
  assert.equal((await call('GET', 'order-limit-approvals/' + singleApproval.id, 'agent')).request.status, 'consumed');

  // A closed-month import replaced after validation but during the real export
  // must be rejected by the atomic SQLite guard, not just an earlier API read.
  const put = route.env.FILES.put;
  route.env.FILES.put = async (...args) => {
    const result = await put.apply(route.env.FILES, args);
    importMonth(monthAt(0), 25);
    return result;
  };
  try {
    await finalize(protectedOrder, 1, 409);
  } finally {
    route.env.FILES.put = put;
  }
  assert.equal(
    sql.prepare('SELECT status FROM orders WHERE id=?').get(protectedOrder)
      .status,
    'draft',
  );
  assert.equal(
    sql.prepare('SELECT status FROM order_limit_approvals WHERE id=?').get(id)
      .status,
    'approved',
  );
  assert.equal((await limits(protectedOrder)).request.status, 'superseded');
  const fresh = (await ask(protectedOrder, 1)).request;
  assert.notEqual(fresh.id, id);
  const approved = (await decide(fresh.id, 'manager-two')).request;
  // Exercise the exact Bucharest month boundary in the real finalization predicate.
  const prepare = route.env.DB.prepare;
  const boundary = route.orderLimitWindow().validity.end;
  let exportFinished = false;
  route.env.DB.prepare = (query) =>
    prepare.call(
      route.env.DB,
      exportFinished && query.includes('order_limit_sales.sales_months')
        ? query.replaceAll(
            "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            "'" + boundary + "'",
          )
        : query,
    );
  route.env.FILES.put = async (...args) => {
    const result = await put.apply(route.env.FILES, args);
    exportFinished = true;
    return result;
  };
  try {
    await finalize(protectedOrder, 1, 409);
  } finally {
    route.env.DB.prepare = prepare;
    route.env.FILES.put = put;
  }
  assert.equal(
    sql.prepare('SELECT status FROM orders WHERE id=?').get(protectedOrder)
      .status,
    'draft',
  );
  assert.equal(
    sql
      .prepare('SELECT status FROM order_limit_approvals WHERE id=?')
      .get(fresh.id).status,
    'approved',
  );
  const finished = await finalize(protectedOrder, 1);
  assert.equal(finished.order.status, 'finalized');
  await finalize(protectedOrder, 1); // A safe finalization retry cannot consume twice.
  const consumed = (
    await call('GET', 'order-limit-approvals/' + fresh.id, 'agent')
  ).request;
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.revision, 3);
  assert.equal(consumed.decidedAt, approved.decidedAt);
  assert.deepEqual(consumed.violations, approved.violations);

  const revisionOrder = order([['cap-charger', 26]]);
  const revisionApproval = (await ask(revisionOrder, 1)).request;
  await decide(revisionApproval.id, 'manager-one');
  const draft = await call('PUT', 'orders/' + revisionOrder, 'agent', {
    revision: 1,
    items: [{ id: 'cap-charger', quantity: 27 }],
    standItems: [],
    notes: '',
  });
  assert.equal(draft.order.revision, 2);
  assert.equal((await limits(revisionOrder)).request.status, 'superseded');
  await finalize(revisionOrder, 2, 409);
  const reassigned = (await ask(revisionOrder, 2)).request;
  remove('manager-two');
  assign('manager-new');
  await decide(reassigned.id, 'manager-two', 'approved', 1, 404);
  await decide(reassigned.id, 'manager-new', 'approved', 1, 403);
  await decide(reassigned.id, 'manager-one', 'approved', 1, 409);
  const renewed = (await ask(revisionOrder, 2)).request;
  assert.notEqual(renewed.id, reassigned.id);
  assert.equal(
    (await decide(renewed.id, 'manager-new', 'rejected')).request.status,
    'rejected',
  );
  assert.equal(
    (await ask(revisionOrder, 2, 200)).request.id,
    renewed.id,
    'a rejection replay returns the decision already made',
  );

  const scopedPolicy = await call('GET', 'order-limit-policy', 'manager-one');
  assert.equal(scopedPolicy.canEdit, false);
  assert.equal(scopedPolicy.revision, 0);
  await call('GET', 'order-limit-policy', 'agent', undefined, 403);
  await call(
    'PUT',
    'order-limit-policy',
    'manager-one',
    { revision: 0, floors: scopedPolicy.floors },
    403,
  );
  await call(
    'PUT',
    'order-limit-policy',
    'manager-global',
    { revision: 0, floors: { ...scopedPolicy.floors, unapproved: 1 } },
    400,
  );
  const policyOrder = order([['cap-case', 6]]);
  const oldPolicy = (await ask(policyOrder, 1)).request;
  await decide(oldPolicy.id, 'manager-one');
  const policy = await call('PUT', 'order-limit-policy', 'manager-global', {
    revision: 0,
    floors: { ...scopedPolicy.floors, casesFilms: 7 },
  });
  assert.equal(policy.revision, 1);
  assert.equal((await limits(policyOrder)).request.status, 'superseded');
  await finalize(policyOrder, 1);
  assert.equal(
    sql
      .prepare('SELECT status FROM order_limit_approvals WHERE id=?')
      .get(oldPolicy.id).status,
    'approved',
    'an obsolete exception is not consumed',
  );

  const catalogOrder = order([['cap-case', 8]]);
  const catalogApproval = (await ask(catalogOrder, 1)).request;
  const state = JSON.parse(
    sql.prepare("SELECT value FROM settings WHERE key='catalog'").get().value,
  );
  state.overrides['cap-case'].category = 'Audio';
  sql
    .prepare("UPDATE settings SET value=? WHERE key='catalog'")
    .run(JSON.stringify(state));
  const staleCatalog = (
    await call(
      'GET',
      'order-limit-approvals/' + catalogApproval.id,
      'manager-one',
    )
  ).request;
  assert.equal(staleCatalog.status, 'superseded');
  assert.equal(staleCatalog.canDecide, false);
  assert.equal(
    (
      await call('GET', 'order-limit-approvals?status=pending', 'manager-one')
    ).items.some((x) => x.id === catalogApproval.id),
    false,
  );
  await decide(catalogApproval.id, 'manager-one', 'approved', 1, 409);

  // Revoke an already admitted global read while it is loading source stamps.
  const globalTokenHash = createHash('sha256')
    .update(tokens.get('manager-global'))
    .digest('hex');
  let revoked = false;
  route.env.DB.prepare = (query) => {
    if (
      !revoked &&
      query === "SELECT value FROM settings WHERE key='catalog'"
    ) {
      sql
        .prepare('DELETE FROM sessions WHERE token_hash=?')
        .run(globalTokenHash);
      revoked = true;
    }
    return prepare.call(route.env.DB, query);
  };
  try {
    await call(
      'GET',
      'order-limit-approvals/' + catalogApproval.id,
      'manager-global',
      undefined,
      404,
    );
  } finally {
    route.env.DB.prepare = prepare;
  }
  assert(revoked);
  // A later multi-team rollout preserves the original pilot while applying
  // authorization to new teams through current manager_agents assignments.
  process.env.MOBIUP_ORDER_LIMIT_ADDITIONAL_MANAGER_IDS =
    'manager-two, manager-new, manager-two';
  assign('manager-two', 'other');
  const secondTeamOrder = order([['cap-cable', 20]], 'other');
  const secondTeamLimits = await call(
    'GET', 'orders/' + secondTeamOrder + '/limits', 'other',
  );
  assert.equal(secondTeamLimits.enabled, true);
  assert.deepEqual(
    secondTeamLimits.violations.map((v) => [v.code, v.requested, v.limit]),
    [['SYNTH-CABLE', 20, 10]],
  );
  await call('POST', 'orders/' + secondTeamOrder + '/finalize', 'other',
    { revision: 1 }, 409);
  const secondTeamApproval = (await call(
    'POST', 'orders/' + secondTeamOrder + '/limit-approval', 'other',
    { revision: 1, reason: 'Synthetic exception request' }, 201,
  )).request;
  await decide(secondTeamApproval.id, 'manager-two');
  assert.equal(
    (await call('POST', 'orders/' + secondTeamOrder + '/finalize',
      'other', { revision: 1 })).order.status,
    'finalized',
  );
  remove('manager-one');
  const thirdTeamOrder = order([['cap-cable', 20]]);
  assert.equal((await limits(thirdTeamOrder)).enabled, true,
    'a third configured manager alone enables the guard');
  await finalize(thirdTeamOrder, 1, 409);
  remove('manager-new');
  assert.equal((await limits(thirdTeamOrder)).enabled, false,
    'removing the last configured assignment disables the guard');
  await finalize(thirdTeamOrder, 1);
  assign('manager-one');
  assert.equal((await limits(order([['cap-cable', 20]]))).enabled, true,
    'the original manager stays enabled after the extension');
  remove('manager-two', 'other');
  assert.equal((await call('GET',
    'orders/' + order([['cap-cable', 20]], 'other') + '/limits', 'other')).enabled,
    false, 'outside teams must remain exempt');
  delete process.env.MOBIUP_ORDER_LIMIT_MANAGER_ID;
  assert.equal((await limits(order([['cap-cable', 20]]))).enabled, false,
    'without any matching assigned configured manager the gate stays off');

  console.log(
    'PASS order floors, returns and month coverage, HTTP guards, exact approvals, catalog/role scope, CAS, and sales/window races.',
  );
} finally {
  sales?.close();
  sql?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
}
