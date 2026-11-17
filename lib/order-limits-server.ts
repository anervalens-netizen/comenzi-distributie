import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readCatalog } from './catalog';
import { notificationInsert } from './notification-center';
import { operationalWriteGuard } from './operational-write-guard';
import {
  defaultOrderLimitFloors,
  orderLimitCode,
  orderLimitFloor,
  orderLimitPeriod,
  orderLimitViolations,
  orderLimitWindow,
  productOrderLimits,
} from './order-limits';
import type {
  OrderLimitApproval,
  OrderLimitApprovalStatus,
  OrderLimitFloors,
  OrderLimitPolicy,
  OrderLimitViolation,
  OrderLimitsView,
} from './order-limits-types';
import { sendNotificationPush } from './push-notifications';
import { orderLimitSalesScope } from './sales-server';
import {
  orderLimitSalesTotals,
  orderLimitSalesVersion,
  salesDatabasePath,
} from './sales-store';
import {
  db,
  fail,
  getOrder,
  isGlobalManager,
  jsonBody,
  requireGlobalManager,
  requireManager,
  response,
  sha256,
  textField,
} from './server';
import { runtimeKind } from './runtime';
import type { Order, User } from './types';

type Catalog = Awaited<ReturnType<typeof readCatalog>>;
type Owner = { revision: number; warehouse: string; managers: string };
type StoredApprovalStatus = Exclude<OrderLimitApprovalStatus, 'superseded'>;
type ApprovalRow = {
  id: string;
  order_id: string;
  order_revision: number;
  order_number: string;
  agent_id: string;
  agent_name: string;
  agent_revision: number;
  warehouse_id: string;
  manager_ids: string;
  input_key: string;
  sales_version: string;
  violations: string;
  status: StoredApprovalStatus;
  present_status: OrderLimitApprovalStatus;
  reason: string;
  comment: string;
  decided_by_name: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};

const statuses: OrderLimitApprovalStatus[] = [
  'pending',
  'approved',
  'rejected',
  'consumed',
  'superseded',
];
const approvalConflict =
  'Comanda, limitele sau accesul s-au modificat. Reîncarcă înainte de a continua.';
const approvalRequired =
  'Cantitatea depășește limita. Cere aprobarea unui manager înainte de finalizare.';
const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const savedRevision = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    fail(400, 'Versiunea transmisă este invalidă.');
  return Number(value);
};

const pilotManagerId = () =>
  process.env.MOBIUP_ORDER_LIMIT_MANAGER_ID?.trim() ?? '';
function pilotMembership(agentExpr: string) {
  return (
    'EXISTS (SELECT 1 FROM manager_agents pilot_link ' +
    "JOIN users pilot_manager ON pilot_manager.id=pilot_link.manager_id AND pilot_manager.role='manager' AND pilot_manager.active=1 " +
    "JOIN users pilot_agent ON pilot_agent.id=pilot_link.agent_id AND pilot_agent.role='agent' AND pilot_agent.active=1 " +
    'WHERE pilot_link.manager_id=? AND pilot_link.agent_id=' +
    agentExpr +
    ')'
  );
}
async function pilotApplies(agentId: string, managerId: string) {
  return (
    !!managerId &&
    !!(await db()
      .prepare('SELECT 1 WHERE ' + pilotMembership('?'))
      .bind(managerId, agentId)
      .first())
  );
}

const policyKey = 'order-limit-policy-v1';
const policyFields = [
  'casesFilms',
  'chargers',
  'cablesAdapters',
  'prepaidSim',
] as const;
function policyFloors(value: unknown): OrderLimitFloors {
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
    fail(400, 'Introdu o cantitate între 1 și 9.999 pentru fiecare categorie.');
  }
  const floors = value as OrderLimitFloors;
  return {
    casesFilms: floors.casesFilms,
    chargers: floors.chargers,
    cablesAdapters: floors.cablesAdapters,
    prepaidSim: floors.prepaidSim,
  };
}
async function readPolicy() {
  const row = await db()
    .prepare('SELECT value FROM settings WHERE key=?')
    .bind(policyKey)
    .first<{ value: string }>();
  const raw = row?.value ?? null;
  const policy: OrderLimitPolicy =
    raw === null
      ? { revision: 0, floors: defaultOrderLimitFloors }
      : JSON.parse(raw);
  return {
    policy,
    raw,
    version: sha256(JSON.stringify([raw, pilotManagerId()])),
  };
}

export async function orderLimitPolicyApi(req: Request, user: User) {
  requireManager(user);
  const previous = await readPolicy();
  if (req.method === 'GET')
    return response({ ...previous.policy, canEdit: isGlobalManager(user) });
  if (req.method !== 'PUT') fail(405, 'Operațiune indisponibilă.');
  requireGlobalManager(user);
  const body = await jsonBody(req);
  if (body.revision !== previous.policy.revision)
    fail(409, 'Pragurile s-au modificat. Reîncarcă setările.');
  const next = {
    revision: previous.policy.revision + 1,
    floors: policyFloors(body.floors),
  };
  const guard = operationalWriteGuard(req, user, { globalOnly: true });
  const result =
    previous.raw === null
      ? await db()
          .prepare(
            'INSERT INTO settings(key,value) SELECT ?,? WHERE ' +
              guard.sql +
              ' ON CONFLICT(key) DO NOTHING',
          )
          .bind(policyKey, JSON.stringify(next), ...guard.args)
          .run()
      : await db()
          .prepare(
            'UPDATE settings SET value=? WHERE key=? AND value=? AND ' +
              guard.sql,
          )
          .bind(JSON.stringify(next), policyKey, previous.raw, ...guard.args)
          .run();
  if (!result.meta.changes)
    fail(409, 'Pragurile sau accesul s-au modificat. Reîncarcă setările.');
  return response({ ...next, canEdit: true });
}

let salesAttachment: Promise<unknown> | undefined;
function bindSalesSource() {
  if (runtimeKind !== 'node')
    fail(503, 'Verificarea limitelor nu este disponibilă în acest mediu.');
  if (!salesAttachment) {
    const url = pathToFileURL(salesDatabasePath);
    url.searchParams.set('mode', 'ro');
    salesAttachment = db()
      .prepare('ATTACH DATABASE ? AS order_limit_sales')
      .bind(url.href)
      .run()
      .catch((error) => {
        salesAttachment = undefined;
        throw error;
      });
  }
  return salesAttachment;
}

async function readSourceVersions() {
  const period = orderLimitPeriod();
  const [mapping, policy, catalog] = await Promise.all([
    orderLimitSalesScope(),
    readPolicy(),
    db()
      .prepare("SELECT value FROM settings WHERE key='catalog'")
      .first<{ value: string }>(),
  ]);
  return {
    salesVersion: orderLimitSalesVersion(period.from, period.to),
    mappingVersion: mapping.version,
    policyVersion: policy.version,
    catalogVersion: sha256(catalog?.value ?? ''),
  };
}
type SourceVersions = Awaited<ReturnType<typeof readSourceVersions>>;
const sourceArgs = (versions: SourceVersions) => [
  versions.salesVersion,
  versions.mappingVersion,
  versions.policyVersion,
  versions.catalogVersion,
];

function activeManagers(agentId: string) {
  // The sorted JSON array is compared in the same writer transaction as each decision or consumption.
  return (
    '(SELECT json_group_array(id) FROM (SELECT m.id FROM manager_agents ma JOIN users m ON m.id=ma.manager_id ' +
    'WHERE ma.agent_id=' +
    agentId +
    " AND m.active=1 AND m.role='manager' ORDER BY m.id))"
  );
}

function readOwner(agentId: string) {
  return db()
    .prepare(
      'SELECT a.profile_revision revision,a.warehouse_id warehouse,' +
        activeManagers('a.id') +
        " managers FROM users a WHERE a.id=? AND a.active=1 AND a.role='agent'",
    )
    .bind(agentId)
    .first<Owner>();
}

function approvalScope(req: Request, user: User) {
  const actor = operationalWriteGuard(req, user, {
    globalOnly: isGlobalManager(user),
  });
  const sql = actor.sql + ' AND ' + pilotMembership('a.agent_id');
  const args = [...actor.args, pilotManagerId()];
  if (user.role === 'agent')
    return { sql: sql + ' AND a.agent_id=?', args: [...args, user.id] };
  if (isGlobalManager(user)) return { sql, args };
  return {
    sql:
      sql +
      ' AND EXISTS(SELECT 1 FROM manager_agents own WHERE own.manager_id=? AND own.agent_id=a.agent_id)',
    args: [...args, user.id],
  };
}

function rowProjection() {
  return (
    'SELECT a.*,o.number order_number,owner.name agent_name,decider.name decided_by_name,' +
    "CASE WHEN a.status='consumed' THEN 'consumed' WHEN o.status='draft' AND o.revision=a.order_revision " +
    "AND o.user_id=a.agent_id AND o.warehouse_id=a.warehouse_id AND owner.active=1 AND owner.role='agent' " +
    'AND owner.profile_revision=a.agent_revision AND owner.warehouse_id=a.warehouse_id AND a.sales_version=? AND a.mapping_version=? AND a.policy_version=? AND a.catalog_version=? ' +
    'AND ' +
    activeManagers('a.agent_id') +
    "=a.manager_ids THEN a.status ELSE 'superseded' END present_status " +
    'FROM order_limit_approvals a JOIN orders o ON o.id=a.order_id JOIN users owner ON owner.id=a.agent_id ' +
    'LEFT JOIN users decider ON decider.id=a.decided_by'
  );
}

function approvalView(
  row: ApprovalRow,
  user: User,
  inputKey?: string,
): OrderLimitApproval {
  const status =
    inputKey !== undefined &&
    row.input_key !== inputKey &&
    row.status !== 'consumed'
      ? 'superseded'
      : row.present_status;
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    agentId: row.agent_id,
    agentName: row.agent_name,
    orderRevision: row.order_revision,
    revision: row.revision,
    status,
    reason: row.reason,
    comment: row.comment,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    violations: JSON.parse(row.violations) as OrderLimitViolation[],
    canDecide:
      status === 'pending' &&
      user.role === 'manager' &&
      (JSON.parse(row.manager_ids) as string[]).includes(user.id),
  };
}

async function approvalById(
  req: Request,
  id: string,
  user: User,
  versions: SourceVersions,
) {
  if (!isUuid(id)) fail(404, 'Aprobarea nu a fost găsită.');
  const scope = approvalScope(req, user);
  const row = await db()
    .prepare(rowProjection() + ' WHERE a.id=? AND (' + scope.sql + ')')
    .bind(...sourceArgs(versions), id, ...scope.args)
    .first<ApprovalRow>();
  if (!row) fail(404, 'Aprobarea nu a fost găsită.');
  return row;
}

function containsLimitedProduct(order: Order, catalog: Catalog) {
  if (order.kind === 'sim' || order.kind === 'stand_client') return false;
  const requested = new Set(
    [
      ...order.items,
      ...(order.kind === 'combined' ? (order.standItems ?? []) : []),
    ].map((line) => orderLimitCode(line.code)),
  );
  return catalog.products.some(
    (product) =>
      requested.has(orderLimitCode(product.code)) &&
      orderLimitFloor(product) > 0,
  );
}

async function evaluate(order: Order, catalog: Catalog) {
  const [mapping, owner, policy] = await Promise.all([
    orderLimitSalesScope(order.userId),
    readOwner(order.userId),
    readPolicy(),
  ]);
  if (!owner || owner.warehouse !== order.warehouseId)
    fail(409, approvalConflict);
  const { period, validity } = orderLimitWindow();
  const codes = [
    ...new Set(
      catalog.products
        .filter((product) => orderLimitFloor(product) > 0)
        .map((p) => orderLimitCode(p.code)),
    ),
  ];
  const salesVersion = orderLimitSalesVersion(period.from, period.to);
  const sales =
    mapping.scope === null
      ? { totals: new Map<string, number>(), coveredMonths: 0 }
      : orderLimitSalesTotals(mapping.scope, period.from, period.to, codes);
  if (salesVersion !== orderLimitSalesVersion(period.from, period.to))
    fail(409, approvalConflict);
  const products = productOrderLimits(
    catalog.products,
    sales.totals,
    period,
    sales.coveredMonths,
    policy.policy.floors,
  );
  const violations = orderLimitViolations(order, products);
  const catalogVersion = sha256(catalog.raw ?? '');
  const inputKey = sha256(
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
    mapping,
    policy,
    mappingVersion: mapping.version,
    policyVersion: policy.version,
    catalogVersion,
  };
}
type Evaluation = Awaited<ReturnType<typeof evaluate>>;

function ownerGuard(agentId: string, owner: Owner) {
  return {
    sql:
      "EXISTS(SELECT 1 FROM users a_owner WHERE a_owner.id=? AND a_owner.active=1 AND a_owner.role='agent' " +
      'AND a_owner.profile_revision=? AND a_owner.warehouse_id=? AND ' +
      activeManagers('a_owner.id') +
      '=?)',
    args: [agentId, owner.revision, owner.warehouse, owner.managers],
  };
}

async function evaluationGuard(
  evaluation: Evaluation,
  catalog: Catalog,
  agentId: string,
  managerId: string,
) {
  await bindSalesSource();
  const { from, to } = evaluation.period;
  const mapping = evaluation.mapping.guard;
  return {
    sql:
      '(SELECT json_array(?,?,json((SELECT json_group_array(json_array(month,import_id)) FROM ' +
      '(SELECT month,import_id FROM order_limit_sales.sales_months WHERE month BETWEEN ? AND ? ORDER BY month)))))=? ' +
      'AND (' +
      mapping.sql +
      ') AND (SELECT value FROM settings WHERE key=?) IS ? ' +
      "AND (SELECT value FROM settings WHERE key='catalog') IS ? " +
      "AND strftime('%Y-%m-%dT%H:%M:%fZ','now')>=? AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<?" +
      ' AND ' +
      pilotMembership('?'),
    args: [
      from,
      to,
      from,
      to,
      evaluation.salesVersion,
      ...mapping.args,
      policyKey,
      evaluation.policy.raw,
      catalog.raw,
      evaluation.validity.start,
      evaluation.validity.end,
      managerId,
      agentId,
    ],
  };
}

const liveDraftSql =
  "EXISTS(SELECT 1 FROM orders live WHERE live.id=? AND live.revision=? AND live.user_id=? AND live.warehouse_id=? AND live.status='draft')";
const liveDraftArgs = (order: Order) => [
  order.id,
  order.revision,
  order.userId,
  order.warehouseId,
];

async function currentRequest(
  req: Request,
  order: Order,
  evaluation: Evaluation,
  user: User,
) {
  const scope = approvalScope(req, user);
  const row = await db()
    .prepare(
      rowProjection() +
        ' WHERE a.order_id=? AND (' +
        scope.sql +
        ')' +
        ' ORDER BY (a.input_key=?) DESC,a.created_at DESC,a.id DESC LIMIT 1',
    )
    .bind(
      ...sourceArgs(evaluation),
      order.id,
      ...scope.args,
      evaluation.inputKey,
    )
    .first<ApprovalRow>();
  return row ? approvalView(row, user, evaluation.inputKey) : null;
}

export async function orderLimits(req: Request, orderId: string, user: User) {
  const order = await getOrder(orderId, user);
  if (
    !(await pilotApplies(order.userId, pilotManagerId())) ||
    order.kind === 'sim' ||
    order.kind === 'stand_client'
  ) {
    return response({
      enabled: false,
      orderId,
      revision: order.revision,
      period: orderLimitPeriod(),
      products: [],
      violations: [],
      request: null,
    } satisfies OrderLimitsView);
  }
  const evaluation = await evaluate(order, await readCatalog());
  const request = await currentRequest(req, order, evaluation, user);
  const actor = operationalWriteGuard(req, user, {
    agentId: order.userId,
    globalOnly: isGlobalManager(user),
  });
  if (
    !(await db()
      .prepare('SELECT 1 WHERE ' + actor.sql)
      .bind(...actor.args)
      .first())
  )
    fail(409, approvalConflict);
  const view: OrderLimitsView = {
    enabled: true,
    orderId,
    revision: order.revision,
    period: evaluation.period,
    products: evaluation.products,
    violations: evaluation.violations,
    request,
  };
  return response(view);
}

function approvalsNotifications(
  order: Order,
  id: string,
  eventKey: string,
  users: string[],
  title: string,
  message: string,
  time: string,
  guard: Parameters<typeof notificationInsert>[1],
) {
  return users.map((recipientId) =>
    notificationInsert(
      {
        recipientId,
        eventKey,
        category: 'order',
        title,
        body: 'Comanda ' + order.number + ' · ' + message,
        targetType: 'order-approval',
        targetId: id,
        createdAt: time,
      },
      guard,
    ),
  );
}

function pushApprovalNotification(recipients: string[], eventKey: string) {
  for (const recipient of recipients)
    void sendNotificationPush(recipient, eventKey).catch(() => {});
}

export async function requestOrderLimitApproval(
  req: Request,
  orderId: string,
  user: User,
) {
  if (user.role !== 'agent')
    fail(403, 'Doar agentul poate solicita aprobarea comenzii sale.');
  const managerId = pilotManagerId();
  if (!(await pilotApplies(user.id, managerId)))
    fail(
      403,
      'Confirmarea limitelor nu este disponibilă pentru această comandă.',
    );
  const [order, body, catalog] = await Promise.all([
    getOrder(orderId, user),
    jsonBody(req),
    readCatalog(),
  ]);
  if (
    order.status !== 'draft' ||
    order.revision !== savedRevision(body.revision)
  )
    fail(409, approvalConflict);
  const evaluation = await evaluate(order, catalog);
  if (!evaluation.violations.length)
    fail(400, 'Comanda se încadrează în limitele aplicabile.');
  const managers = JSON.parse(evaluation.owner.managers) as string[];
  if (!managers.length)
    fail(409, 'Comanda nu are un manager alocat care să o poată aproba.');

  const actor = operationalWriteGuard(req, user, { agentId: order.userId });
  const owner = ownerGuard(order.userId, evaluation.owner);
  const source = await evaluationGuard(
    evaluation,
    catalog,
    order.userId,
    managerId,
  );
  const scope =
    actor.sql +
    ' AND ' +
    owner.sql +
    ' AND ' +
    source.sql +
    ' AND ' +
    liveDraftSql;
  const scopeArgs = [
    ...actor.args,
    ...owner.args,
    ...source.args,
    ...liveDraftArgs(order),
  ];
  const id = randomUUID(),
    now = new Date().toISOString();
  const eventKey = id + ':requested';
  const insert = db()
    .prepare(
      'INSERT INTO order_limit_approvals (id,order_id,order_revision,agent_id,agent_revision,warehouse_id,manager_ids,' +
        'input_key,sales_version,mapping_version,policy_version,catalog_version,violations,status,reason,created_at,updated_at) ' +
        "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,? WHERE " +
        scope +
        ' ON CONFLICT(order_id,order_revision,input_key) DO NOTHING',
    )
    .bind(
      id,
      order.id,
      order.revision,
      order.userId,
      evaluation.owner.revision,
      evaluation.owner.warehouse,
      evaluation.owner.managers,
      evaluation.inputKey,
      ...sourceArgs(evaluation),
      JSON.stringify(evaluation.violations),
      textField(body.reason, 1200),
      now,
      now,
      ...scopeArgs,
    );
  const result = await db().batch([
    insert,
    ...approvalsNotifications(
      order,
      id,
      eventKey,
      managers,
      'Aprobare cantități comandă',
      'A fost solicitată aprobarea pentru cantitățile peste limită.',
      now,
      {
        sql: 'EXISTS(SELECT 1 FROM order_limit_approvals WHERE id=?)',
        args: [id],
      },
    ),
  ]);
  if (result[0].meta.changes) {
    pushApprovalNotification(managers, eventKey);
    return response(
      {
        request: approvalView(
          await approvalById(req, id, user, evaluation),
          user,
        ),
      },
      201,
    );
  }
  if (
    !(await db()
      .prepare('SELECT 1 WHERE ' + scope)
      .bind(...scopeArgs)
      .first())
  )
    fail(409, approvalConflict);
  const existing = await currentRequest(req, order, evaluation, user);
  if (!existing || existing.status === 'superseded')
    fail(409, approvalConflict);
  return response({ request: existing });
}

async function listOrderLimitApprovals(
  req: Request,
  user: User,
  params: URLSearchParams,
) {
  requireManager(user);
  if (!pilotManagerId()) return response({ items: [], hasMore: false });
  const scope = approvalScope(req, user);
  const offset = Number(params.get('offset') ?? 0),
    limit = Number(params.get('limit') ?? 30);
  const status = params.get('status') ?? 'all';
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (status !== 'all' && !statuses.includes(status as OrderLimitApprovalStatus))
  )
    fail(400, 'Filtrele aprobărilor nu sunt valide.');
  const versions = await readSourceVersions();
  const rows = (
    await db()
      .prepare(
        'SELECT * FROM (' +
          rowProjection() +
          ' WHERE ' +
          scope.sql +
          ") WHERE (?='all' OR present_status=?) " +
          'ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
      )
      .bind(
        ...sourceArgs(versions),
        ...scope.args,
        status,
        status,
        limit + 1,
        offset,
      )
      .all<ApprovalRow>()
  ).results;
  return response({
    items: rows.slice(0, limit).map((row) => approvalView(row, user)),
    hasMore: rows.length > limit,
  });
}

async function decideApproval(req: Request, user: User, id: string) {
  requireManager(user);
  const managerId = pilotManagerId();
  if (!managerId) fail(404, 'Aprobarea nu a fost găsită.');
  const [body, versions] = await Promise.all([
    jsonBody(req),
    readSourceVersions(),
  ]);
  const revision = savedRevision(body.revision);
  const decision = body.decision;
  const comment = textField(body.comment, 1200);
  if (decision !== 'approved' && decision !== 'rejected')
    fail(400, 'Alege aprobarea sau respingerea.');
  const row = await approvalById(req, id, user, versions);
  const recipients = JSON.parse(row.manager_ids) as string[];
  if (!recipients.includes(user.id))
    fail(403, 'Doar un manager alocat la momentul solicitării poate decide.');
  if (row.revision !== revision || row.present_status !== 'pending')
    fail(409, approvalConflict);

  const [order, catalog] = await Promise.all([
    getOrder(row.order_id, user),
    readCatalog(),
  ]);
  const evaluation = await evaluate(order, catalog);
  if (row.input_key !== evaluation.inputKey || order.status !== 'draft')
    fail(409, approvalConflict);
  const actor = operationalWriteGuard(req, user, { agentId: order.userId });
  const owner = ownerGuard(order.userId, evaluation.owner);
  const source = await evaluationGuard(
    evaluation,
    catalog,
    order.userId,
    managerId,
  );
  const now = new Date().toISOString(),
    nextRevision = revision + 1;
  const eventKey = id + ':decision:' + nextRevision;
  const notify = [order.userId, ...recipients.filter((id) => id !== user.id)];
  const written = await db().batch([
    db()
      .prepare(
        'UPDATE order_limit_approvals SET status=?,comment=?,decided_by=?,decided_at=?,updated_at=?,revision=revision+1 ' +
          "WHERE id=? AND status='pending' AND revision=? AND input_key=? AND " +
          actor.sql +
          ' AND EXISTS(SELECT 1 FROM manager_agents WHERE manager_id=? AND agent_id=?) ' +
          'AND EXISTS(SELECT 1 FROM json_each(manager_ids) WHERE value=?) AND ' +
          owner.sql +
          ' AND ' +
          source.sql +
          ' AND ' +
          liveDraftSql,
      )
      .bind(
        decision,
        comment,
        user.id,
        now,
        now,
        id,
        revision,
        evaluation.inputKey,
        ...actor.args,
        user.id,
        order.userId,
        user.id,
        ...owner.args,
        ...source.args,
        ...liveDraftArgs(order),
      ),
    ...approvalsNotifications(
      order,
      id,
      eventKey,
      notify,
      'Decizie privind cantitățile comenzii',
      decision === 'approved'
        ? 'Cantitățile au fost aprobate.'
        : 'Cantitățile au fost respinse.',
      now,
      {
        sql: 'EXISTS(SELECT 1 FROM order_limit_approvals WHERE id=? AND status=? AND revision=? AND decided_by=? AND updated_at=?)',
        args: [id, decision, nextRevision, user.id, now],
      },
    ),
  ]);
  if (!written[0].meta.changes) fail(409, approvalConflict);
  pushApprovalNotification(notify, eventKey);
  return response({
    request: approvalView(await approvalById(req, id, user, evaluation), user),
  });
}

export async function orderLimitApprovalsApi(
  req: Request,
  user: User,
  id?: string,
  action?: string,
) {
  if (req.method === 'GET' && !id)
    return listOrderLimitApprovals(req, user, new URL(req.url).searchParams);
  if (req.method === 'GET' && id && !action) {
    if (!pilotManagerId()) fail(404, 'Aprobarea nu a fost găsită.');
    const versions = await readSourceVersions();
    return response({
      request: approvalView(await approvalById(req, id, user, versions), user),
    });
  }
  if (req.method === 'POST' && id && action === 'decision')
    return decideApproval(req, user, id);
  fail(405, 'Operațiune indisponibilă.');
}

export async function orderLimitFinalization(
  req: Request,
  order: Order,
  catalog: Catalog,
  user: User,
) {
  const managerId = pilotManagerId();
  if (!managerId || !containsLimitedProduct(order, catalog))
    return { sql: '1', args: [], approvalId: null };
  if (!(await pilotApplies(order.userId, managerId))) {
    // Recheck in the order writer; a newly assigned agent must be evaluated on retry.
    return {
      sql: 'NOT ' + pilotMembership('?'),
      args: [managerId, order.userId],
      approvalId: null,
    };
  }
  const evaluation = await evaluate(order, catalog);
  const owner = ownerGuard(order.userId, evaluation.owner);
  const source = await evaluationGuard(
    evaluation,
    catalog,
    order.userId,
    managerId,
  );
  const gate = {
    sql: '(' + owner.sql + ') AND (' + source.sql + ')',
    args: [...owner.args, ...source.args],
    approvalId: null as string | null,
  };
  if (!evaluation.violations.length) return gate;

  const request = await currentRequest(req, order, evaluation, user);
  if (request?.status !== 'approved') fail(409, approvalRequired);
  return {
    sql:
      gate.sql +
      ' AND EXISTS(SELECT 1 FROM order_limit_approvals a JOIN users approver ON approver.id=a.decided_by ' +
      "WHERE a.id=? AND a.order_id=? AND a.order_revision=? AND a.input_key=? AND a.status='approved' AND a.revision=? " +
      "AND approver.active=1 AND approver.role='manager' AND EXISTS(SELECT 1 FROM json_each(a.manager_ids) WHERE value=approver.id) " +
      'AND EXISTS(SELECT 1 FROM manager_agents ma WHERE ma.manager_id=approver.id AND ma.agent_id=a.agent_id))',
    args: [
      ...gate.args,
      request.id,
      order.id,
      order.revision,
      evaluation.inputKey,
      request.revision,
    ],
    approvalId: request.id,
  };
}

export function consumeOrderLimitApproval(
  approvalId: string,
  proofKey: string,
  updatedAt: string,
) {
  return db()
    .prepare(
      "UPDATE order_limit_approvals SET status='consumed',updated_at=?,revision=revision+1 WHERE id=? AND status='approved' " +
        'AND EXISTS(SELECT 1 FROM settings WHERE key=?)',
    )
    .bind(updatedAt, approvalId, proofKey);
}
