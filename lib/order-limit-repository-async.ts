import { randomUUID } from 'node:crypto';
import type { RequestActorSnapshot } from './authority-repository-async';
import {
  AccountWriteError,
  accountClock,
  accountRevision,
  type AccountRecord,
} from './session-repository-async';
import {
  orderAgentAllowed,
  requireOrderWriteActor,
  withCapturedOrderWrite,
} from './order-write-authority-async';
import {
  sqlIdentifier,
  sqlQuery,
  safeSqlInteger,
  type AsyncSqlDatabase,
  type SqlReader,
  type SqlRow,
  type SqlWriter,
} from './sql-database';
import {
  defaultOrderLimitFloors,
  orderLimitCode,
  orderLimitFloor,
  orderLimitViolations,
  orderLimitWindow,
  productOrderLimits,
} from './order-limits';
import type {
  OrderLimitApproval,
  OrderLimitFloors,
  OrderLimitPolicy,
  OrderLimitsView,
  OrderLimitViolation,
} from './order-limits-types';
import type { Order, Product } from './types';
import { OrderLimitSources } from './order-limit-source-async';
import {
  OrderUnavailableError,
  orderBody,
  orderFromRow,
  orderInputHash,
  orderSetting,
  orderText,
  orderTextField,
  readFinalizationCatalog,
  readOrderForWrite,
  type FinalizationCatalog,
} from './order-finalization-state-async';

const policyKey = 'order-limit-policy-v1';
const policyFields = [
  'casesFilms',
  'chargers',
  'cablesAdapters',
  'prepaidSim',
] as const;
type Owner = Readonly<{
  revision: number;
  warehouse: string | null;
  managers: string;
}>;
type SourceVersions = Readonly<{
  salesVersion: string;
  mappingVersion: string;
  policyVersion: string;
  catalogVersion: string;
}>;
type PolicySnapshot = Readonly<{
  policy: OrderLimitPolicy;
  raw: string | null;
  version: string;
}>;
export type LimitEvaluation = SourceVersions &
  Readonly<{
    period: { from: string; to: string };
    validity: { start: string; end: string };
    products: OrderLimitsView['products'];
    violations: OrderLimitViolation[];
    inputKey: string;
    owner: Owner;
    policy: PolicySnapshot;
    catalogRaw: string | null;
  }>;
export type FinalizationLimitGate =
  | Readonly<{ kind: 'disabled' }>
  | Readonly<{ kind: 'outside-pilot' }>
  | Readonly<{
      kind: 'evaluated';
      evaluation: LimitEvaluation;
      approvalId: string | null;
      approvalRevision: number | null;
    }>;
export type OrderLimitOptions = Readonly<{
  applicationSchema: string;
  salesSchema: string;
  seedProducts: readonly Product[];
  pilotManagerIds: readonly string[];
  clock?: () => number;
}>;
export type ApprovalNotification = Readonly<{
  eventKey: string;
  recipients: readonly string[];
}>;
export type ApprovalMutation = Readonly<{
  request: OrderLimitApproval;
  created?: boolean;
  notification: ApprovalNotification | null;
}>;

function floors(value: unknown): OrderLimitFloors {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== policyFields.length ||
    policyFields.some(
      (key) =>
        !(key in value) ||
        !Number.isSafeInteger((value as Record<string, unknown>)[key]) ||
        Number((value as Record<string, unknown>)[key]) < 1 ||
        Number((value as Record<string, unknown>)[key]) > 9999,
    )
  ) {
    throw new AccountWriteError(400, 'invalid_order_limit_floors');
  }
  const source = value as OrderLimitFloors;
  return {
    casesFilms: source.casesFilms,
    chargers: source.chargers,
    cablesAdapters: source.cablesAdapters,
    prepaidSim: source.prepaidSim,
  };
}
const conflict = () => new AccountWriteError(409, 'order_approval_changed');
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function savedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new AccountWriteError(400, 'invalid_order_revision');
  return value;
}

/** Prepared asynchronous policy/evaluation/request/decision component. No routes or selector are enabled. */
export class OrderLimitRepository {
  readonly schema: string;
  readonly applicationSchema: string;
  readonly clock: () => number;
  private readonly sources: OrderLimitSources;
  private readonly seedProducts: readonly Product[];
  private readonly managers: readonly string[];
  private readonly managerJson: string;
  constructor(
    private readonly database: AsyncSqlDatabase,
    options: OrderLimitOptions,
  ) {
    this.applicationSchema = options.applicationSchema;
    this.schema = sqlIdentifier(options.applicationSchema);
    this.sources = new OrderLimitSources(
      options.applicationSchema,
      options.salesSchema,
    );
    this.seedProducts = structuredClone(options.seedProducts);
    if (options.pilotManagerIds.some((id) => typeof id !== 'string'))
      throw new Error('Explicit manager IDs required');
    this.managers = Object.freeze(
      [
        ...new Set(
          options.pilotManagerIds.map((id) => id.trim()).filter(Boolean),
        ),
      ].sort(),
    );
    this.managerJson = this.managers.length
      ? JSON.stringify(this.managers)
      : '';
    this.clock = options.clock ?? Date.now;
  }
  private read<T>(
    identity: RequestActorSnapshot,
    action: (tx: SqlReader, actor: AccountRecord) => Promise<T>,
  ): Promise<T> {
    const captured = structuredClone(identity);
    return this.database.read(async (tx) => {
      const actor = await requireOrderWriteActor(
        tx,
        this.schema,
        captured,
        this.clock,
      );
      const result = await action(tx, actor);
      await requireOrderWriteActor(tx, this.schema, captured, this.clock);
      return result;
    });
  }
  catalog(tx: SqlReader): Promise<FinalizationCatalog> {
    return readFinalizationCatalog(tx, this.schema, this.seedProducts);
  }
  private async policy(tx: SqlReader): Promise<PolicySnapshot> {
    const raw = await orderSetting(tx, this.schema, policyKey);
    const policy: OrderLimitPolicy =
      raw === null
        ? { revision: 0, floors: { ...defaultOrderLimitFloors } }
        : JSON.parse(raw);
    return {
      policy,
      raw,
      version: orderInputHash(JSON.stringify([raw, this.managerJson])),
    };
  }
  private async verifiedPilot(tx: SqlReader): Promise<boolean> {
    if (!this.managers.length) return false;
    const found = await tx.query(
      sqlQuery(
        'read',
        'SELECT COUNT(*) AS total FROM ' +
          this.schema +
          ".users WHERE active=1 AND role='manager' AND id IN (SELECT value FROM json_each(?))",
        'SELECT COUNT(*) AS total FROM ' +
          this.schema +
          ".users WHERE active=1 AND role='manager' AND id IN (SELECT value FROM jsonb_array_elements_text($1::jsonb) AS ids(value))",
      ),
      [this.managerJson],
    );
    if (safeSqlInteger(found.rows[0].total) !== this.managers.length)
      throw new OrderUnavailableError('invalid_order_limit_configuration');
    return true;
  }
  private async pilotApplies(tx: SqlReader, agentId: string): Promise<boolean> {
    if (!this.managers.length) return false;
    const prefix =
      'SELECT 1 AS allowed FROM ' +
      this.schema +
      '.manager_agents ma JOIN ' +
      this.schema +
      ".users m ON m.id=ma.manager_id AND m.active=1 AND m.role='manager' JOIN " +
      this.schema +
      ".users a ON a.id=ma.agent_id AND a.active=1 AND a.role='agent' WHERE ma.agent_id=";
    const result = await tx.query(
      sqlQuery(
        'read',
        prefix +
          '? AND ma.manager_id IN (SELECT value FROM json_each(?)) LIMIT 1',
        prefix +
          '$1 AND ma.manager_id IN (SELECT value FROM jsonb_array_elements_text($2::jsonb) AS ids(value)) LIMIT 1',
      ),
      [agentId, this.managerJson],
    );
    return result.rows.length === 1;
  }
  private async owner(tx: SqlReader, id: string): Promise<Owner | null> {
    const found = await tx.query(
      sqlQuery(
        'read',
        'SELECT profile_revision,warehouse_id FROM ' +
          this.schema +
          ".users WHERE id=? AND active=1 AND role='agent'",
        'SELECT profile_revision,warehouse_id FROM ' +
          this.schema +
          ".users WHERE id=$1 AND active=1 AND role='agent'",
      ),
      [id],
    );
    if (found.rows.length !== 1) return null;
    const prefix =
      'SELECT m.id FROM ' +
      this.schema +
      '.manager_agents ma JOIN ' +
      this.schema +
      '.users m ON m.id=ma.manager_id WHERE ma.agent_id=';
    const managers = await tx.query(
      sqlQuery(
        'read',
        prefix + "? AND m.active=1 AND m.role='manager' ORDER BY m.id",
        prefix +
          '$1 AND m.active=1 AND m.role=\'manager\' ORDER BY m.id COLLATE "C"',
      ),
      [id],
    );
    return {
      revision: accountRevision(found.rows[0].profile_revision),
      warehouse:
        found.rows[0].warehouse_id === null
          ? null
          : orderText(found.rows[0].warehouse_id),
      managers: JSON.stringify(managers.rows.map((row) => orderText(row.id))),
    };
  }
  private containsLimitedProduct(
    order: Order,
    catalog: FinalizationCatalog,
  ): boolean {
    if (order.kind === 'sim' || order.kind === 'stand_client') return false;
    const codes = new Set(
      [
        ...order.items,
        ...(order.kind === 'combined' ? order.standItems || [] : []),
      ].map((line) => orderLimitCode(line.code)),
    );
    return catalog.products.some(
      (product) =>
        codes.has(orderLimitCode(product.code)) && orderLimitFloor(product) > 0,
    );
  }
  private async evaluate(
    tx: SqlReader,
    order: Order,
    catalog: FinalizationCatalog,
  ): Promise<LimitEvaluation> {
    const mapping = await this.sources.mapping(tx, order.userId),
      owner = await this.owner(tx, order.userId),
      policy = await this.policy(tx);
    if (!owner || owner.warehouse !== order.warehouseId) throw conflict();
    const { period, validity } = orderLimitWindow(
      new Date(accountClock(this.clock)),
    );
    const codes = [
      ...new Set(
        catalog.products
          .filter((product) => orderLimitFloor(product) > 0)
          .map((product) => orderLimitCode(product.code)),
      ),
    ];
    const salesVersion = await this.sources.version(tx, period.from, period.to);
    const sales = await this.sources.totals(
      tx,
      mapping.scope,
      period.from,
      period.to,
      codes,
    );
    if (
      salesVersion !== (await this.sources.version(tx, period.from, period.to))
    )
      throw conflict();
    const products = productOrderLimits(
      catalog.products,
      sales.totals,
      period,
      sales.coveredMonths,
      policy.policy.floors,
    );
    const violations = orderLimitViolations(order, products),
      catalogVersion = orderInputHash(catalog.raw ?? '');
    const inputKey = orderInputHash(
      JSON.stringify([
        order.id,
        order.revision,
        order.userId,
        owner.revision,
        owner.warehouse,
        owner.managers,
        salesVersion,
        mapping.version,
        policy.version,
        catalogVersion,
        violations.map(
          ({ productId, code, requested, floor, salesQuantity, limit }) => [
            productId,
            code,
            requested,
            floor,
            salesQuantity,
            limit,
          ],
        ),
      ]),
    );
    return {
      period,
      validity,
      products,
      violations,
      inputKey,
      salesVersion,
      owner,
      policy,
      mappingVersion: mapping.version,
      policyVersion: policy.version,
      catalogVersion,
      catalogRaw: catalog.raw,
    };
  }
  private async assertEvaluation(
    tx: SqlReader,
    order: Order,
    evaluation: LimitEvaluation,
  ): Promise<void> {
    const now = new Date(accountClock(this.clock)).toISOString(),
      owner = await this.owner(tx, order.userId);
    if (
      !(await this.verifiedPilot(tx)) ||
      !(await this.pilotApplies(tx, order.userId)) ||
      !owner ||
      JSON.stringify(owner) !== JSON.stringify(evaluation.owner) ||
      (await this.sources.version(
        tx,
        evaluation.period.from,
        evaluation.period.to,
      )) !== evaluation.salesVersion ||
      (await this.sources.mappingVersion(tx)) !== evaluation.mappingVersion ||
      (await orderSetting(tx, this.schema, policyKey)) !==
        evaluation.policy.raw ||
      (await orderSetting(tx, this.schema, 'catalog')) !==
        evaluation.catalogRaw ||
      now < evaluation.validity.start ||
      now >= evaluation.validity.end
    )
      throw conflict();
  }
  private projection(): string {
    return (
      'SELECT a.*,o.number AS order_number,owner.name AS agent_name,decider.name AS decided_by_name FROM ' +
      this.schema +
      '.order_limit_approvals a JOIN ' +
      this.schema +
      '.orders o ON o.id=a.order_id JOIN ' +
      this.schema +
      '.users owner ON owner.id=a.agent_id LEFT JOIN ' +
      this.schema +
      '.users decider ON decider.id=a.decided_by'
    );
  }
  private async rowAllowed(
    tx: SqlReader,
    actor: AccountRecord,
    row: SqlRow,
  ): Promise<boolean> {
    return (
      (await this.pilotApplies(tx, orderText(row.agent_id))) &&
      (await orderAgentAllowed(tx, this.schema, actor, orderText(row.agent_id)))
    );
  }
  private async approvalRow(
    tx: SqlReader,
    actor: AccountRecord,
    id: string,
  ): Promise<SqlRow> {
    if (!uuid(id)) throw new AccountWriteError(404, 'order_approval_not_found');
    const result = await tx.query(
      sqlQuery(
        'read',
        this.projection() + ' WHERE a.id=?',
        this.projection() + ' WHERE a.id=$1',
      ),
      [id],
    );
    if (
      result.rows.length !== 1 ||
      !(await this.rowAllowed(tx, actor, result.rows[0]))
    )
      throw new AccountWriteError(404, 'order_approval_not_found');
    return result.rows[0];
  }
  private async view(
    tx: SqlReader,
    actor: AccountRecord,
    row: SqlRow,
    versions: SourceVersions,
    inputKey?: string,
  ): Promise<OrderLimitApproval> {
    // The existing approval audit remains readable as superseded after a soft
    // delete; ordinary GET-order correctly hides that same deleted order.
    const found = await tx.query(
      sqlQuery(
        'read',
        'SELECT status,revision,user_id,warehouse_id FROM ' +
          this.schema +
          '.orders WHERE id=?',
        'SELECT status,revision,user_id,warehouse_id FROM ' +
          this.schema +
          '.orders WHERE id=$1',
      ),
      [orderText(row.order_id)],
    );
    if (found.rows.length !== 1)
      throw new AccountWriteError(404, 'order_approval_not_found');
    const order = found.rows[0],
      owner = await this.owner(tx, orderText(row.agent_id));
    let status = orderText(row.status) as OrderLimitApproval['status'];
    if (
      status !== 'consumed' &&
      (order.status !== 'draft' ||
        accountRevision(order.revision) !==
          accountRevision(row.order_revision) ||
        order.user_id !== row.agent_id ||
        order.warehouse_id !== row.warehouse_id ||
        !owner ||
        owner.revision !== accountRevision(row.agent_revision) ||
        owner.warehouse !== row.warehouse_id ||
        owner.managers !== row.manager_ids ||
        (
          [
            'salesVersion',
            'mappingVersion',
            'policyVersion',
            'catalogVersion',
          ] as const
        ).some(
          (key, i) =>
            versions[key] !==
            row[
              [
                'sales_version',
                'mapping_version',
                'policy_version',
                'catalog_version',
              ][i]
            ],
        ) ||
        (inputKey !== undefined && inputKey !== row.input_key))
    )
      status = 'superseded';
    return {
      id: orderText(row.id),
      orderId: orderText(row.order_id),
      orderNumber: orderText(row.order_number),
      agentId: orderText(row.agent_id),
      agentName: orderText(row.agent_name),
      orderRevision: accountRevision(row.order_revision),
      revision: accountRevision(row.revision),
      status,
      reason: orderText(row.reason),
      comment: orderText(row.comment),
      decidedByName:
        row.decided_by_name === null ? null : orderText(row.decided_by_name),
      decidedAt: row.decided_at === null ? null : orderText(row.decided_at),
      createdAt: orderText(row.created_at),
      updatedAt: orderText(row.updated_at),
      violations: JSON.parse(orderText(row.violations)),
      canDecide:
        status === 'pending' &&
        actor.role === 'manager' &&
        (JSON.parse(orderText(row.manager_ids)) as string[]).includes(actor.id),
    };
  }
  private async currentRequest(
    tx: SqlReader,
    actor: AccountRecord,
    order: Order,
    evaluation: LimitEvaluation,
  ): Promise<OrderLimitApproval | null> {
    const rows = await tx.query(
      sqlQuery(
        'read',
        this.projection() +
          ' WHERE a.order_id=? ORDER BY (a.input_key=?) DESC,a.created_at DESC,a.id DESC LIMIT 1',
        this.projection() +
          ' WHERE a.order_id=$1 ORDER BY (a.input_key=$2) DESC,a.created_at COLLATE "C" DESC,a.id COLLATE "C" DESC LIMIT 1',
      ),
      [order.id, evaluation.inputKey],
    );
    return rows.rows.length && (await this.rowAllowed(tx, actor, rows.rows[0]))
      ? this.view(tx, actor, rows.rows[0], evaluation, evaluation.inputKey)
      : null;
  }
  private async sourceVersions(tx: SqlReader): Promise<SourceVersions> {
    const { period } = orderLimitWindow(new Date(accountClock(this.clock))),
      policy = await this.policy(tx);
    return {
      salesVersion: await this.sources.version(tx, period.from, period.to),
      mappingVersion: await this.sources.mappingVersion(tx),
      policyVersion: policy.version,
      catalogVersion: orderInputHash(
        (await orderSetting(tx, this.schema, 'catalog')) ?? '',
      ),
    };
  }
  private async assertDraft(
    tx: SqlReader,
    actor: AccountRecord,
    order: Order,
  ): Promise<void> {
    const current = orderFromRow(
      await readOrderForWrite(tx, this.schema, order.id, actor),
    );
    if (
      current.status !== 'draft' ||
      current.revision !== order.revision ||
      current.userId !== order.userId ||
      current.warehouseId !== order.warehouseId
    )
      throw conflict();
  }
  private async notifications(
    tx: SqlWriter,
    order: Order,
    id: string,
    eventKey: string,
    recipients: readonly string[],
    title: string,
    body: string,
    time: string,
  ): Promise<ApprovalNotification> {
    const prefix =
      'INSERT INTO ' +
      this.schema +
      '.notifications(id,recipient_id,event_key,category,title,body,target_type,target_id,created_at) SELECT ';
    for (const recipient of recipients)
      await tx.query(
        sqlQuery(
          'write',
          prefix +
            "?,?,?,'order',?,?,'order-approval',?,? FROM " +
            this.schema +
            '.users recipient WHERE recipient.id=? AND recipient.active=1 ON CONFLICT(recipient_id,event_key) DO NOTHING',
          prefix +
            "$1,$2,$3,'order',$4,$5,'order-approval',$6,$7 FROM " +
            this.schema +
            '.users recipient WHERE recipient.id=$8 AND recipient.active=1 ON CONFLICT(recipient_id,event_key) DO NOTHING',
        ),
        [
          randomUUID(),
          recipient,
          eventKey,
          title,
          'Comanda ' + order.number + ' · ' + body,
          id,
          time,
          recipient,
        ],
      );
    return { eventKey, recipients: [...recipients] };
  }
  getPolicy(
    identity: RequestActorSnapshot,
  ): Promise<OrderLimitPolicy & { canEdit: boolean }> {
    return this.read(identity, async (tx, actor) => {
      if (actor.role !== 'manager')
        throw new AccountWriteError(403, 'manager_required');
      return {
        ...(await this.policy(tx)).policy,
        canEdit: actor.managerScope === 'global',
      };
    });
  }
  async setPolicy(
    identity: RequestActorSnapshot,
    input: unknown,
  ): Promise<OrderLimitPolicy & { canEdit: true }> {
    const actor = structuredClone(identity),
      body = orderBody(input);
    const previous = await this.read(actor, async (tx, user) => {
      if (user.role !== 'manager' || user.managerScope !== 'global')
        throw new AccountWriteError(403, 'global_manager_required');
      return this.policy(tx);
    });
    if (body.revision !== previous.policy.revision) throw conflict();
    const next = {
      revision: previous.policy.revision + 1,
      floors: floors(body.floors),
    };
    return withCapturedOrderWrite(
      this.database,
      this.applicationSchema,
      actor,
      async (tx, user) => {
        if (user.role !== 'manager' || user.managerScope !== 'global')
          throw new AccountWriteError(403, 'global_manager_required');
        const changed =
          previous.raw === null
            ? await tx.query(
                sqlQuery(
                  'write',
                  'INSERT INTO ' +
                    this.schema +
                    '.settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING',
                  'INSERT INTO ' +
                    this.schema +
                    '.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',
                ),
                [policyKey, JSON.stringify(next)],
              )
            : await tx.query(
                sqlQuery(
                  'write',
                  'UPDATE ' +
                    this.schema +
                    '.settings SET value=? WHERE key=? AND value=?',
                  'UPDATE ' +
                    this.schema +
                    '.settings SET value=$1 WHERE key=$2 AND value=$3',
                ),
                [JSON.stringify(next), policyKey, previous.raw],
              );
        if (changed.changes !== 1) throw conflict();
        return { ...next, canEdit: true };
      },
      this.clock,
    );
  }
  limits(identity: RequestActorSnapshot, id: string): Promise<OrderLimitsView> {
    return this.read(identity, async (tx, actor) => {
      const order = orderFromRow(
        await readOrderForWrite(tx, this.schema, id, actor),
      );
      if (
        order.kind === 'sim' ||
        order.kind === 'stand_client' ||
        !(await this.verifiedPilot(tx)) ||
        !(await this.pilotApplies(tx, order.userId))
      ) {
        return {
          enabled: false,
          orderId: id,
          revision: order.revision,
          period: orderLimitWindow(new Date(accountClock(this.clock))).period,
          products: [],
          violations: [],
          request: null,
        };
      }
      const evaluation = await this.evaluate(tx, order, await this.catalog(tx));
      return {
        enabled: true,
        orderId: id,
        revision: order.revision,
        period: evaluation.period,
        products: evaluation.products,
        violations: evaluation.violations,
        request: await this.currentRequest(tx, actor, order, evaluation),
      };
    });
  }
  approval(
    identity: RequestActorSnapshot,
    id: string,
  ): Promise<OrderLimitApproval> {
    return this.read(identity, async (tx, actor) => {
      if (!(await this.verifiedPilot(tx)))
        throw new AccountWriteError(404, 'order_approval_not_found');
      return this.view(
        tx,
        actor,
        await this.approvalRow(tx, actor, id),
        await this.sourceVersions(tx),
      );
    });
  }
  async request(
    identity: RequestActorSnapshot,
    orderId: string,
    input: unknown,
  ): Promise<ApprovalMutation> {
    const actor = structuredClone(identity),
      body = orderBody(input);
    const prepared = await this.read(actor, async (tx, user) => {
      if (user.role !== 'agent')
        throw new AccountWriteError(403, 'agent_required');
      if (
        !(await this.verifiedPilot(tx)) ||
        !(await this.pilotApplies(tx, user.id))
      )
        throw new AccountWriteError(403, 'order_limits_not_enabled');
      const order = orderFromRow(
        await readOrderForWrite(tx, this.schema, orderId, user),
      );
      if (
        order.status !== 'draft' ||
        order.revision !== savedRevision(body.revision)
      )
        throw conflict();
      const evaluation = await this.evaluate(tx, order, await this.catalog(tx));
      if (!evaluation.violations.length)
        throw new AccountWriteError(400, 'order_within_limits');
      const managers = JSON.parse(evaluation.owner.managers) as string[];
      if (!managers.length) throw conflict();
      return { order, evaluation, managers };
    });
    return withCapturedOrderWrite(
      this.database,
      this.applicationSchema,
      actor,
      async (tx, user) => {
        await this.assertDraft(tx, user, prepared.order);
        await this.assertEvaluation(tx, prepared.order, prepared.evaluation);
        const id = randomUUID(),
          time = new Date(accountClock(this.clock)).toISOString(),
          e = prepared.evaluation;
        const columns =
          '(id,order_id,order_revision,agent_id,agent_revision,warehouse_id,manager_ids,input_key,sales_version,mapping_version,policy_version,catalog_version,violations,status,reason,created_at,updated_at)';
        const changed = await tx.query(
          sqlQuery(
            'write',
            'INSERT INTO ' +
              this.schema +
              '.order_limit_approvals' +
              columns +
              " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(order_id,order_revision,input_key) DO NOTHING",
            'INSERT INTO ' +
              this.schema +
              '.order_limit_approvals' +
              columns +
              " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16) ON CONFLICT(order_id,order_revision,input_key) DO NOTHING",
          ),
          [
            id,
            prepared.order.id,
            prepared.order.revision,
            prepared.order.userId,
            e.owner.revision,
            prepared.order.warehouseId,
            e.owner.managers,
            e.inputKey,
            e.salesVersion,
            e.mappingVersion,
            e.policyVersion,
            e.catalogVersion,
            JSON.stringify(e.violations),
            orderTextField(body.reason, 1200),
            time,
            time,
          ],
        );
        if (changed.changes !== 1) {
          const existing = await this.currentRequest(
            tx,
            user,
            prepared.order,
            e,
          );
          if (!existing || existing.status === 'superseded') throw conflict();
          return { request: existing, created: false, notification: null };
        }
        const notification = await this.notifications(
          tx,
          prepared.order,
          id,
          id + ':requested',
          prepared.managers,
          'Aprobare cantități comandă',
          'A fost solicitată aprobarea pentru cantitățile peste limită.',
          time,
        );
        return {
          request: await this.view(
            tx,
            user,
            await this.approvalRow(tx, user, id),
            e,
          ),
          created: true,
          notification,
        };
      },
      this.clock,
    );
  }
  async decide(
    identity: RequestActorSnapshot,
    id: string,
    input: unknown,
  ): Promise<ApprovalMutation> {
    const actor = structuredClone(identity),
      body = orderBody(input),
      revision = savedRevision(body.revision);
    if (body.decision !== 'approved' && body.decision !== 'rejected')
      throw new AccountWriteError(400, 'invalid_approval_decision');
    const decision = body.decision;
    const prepared = await this.read(actor, async (tx, user) => {
      if (user.role !== 'manager')
        throw new AccountWriteError(403, 'manager_required');
      if (!(await this.verifiedPilot(tx)))
        throw new AccountWriteError(404, 'order_approval_not_found');
      const row = await this.approvalRow(tx, user, id),
        recipients = JSON.parse(orderText(row.manager_ids)) as string[];
      if (!recipients.includes(user.id))
        throw new AccountWriteError(403, 'approval_recipient_required');
      const view = await this.view(
        tx,
        user,
        row,
        await this.sourceVersions(tx),
      );
      if (view.revision !== revision || view.status !== 'pending')
        throw conflict();
      const order = orderFromRow(
        await readOrderForWrite(tx, this.schema, orderText(row.order_id), user),
      );
      const evaluation = await this.evaluate(tx, order, await this.catalog(tx));
      if (row.input_key !== evaluation.inputKey || order.status !== 'draft')
        throw conflict();
      return { order, evaluation, recipients };
    });
    return withCapturedOrderWrite(
      this.database,
      this.applicationSchema,
      actor,
      async (tx, user) => {
        await this.assertDraft(tx, user, prepared.order);
        await this.assertEvaluation(tx, prepared.order, prepared.evaluation);
        const row = await this.approvalRow(tx, user, id);
        const link = await tx.query(
          sqlQuery(
            'read',
            'SELECT 1 AS allowed FROM ' +
              this.schema +
              '.manager_agents WHERE manager_id=? AND agent_id=?',
            'SELECT 1 AS allowed FROM ' +
              this.schema +
              '.manager_agents WHERE manager_id=$1 AND agent_id=$2',
          ),
          [user.id, prepared.order.userId],
        );
        if (
          link.rows.length !== 1 ||
          !(JSON.parse(orderText(row.manager_ids)) as string[]).includes(
            user.id,
          )
        )
          throw conflict();
        const time = new Date(accountClock(this.clock)).toISOString(),
          nextRevision = revision + 1;
        const changed = await tx.query(
          sqlQuery(
            'write',
            'UPDATE ' +
              this.schema +
              ".order_limit_approvals SET status=?,comment=?,decided_by=?,decided_at=?,updated_at=?,revision=revision+1 WHERE id=? AND status='pending' AND revision=? AND input_key=?",
            'UPDATE ' +
              this.schema +
              ".order_limit_approvals SET status=$1,comment=$2,decided_by=$3,decided_at=$4,updated_at=$5,revision=revision+1 WHERE id=$6 AND status='pending' AND revision=$7 AND input_key=$8",
          ),
          [
            decision,
            orderTextField(body.comment, 1200),
            user.id,
            time,
            time,
            id,
            revision,
            prepared.evaluation.inputKey,
          ],
        );
        if (changed.changes !== 1) throw conflict();
        const recipients = [
          prepared.order.userId,
          ...prepared.recipients.filter((manager) => manager !== user.id),
        ];
        const notification = await this.notifications(
          tx,
          prepared.order,
          id,
          id + ':decision:' + nextRevision,
          recipients,
          'Decizie privind cantitățile comenzii',
          decision === 'approved'
            ? 'Cantitățile au fost aprobate.'
            : 'Cantitățile au fost respinse.',
          time,
        );
        return {
          request: await this.view(
            tx,
            user,
            await this.approvalRow(tx, user, id),
            prepared.evaluation,
          ),
          notification,
        };
      },
      this.clock,
    );
  }
  async prepareFinalization(
    tx: SqlReader,
    actor: AccountRecord,
    order: Order,
    catalog: FinalizationCatalog,
  ): Promise<FinalizationLimitGate> {
    if (
      !this.containsLimitedProduct(order, catalog) ||
      !(await this.verifiedPilot(tx))
    )
      return { kind: 'disabled' };
    if (!(await this.pilotApplies(tx, order.userId)))
      return { kind: 'outside-pilot' };
    const evaluation = await this.evaluate(tx, order, catalog);
    if (!evaluation.violations.length)
      return {
        kind: 'evaluated',
        evaluation,
        approvalId: null,
        approvalRevision: null,
      };
    const request = await this.currentRequest(tx, actor, order, evaluation);
    if (request?.status !== 'approved')
      throw new AccountWriteError(409, 'order_limit_approval_required');
    return {
      kind: 'evaluated',
      evaluation,
      approvalId: request.id,
      approvalRevision: request.revision,
    };
  }
  async assertFinalization(
    tx: SqlReader,
    actor: AccountRecord,
    order: Order,
    gate: FinalizationLimitGate,
  ): Promise<void> {
    if (gate.kind === 'disabled') return;
    if (gate.kind === 'outside-pilot') {
      if (
        !(await this.verifiedPilot(tx)) ||
        (await this.pilotApplies(tx, order.userId))
      )
        throw conflict();
      return;
    }
    await this.assertEvaluation(tx, order, gate.evaluation);
    if (gate.approvalId === null) return;
    const row = await this.approvalRow(tx, actor, gate.approvalId);
    if (
      row.order_id !== order.id ||
      accountRevision(row.order_revision) !== order.revision ||
      row.input_key !== gate.evaluation.inputKey ||
      row.status !== 'approved' ||
      accountRevision(row.revision) !== gate.approvalRevision ||
      typeof row.decided_by !== 'string' ||
      !(JSON.parse(orderText(row.manager_ids)) as string[]).includes(
        row.decided_by,
      )
    )
      throw conflict();
    const prefix =
      'SELECT 1 AS allowed FROM ' +
      this.schema +
      '.users m JOIN ' +
      this.schema +
      ".manager_agents ma ON ma.manager_id=m.id WHERE m.active=1 AND m.role='manager' AND m.id=";
    const approver = await tx.query(
      sqlQuery(
        'read',
        prefix + '? AND ma.agent_id=?',
        prefix + '$1 AND ma.agent_id=$2',
      ),
      [row.decided_by, order.userId],
    );
    if (approver.rows.length !== 1) throw conflict();
  }
  async consumeFinalization(
    tx: SqlWriter,
    gate: FinalizationLimitGate,
    time: string,
  ): Promise<void> {
    if (gate.kind !== 'evaluated' || gate.approvalId === null) return;
    const changed = await tx.query(
      sqlQuery(
        'write',
        'UPDATE ' +
          this.schema +
          ".order_limit_approvals SET status='consumed',updated_at=?,revision=revision+1 WHERE id=? AND status='approved' AND revision=?",
        'UPDATE ' +
          this.schema +
          ".order_limit_approvals SET status='consumed',updated_at=$1,revision=revision+1 WHERE id=$2 AND status='approved' AND revision=$3",
      ),
      [time, gate.approvalId, gate.approvalRevision],
    );
    if (changed.changes !== 1) throw conflict();
  }
}
