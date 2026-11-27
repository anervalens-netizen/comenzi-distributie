// Synthetic business contract reusable by SQLite and the isolated PostgreSQL driver.
// Authority/order DDL, role grants, transport authentication and cleanup are caller-owned.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function orderFinalizationFixtureStatements(
  api,
  applicationSchema,
  salesSchema,
  dialect,
) {
  const a = api.sqlIdentifier(applicationSchema),
    s = api.sqlIdentifier(salesSchema);
  const integer = dialect === 'postgresql' ? 'BIGINT' : 'INTEGER';
  return [
    `CREATE TABLE ${a}.notifications(id TEXT PRIMARY KEY,recipient_id TEXT NOT NULL,event_key TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,UNIQUE(recipient_id,event_key))`,
    `CREATE TABLE ${s}.sales_months(month TEXT PRIMARY KEY,import_id ${integer} NOT NULL)`,
    `CREATE TABLE ${s}.sales_rows(import_id ${integer} NOT NULL,month TEXT NOT NULL,location TEXT NOT NULL,site_code TEXT NOT NULL,item_code TEXT NOT NULL,quantity DOUBLE PRECISION NOT NULL)`,
  ];
}

export async function runOrderFinalizationContract(api, fixture) {
  const { database, other, applicationSchema, salesSchema } = fixture;
  const a = api.sqlIdentifier(applicationSchema),
    s = api.sqlIdentifier(salesSchema);
  const q = (kind, sqlite, pg = sqlite) => api.sqlQuery(kind, sqlite, pg),
    n = api.safeSqlInteger;
  const read = (sql, args = [], pg = sql) =>
    database.read((tx) => tx.query(q('read', sql, pg), args));
  const write = (sql, args = [], pg = sql, connection = database) =>
    connection.write((tx) => tx.query(q('write', sql, pg), args));
  const agent = { userId: 'fixture-agent-a', tokenHash: 'fixture-agent-token' };
  const stranger = {
    userId: 'fixture-agent-b',
    tokenHash: 'fixture-agent-b-token',
  };
  const regional = {
    userId: 'fixture-manager-a',
    tokenHash: 'fixture-manager-token',
  };
  const second = {
    userId: 'fixture-manager-b',
    tokenHash: 'fixture-manager-b-token',
  };
  const global = {
    userId: 'fixture-global',
    tokenHash: 'fixture-global-token',
  };
  const now0 = Date.parse('2025-04-15T09:00:00.000Z');
  let now = now0;
  const ids = {
    a: 'aaaaaaaa-0000-4000-8000-000000000001',
    b: 'bbbbbbbb-0000-4000-8000-000000000002',
  };
  const product = (id, kind, category) => ({
    id,
    code: id.toUpperCase(),
    name: 'Fictional ' + id,
    brand: 'Synthetic',
    category,
    kind,
    price: 2.5,
    netPrice: 2,
    sourceRow: 2,
    image: null,
  });
  const products = [
    product('fixture-case', 'accessories', 'Huse & Folii'),
    product('fixture-display', 'stands', 'Standuri'),
    product('fixture-stock-card', 'stands', 'Cartele'),
    product('fixture-unlimited', 'accessories', 'Synthetic other'),
  ];
  const options = (extra = {}) => ({
    applicationSchema,
    salesSchema,
    seedProducts: products,
    pilotManagerIds: [regional.userId],
    clock: () => now,
    ...extra,
  });
  const limits = (db = database, extra = {}) =>
    new api.OrderLimitRepository(db, options(extra));
  const finalizer = (db = database, extra = {}) =>
    new api.OrderFinalizationRepository(db, options(extra));
  const actor = (identity = agent) =>
    new api.AuthorityRepository(
      database,
      applicationSchema,
      () => now,
    ).captureRequestActor(identity);
  const status = (expected) => (error) => error && error.status === expected;
  const code = (expected) => (error) => error && error.code === expected;
  const payload = async (id = ids.a) =>
    (
      await read(
        `SELECT * FROM ${a}.orders WHERE id=?`,
        [id],
        `SELECT * FROM ${a}.orders WHERE id=$1`,
      )
    ).rows[0];
  const setting = (key, value) =>
    write(
      `INSERT INTO ${a}.settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, typeof value === 'string' ? value : JSON.stringify(value)],
      `INSERT INTO ${a}.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
  const business = async () => {
    const value = {};
    for (const [table, sort] of [
      ['orders', 'id'],
      ['serials', 'serial'],
      ['order_limit_approvals', 'id'],
      ['notifications', 'id'],
      ['order_list_revision', 'id'],
    ]) {
      value[table] = (
        await read(`SELECT * FROM ${a}.${table} ORDER BY ${sort}`)
      ).rows;
    }
    return value;
  };
  const reset = () =>
    database.write(async (tx) => {
      for (const table of [
        'notifications',
        'order_limit_approvals',
        'serials',
        'orders',
        'customers',
        'sessions',
        'manager_agents',
        'login_attempts',
        'users',
        'settings',
      ]) {
        await tx.query(q('write', `DELETE FROM ${a}.${table}`));
      }
      for (const table of ['sales_rows', 'sales_months'])
        await tx.query(q('write', `DELETE FROM ${s}.${table}`));
      const users = [
        [
          agent.userId,
          'agent',
          'assigned',
          'fixture-warehouse-a',
          'Warehouse A',
          'SITE-A',
        ],
        [
          stranger.userId,
          'agent',
          'assigned',
          'fixture-warehouse-b',
          'Warehouse B',
          'SITE-B',
        ],
        [regional.userId, 'manager', 'assigned', null, null, ''],
        [second.userId, 'manager', 'assigned', null, null, ''],
        [global.userId, 'manager', 'global', null, null, ''],
      ];
      for (const [id, role, scope, warehouse, name, site] of users)
        await tx.query(
          q(
            'write',
            `INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,?,?,?,?,?,'opaque-synthetic',0,1,1)`,
            `INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'opaque-synthetic',0,1,1)`,
          ),
          [id, id, 'Fictional ' + id, role, scope, warehouse, name, site],
        );
      for (const identity of [agent, stranger, regional, second, global])
        await tx.query(
          q(
            'write',
            `INSERT INTO ${a}.sessions VALUES(?,?,?)`,
            `INSERT INTO ${a}.sessions VALUES($1,$2,$3)`,
          ),
          [identity.tokenHash, identity.userId, now0 + 90 * 86400_000],
        );
      for (const id of [regional.userId, second.userId])
        await tx.query(
          q(
            'write',
            `INSERT INTO ${a}.manager_agents VALUES(?,?)`,
            `INSERT INTO ${a}.manager_agents VALUES($1,$2)`,
          ),
          [id, agent.userId],
        );
      await tx.query(
        q(
          'write',
          `UPDATE ${a}.portfolio_revision SET scope_revision=100 WHERE id=1`,
        ),
      );
      await tx.query(
        q('write', `UPDATE ${a}.order_list_revision SET revision=1 WHERE id=1`),
      );
    });
  const seed = async (extra = {}, id = ids.a) => {
    const order = {
      id,
      number: 'SYN-' + id,
      kind: 'accessories',
      userId: agent.userId,
      agentName: 'Fictional agent',
      warehouseId: 'fixture-warehouse-a',
      warehouseName: 'Warehouse A',
      status: 'draft',
      items: [{ ...products[0], quantity: 1 }],
      standItems: [],
      serials: [],
      client: null,
      notes: '',
      createdAt: '2025-04-15T08:00:00.000Z',
      finalizedAt: null,
      sourceOrderId: null,
      revision: 1,
      total: 2.5,
      pieces: 1,
      ...extra,
    };
    await write(
      `INSERT INTO ${a}.orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,source_order_id,revision,week_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        order.number,
        order.userId,
        order.warehouseId,
        order.kind,
        order.status,
        JSON.stringify(order),
        order.createdAt,
        order.finalizedAt,
        order.sourceOrderId,
        order.revision,
        extra.weekKey ?? null,
      ],
      `INSERT INTO ${a}.orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,source_order_id,revision,week_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    );
    return order;
  };
  const customer = async (
    memberships = ['fixture-warehouse-a'],
    extra = {},
  ) => {
    const data = {
      id: 'fixture-customer',
      name: 'Fictional customer',
      cui: 'SYNTHETIC',
      city: 'Fictional',
      county: 'Fictional',
      address: 'Fictional',
      route: 'Fictional',
      warehouseId: 'fixture-warehouse-a',
      ...(memberships === undefined ? {} : { warehouseIds: memberships }),
      ...extra,
    };
    await write(
      `INSERT INTO ${a}.customers VALUES(?,?,?,1)`,
      [data.id, 'fixture-warehouse-a', JSON.stringify(data)],
      `INSERT INTO ${a}.customers VALUES($1,$2,$3,1)`,
    );
    return data;
  };
  const months = async (quantities = [1, 2, 3]) => {
    for (let i = 0; i < quantities.length; i++) {
      const month = '2025-0' + (i + 1),
        importId = i + 1;
      await write(
        `INSERT INTO ${s}.sales_months VALUES(?,?)`,
        [month, importId],
        `INSERT INTO ${s}.sales_months VALUES($1,$2)`,
      );
      await write(
        `INSERT INTO ${s}.sales_rows VALUES(?,?,?,?,?,?)`,
        [
          importId,
          month,
          'Warehouse A',
          'SITE-A',
          'FIXTURE-CASE',
          quantities[i],
        ],
        `INSERT INTO ${s}.sales_rows VALUES($1,$2,$3,$4,$5,$6)`,
      );
    }
  };
  const staged = () => {
    const intents = [],
      objects = new Map(),
      states = new Map(),
      discarded = [];
    let onBegin, onStage, failBegin, failStage, failDiscard, failSettle;
    return {
      intents,
      objects,
      states,
      discarded,
      get onBegin() {
        return onBegin;
      },
      set onBegin(value) {
        onBegin = value;
      },
      get onStage() {
        return onStage;
      },
      set onStage(value) {
        onStage = value;
      },
      set failBegin(value) {
        failBegin = value;
      },
      set failStage(value) {
        failStage = value;
      },
      set failDiscard(value) {
        failDiscard = value;
      },
      set failSettle(value) {
        failSettle = value;
      },
      async begin(intent) {
        assert.equal(intent.kind, 'order-finalization-v1');
        assert.equal(
          intents.some((row) => row.operationId === intent.operationId),
          false,
        );
        intents.push(structuredClone(intent));
        states.set(intent.operationId, 'pending');
        if (onBegin) await onBegin(intent);
        if (failBegin) throw new Error('synthetic begin acknowledgement lost');
      },
      async stage(intent, order, catalog) {
        assert.equal(states.get(intent.operationId), 'pending');
        assert.equal(intent.orderId, order.id);
        assert.equal(
          intent.finalOrderSha256,
          createHash('sha256').update(JSON.stringify(order)).digest('hex'),
        );
        assert.match(
          intent.exportKey,
          new RegExp('^exports/' + order.id + '/[0-9a-f-]+\\.xlsx$'),
        );
        objects.set(intent.exportKey, {
          order: structuredClone(order),
          catalog: structuredClone(catalog),
        });
        if (onStage) await onStage(intent);
        if (failStage) throw new Error('synthetic stage acknowledgement lost');
      },
      async discard(intent) {
        assert.equal(states.get(intent.operationId), 'pending');
        if (failDiscard) throw new Error('synthetic discard failure');
        discarded.push(intent.exportKey);
        objects.delete(intent.exportKey);
      },
      async settle(intent, disposition) {
        assert.equal(states.get(intent.operationId), 'pending');
        if (failSettle) throw new Error('synthetic settle failure');
        states.set(intent.operationId, disposition);
      },
    };
  };
  const approve = async (order) => {
    order ??= await seed({
      items: [{ ...products[0], quantity: 8 }],
      pieces: 8,
    });
    const request = await limits().request(await actor(), order.id, {
      revision: order.revision,
      reason: 'Synthetic reason',
    });
    const decision = await limits().decide(
      await actor(regional),
      request.request.id,
      {
        revision: request.request.revision,
        decision: 'approved',
        comment: 'Synthetic decision',
      },
    );
    return { order, request, decision };
  };
  const cases = [],
    check = async (name, run) => {
      now = now0;
      await reset();
      try {
        await run();
      } catch (error) {
        error.message = `${name}: ${error.message}`;
        throw error;
      }
      cases.push(name);
    };
  const failWrite = (pattern, occurrence) => {
    let count = 0;
    return {
      read: (action) => database.read(action),
      close: () => Promise.resolve(),
      write: (action, authority) =>
        database.write(
          (tx) =>
            action({
              dialect: tx.dialect,
              query: async (query, values) => {
                if (
                  query.kind === 'write' &&
                  pattern.test(query[tx.dialect]) &&
                  ++count === occurrence
                )
                  throw new Error('synthetic statement failure');
                return tx.query(query, values);
              },
            }),
          authority,
        ),
    };
  };

  await check(
    'catalog_and_client_helpers_preserve_json1_membership_and_raw_hashes',
    async () => {
      for (const [value, expected] of [
        [undefined, true],
        [null, true],
        [[], false],
        [['fixture-warehouse-a'], true],
        [{ legacy: 'fixture-warehouse-a' }, true],
        ['"fixture-warehouse-a"', true],
        ['["fixture-warehouse-a"]', true],
        [true, false],
        [1, false],
      ]) {
        assert.equal(
          api.customerHasWarehouse(
            value === undefined ? {} : { warehouseIds: value },
            'fixture-warehouse-a',
            'fixture-warehouse-a',
          ),
          expected,
        );
      }
      assert.throws(
        () =>
          api.customerHasWarehouse(
            { warehouseIds: 'fixture-warehouse-a' },
            'fixture-warehouse-a',
            'fixture-warehouse-a',
          ),
        SyntaxError,
      );
    },
  );
  for (const [at, week] of [
    ['2025-03-30T20:59:59.999Z', '2025-03-24'],
    ['2025-03-30T21:00:00.000Z', '2025-03-31'],
    ['2025-10-26T21:59:59.999Z', '2025-10-20'],
    ['2025-10-26T22:00:00.000Z', '2025-10-27'],
  ]) {
    await check('bucharest_week_' + at, async () =>
      assert.equal(api.finalizationWeekKey(new Date(at)), week),
    );
  }
  for (const kind of [
    'accessories',
    'stands',
    'combined',
    'sim',
    'stand_client',
  ])
    await check(
      'finalize_' + kind + '_atomic_shape_and_private_export',
      async () => {
        const extra = { kind };
        if (kind === 'stands' || kind === 'stand_client')
          extra.items = [{ ...products[1], quantity: 1 }];
        if (kind === 'sim') {
          extra.items = [];
          extra.serials = ['100000000000000001'];
          extra.client = await customer();
        }
        if (kind === 'stand_client') extra.client = await customer();
        const order = await seed(extra),
          store = staged(),
          result = await finalizer().finalize(
            await actor(),
            order.id,
            { revision: 1 },
            store,
          );
        assert.equal(result.finalized, true);
        assert.equal(result.order.revision, 2);
        assert.equal(result.order.status, 'finalized');
        assert.equal(result.order.finalizedAt, new Date(now).toISOString());
        assert.equal(store.objects.size, kind === 'stand_client' ? 0 : 1);
        assert.equal(
          store.states.get(store.intents[0].operationId),
          'committed',
        );
        assert.equal(
          n(
            (
              await read(
                `SELECT revision FROM ${a}.order_list_revision WHERE id=1`,
              )
            ).rows[0].revision,
          ),
          3,
        );
        assert.equal(
          (await read(`SELECT * FROM ${a}.serials`)).rows.length,
          kind === 'sim' ? 1 : 0,
        );
        const before = await business(),
          retry = await finalizer().finalize(
            await actor(),
            order.id,
            null,
            staged(),
          );
        assert.equal(retry.finalized, false);
        assert.deepEqual(retry.order, result.order);
        assert.deepEqual(await business(), before);
      },
    );
  for (const [name, id] of [
    ['hyphens', '-'.repeat(36)],
    ['hex_without_uuid_segments', 'a'.repeat(36)],
  ])
    await check(
      'legacy_id_' + name + '_creates_saves_and_finalizes',
      async () => {
        const drafts = new api.OrderDraftRepository(
          database,
          applicationSchema,
          { products, warehouses: [] },
          () => now,
        );
        const captured = await actor();
        const created = await drafts.create(captured, {
          id,
          kind: 'accessories',
          agentId: agent.userId,
        });
        assert.equal(created.created, true);
        const saved = await drafts.save(captured, id, {
          revision: created.order.revision,
          items: [{ id: products[0].id, quantity: 1 }],
        });
        const store = staged();
        const result = await finalizer().finalize(
          captured,
          id,
          { revision: saved.revision },
          store,
        );
        assert.equal(result.finalized, true);
        assert.equal(result.order.id, id);
        assert.equal(result.order.revision, saved.revision + 1);
        assert.equal(store.intents[0].orderId, id);
        assert.deepEqual(result.exportKey.split('/').slice(0, 2), [
          'exports',
          id,
        ]);
        assert.equal(store.objects.get(result.exportKey).order.id, id);
        assert.equal(
          store.states.get(store.intents[0].operationId),
          'committed',
        );
      },
    );
  await check('existing_uppercase_stored_id_remains_finalizable', async () => {
    const id = ids.a.toUpperCase();
    await seed({}, id);
    const store = staged();
    const result = await finalizer().finalize(
      await actor(),
      id,
      { revision: 1 },
      store,
    );
    assert.equal(result.finalized, true);
    assert.equal(store.intents[0].orderId, id);
    assert.equal(result.exportKey.split('/')[1], id);
  });
  await check(
    'unsafe_stored_id_cannot_create_private_export_intent',
    async () => {
      for (const id of ['../'.repeat(12), 'a'.repeat(35) + '/']) {
        await seed({}, id);
        const before = await business();
        const store = staged();
        await assert.rejects(
          finalizer().finalize(await actor(), id, { revision: 1 }, store),
          /Stored order identity cannot bind a private export/,
        );
        assert.equal(store.intents.length, 0);
        assert.equal(store.objects.size, 0);
        assert.deepEqual(await business(), before);
      }
    },
  );
  for (const gate of ['disabled', 'outside_pilot', 'evaluated'])
    for (const phase of ['begin', 'stage'])
      await check(
        'ean_change_after_' + phase + '_' + gate + '_refuses_stale_export',
        async () => {
          if (phase === 'stage')
            await setting('inventory-ean-v1', { 12345670: 'FIXTURE-CASE' });
          await seed();
          const before = await business();
          const store = staged();
          store.objects.set('unrelated-existing-export', { owned: false });
          const mutate = () =>
            write(
              `INSERT INTO ${a}.settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
              [
                'inventory-ean-v1',
                JSON.stringify({ 96385074: 'FIXTURE-CASE' }),
              ],
              `INSERT INTO ${a}.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
              other,
            );
          if (phase === 'begin') store.onBegin = mutate;
          else store.onStage = mutate;
          const pilotManagerIds =
            gate === 'disabled'
              ? []
              : gate === 'outside_pilot'
                ? [global.userId]
                : [regional.userId];
          await assert.rejects(
            finalizer(database, { pilotManagerIds }).finalize(
              await actor(),
              ids.a,
              { revision: 1 },
              store,
            ),
            code('catalog_changed'),
          );
          assert.deepEqual(await business(), before);
          assert.equal(store.objects.size, 1);
          assert.deepEqual(store.objects.get('unrelated-existing-export'), {
            owned: false,
          });
          assert.deepEqual(store.discarded, [store.intents[0].exportKey]);
          assert.equal(
            store.states.get(store.intents[0].operationId),
            'rolled_back',
          );
        },
      );
  for (const [name, extra, body, expected] of [
    ['wrong_revision', {}, { revision: 2 }, 409],
    ['empty', { items: [], pieces: 0 }, { revision: 1 }, 400],
    [
      'missing_client',
      { kind: 'sim', items: [], serials: ['100000000000000001'], client: null },
      { revision: 1 },
      400,
    ],
    [
      'removed_product',
      { items: [{ ...products[0], id: 'missing', quantity: 1 }] },
      { revision: 1 },
      409,
    ],
    [
      'changed_product',
      { items: [{ ...products[0], price: 999, quantity: 1 }] },
      { revision: 1 },
      409,
    ],
  ]) {
    if (typeof name !== 'string') throw new Error('Expected named fixture');
    await check('reject_' + name + '_before_export', async () => {
      await seed(extra);
      const before = await business(),
        store = staged();
      await assert.rejects(
        finalizer().finalize(await actor(), ids.a, body, store),
        status(expected),
      );
      assert.equal(store.intents.length, 0);
      assert.deepEqual(await business(), before);
    });
  }
  await check(
    'finalize_actor_cannot_write_foreign_order_or_reuse_expired_session',
    async () => {
      await seed();
      await assert.rejects(
        finalizer().finalize(
          await actor(stranger),
          ids.a,
          { revision: 1 },
          staged(),
        ),
        status(404),
      );
      const captured = await actor();
      await write(
        `DELETE FROM ${a}.sessions WHERE token_hash=?`,
        [agent.tokenHash],
        `DELETE FROM ${a}.sessions WHERE token_hash=$1`,
      );
      await assert.rejects(
        finalizer().finalize(captured, ids.a, { revision: 1 }, staged()),
        status(409),
      );
    },
  );
  for (const value of [null, '0', true, 1.5, 8, -1])
    await check(
      'invalid_weekly_' + JSON.stringify(value) + '_blocks_counted_only',
      async () => {
        await setting('app', { weeklyLimit: value });
        await seed();
        const store = staged();
        await assert.rejects(
          finalizer().finalize(await actor(), ids.a, { revision: 1 }, store),
          status(503),
        );
        assert.equal(store.intents.length, 0);
        await seed(
          { kind: 'stands', items: [{ ...products[1], quantity: 1 }] },
          ids.b,
        );
        assert.equal(
          (
            await finalizer().finalize(
              await actor(),
              ids.b,
              { revision: 1 },
              staged(),
            )
          ).finalized,
          true,
        );
      },
    );
  for (const value of [0, 2147483647])
    await check(
      'unlimited_storage_' + value + '_preserves_json_integer',
      async () => {
        await setting('app', { weeklyLimit: value });
        await seed({ status: 'finalized', weekKey: '2025-04-14' }, ids.b);
        await seed();
        assert.equal(
          (
            await finalizer().finalize(
              await actor(),
              ids.a,
              { revision: 1 },
              staged(),
            )
          ).finalized,
          true,
        );
        assert.equal(
          JSON.parse(
            (await read(`SELECT value FROM ${a}.settings WHERE key='app'`))
              .rows[0].value,
          ).weeklyLimit,
          value,
        );
      },
    );
  await check(
    'finite_weekly_cap_counts_accessories_and_nonempty_combined_only',
    async () => {
      await setting('app', { weeklyLimit: 1 });
      await seed(
        {
          kind: 'combined',
          items: [],
          standItems: [{ ...products[1], quantity: 1 }],
          status: 'finalized',
          weekKey: '2025-04-14',
        },
        ids.b,
      );
      await seed();
      assert.equal(
        (
          await finalizer().finalize(
            await actor(),
            ids.a,
            { revision: 1 },
            staged(),
          )
        ).finalized,
        true,
      );
      await write(
        `DELETE FROM ${a}.orders WHERE id=?`,
        [ids.b],
        `DELETE FROM ${a}.orders WHERE id=$1`,
      );
      await seed({}, ids.b);
      const store = staged();
      await assert.rejects(
        finalizer().finalize(await actor(), ids.b, { revision: 1 }, store),
        code('weekly_order_limit_reached'),
      );
      assert.equal((await payload(ids.b)).status, 'draft');
      assert.equal(store.objects.size, 0);
    },
  );
  await check(
    'parallel_finalizations_cannot_exceed_one_weekly_slot',
    async () => {
      await setting('app', { weeklyLimit: 1 });
      await seed();
      await seed({}, ids.b);
      const captured = await actor(),
        stores = [staged(), staged()];
      const outcomes = await Promise.allSettled(
        [ids.a, ids.b].map((id, i) =>
          finalizer().finalize(captured, id, { revision: 1 }, stores[i]),
        ),
      );
      assert.equal(
        outcomes.filter((row) => row.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        n(
          (
            await read(
              `SELECT COUNT(*) AS total FROM ${a}.orders WHERE status='finalized'`,
            )
          ).rows[0].total,
        ),
        1,
      );
      assert.equal(
        stores.reduce((sum, store) => sum + store.objects.size, 0),
        1,
      );
    },
  );
  await check(
    'policy_requires_global_manager_and_raw_cas_and_exact_floor_fields',
    async () => {
      await assert.rejects(limits().getPolicy(await actor()), status(403));
      await assert.rejects(
        limits().setPolicy(await actor(regional), { revision: 0, floors: {} }),
        status(403),
      );
      const floors = {
        casesFilms: 8,
        chargers: 10,
        cablesAdapters: 11,
        prepaidSim: 251,
      };
      for (const invalid of [
        { ...floors, casesFilms: 0 },
        { ...floors, casesFilms: 1.5 },
        { ...floors, extra: 1 },
      ]) {
        await assert.rejects(
          limits().setPolicy(await actor(global), {
            revision: 0,
            floors: invalid,
          }),
          status(400),
        );
      }
      assert.equal(
        (await limits().setPolicy(await actor(global), { revision: 0, floors }))
          .revision,
        1,
      );
      await assert.rejects(
        limits().setPolicy(await actor(global), { revision: 0, floors }),
        status(409),
      );
    },
  );
  for (const [label, quantities, source, limit] of [
    ['empty', [], 'unavailable', 5],
    ['partial', [20], 'partial', 5],
    ['net', [9, -3, 2], 'sales', 8],
    ['negative', [-3, -2, -1], 'floor', 5],
  ]) {
    await check(
      'product_limit_' + label + '_uses_active_closed_months',
      async () => {
        await seed({ items: [{ ...products[0], quantity: 9 }], pieces: 9 });
        await months(quantities);
        await write(
          `INSERT INTO ${s}.sales_rows VALUES(999,'2025-01','Warehouse A','SITE-A','FIXTURE-CASE',9999)`,
        );
        const view = await limits().limits(await actor(), ids.a),
          item = view.products.find((row) => row.productId === products[0].id);
        assert.equal(item.source, source);
        assert.equal(item.limit, limit);
        assert.equal(view.violations[0].requested, 9);
      },
    );
  }
  await check('ambiguous_seller_alias_mapping_uses_floor', async () => {
    await seed({ items: [{ ...products[0], quantity: 9 }], pieces: 9 });
    await months([30, 30, 30]);
    await setting('sales-agent-aliases-v1', [
      {
        userId: stranger.userId,
        warehouseName: 'Warehouse A',
        siteCode: 'SITE-A',
      },
    ]);
    const view = await limits().limits(await actor(), ids.a);
    assert.equal(view.products[0].source, 'unavailable');
    assert.equal(view.products[0].limit, 5);
  });
  await check(
    'duplicate_product_codes_use_floor_even_when_sales_mapping_is_available',
    async () => {
      await seed({ items: [{ ...products[0], quantity: 9 }], pieces: 9 });
      await months([30, 30, 30]);
      const baseline = await limits().limits(await actor(), ids.a);
      assert.equal(baseline.products[0].source, 'sales');
      assert.equal(baseline.products[0].limit, 90);
      const duplicate = [
        ...products,
        { ...products[0], id: 'fixture-duplicate' },
      ];
      assert.equal(
        (
          await limits(database, { seedProducts: duplicate }).limits(
            await actor(),
            ids.a,
          )
        ).products[0].source,
        'unavailable',
      );
    },
  );
  await check(
    'request_is_idempotent_and_notifies_each_active_assigned_manager_once',
    async () => {
      await seed({ items: [{ ...products[0], quantity: 8 }], pieces: 8 });
      const captured = await actor();
      const first = await limits().request(captured, ids.a, {
        revision: 1,
        reason: ' reason ',
      });
      assert.equal(first.created, true);
      assert.equal(first.request.reason, 'reason');
      assert.equal(first.request.status, 'pending');
      assert.equal(first.notification.recipients.length, 2);
      const secondRequest = await limits().request(captured, ids.a, {
        revision: 1,
        reason: 'changed',
      });
      assert.equal(secondRequest.created, false);
      assert.equal(secondRequest.notification, null);
      assert.equal(secondRequest.request.id, first.request.id);
      assert.equal(
        (await read(`SELECT * FROM ${a}.notifications`)).rows.length,
        2,
      );
    },
  );
  await check(
    'only_current_request_recipient_may_decide_and_one_decision_wins',
    async () => {
      await seed({ items: [{ ...products[0], quantity: 8 }], pieces: 8 });
      const request = await limits().request(await actor(), ids.a, {
        revision: 1,
      });
      await assert.rejects(
        limits().decide(await actor(global), request.request.id, {
          revision: 1,
          decision: 'approved',
        }),
        status(403),
      );
      const result = await limits().decide(
        await actor(regional),
        request.request.id,
        { revision: 1, decision: 'approved' },
      );
      assert.equal(result.request.status, 'approved');
      assert.equal(result.request.revision, 2);
      await assert.rejects(
        limits().decide(await actor(second), request.request.id, {
          revision: 1,
          decision: 'rejected',
        }),
        status(409),
      );
      assert.equal(
        (await read(`SELECT * FROM ${a}.notifications`)).rows.length,
        4,
      );
    },
  );
  await check('approval_is_consumed_in_the_same_order_commit', async () => {
    const { order, request } = await approve();
    const result = await finalizer().finalize(
      await actor(),
      order.id,
      { revision: 1 },
      staged(),
    );
    assert.equal(result.order.status, 'finalized');
    const approval = await limits().approval(await actor(), request.request.id);
    assert.equal(approval.status, 'consumed');
    assert.equal(approval.revision, 3);
  });
  await check(
    'unapproved_excess_never_creates_export_or_changes_order',
    async () => {
      await seed({ items: [{ ...products[0], quantity: 8 }], pieces: 8 });
      const before = await business(),
        store = staged();
      await assert.rejects(
        finalizer().finalize(await actor(), ids.a, { revision: 1 }, store),
        code('order_limit_approval_required'),
      );
      assert.equal(store.intents.length, 0);
      assert.deepEqual(await business(), before);
    },
  );
  for (const mutation of ['request', 'decision'])
    await check(
      'second_notification_failure_rolls_back_' + mutation,
      async () => {
        await seed({ items: [{ ...products[0], quantity: 8 }], pieces: 8 });
        const request =
          mutation === 'decision'
            ? await limits().request(await actor(), ids.a, { revision: 1 })
            : null;
        const before = await business(),
          repository = limits(failWrite(/\.notifications\(/, 2));
        const action =
          mutation === 'decision'
            ? repository.decide(await actor(regional), request.request.id, {
                revision: 1,
                decision: 'approved',
              })
            : repository.request(await actor(), ids.a, { revision: 1 });
        await assert.rejects(action, /synthetic statement failure/);
        assert.deepEqual(await business(), before);
      },
    );
  await check(
    'invalid_pilot_configuration_fails_closed_for_limited_products',
    async () => {
      await seed();
      const store = staged();
      await assert.rejects(
        finalizer(database, {
          pilotManagerIds: ['fictional-missing-manager'],
        }).finalize(await actor(), ids.a, { revision: 1 }, store),
        code('invalid_order_limit_configuration'),
      );
      assert.equal(store.intents.length, 0);
      assert.equal((await payload()).status, 'draft');
    },
  );
  await check(
    'revocation_after_pending_journal_ack_prevents_private_export_staging',
    async () => {
      await seed();
      const captured = await actor(),
        store = staged();
      store.onBegin = () =>
        write(
          `DELETE FROM ${a}.sessions WHERE token_hash=?`,
          [agent.tokenHash],
          `DELETE FROM ${a}.sessions WHERE token_hash=$1`,
          other,
        );
      await assert.rejects(
        finalizer().finalize(captured, ids.a, { revision: 1 }, store),
        status(409),
      );
      assert.equal(store.objects.size, 0);
      assert.equal(
        store.states.get(store.intents[0].operationId),
        'rolled_back',
      );
      assert.equal((await payload()).status, 'draft');
    },
  );
  await check(
    'manager_portfolio_revoked_during_export_refuses_finalization',
    async () => {
      await seed();
      const captured = await actor(regional),
        store = staged();
      store.onStage = () =>
        write(
          `DELETE FROM ${a}.manager_agents WHERE manager_id=? AND agent_id=?`,
          [regional.userId, agent.userId],
          `DELETE FROM ${a}.manager_agents WHERE manager_id=$1 AND agent_id=$2`,
          other,
        );
      await assert.rejects(
        finalizer().finalize(captured, ids.a, { revision: 1 }, store),
        status(409),
      );
      assert.equal(store.objects.size, 0);
      assert.equal((await payload()).status, 'draft');
    },
  );
  for (const mutation of ['raw', 'membership', 'inactive'])
    await check(
      'client_' + mutation + '_changed_during_export_refuses_finalization',
      async () => {
        const client = await customer();
        await seed({
          kind: 'sim',
          items: [],
          serials: ['100000000000000001'],
          client,
        });
        const store = staged();
        store.onStage = () =>
          mutation === 'inactive'
            ? write(`UPDATE ${a}.customers SET active=0`, [], undefined, other)
            : write(
                `UPDATE ${a}.customers SET data=?`,
                [
                  JSON.stringify({
                    ...client,
                    ...(mutation === 'raw'
                      ? { unrelatedField: 'changed' }
                      : { warehouseIds: [] }),
                  }),
                ],
                `UPDATE ${a}.customers SET data=$1`,
                other,
              );
        await assert.rejects(
          finalizer().finalize(await actor(), ids.a, { revision: 1 }, store),
          status(409),
        );
        assert.equal(store.objects.size, 0);
        assert.equal((await payload()).status, 'draft');
        assert.equal((await read(`SELECT * FROM ${a}.serials`)).rows.length, 0);
      },
    );
  for (const [name, mutate] of [
    ['catalog', () => setting('catalog', { overrides: {} })],
    ['weekly', () => setting('app', { weeklyLimit: 2 })],
    [
      'draft',
      () =>
        write(
          `UPDATE ${a}.orders SET revision=revision+1 WHERE id=?`,
          [ids.a],
          `UPDATE ${a}.orders SET revision=revision+1 WHERE id=$1`,
          other,
        ),
    ],
    [
      'session',
      () =>
        write(
          `DELETE FROM ${a}.sessions WHERE token_hash=?`,
          [agent.tokenHash],
          `DELETE FROM ${a}.sessions WHERE token_hash=$1`,
          other,
        ),
    ],
    [
      'profile',
      () =>
        write(
          `UPDATE ${a}.users SET profile_revision=profile_revision+1 WHERE id=?`,
          [agent.userId],
          `UPDATE ${a}.users SET profile_revision=profile_revision+1 WHERE id=$1`,
          other,
        ),
    ],
  ])
    await check(
      'mutation_during_export_' + name + '_refuses_and_cleans_only_own_object',
      async () => {
        await seed();
        const store = staged();
        store.objects.set('unrelated-existing-export', { owned: false });
        store.onStage = mutate;
        await assert.rejects(
          finalizer().finalize(await actor(), ids.a, { revision: 1 }, store),
          status(409),
        );
        assert.equal((await payload()).status, 'draft');
        assert.equal(store.objects.size, 1);
        assert.equal(store.objects.has('unrelated-existing-export'), true);
        assert.equal(
          store.states.get(store.intents[0].operationId),
          'rolled_back',
        );
      },
    );
  for (const [name, mutate] of [
    [
      'sales_closed_month',
      () => write(`INSERT INTO ${s}.sales_months VALUES('2025-02',99)`),
    ],
    ['sales_aliases', () => setting('sales-agent-aliases-v1', [])],
    [
      'policy',
      () =>
        setting('order-limit-policy-v1', {
          revision: 2,
          floors: {
            casesFilms: 6,
            chargers: 10,
            cablesAdapters: 10,
            prepaidSim: 250,
          },
        }),
    ],
    [
      'assignments',
      () =>
        write(
          `DELETE FROM ${a}.manager_agents WHERE manager_id=? AND agent_id=?`,
          [second.userId, agent.userId],
          `DELETE FROM ${a}.manager_agents WHERE manager_id=$1 AND agent_id=$2`,
          other,
        ),
    ],
    [
      'approval_revision',
      () => write(`UPDATE ${a}.order_limit_approvals SET revision=revision+1`),
    ],
    [
      'month_boundary',
      async () => {
        now = Date.parse('2025-04-30T21:00:00.000Z');
      },
    ],
  ])
    await check(
      'approval_source_change_' + name + '_cannot_be_consumed',
      async () => {
        const { order, request } = await approve();
        const store = staged();
        store.onStage = mutate;
        await assert.rejects(
          finalizer().finalize(await actor(), order.id, { revision: 1 }, store),
          status(409),
        );
        assert.equal((await payload()).status, 'draft');
        assert.equal(
          (
            await read(
              `SELECT status FROM ${a}.order_limit_approvals WHERE id=?`,
              [request.request.id],
              `SELECT status FROM ${a}.order_limit_approvals WHERE id=$1`,
            )
          ).rows[0].status,
          'approved',
        );
        assert.equal(store.objects.size, 0);
      },
    );
  await check(
    'current_month_sales_import_does_not_invalidate_closed_month_approval',
    async () => {
      const { order } = await approve(),
        store = staged();
      store.onStage = () =>
        write(`INSERT INTO ${s}.sales_months VALUES('2025-04',99)`);
      assert.equal(
        (
          await finalizer().finalize(
            await actor(),
            order.id,
            { revision: 1 },
            store,
          )
        ).finalized,
        true,
      );
    },
  );
  await check('deleted_order_preserves_superseded_approval_audit', async () => {
    const { request } = await approve();
    await write(
      `UPDATE ${a}.orders SET status='deleted',revision=revision+1 WHERE id=?`,
      [ids.a],
      `UPDATE ${a}.orders SET status='deleted',revision=revision+1 WHERE id=$1`,
    );
    assert.equal(
      (await limits().approval(await actor(), request.request.id)).status,
      'superseded',
    );
  });
  await check(
    'serial_collision_preserves_existing_order_and_rolls_back_attempt',
    async () => {
      const client = await customer();
      await seed({
        kind: 'sim',
        items: [],
        serials: ['100000000000000001'],
        client,
      });
      await seed({ kind: 'sim', items: [], status: 'finalized' }, ids.b);
      await write(
        `INSERT INTO ${a}.serials VALUES(?,?)`,
        ['100000000000000001', ids.b],
        `INSERT INTO ${a}.serials VALUES($1,$2)`,
      );
      const before = await business(),
        store = staged();
      await assert.rejects(
        finalizer().finalize(await actor(), ids.a, { revision: 1 }, store),
        code('serial_already_finalized'),
      );
      assert.deepEqual(await business(), before);
      assert.equal(store.objects.size, 0);
    },
  );
  await check(
    'failure_after_order_and_approval_update_rolls_back_every_database_write',
    async () => {
      const { order } = await approve();
      const before = await business();
      const failing = {
        read: (action) => database.read(action),
        close: () => Promise.resolve(),
        write: (action, authority) =>
          database.write(async (tx) => {
            const result = await action(tx);
            throw Object.assign(new Error('synthetic failure before commit'), {
              result,
            });
          }, authority),
      };
      const store = staged();
      await assert.rejects(
        finalizer(failing).finalize(
          await actor(),
          order.id,
          { revision: 1 },
          store,
        ),
        /synthetic failure before commit/,
      );
      assert.deepEqual(await business(), before);
      assert.equal(store.objects.size, 0);
    },
  );
  await check(
    'second_serial_insert_failure_rolls_back_first_serial_order_and_revision',
    async () => {
      const client = await customer();
      await seed({
        kind: 'sim',
        items: [],
        serials: ['100000000000000001', '100000000000000002'],
        client,
        pieces: 2,
      });
      const before = await business(),
        store = staged();
      await assert.rejects(
        finalizer(failWrite(/\.serials\(/, 2)).finalize(
          await actor(),
          ids.a,
          { revision: 1 },
          store,
        ),
        /synthetic statement failure/,
      );
      assert.deepEqual(await business(), before);
      assert.equal(store.objects.size, 0);
    },
  );
  await check(
    'session_expiry_after_domain_writes_rolls_back_before_commit',
    async () => {
      await seed();
      const before = await business(),
        store = staged();
      const delayed = {
        read: (action) => database.read(action),
        close: () => Promise.resolve(),
        write: (action, authority) =>
          database.write(async (tx) => {
            const result = await action(tx);
            now = now0 + 90 * 86400_000;
            return result;
          }, authority),
      };
      await assert.rejects(
        finalizer(delayed).finalize(
          await actor(),
          ids.a,
          { revision: 1 },
          store,
        ),
        status(409),
      );
      assert.deepEqual(await business(), before);
      assert.equal(store.objects.size, 0);
    },
  );
  for (const committed of [false, true])
    await check(
      'unknown_commit_' +
        committed +
        '_retains_exact_export_and_pending_intent',
      async () => {
        await seed();
        const store = staged();
        const unknown = {
          read: (action) => database.read(action),
          close: () => Promise.resolve(),
          write: async (action, authority) => {
            if (committed) await database.write(action, authority);
            throw new api.CommitOutcomeUnknownError(
              new Error('synthetic acknowledgement loss'),
            );
          },
        };
        await assert.rejects(
          finalizer(unknown).finalize(
            await actor(),
            ids.a,
            { revision: 1 },
            store,
          ),
          (error) =>
            error instanceof api.FinalizationReconciliationRequiredError &&
            error.phase === 'database_commit_unknown' &&
            error.retryUnsafe,
        );
        assert.equal(store.discarded.length, 0);
        assert.equal(store.objects.size, 1);
        assert.equal(store.states.get(store.intents[0].operationId), 'pending');
        assert.equal(
          (await payload()).status,
          committed ? 'finalized' : 'draft',
        );
      },
    );
  for (const phase of ['failBegin', 'failStage', 'failSettle'])
    await check(
      'export_' + phase + '_is_explicit_pending_not_automatic_retry',
      async () => {
        await seed();
        const store = staged();
        store[phase] = true;
        await assert.rejects(
          finalizer().finalize(await actor(), ids.a, { revision: 1 }, store),
          (error) =>
            error instanceof api.FinalizationReconciliationRequiredError &&
            error.retryUnsafe,
        );
        assert.equal(store.discarded.length, 0);
        assert.equal(store.states.get(store.intents[0].operationId), 'pending');
        assert.equal(
          (await payload()).status,
          phase === 'failSettle' ? 'finalized' : 'draft',
        );
      },
    );
  await check(
    'cleanup_failure_preserves_pending_journal_and_original_business_state',
    async () => {
      await seed();
      const store = staged();
      store.failDiscard = true;
      store.onStage = () => setting('catalog', { overrides: {} });
      await assert.rejects(
        finalizer().finalize(await actor(), ids.a, { revision: 1 }, store),
        (error) =>
          error instanceof api.FinalizationReconciliationRequiredError &&
          error.phase === 'cleanup_pending',
      );
      assert.equal((await payload()).status, 'draft');
      assert.equal(store.objects.size, 1);
      assert.equal(store.states.get(store.intents[0].operationId), 'pending');
    },
  );
  await check(
    'concurrent_winner_discards_only_losing_export_and_does_not_change_final_order',
    async () => {
      await seed();
      const captured = await actor(),
        loser = staged(),
        winner = staged();
      loser.onStage = () =>
        finalizer(other).finalize(captured, ids.a, { revision: 1 }, winner);
      const result = await finalizer().finalize(
        captured,
        ids.a,
        { revision: 1 },
        loser,
      );
      assert.equal(result.finalized, false);
      assert.equal(winner.objects.size, 1);
      assert.equal(loser.objects.size, 0);
      assert.equal(result.exportKey, winner.intents[0].exportKey);
      assert.notEqual(result.exportKey, loser.intents[0].exportKey);
      assert.equal(
        loser.states.get(loser.intents[0].operationId),
        'concurrent_finalization',
      );
    },
  );
  return cases;
}
