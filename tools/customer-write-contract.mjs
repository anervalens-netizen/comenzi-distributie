// Synthetic, reusable manager-edit/client-import contract. The fixture owns the
// real storage schema, authority tables, dedicated connections and cleanup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const caseSuffix = (value) => {
  if (typeof value !== 'string')
    throw new TypeError('Case suffix must be text');
  return value;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export async function runCustomerWriteContract(api, fixture) {
  const { database, other, applicationSchema } = fixture;
  const a = api.sqlIdentifier(applicationSchema),
    q = api.sqlQuery,
    n = api.safeSqlInteger;
  let now = 1000;
  const warehouses = [
    { id: 'warehouse-a', name: 'Synthetic A' },
    { id: 'warehouse-b', name: 'Synthetic B' },
    { id: 'warehouse-c', name: 'Synthetic C' },
    { id: 'warehouse-d', name: 'Synthetic D' },
  ];
  const global = { userId: 'manager', tokenHash: 'token-global' };
  const regional = { userId: 'regional', tokenHash: 'token-regional' };
  const agent = { userId: 'agent-a', tokenHash: 'token-agent' };
  const actor = (identity = global) =>
    new api.AuthorityRepository(
      database,
      applicationSchema,
      () => now,
    ).captureRequestActor(identity);
  const repo = (db = database, clock = () => now) =>
    new api.CustomerWriteRepository(db, applicationSchema, warehouses, clock);
  const read = (sql, values = [], pg = sql, db = database) =>
    db.read((tx) => tx.query(q('read', sql, pg), values));
  const write = (sql, values = [], pg = sql, db = database) =>
    db.write((tx) => tx.query(q('write', sql, pg), values));
  const normal = (value) =>
    typeof value === 'bigint'
      ? n(value)
      : Array.isArray(value)
        ? value.map(normal)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, normal(item)]),
            )
          : value;
  const tables = [
    ['users', 'id'],
    ['sessions', 'token_hash'],
    ['manager_agents', 'manager_id,agent_id'],
    ['customers', 'id'],
    ['partner_profiles', 'customer_id'],
    ['portfolio_revision', 'id'],
    ['portfolio_dirty', 'id'],
    ['location_county_overrides', 'kind,id'],
    ['customer_identity_aliases', 'alias_id'],
    ['crm_directory_revision', 'id'],
    ['activation_portfolio_memberships', 'warehouse_id,customer_id'],
  ];
  const snapshot = () =>
    database.read(async (tx) => {
      const result = {};
      for (const [table, sort] of tables)
        result[table] = normal(
          (
            await tx.query(
              q(
                'read',
                `SELECT * FROM ${a}.${table} ORDER BY ${sort}`,
                `SELECT * FROM ${a}.${table} ORDER BY ${sort}`,
              ),
            )
          ).rows,
        );
      return result;
    });
  const client = (id = 'customer', extra = {}) => ({
    id,
    warehouseId: 'warehouse-a',
    name: 'Synthetic company',
    cui: 'RO100',
    city: 'City',
    county: 'County',
    address: 'Street 1',
    route: 'Route',
    ...extra,
  });
  const put = (
    value = client(),
    warehouse = value.warehouseId,
    active = 1,
    raw = JSON.stringify(value),
  ) =>
    write(
      `INSERT INTO ${a}.customers(id,warehouse_id,data,active) VALUES(?,?,?,?)`,
      [value.id, warehouse, raw, active],
      `INSERT INTO ${a}.customers(id,warehouse_id,data,active) VALUES($1,$2,$3,$4)`,
    );
  const record = async (id = 'customer') =>
    normal(
      (
        await read(
          `SELECT * FROM ${a}.customers WHERE id=?`,
          [id],
          `SELECT * FROM ${a}.customers WHERE id=$1`,
        )
      ).rows[0],
    );
  const editBody = async (extra = {}, id = 'customer') => ({
    agentIds: ['agent-a'],
    version: sha((await record(id)).data),
    name: 'Edited synthetic',
    cui: 'RO100',
    city: 'City',
    county: 'County',
    address: 'Street 1',
    route: 'Route',
    ...extra,
  });
  const importBody = (clients = [client()], extra = {}) => ({
    warehouseId: 'warehouse-a',
    clients,
    ...extra,
  });
  const profile = () =>
    write(
      `INSERT INTO ${a}.partner_profiles(customer_id,latitude,longitude,position_source,position_accuracy,address_fingerprint,revision,updated_at,updated_by) VALUES('customer',45,26,'gps',5,'original',7,'2000-01-01T00:00:00.000Z','regional')`,
    );
  const reset = async () => {
    now = 1000;
    await database.write(async (tx) => {
      for (const table of [
        'customer_identity_aliases',
        'partner_profiles',
        'customers',
        'portfolio_dirty',
        'location_county_overrides',
        'sessions',
        'manager_agents',
        'login_attempts',
        'users',
        'settings',
      ]) {
        await tx.query(
          q('write', `DELETE FROM ${a}.${table}`, `DELETE FROM ${a}.${table}`),
        );
      }
      for (const [id, role, scope, warehouse, active] of [
        ['manager', 'manager', 'global', null, 1],
        ['regional', 'manager', 'assigned', null, 1],
        ['other-manager', 'manager', 'assigned', null, 1],
        ['agent-a', 'agent', 'assigned', 'warehouse-a', 1],
        ['agent-b', 'agent', 'assigned', 'warehouse-b', 1],
        ['agent-c', 'agent', 'assigned', 'warehouse-c', 1],
        ['agent-d', 'agent', 'assigned', 'warehouse-d', 0],
        ['agent-no-warehouse', 'agent', 'assigned', null, 1],
      ]) {
        await tx.query(
          q(
            'write',
            `INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,?,?,?,?,?,?,0,?,1)`,
            `INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,1)`,
          ),
          [
            id,
            id,
            'Synthetic ' + id,
            role,
            scope,
            warehouse,
            warehouse,
            role === 'agent' ? id : '',
            'opaque-fixture-' + id,
            active,
          ],
        );
      }
      for (const [token, id] of [
        ['token-global', 'manager'],
        ['token-regional', 'regional'],
        ['token-agent', 'agent-a'],
      ]) {
        await tx.query(
          q(
            'write',
            `INSERT INTO ${a}.sessions VALUES(?,?,2000)`,
            `INSERT INTO ${a}.sessions VALUES($1,$2,2000)`,
          ),
          [token, id],
        );
      }
      for (const [manager, agent] of [
        ['regional', 'agent-a'],
        ['regional', 'agent-b'],
        ['regional', 'agent-d'],
        ['other-manager', 'agent-c'],
      ]) {
        await tx.query(
          q(
            'write',
            `INSERT INTO ${a}.manager_agents VALUES(?,?)`,
            `INSERT INTO ${a}.manager_agents VALUES($1,$2)`,
          ),
          [manager, agent],
        );
      }
      await tx.query(
        q(
          'write',
          `UPDATE ${a}.portfolio_revision SET data_revision=100,scope_revision=200 WHERE id=1`,
          `UPDATE ${a}.portfolio_revision SET data_revision=100,scope_revision=200 WHERE id=1`,
        ),
      );
      await tx.query(
        q(
          'write',
          `UPDATE ${a}.crm_directory_revision SET revision=300 WHERE id=1`,
          `UPDATE ${a}.crm_directory_revision SET revision=300 WHERE id=1`,
        ),
      );
    });
  };
  const status = (expected) => (error) => error && error.status === expected;
  const cases = [],
    observations = [];
  const test = async (id, action) => {
    await reset();
    try {
      await action();
      cases.push(id);
    } catch (error) {
      error.message = `${id}: ${error.message}`;
      error.customerWriterEvidence = {
        caseIds: [...cases],
        failedCase: id,
        observations,
      };
      throw error;
    }
  };
  const unchanged = async (action) => {
    const before = await snapshot();
    await action();
    assert.deepEqual(await snapshot(), before);
  };
  const delegated = (queryHook, afterWrite) => ({
    read: (action) => database.read(action),
    close: async () => {},
    write: (action, authority) =>
      database.write(async (tx) => {
        const proxy = queryHook
          ? {
              dialect: tx.dialect,
              query: (query, values) => queryHook(tx, query, values),
            }
          : tx;
        const result = await action(proxy);
        if (afterWrite) await afterWrite();
        return result;
      }, authority),
  });
  const canonical = (state, before, bounds) => {
    const result = structuredClone(state);
    for (const row of result.partner_profiles) {
      const old = before.partner_profiles.find(
        (x) => x.customer_id === row.customer_id,
      );
      if (row.updated_at !== old?.updated_at) {
        assert.match(
          row.updated_at,
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
        const instant = Date.parse(row.updated_at);
        assert.ok(
          instant >= bounds.started - 5 && instant <= bounds.ended + 5,
          'Profile timestamp outside observed write window',
        );
        row.updated_at = '<validated statement timestamp>';
      }
    }
    return result;
  };
  // The legacy oracle is the extracted original route branch/import function,
  // executed against an exact copy of this synthetic SQLite database. It is
  // deliberately separate from the new implementation and its transaction.
  const oracle = async (kind, body, id = 'customer', identity = global) => {
    if (!fixture.legacyOracle)
      throw new Error(
        'Customer writer qualification requires the original native oracle',
      );
    const before = await snapshot();
    const legacy = await fixture.legacyOracle(
      kind,
      body,
      id,
      identity.userId,
      tables,
    );
    const started = Date.now();
    let value, error;
    try {
      const captured = await actor(identity);
      value =
        kind === 'edit'
          ? await repo().edit(captured, id, body)
          : await repo().importClients(captured, body);
    } catch (failure) {
      error = { status: failure.status ?? null, message: failure.message };
    }
    const ended = Date.now(),
      after = await snapshot();
    observations.push({
      kind,
      legacy,
      actual: { value, error, state: after, bounds: { started, ended } },
    });
    assert.deepEqual(error, legacy.error);
    if (!error) {
      const actual =
        kind === 'edit'
          ? { client: value.client }
          : 'preview' in value
            ? value
            : { count: value.count };
      assert.deepEqual(actual, legacy.value);
    }
    assert.deepEqual(
      canonical(after, before, { started, ended }),
      canonical(legacy.state, before, legacy.bounds),
    );
    return value;
  };

  await test('customer.write.edit.global-fields-and-extra-metadata-match-original', async () => {
    await put(
      client('customer', {
        historyCatalog: { kind: 'fixture' },
        warehouseIds: ['warehouse-a'],
      }),
    );
    const value = await oracle(
      'edit',
      await editBody({ name: '  Trimmed  ', address: ' New address ' }),
    );
    assert.equal(value.client.name, 'Trimmed');
    assert.equal(value.client.historyCatalog.kind, 'fixture');
    assert.equal(value.users.find((x) => x.id === 'agent-a').clientCount, 1);
  });
  await test('customer.write.edit.assigned-manager-preserves-hidden-portfolios', async () => {
    await put(
      client('customer', { warehouseIds: ['warehouse-a', 'warehouse-c'] }),
    );
    const value = await oracle(
      'edit',
      await editBody({ agentIds: ['agent-b'] }),
      'customer',
      regional,
    );
    assert.deepEqual(value.client.warehouseIds, ['warehouse-c', 'warehouse-b']);
    assert.equal(value.client.warehouseId, 'warehouse-c');
  });
  await test('customer.write.edit.global-single-agent-preserves-other-portfolios', async () => {
    await put(
      client('customer', { warehouseIds: ['warehouse-a', 'warehouse-c'] }),
    );
    const value = await oracle(
      'edit',
      await editBody({ agentIds: undefined, agentId: 'agent-b' }),
    );
    assert.deepEqual(value.client.warehouseIds, ['warehouse-c', 'warehouse-b']);
  });
  await test('customer.write.edit.global-agent-array-replaces-complete-set', async () => {
    await put(
      client('customer', { warehouseIds: ['warehouse-a', 'warehouse-c'] }),
    );
    const value = await oracle(
      'edit',
      await editBody({ agentIds: ['agent-b', 'agent-b', 'agent-a'] }),
    );
    assert.deepEqual(value.client.warehouseIds, ['warehouse-b', 'warehouse-a']);
  });
  await test('customer.write.edit.inactive-existing-warehouse-is-retained', async () => {
    await put(
      client('customer', { warehouseIds: ['warehouse-a', 'warehouse-d'] }),
    );
    const value = await oracle(
      'edit',
      await editBody({ agentIds: ['agent-d'] }),
      'customer',
      regional,
    );
    assert.deepEqual(value.client.warehouseIds, ['warehouse-d']);
  });
  for (const [name, extra, identity] of [
    ['new-inactive-agent', { agentIds: ['agent-d'] }, global],
    ['agent-without-warehouse', { agentIds: ['agent-no-warehouse'] }, global],
    ['unauthorized-agent', { agentIds: ['agent-c'] }, regional],
    ['source-not-owned', { sourceWarehouseId: 'warehouse-b' }, global],
    ['wrong-version', { version: 'stale' }, global],
    ['empty-agents', { agentIds: [] }, global],
    ['too-many-agents', { agentIds: Array(51).fill('agent-a') }, global],
    ['nonarray-agents', { agentIds: 'agent-a' }, global],
    ['nontext-agent', { agentIds: [42] }, global],
    [
      'unauthorized-id-precedes-other-input-error',
      { agentIds: ['agent-c', 42] },
      regional,
    ],
    ['missing-field', { route: undefined }, global],
    ['oversized-field', { name: 'x'.repeat(201) }, global],
    ['empty-name', { name: '  ' }, global],
  ])
    await test(
      'customer.write.edit.original-rejection.' + caseSuffix(name),
      async () => {
        await put();
        await oracle('edit', await editBody(extra), 'customer', identity);
      },
    );
  await test('customer.write.edit.profile-reset-effects-match-original', async () => {
    await put();
    await profile();
    await oracle('edit', await editBody({ address: 'Different' }));
    const state = await snapshot();
    assert.equal(state.partner_profiles[0].revision, 8);
    assert.equal(state.portfolio_revision[0].data_revision, 104);
    assert.equal(state.crm_directory_revision[0].revision, 302);
  });
  await test('customer.write.edit.county-repair-keeps-original-response-version', async () => {
    await put();
    await write(
      `INSERT INTO ${a}.location_county_overrides VALUES('customer','customer','Repaired')`,
    );
    await profile();
    const value = await oracle('edit', await editBody({ county: 'Prepared' }));
    assert.equal(value.client.county, 'Prepared');
    assert.equal(JSON.parse((await record()).data).county, 'Repaired');
    assert.notEqual(value.client.version, sha((await record()).data));
  });
  await test('customer.write.edit.no-uuid-restriction-on-stored-id', async () => {
    const id = 'arbitrary/Customer-Ș';
    await put(client(id));
    const value = await oracle('edit', await editBody({}, id), id);
    assert.equal(value.client.id, id);
  });
  await test('customer.write.edit.inactive-client-is-not-editable', async () => {
    await put(client(), 'warehouse-a', 0);
    await oracle('edit', { version: 'irrelevant' });
  });
  await test('customer.write.edit.missing-client-refuses-without-write', async () => {
    await oracle('edit', {});
  });

  await test('customer.write.import.empty-portfolio-keeps-simple-import', async () => {
    const value = await oracle('import', importBody());
    assert.equal(value.count, 1);
    assert.match((await snapshot()).customers[0].id, /^imp-[0-9a-f]{32}$/);
    assert.equal(value.users.find((x) => x.id === 'agent-a').clientCount, 1);
  });
  await test('customer.write.import.preview-is-exact-and-side-effect-free', async () => {
    await put();
    const before = await snapshot();
    const value = await oracle(
      'import',
      importBody([client()], { preview: true }),
    );
    assert.equal(value.preview.unchanged.length, 1);
    assert.deepEqual(await snapshot(), before);
  });
  await test('customer.write.import.normalized-duplicate-input-first-wins', async () => {
    const one = client('ignored', { city: 'Cíty', address: 'Road  1' });
    const two = client('ignored-again', {
      name: 'Later duplicate',
      cui: '100',
      city: 'CITY',
      county: 'COUNTY',
      address: 'ROAD 1',
    });
    const value = await oracle('import', importBody([one, two]));
    assert.equal(value.count, 1);
    assert.equal(
      JSON.parse((await snapshot()).customers[0].data).name,
      one.name,
    );
  });
  await test('customer.write.import.address-punctuation-keeps-distinct-points', async () => {
    const value = await oracle(
      'import',
      importBody([
        client('one', { address: '1-3' }),
        client('two', { address: '13' }),
      ]),
    );
    assert.equal(value.count, 2);
  });
  await test('customer.write.import.nonempty-requires-preview-snapshot', async () => {
    await put();
    await oracle('import', importBody());
  });
  await test('customer.write.import.removals-require-exact-confirmation', async () => {
    await put();
    const body = importBody([client('other', { cui: '200' })]);
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    await oracle('import', { ...body, snapshot: preview.snapshot });
  });
  await test('customer.write.import.confirmed-removals-are-atomic', async () => {
    await put();
    const body = importBody([client('other', { cui: '200' })]);
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    await oracle('import', {
      ...body,
      snapshot: preview.snapshot,
      confirmRemovals: preview.snapshot,
    });
    assert.equal((await record()).active, 0);
    assert.equal((await snapshot()).customers.length, 2);
  });
  await test('customer.write.import.exact-match-keeps-original-address-and-optional-metadata', async () => {
    await put(
      client('customer', {
        city: '  Cíty ',
        county: 'COUNTY',
        address: 'Street  1',
        route: 'Preserve',
        historyCatalog: { kind: 'fixture' },
      }),
    );
    await profile();
    const body = importBody([
      client('irrelevant', {
        name: 'Changed',
        city: 'CITY',
        county: 'County',
        address: 'STREET 1',
        route: '',
      }),
    ]);
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    await oracle('import', { ...body, snapshot: preview.snapshot });
    const current = JSON.parse((await record()).data);
    assert.equal(current.city, '  Cíty ');
    assert.equal(current.address, 'Street  1');
    assert.equal(current.route, 'Preserve');
    assert.equal((await snapshot()).partner_profiles[0].revision, 7);
  });
  await test('customer.write.import.inactive-exact-identity-reactivates-same-id', async () => {
    await put(client(), 'warehouse-a', 0);
    const body = importBody();
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    await oracle('import', { ...body, snapshot: preview.snapshot });
    assert.equal((await record()).active, 1);
  });
  await test('customer.write.import.duplicate-stored-identity-is-ambiguous', async () => {
    await put();
    await put(client('duplicate'));
    await oracle('import', importBody([client()], { preview: true }));
    await oracle('import', importBody());
  });
  await test('customer.write.import.omitted-active-point-does-not-become-new-address', async () => {
    await put();
    const body = importBody([client('new', { address: 'Another' })]);
    const preview = await oracle('import', { ...body, preview: true });
    assert.equal(preview.preview.ambiguous.length, 1);
    await oracle('import', body);
  });
  await test('customer.write.import.explicit-old-point-permits-new-point', async () => {
    await put();
    const body = importBody([client(), client('new', { address: 'Another' })]);
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    await oracle('import', { ...body, snapshot: preview.snapshot });
    assert.equal((await snapshot()).customers.length, 2);
  });
  await test('customer.write.import.missing-address-with-history-is-ambiguous', async () => {
    await put(client(), 'warehouse-a', 0);
    await oracle(
      'import',
      importBody([client('new', { address: '' })], { preview: true }),
    );
  });
  for (const [name, active, incoming] of [
    ['active-shared', 1, client()],
    ['retained-inactive-shared', 0, client()],
    ['unretained-inactive-shared', 0, client('new', { cui: '200' })],
  ])
    await test(
      'customer.write.import.shared-rule.' + caseSuffix(name),
      async () => {
        await put(
          client('customer', { warehouseIds: ['warehouse-a', 'warehouse-b'] }),
          'warehouse-a',
          active,
        );
        await oracle('import', importBody([incoming], { preview: true }));
      },
    );
  await test('customer.write.import.moved-deterministic-id-is-visible-and-blocked', async () => {
    const body = importBody();
    const first = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    const id = first.preview.added[0].id;
    await put(client(id, { warehouseId: 'warehouse-b' }), 'warehouse-b');
    const result = await oracle('import', { ...body, preview: true });
    assert.ok(result.preview.blocked.length);
    await oracle('import', body);
  });
  await test('customer.write.import.raw-format-change-invalidates-preview', async () => {
    await put();
    const body = importBody();
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    const raw = (await record()).data;
    await write(
      `UPDATE ${a}.customers SET data=? WHERE id='customer'`,
      [' ' + raw + ' '],
      `UPDATE ${a}.customers SET data=$1 WHERE id='customer'`,
    );
    await oracle('import', { ...body, snapshot: preview.snapshot });
  });
  await test('customer.write.import.alias-postcondition-refuses-whole-batch', async () => {
    await put(client('canonical', { cui: '200' }));
    await put(client(), 'warehouse-a', 0);
    await write(
      `INSERT INTO ${a}.customer_identity_aliases VALUES('customer','canonical','{}')`,
    );
    const body = importBody([client(), client('canonical', { cui: '200' })]);
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    await oracle('import', { ...body, snapshot: preview.snapshot });
    assert.equal((await record()).active, 0);
  });
  await test('customer.write.import.county-postcondition-refuses-whole-batch', async () => {
    const body = importBody();
    const { preview } = await repo().importClients(await actor(), {
      ...body,
      preview: true,
    });
    const id = preview.added[0].id;
    await write(
      `INSERT INTO ${a}.location_county_overrides VALUES('customer',?,'Repaired')`,
      [id],
      `INSERT INTO ${a}.location_county_overrides VALUES('customer',$1,'Repaired')`,
    );
    await oracle('import', body);
    assert.equal((await snapshot()).customers.length, 0);
  });
  for (const [name, body] of [
    ['empty-input', importBody([])],
    ['too-many', importBody(Array(3001).fill(client()))],
    ['invalid-row', importBody([null])],
    ['missing-name', importBody([client('x', { name: '' })])],
    ['invalid-cui', importBody([client('x', { cui: '---' })])],
    ['invalid-warehouse', importBody([client()], { warehouseId: 'missing' })],
  ])
    await test(
      'customer.write.import.original-validation.' + caseSuffix(name),
      async () => {
        await oracle('import', body);
      },
    );
  await test('customer.write.import.long-text-is-trimmed-as-before', async () => {
    await oracle(
      'import',
      importBody([
        client('x', { name: '  ' + 'n'.repeat(220), route: 'r'.repeat(40) }),
      ]),
    );
    const value = JSON.parse((await snapshot()).customers[0].data);
    assert.equal(value.name.length, 200);
    assert.equal(value.route.length, 30);
  });
  await test('customer.write.import.assigned-warehouse-denial-matches-original', async () => {
    await oracle(
      'import',
      importBody([client()], { warehouseId: 'warehouse-c' }),
      'customer',
      regional,
    );
  });

  for (const kind of ['edit', 'import'])
    await test(`customer.write.authority.${kind}-requires-manager`, async () => {
      await put();
      const captured = await actor(agent),
        body = await editBody();
      await unchanged(() =>
        assert.rejects(
          kind === 'edit'
            ? repo().edit(captured, 'customer', body)
            : repo().importClients(captured, importBody([], { preview: true })),
          status(403),
        ),
      );
    });
  for (const [name, sql] of [
    ['logout', `DELETE FROM ${a}.sessions WHERE token_hash='token-regional'`],
    ['active-revoked', `UPDATE ${a}.users SET active=0 WHERE id='regional'`],
    ['role-changed', `UPDATE ${a}.users SET role='agent' WHERE id='regional'`],
    [
      'profile-revision',
      `UPDATE ${a}.users SET profile_revision=profile_revision+1 WHERE id='regional'`,
    ],
    [
      'portfolio-scope-revision',
      `UPDATE ${a}.portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1`,
    ],
    [
      'assignment-revoked',
      `DELETE FROM ${a}.manager_agents WHERE manager_id='regional' AND agent_id='agent-a'`,
    ],
    [
      'password-reset',
      `UPDATE ${a}.users SET must_change_password=1,profile_revision=profile_revision+1 WHERE id='regional'`,
    ],
  ])
    await test(
      'customer.write.authority.revoked-before-lock.' + String(name),
      async () => {
        await put();
        const captured = await actor(regional),
          body = await editBody();
        await write(sql);
        await unchanged(() =>
          assert.rejects(repo().edit(captured, 'customer', body), status(409)),
        );
        await unchanged(() =>
          assert.rejects(
            repo().importClients(captured, importBody([], { preview: true })),
            status(409),
          ),
        );
      },
    );
  await test('customer.write.authority.expiry-after-mutation-rolls-back-all-effects', async () => {
    await put();
    await profile();
    const captured = await actor(regional),
      body = await editBody({ address: 'Different' });
    const db = delegated(null, async () => {
      now = 2500;
    });
    await unchanged(() =>
      assert.rejects(repo(db).edit(captured, 'customer', body), status(409)),
    );
  });
  await test('customer.write.response-query-failure-rolls-back-customer-and-triggers', async () => {
    await put();
    await profile();
    const captured = await actor(),
      body = await editBody({ address: 'Different' });
    const db = delegated(async (tx, query, values) => {
      if (query.kind === 'read' && query.sqlite.includes('SELECT u.* FROM'))
        throw new Error('synthetic response read failure');
      return tx.query(query, values);
    });
    await unchanged(() =>
      assert.rejects(
        repo(db).edit(captured, 'customer', body),
        /synthetic response read failure/,
      ),
    );
  });
  await test('customer.write.import.failure-after-first-record-rolls-back-batch', async () => {
    let records = 0;
    const captured = await actor();
    const db = delegated(async (tx, query, values) => {
      if (
        query.kind === 'write' &&
        query.sqlite.includes('.customers(id,warehouse_id,data,active)') &&
        ++records === 2
      )
        throw new Error('synthetic second record failure');
      return tx.query(query, values);
    });
    await unchanged(() =>
      assert.rejects(
        repo(db).importClients(
          captured,
          importBody([client(), client('second', { cui: '200' })]),
        ),
        /synthetic second record failure/,
      ),
    );
    assert.equal(records, 2);
  });
  await test('customer.write.import.final-set-guard-catches-extra-row', async () => {
    let scopes = 0;
    const captured = await actor();
    const db = delegated(async (tx, query, values) => {
      if (
        query.kind === 'read' &&
        query.sqlite.includes('SELECT id,warehouse_id,data,active FROM') &&
        ++scopes === 3
      ) {
        await tx.query(
          q(
            'write',
            `INSERT INTO ${a}.customers VALUES('unexpected','warehouse-a','{}',1)`,
            `INSERT INTO ${a}.customers VALUES('unexpected','warehouse-a','{}',1)`,
          ),
        );
      }
      return tx.query(query, values);
    });
    await unchanged(() =>
      assert.rejects(
        repo(db).importClients(captured, importBody()),
        status(409),
      ),
    );
    assert.equal(scopes, 3);
  });
  await test('customer.write.import.prewrite-guard-catches-raw-row-change', async () => {
    await put();
    const body = importBody(),
      captured = await actor();
    const { preview } = await repo().importClients(captured, {
      ...body,
      preview: true,
    });
    let scopes = 0;
    const db = delegated(async (tx, query, values) => {
      if (
        query.kind === 'read' &&
        query.sqlite.includes('SELECT id,warehouse_id,data,active FROM') &&
        ++scopes === 2
      ) {
        await tx.query(
          q(
            'write',
            `UPDATE ${a}.customers SET data=data||' ' WHERE id='customer'`,
            `UPDATE ${a}.customers SET data=data||' ' WHERE id='customer'`,
          ),
        );
      }
      return tx.query(query, values);
    });
    await unchanged(() =>
      assert.rejects(
        repo(db).importClients(captured, {
          ...body,
          snapshot: preview.snapshot,
        }),
        status(409),
      ),
    );
    assert.equal(scopes, 2);
  });
  await test('customer.write.import.upsert-cas-catches-change-after-set-guard', async () => {
    await put();
    const body = importBody(),
      captured = await actor();
    const { preview } = await repo().importClients(captured, {
      ...body,
      preview: true,
    });
    let changed = false;
    const db = delegated(async (tx, query, values) => {
      if (
        !changed &&
        query.kind === 'write' &&
        query.sqlite.includes('.customers(id,warehouse_id,data,active)')
      ) {
        changed = true;
        await tx.query(
          q(
            'write',
            `UPDATE ${a}.customers SET data=data||' ' WHERE id='customer'`,
            `UPDATE ${a}.customers SET data=data||' ' WHERE id='customer'`,
          ),
        );
      }
      return tx.query(query, values);
    });
    await unchanged(() =>
      assert.rejects(
        repo(db).importClients(captured, {
          ...body,
          snapshot: preview.snapshot,
        }),
        status(409),
      ),
    );
    assert.ok(changed);
  });
  await test('customer.write.lock.revoker-commits-before-waiting-import-authority-read', async () => {
    const captured = await actor(regional),
      entered = deferred(),
      release = deferred();
    const heldOther = {
      read: (action) => other.read(action),
      close: async () => {},
      write: (action, authority) =>
        other.write(async (tx) => {
          entered.resolve();
          await release.promise;
          return action(tx);
        }, authority),
    };
    const revoker = new api.SessionRepository(
      heldOther,
      applicationSchema,
      () => now,
    ).logout(regional);
    await entered.promise;
    const waiting = repo()
      .importClients(captured, importBody())
      .then(
        () => ({ passed: true }),
        (error) => ({ error }),
      );
    release.resolve();
    await revoker;
    const result = await waiting;
    assert.equal(result.error?.status, 409);
    assert.equal((await snapshot()).customers.length, 0);
  });
  await test('customer.write.lock.request-body-is-captured-before-await', async () => {
    const captured = await actor(),
      entered = deferred(),
      release = deferred();
    const blocker = other.write(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const body = importBody();
    const waiting = repo().importClients(captured, body);
    body.clients[0].name = 'Mutated after call';
    body.warehouseId = 'warehouse-b';
    release.resolve();
    await blocker;
    await waiting;
    const row = (await snapshot()).customers[0];
    assert.equal(row.warehouse_id, 'warehouse-a');
    assert.equal(JSON.parse(row.data).name, 'Synthetic company');
  });
  await test('customer.write.uses-existing-transaction-for-response-counts', async () => {
    let reads = 0,
      writes = 0;
    const db = {
      read: () => {
        reads++;
        throw new Error('Unexpected second read transaction');
      },
      close: async () => {},
      write: (action, authority) => {
        writes++;
        return database.write(action, authority);
      },
    };
    await repo(db).importClients(await actor(), importBody());
    assert.equal(reads, 0);
    assert.equal(writes, 1);
  });
  return { caseIds: cases, oracleCount: observations.length, observations };
}
