// The expected effects below come from the native SQLite schema, including its
// creation order and recursive_triggers=OFF. They are not a PostgreSQL model.
// A future PG driver must provide the real DDL and a fresh fixture for each case.
import assert from 'node:assert/strict';

const tableOrders = {
  customers: 'id',
  partner_profiles: 'customer_id',
  portfolio_revision: 'id',
  portfolio_dirty: 'id',
  location_county_overrides: 'kind,id',
  customer_identity_aliases: 'alias_id,canonical_id,original_data',
  crm_directory_revision: 'id',
  activation_portfolio_memberships: 'warehouse_id,customer_id',
};
const integerColumns = new Set([
  'active',
  'revision',
  'data_revision',
  'scope_revision',
]);
const stamp0 = '2000-01-01T00:00:00.000Z';
const geoColumns = [
  'latitude',
  'longitude',
  'position_source',
  'position_accuracy',
  'position_provider',
  'position_metadata',
];

function integer(value) {
  const n =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string' && /^-?\d+$/.test(value)
        ? Number(value)
        : value;
  assert.ok(
    Number.isSafeInteger(n),
    `Unsafe fixture integer: ${String(value)}`,
  );
  return n;
}

function caseSuffix(value) {
  if (typeof value !== 'string')
    throw new TypeError('Case suffix must be text');
  return value;
}

function helpers(fixture) {
  const t = fixture.tables;
  for (const table of [
    ...Object.keys(tableOrders),
    'activation_customer_warehouse_rows',
  ]) {
    assert.equal(typeof t[table], 'string', `Missing table binding: ${table}`);
  }
  const p = (i) => (fixture.dialect === 'postgresql' ? `$${i}` : '?');
  const run = (sql, args = []) => fixture.run(sql, args);
  const rows = (sql, args = []) => fixture.rows(sql, args);
  const insert = (id, data, warehouse = 'warehouse-a', active = 1) =>
    run(
      `INSERT INTO ${t.customers}(id,warehouse_id,data,active) VALUES(${p(1)},${p(2)},${p(3)},${p(4)})`,
      [id, warehouse, data, active],
    );
  const update = (id, data) =>
    run(`UPDATE ${t.customers} SET data=${p(1)} WHERE id=${p(2)}`, [data, id]);
  const override = (id, county = 'Override', kind = 'customer') =>
    run(
      `INSERT INTO ${t.location_county_overrides}(kind,id,county) VALUES(${p(1)},${p(2)},${p(3)})`,
      [kind, id, county],
    );
  const alias = (id, canonical = 'canonical', raw = '{"original":true}') =>
    run(
      `INSERT INTO ${t.customer_identity_aliases}(alias_id,canonical_id,original_data) VALUES(${p(1)},${p(2)},${p(3)})`,
      [id, canonical, raw],
    );
  const profile = (id) =>
    run(
      `INSERT INTO ${t.partner_profiles}(customer_id,contact,phone,email,latitude,longitude,position_source,position_accuracy,position_provider,position_metadata,address_fingerprint,revision,updated_at,updated_by) VALUES(${Array.from({ length: 14 }, (_, i) => p(i + 1)).join(',')})`,
      [
        id,
        'Synthetic contact',
        'fixture-phone',
        'fixture@example.invalid',
        45,
        26,
        'gps',
        5,
        'fixture-provider',
        '{"precision":1.0}',
        'fingerprint',
        7,
        stamp0,
        'operator',
      ],
    );
  const state = async () => {
    const result = {};
    for (const [table, order] of Object.entries(tableOrders)) {
      result[table] = (
        await rows(`SELECT * FROM ${t[table]} ORDER BY ${order}`)
      ).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            integerColumns.has(key) && value !== null ? integer(value) : value,
          ]),
        ),
      );
    }
    result.activation_view = await rows(
      `SELECT customer_id,warehouse_id FROM ${t.activation_customer_warehouse_rows} ORDER BY warehouse_id,customer_id`,
    );
    assert.deepEqual(
      result.activation_portfolio_memberships,
      result.activation_view.map((x) => ({
        warehouse_id: x.warehouse_id,
        customer_id: x.customer_id,
      })),
      'Materialized activation memberships differ from the native view',
    );
    return result;
  };
  const mutate = async (action) => {
    const before = await state(),
      started = Date.now();
    const result = await action();
    const ended = Date.now(),
      after = await state();
    return { before, after, started, ended, result };
  };
  const delta = (m, data, crm) => {
    assert.equal(
      m.after.portfolio_revision[0].data_revision -
        m.before.portfolio_revision[0].data_revision,
      data,
      'portfolio data generation',
    );
    assert.equal(
      m.after.portfolio_revision[0].scope_revision,
      m.before.portfolio_revision[0].scope_revision,
      'Customer storage must not advance authority scope generation',
    );
    assert.equal(
      m.after.crm_directory_revision[0].revision -
        m.before.crm_directory_revision[0].revision,
      crm,
      'CRM directory generation',
    );
  };
  const memberships = (m, expected) =>
    assert.deepEqual(
      m.after.activation_portfolio_memberships,
      expected.map(([warehouse_id, customer_id]) => ({
        warehouse_id,
        customer_id,
      })),
    );
  const dirty = (m, expected) =>
    assert.deepEqual(
      m.after.portfolio_dirty,
      expected.map((id) => ({ id })),
    );
  const cleared = (m, resets = 1, id = 'customer') => {
    const old = m.before.partner_profiles.find((x) => x.customer_id === id),
      current = m.after.partner_profiles.find((x) => x.customer_id === id);
    assert.ok(old && current);
    const expected = {
      ...old,
      address_fingerprint: '',
      revision: old.revision + resets,
      updated_by: null,
      updated_at: current.updated_at,
    };
    for (const key of geoColumns) expected[key] = null;
    assert.deepEqual(current, expected);
    assert.match(
      current.updated_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    const time = Date.parse(current.updated_at);
    assert.ok(
      time >= m.started - 5 && time <= m.ended + 5,
      `Profile timestamp is outside the actual statement window: ${current.updated_at}`,
    );
    assert.notEqual(current.updated_at, stamp0);
  };
  const refused = async (action, pattern) => {
    const before = await state();
    let observed;
    await assert.rejects(fixture.atomic(action), (error) => {
      observed = {
        code: error.code ?? null,
        message: error.message,
        errcode: error.errcode ?? null,
      };
      return pattern.test(error.message);
    });
    assert.deepEqual(
      await state(),
      before,
      'Refused statement/transaction changed storage',
    );
    return { before, after: await state(), error: observed };
  };
  return {
    t,
    p,
    run,
    rows,
    insert,
    update,
    override,
    alias,
    profile,
    state,
    mutate,
    delta,
    memberships,
    dirty,
    cleared,
    refused,
  };
}

/** All cases use wholly synthetic rows. A failed case is emitted before throw. */
export async function runCustomerStorageContract(
  createFixture,
  { onCase = () => {} } = {},
) {
  const results = [],
    seen = new Set();
  const test = async (id, action, coverage = 'portable-storage') => {
    assert.ok(!seen.has(id), `Duplicate case ${id}`);
    seen.add(id);
    const fixture = await createFixture();
    let record;
    try {
      const observations = await action(helpers(fixture), fixture);
      record = { id, coverage, passed: true, observations };
    } catch (error) {
      record = {
        id,
        coverage,
        passed: false,
        error: { name: error.name, message: error.message },
      };
      results.push(record);
      await Promise.resolve(onCase(record));
      error.message = `${id}: ${error.message}`;
      throw error;
    } finally {
      await fixture.close();
    }
    results.push(record);
    await Promise.resolve(onCase(record));
  };

  await test('customer.storage.insert.preserves-raw-text', async (h) => {
    const raw =
      ' {"warehouseIds":["warehouse-b","warehouse-a","warehouse-b"],"name":"Synthetic", "n":1.0,"n":2} ';
    const m = await h.mutate(() => h.insert('customer', raw));
    h.delta(m, 1, 1);
    h.dirty(m, ['customer']);
    h.memberships(m, [
      ['warehouse-a', 'customer'],
      ['warehouse-b', 'customer'],
    ]);
    assert.deepEqual(m.after.customers, [
      { id: 'customer', warehouse_id: 'warehouse-a', data: raw, active: 1 },
    ]);
    assert.equal(m.result.changes, 1);
    return m;
  });
  await test('customer.storage.update.no-op-still-advances-generations', async (h) => {
    await h.insert('customer', '{}');
    await h.profile('customer');
    const m = await h.mutate(() =>
      h.run(`UPDATE ${h.t.customers} SET data=data WHERE id='customer'`),
    );
    h.delta(m, 1, 1);
    assert.deepEqual(m.after.partner_profiles, m.before.partner_profiles);
    assert.equal(m.result.changes, 1);
    return m;
  });
  await test('customer.storage.update.warehouse-refreshes-fallback-membership', async (h) => {
    await h.insert('customer', '{}');
    const m = await h.mutate(() =>
      h.run(
        `UPDATE ${h.t.customers} SET warehouse_id='warehouse-b' WHERE id='customer'`,
      ),
    );
    h.delta(m, 1, 1);
    h.memberships(m, [['warehouse-b', 'customer']]);
    return m;
  });
  for (const active of [0, 2, -1])
    await test(`customer.storage.active.${active}-has-no-memberships`, async (h) => {
      await h.insert('customer', '{}');
      const m = await h.mutate(() =>
        h.run(
          `UPDATE ${h.t.customers} SET active=${h.p(1)} WHERE id='customer'`,
          [active],
        ),
      );
      h.delta(m, 1, 1);
      h.memberships(m, []);
      assert.equal(m.after.customers[0].active, active);
      return m;
    });
  await test('customer.storage.update.id-retains-both-dirty-identities', async (h) => {
    await h.insert('old', '{}');
    const m = await h.mutate(() =>
      h.run(`UPDATE ${h.t.customers} SET id='new' WHERE id='old'`),
    );
    h.delta(m, 1, 1);
    h.dirty(m, ['new', 'old']);
    h.memberships(m, [['warehouse-a', 'new']]);
    return m;
  });
  await test('customer.storage.delete.removes-memberships-and-keeps-dirty-id', async (h) => {
    await h.insert('customer', '{}');
    const m = await h.mutate(() =>
      h.run(`DELETE FROM ${h.t.customers} WHERE id='customer'`),
    );
    h.delta(m, 1, 1);
    h.dirty(m, ['customer']);
    h.memberships(m, []);
    assert.deepEqual(m.after.customers, []);
    return m;
  });
  for (const [name, sql] of [
    [
      'missing-update',
      (h) => `UPDATE ${h.t.customers} SET data=data WHERE id='absent'`,
    ],
    ['missing-delete', (h) => `DELETE FROM ${h.t.customers} WHERE id='absent'`],
    [
      'stale-cas',
      (h) =>
        `UPDATE ${h.t.customers} SET data='{}' WHERE id='customer' AND data='stale'`,
    ],
  ])
    await test(`customer.storage.no-effect.${caseSuffix(name)}`, async (h) => {
      await h.insert('customer', '{"name":"Synthetic"}');
      const m = await h.mutate(() => h.run(sql(h)));
      h.delta(m, 0, 0);
      assert.equal(m.result.changes, 0);
      assert.deepEqual(m.after, m.before);
      return m;
    });
  await test('customer.storage.cas.current-no-op-still-counts', async (h) => {
    await h.insert('customer', '{}');
    const m = await h.mutate(() =>
      h.run(
        `UPDATE ${h.t.customers} SET data='{}' WHERE id='customer' AND data='{}' AND active=1 AND warehouse_id='warehouse-a'`,
      ),
    );
    h.delta(m, 1, 1);
    assert.equal(m.result.changes, 1);
    return m;
  });
  await test('customer.storage.update.each-matching-row-advances-generations', async (h) => {
    await h.insert('a', '{}');
    await h.insert('b', '{}');
    const m = await h.mutate(() =>
      h.run(`UPDATE ${h.t.customers} SET data=data`),
    );
    h.delta(m, 2, 2);
    assert.equal(m.result.changes, 2);
    h.dirty(m, ['a', 'b']);
    return m;
  });
  await test('customer.storage.insert-conflict-do-nothing-is-inert', async (h) => {
    await h.insert('customer', '{}');
    const m = await h.mutate(() =>
      h.run(
        `INSERT INTO ${h.t.customers}(id,warehouse_id,data,active) VALUES('customer','warehouse-b','[]',0) ON CONFLICT(id) DO NOTHING`,
      ),
    );
    h.delta(m, 0, 0);
    assert.equal(m.result.changes, 0);
    assert.deepEqual(m.after, m.before);
    return m;
  });
  await test('customer.storage.upsert.no-op-takes-update-path-once', async (h) => {
    await h.insert('customer', '{}');
    const m = await h.mutate(() =>
      h.run(
        `INSERT INTO ${h.t.customers}(id,warehouse_id,data,active) VALUES('customer','warehouse-a','{}',1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=excluded.active,warehouse_id=excluded.warehouse_id`,
      ),
    );
    h.delta(m, 1, 1);
    assert.equal(m.result.changes, 1);
    return m;
  });
  await test('customer.storage.transaction.rollback-reverts-all-derived-effects', async (h, f) => {
    await h.insert('customer', '{}');
    await h.profile('customer');
    const before = await h.state();
    await assert.rejects(
      f.atomic(async () => {
        await h.update('customer', '{"city":"New"}');
        await h.insert('second', '{}');
        throw new Error('synthetic rollback');
      }),
      /synthetic rollback/,
    );
    assert.deepEqual(await h.state(), before);
    return { before, after: await h.state() };
  });
  await test('customer.storage.transaction.nested-rollback-keeps-outer-write', async (h, f) => {
    await h.insert('customer', '{}');
    const m = await h.mutate(() =>
      f.atomic(async () => {
        await h.update('customer', '{"outer":true}');
        await assert.rejects(
          f.atomic(async () => {
            await h.insert('inner', '{}');
            throw new Error('inner rollback');
          }),
          /inner rollback/,
        );
        assert.equal(
          integer(
            (
              await h.rows(
                `SELECT COUNT(*) AS n FROM ${h.t.customers} WHERE id='inner'`,
              )
            )[0].n,
          ),
          0,
        );
      }),
    );
    h.delta(m, 1, 1);
    h.dirty(m, ['customer']);
    assert.equal(m.after.customers[0].data, '{"outer":true}');
    return m;
  });

  for (const [name, raw, expected, insertCount, updateCount] of [
    ['object-missing', '{ }', '{"county":"Override"}', 2, 1],
    [
      'object-different',
      '{"county":"Old","n":1.0}',
      '{"county":"Override","n":1.0}',
      2,
      1,
    ],
    [
      'object-matching',
      ' {"county":"Override"} ',
      ' {"county":"Override"} ',
      1,
      1,
    ],
    [
      'duplicate-first',
      '{"county":"Old","county":"Override"}',
      '{"county":"Override","county":"Override"}',
      2,
      1,
    ],
    [
      'duplicate-later',
      '{"county":"Override","county":"Old"}',
      '{"county":"Override","county":"Old"}',
      1,
      1,
    ],
    ['array', '[1, 2]', '[1,2]', 3, 2],
    ['number', '1.0', '1.0', 3, 2],
    ['null', 'null', 'null', 3, 2],
    ['string', '"Synthetic"', '"Synthetic"', 3, 2],
    ['boolean', 'true', 'true', 3, 2],
  ])
    await test(`customer.storage.county-repair.${name}`, async (h) => {
      await h.override('customer');
      const inserted = await h.mutate(() => h.insert('customer', raw));
      h.delta(inserted, insertCount, insertCount);
      assert.equal(inserted.after.customers[0].data, expected);
      const updated = await h.mutate(() =>
        h.run(`UPDATE ${h.t.customers} SET data=data WHERE id='customer'`),
      );
      h.delta(updated, updateCount, updateCount);
      assert.equal(updated.after.customers[0].data, expected);
      return { inserted, updated };
    });
  await test('customer.storage.county-repair.override-install-is-not-retroactive', async (h) => {
    await h.insert('customer', '{"county":"Old"}');
    const installed = await h.mutate(() => h.override('customer'));
    h.delta(installed, 0, 0);
    assert.equal(installed.after.customers[0].data, '{"county":"Old"}');
    const repaired = await h.mutate(() =>
      h.run(
        `UPDATE ${h.t.customers} SET warehouse_id=warehouse_id WHERE id='customer'`,
      ),
    );
    h.delta(repaired, 2, 2);
    assert.equal(repaired.after.customers[0].data, '{"county":"Override"}');
    return { installed, repaired };
  });
  await test('customer.storage.county-repair.crm-kind-does-not-repair-customer', async (h) => {
    await h.override('customer', 'Override', 'crm');
    const m = await h.mutate(() => h.insert('customer', '{}'));
    h.delta(m, 1, 1);
    assert.equal(m.after.customers[0].data, '{}');
    return m;
  });
  await test('customer.storage.county-repair.malformed-json-refuses-atomically', async (h) => {
    await h.override('customer');
    return h.refused(
      () => h.insert('customer', 'not json'),
      /malformed JSON|invalid.*json/i,
    );
  });
  await test('customer.storage.county-repair.profile-can-reset-twice-in-one-update', async (h) => {
    await h.override('customer');
    await h.insert('customer', '{"county":"Override"}');
    await h.profile('customer');
    const m = await h.mutate(() => h.update('customer', '{"county":"Other"}'));
    h.delta(m, 4, 2);
    h.cleared(m, 2);
    assert.equal(m.after.customers[0].data, '{"county":"Override"}');
    return m;
  });

  await test('customer.storage.alias.install-does-not-retroactively-deactivate', async (h) => {
    await h.insert('canonical', '{}');
    await h.insert('customer', '{}');
    const m = await h.mutate(() => h.alias('customer'));
    h.delta(m, 0, 0);
    assert.equal(m.after.customers.find((x) => x.id === 'customer').active, 1);
    h.memberships(m, [
      ['warehouse-a', 'canonical'],
      ['warehouse-a', 'customer'],
    ]);
    return m;
  });
  await test('customer.storage.alias.data-only-update-does-not-mention-active', async (h) => {
    await h.insert('canonical', '{}');
    await h.insert('customer', '{}');
    await h.alias('customer');
    const m = await h.mutate(() => h.update('customer', '{"n":1}'));
    h.delta(m, 1, 1);
    assert.equal(m.after.customers.find((x) => x.id === 'customer').active, 1);
    return m;
  });
  await test('customer.storage.alias.no-op-active-update-forces-inactive', async (h) => {
    await h.insert('canonical', '{}');
    await h.insert('customer', '{}');
    await h.alias('customer');
    const m = await h.mutate(() =>
      h.run(`UPDATE ${h.t.customers} SET active=active WHERE id='customer'`),
    );
    h.delta(m, 2, 2);
    assert.equal(m.after.customers.find((x) => x.id === 'customer').active, 0);
    h.memberships(m, [['warehouse-a', 'canonical']]);
    return m;
  });
  await test('customer.storage.alias.already-inactive-no-op-is-one-update', async (h) => {
    await h.insert('canonical', '{}');
    await h.insert('customer', '{}', 'warehouse-a', 0);
    await h.alias('customer');
    const m = await h.mutate(() =>
      h.run(`UPDATE ${h.t.customers} SET active=0 WHERE id='customer'`),
    );
    h.delta(m, 1, 1);
    return m;
  });
  await test('customer.storage.alias.upsert-conflict-invokes-active-repair', async (h) => {
    await h.insert('canonical', '{}');
    await h.insert('customer', '{}', 'warehouse-a', 0);
    await h.alias('customer');
    const m = await h.mutate(() =>
      h.run(
        `INSERT INTO ${h.t.customers}(id,warehouse_id,data,active) VALUES('customer','warehouse-a','{}',1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=excluded.active`,
      ),
    );
    h.delta(m, 2, 2);
    assert.equal(m.after.customers.find((x) => x.id === 'customer').active, 0);
    return m;
  });
  await test('customer.storage.alias.import-postcondition-rolls-back-forced-inactive', async (h, f) => {
    await h.insert('canonical', '{}');
    await h.insert('customer', '{}', 'warehouse-a', 0);
    await h.alias('customer');
    const before = await h.state();
    await assert.rejects(
      f.atomic(async () => {
        await h.run(
          `INSERT INTO ${h.t.customers}(id,warehouse_id,data,active) VALUES('customer','warehouse-a','{"imported":true}',1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=excluded.active`,
        );
        const stored = await h.rows(
          `SELECT active FROM ${h.t.customers} WHERE id='customer'`,
        );
        if (integer(stored[0].active) !== 1)
          throw new Error('synthetic import final snapshot changed');
      }),
      /synthetic import final snapshot changed/,
    );
    assert.deepEqual(await h.state(), before);
    return { before, after: await h.state() };
  });
  await test('customer.storage.alias.county-and-active-repairs-compose', async (h) => {
    await h.insert('canonical', '{}');
    await h.insert('customer', '{"county":"Override"}', 'warehouse-a', 0);
    await h.alias('customer');
    await h.override('customer');
    await h.profile('customer');
    const m = await h.mutate(() =>
      h.run(
        `UPDATE ${h.t.customers} SET data='{"county":"Other"}',active=1 WHERE id='customer'`,
      ),
    );
    h.delta(m, 5, 3);
    h.cleared(m, 2);
    const customer = m.after.customers.find((x) => x.id === 'customer');
    assert.equal(customer.active, 0);
    assert.equal(customer.data, '{"county":"Override"}');
    return m;
  });

  for (const [name, setup, mutation] of [
    [
      'profile-prevents-customer-delete',
      async (h) => h.profile('customer'),
      (h) => h.run(`DELETE FROM ${h.t.customers} WHERE id='customer'`),
    ],
    [
      'profile-prevents-customer-rename',
      async (h) => h.profile('customer'),
      (h) =>
        h.run(`UPDATE ${h.t.customers} SET id='renamed' WHERE id='customer'`),
    ],
    [
      'alias-prevents-alias-delete',
      async (h) => {
        await h.insert('canonical', '{}');
        await h.alias('customer');
      },
      (h) => h.run(`DELETE FROM ${h.t.customers} WHERE id='customer'`),
    ],
    [
      'alias-prevents-canonical-delete',
      async (h) => {
        await h.insert('canonical', '{}');
        await h.alias('customer');
      },
      (h) => h.run(`DELETE FROM ${h.t.customers} WHERE id='canonical'`),
    ],
    ['profile-requires-customer', async () => {}, (h) => h.profile('missing')],
    [
      'alias-requires-canonical',
      async () => {},
      (h) => h.alias('customer', 'missing'),
    ],
  ])
    await test(`customer.storage.foreign-key.${caseSuffix(name)}`, async (h) => {
      await h.insert('customer', '{}');
      await setup(h);
      return h.refused(() => mutation(h), /FOREIGN KEY|foreign key/i);
    });
  for (const [name, sql] of [
    [
      'data-not-null',
      (h) => `UPDATE ${h.t.customers} SET data=NULL WHERE id='customer'`,
    ],
    [
      'warehouse-not-null',
      (h) =>
        `UPDATE ${h.t.customers} SET warehouse_id=NULL WHERE id='customer'`,
    ],
    [
      'active-not-null',
      (h) => `UPDATE ${h.t.customers} SET active=NULL WHERE id='customer'`,
    ],
    [
      'id-not-null',
      (h) => `UPDATE ${h.t.customers} SET id=NULL WHERE id='customer'`,
    ],
  ])
    await test(`customer.storage.constraint.${caseSuffix(name)}`, async (h) => {
      await h.insert('customer', '{}');
      return h.refused(() => h.run(sql(h)), /NOT NULL|not-null|null value/i);
    });
  for (const [name, assignment] of [
    ['partial-coordinate', 'longitude=NULL'],
    ['latitude-range', 'latitude=91'],
    ['longitude-range', 'longitude=-181'],
    ['negative-accuracy', 'position_accuracy=-1'],
    ['unknown-source', "position_source='unknown'"],
    [
      'geocoding-without-provider',
      "position_source='geocoding',position_provider=NULL",
    ],
    [
      'geocoding-without-metadata',
      "position_source='geocoding',position_metadata=NULL",
    ],
  ])
    await test(`customer.storage.profile.constraint.${name}`, async (h) => {
      await h.insert('customer', '{}');
      await h.profile('customer');
      return h.refused(
        () =>
          h.run(
            `UPDATE ${h.t.partner_profiles} SET ${assignment} WHERE customer_id='customer'`,
          ),
        /CHECK|check constraint/i,
      );
    });
  await test('customer.storage.profile.insert-update-delete-only-advance-data-generation', async (h) => {
    await h.insert('customer', '{}');
    const inserted = await h.mutate(() => h.profile('customer'));
    h.delta(inserted, 1, 0);
    const updated = await h.mutate(() =>
      h.run(
        `UPDATE ${h.t.partner_profiles} SET contact=contact WHERE customer_id='customer'`,
      ),
    );
    h.delta(updated, 1, 0);
    const removed = await h.mutate(() =>
      h.run(`DELETE FROM ${h.t.partner_profiles} WHERE customer_id='customer'`),
    );
    h.delta(removed, 1, 0);
    h.dirty(removed, ['customer']);
    return { inserted, updated, removed };
  });

  // These expectations are native SQL IS/COALESCE semantics, not JavaScript
  // equality or JSON.parse object equality. The duplicate-first rule matters.
  const addressCases = [
    ['missing-null', '{}', '{"address":null}', false],
    ['null-empty', '{"address":null}', '{"address":""}', false],
    ['numeric-real-equal', '{"address":1}', '{"address":1.0}', false],
    ['number-boolean-equal', '{"address":1}', '{"address":true}', false],
    ['zero-negative-zero', '{"address":0}', '{"address":-0.0}', false],
    ['number-string-different', '{"address":1}', '{"address":"1"}', true],
    ['string-case-different', '{"address":"A"}', '{"address":"a"}', true],
    ['string-space-different', '{"address":"A"}', '{"address":" A"}', true],
    ['unicode-escape-equal', '{"address":"A"}', '{"address":"\\u0041"}', false],
    [
      'duplicate-later-change',
      '{"address":"first","address":"old"}',
      '{"address":"first","address":"new"}',
      false,
    ],
    [
      'duplicate-first-change',
      '{"address":"old","address":"same"}',
      '{"address":"new","address":"same"}',
      true,
    ],
    [
      'object-whitespace-equal',
      '{"address":{"n":1}}',
      '{"address": { "n" : 1 }}',
      false,
    ],
    [
      'object-number-lexeme-different',
      '{"address":{"n":1}}',
      '{"address":{"n":1.0}}',
      true,
    ],
    [
      'object-escaped-key-different',
      '{"address":{"A":1}}',
      '{"address":{"\\u0041":1}}',
      true,
    ],
    [
      'object-string-equal',
      '{"address":{"n":1}}',
      '{"address":"{\\"n\\":1}"}',
      false,
    ],
    ['array-string-equal', '{"address":[1,2]}', '{"address":"[1,2]"}', false],
    [
      'array-number-lexeme-different',
      '{"address":[1]}',
      '{"address":[1.0]}',
      true,
    ],
    [
      'large-integer-different',
      '{"address":9007199254740992}',
      '{"address":9007199254740993}',
      true,
    ],
    [
      'large-real-rounded-equal',
      '{"address":9007199254740992.0}',
      '{"address":9007199254740993.0}',
      false,
    ],
    [
      'int64-vs-rounded-real-different',
      '{"address":9223372036854775807}',
      '{"address":9223372036854775807.0}',
      true,
    ],
    ['city-different', '{"city":"A"}', '{"city":"B"}', true],
    ['county-different', '{"county":"A"}', '{"county":"B"}', true],
    ['nonaddress-change', '{"name":"A"}', '{"name":"B"}', false],
    ['whole-document-whitespace', '{"city":"A"}', ' { "city" : "A" } ', false],
    ['root-object-to-array-empty-addresses', '{}', '[]', false],
    ['malformed-same-always-resets', 'invalid json', 'invalid json', true],
    ['malformed-to-valid-resets', 'invalid json', '{}', true],
  ];
  for (const [name, old, next, reset] of addressCases)
    await test(`customer.storage.address.${name}`, async (h) => {
      await h.insert('customer', old);
      await h.profile('customer');
      const m = await h.mutate(() => h.update('customer', next));
      h.delta(m, reset ? 2 : 1, 1);
      if (reset) h.cleared(m);
      else
        assert.deepEqual(m.after.partner_profiles, m.before.partner_profiles);
      assert.equal(m.after.customers[0].data, next);
      return m;
    });
  await test('customer.storage.address.one-statement-has-one-reset-timestamp', async (h) => {
    for (const id of ['a', 'b']) {
      await h.insert(id, '{}');
      await h.profile(id);
    }
    const m = await h.mutate(() =>
      h.run(`UPDATE ${h.t.customers} SET data='{"city":"New"}'`),
    );
    h.delta(m, 4, 2);
    h.cleared(m, 1, 'a');
    h.cleared(m, 1, 'b');
    assert.equal(
      m.after.partner_profiles[0].updated_at,
      m.after.partner_profiles[1].updated_at,
    );
    return m;
  });

  const membershipCases = [
    ['absent-fallback', '{}', ['warehouse-a']],
    ['null-fallback', '{"warehouseIds":null}', ['warehouse-a']],
    ['empty-array', '{"warehouseIds":[]}', []],
    [
      'ordered-duplicates-deduplicate',
      '{"warehouseIds":["b","a","b"]}',
      ['a', 'b'],
    ],
    [
      'text-only',
      '{"warehouseIds":["0",0,true,false,null,{},[],"",1.0,"1"]}',
      ['', '0', '1'],
    ],
    ['quoted-json-string-not-array', '{"warehouseIds":"[\\"b\\"]"}', []],
    ['object-is-not-array', '{"warehouseIds":{"a":"b"}}', []],
    ['scalar-is-not-array', '{"warehouseIds":1}', []],
    [
      'duplicate-first-null',
      '{"warehouseIds":null,"warehouseIds":["b"]}',
      ['warehouse-a'],
    ],
    [
      'duplicate-first-array',
      '{"warehouseIds":["b"],"warehouseIds":["a"]}',
      ['b'],
    ],
    [
      'duplicate-first-wrong-type',
      '{"warehouseIds":"b","warehouseIds":["a"]}',
      [],
    ],
    ['escaped-member-name', '{"warehouse\\u0049ds":["b"]}', ['b']],
    ['unicode-text', '{"warehouseIds":["ș","A","é"]}', ['A', 'é', 'ș']],
    ['root-array', '[]', []],
    ['root-null', 'null', []],
    ['malformed-json', 'not json', []],
  ];
  for (const [name, raw, expected] of membershipCases)
    await test(`customer.storage.membership.${caseSuffix(name)}`, async (h) => {
      const m = await h.mutate(() => h.insert('customer', raw));
      h.delta(m, 1, 1);
      h.memberships(
        m,
        expected.map((w) => [w, 'customer']),
      );
      assert.equal(m.after.customers[0].data, raw);
      return m;
    });

  // Explicit native edges: they are eligibility inputs for a future migration,
  // not permission to approximate values that PostgreSQL TEXT cannot represent.
  await test(
    'customer.storage.native.consumer-index-json1-predicate',
    async (h) => {
      const inputs = [
        ['a-string', '{"cui":"G"}', 1],
        ['b-digit', '{"cui":"G1"}', 1],
        ['c-non-ascii-digit', '{"cui":"G٠"}', 1],
        ['d-object', '{"cui":{"g":true}}', 1],
        ['e-object-digit', '{"cui":{"g":0}}', 1],
        ['f-array', '{"cui":["G"]}', 1],
        ['g-first-duplicate', '{"cui":"G","cui":"123"}', 1],
        ['h-later-duplicate', '{"cui":"123","cui":"G"}', 1],
        ['i-number', '{"cui":12.0}', 1],
        ['j-null', '{"cui":null}', 1],
        ['k-absent', '{}', 1],
        ['l-escaped-string', '{"cui":"\\u0047"}', 1],
        ['m-escaped-object-key', '{"cui":{"\\u0067":true}}', 1],
        ['n-invalid-json', 'not json', 1],
        ['o-inactive', '{"cui":"g"}', 0],
        ['p-json5', '{cui:"G",}', 1],
      ];
      for (const [id, raw, active] of inputs)
        await h.insert(id, raw, 'warehouse-a', active);
      const predicate =
        "json_valid(data) AND CAST(json_extract(data,'$.cui') AS TEXT) GLOB '*[gG]*' AND CAST(json_extract(data,'$.cui') AS TEXT) NOT GLOB '*[0-9]*'";
      const query = (indexed) =>
        `SELECT id FROM ${h.t.customers}${indexed ? ' INDEXED BY idx_customers_consumer_candidates' : ''} WHERE ${predicate} ORDER BY id`;
      const expected = [
        'a-string',
        'c-non-ascii-digit',
        'd-object',
        'f-array',
        'g-first-duplicate',
        'l-escaped-string',
        'o-inactive',
      ];
      const automatic = await h.rows(query(false)),
        indexed = await h.rows(query(true));
      assert.deepEqual(
        automatic.map((x) => x.id),
        expected,
      );
      assert.deepEqual(indexed, automatic);
      const plan = await h.rows('EXPLAIN QUERY PLAN ' + query(true));
      assert.ok(
        plan.some((x) =>
          x.detail.includes('idx_customers_consumer_candidates'),
        ),
      );
      const m = await h.mutate(() => h.update('a-string', '{"cui":"G1"}'));
      h.delta(m, 1, 1);
      const after = await h.rows(query(true));
      assert.deepEqual(
        after.map((x) => x.id),
        expected.slice(1),
      );
      return { automatic, indexed, plan, after, mutation: m };
    },
    'native-sql-index-oracle',
  );
  await test(
    'customer.storage.native.alias-null-primary-key-is-allowed',
    async (h) => {
      await h.insert('canonical', '{}');
      const m = await h.mutate(async () => {
        await h.alias(null);
        await h.alias(null);
      });
      h.delta(m, 0, 0);
      assert.equal(m.after.customer_identity_aliases.length, 2);
      assert.ok(
        m.after.customer_identity_aliases.every((x) => x.alias_id === null),
      );
      return m;
    },
    'native-eligibility-edge',
  );
  await test(
    'customer.storage.native.replace-does-not-fire-delete-trigger',
    async (h) => {
      await h.insert('canonical', '{}');
      await h.insert('customer', '{}', 'warehouse-a', 0);
      await h.alias('customer');
      await h.profile('customer');
      const m = await h.mutate(() =>
        h.run(
          `INSERT OR REPLACE INTO ${h.t.customers}(id,warehouse_id,data,active) VALUES('customer','warehouse-b','{}',1)`,
        ),
      );
      h.delta(m, 1, 1);
      assert.deepEqual(m.after.partner_profiles, m.before.partner_profiles);
      assert.equal(
        m.after.customers.find((x) => x.id === 'customer').active,
        1,
      );
      h.memberships(m, [
        ['warehouse-a', 'canonical'],
        ['warehouse-b', 'customer'],
      ]);
      return m;
    },
    'native-statement-edge',
  );
  await test(
    'customer.storage.native.json5-is-not-strict-json',
    async (h) => {
      await h.insert('customer', '{city:"A",}');
      await h.profile('customer');
      const m = await h.mutate(() => h.update('customer', '{city:"A",}'));
      h.delta(m, 2, 1);
      h.cleared(m);
      h.memberships(m, []);
      return m;
    },
    'native-eligibility-edge',
  );
  await test(
    'customer.storage.native.nul-membership-needs-text-eligibility',
    async (h) => {
      const raw = '{"warehouseIds":["a\\u0000b"]}';
      const m = await h.mutate(() => h.insert('customer', raw));
      h.delta(m, 1, 1);
      h.memberships(m, [['a\0b', 'customer']]);
      assert.equal(m.after.customers[0].data, raw);
      return m;
    },
    'native-eligibility-edge',
  );
  await test(
    'customer.storage.native.excess-json-depth-needs-eligibility',
    async (h) => {
      const raw = '['.repeat(1001) + '0' + ']'.repeat(1001);
      const m = await h.mutate(() => h.insert('customer', raw));
      h.delta(m, 1, 1);
      h.memberships(m, []);
      assert.equal(m.after.customers[0].data, raw);
      return m;
    },
    'native-eligibility-edge',
  );
  return {
    passed: results.every((x) => x.passed),
    caseCount: results.length,
    cases: results,
  };
}
