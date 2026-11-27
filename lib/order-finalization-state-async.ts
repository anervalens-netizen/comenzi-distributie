import { createHash } from 'node:crypto';
import { readCatalogSnapshot } from './catalog-customer-repository-async';
import { customerWarehouseValues } from './customer-membership-json';
import {
  AccountWriteError,
  accountRevision,
  type AccountRecord,
} from './session-repository-async';
import { orderAgentAllowed } from './order-write-authority-async';
import { sqlQuery, type SqlReader, type SqlRow } from './sql-database';
import type { Client, Order, Product } from './types';

export type FinalizationCatalog = Readonly<{
  products: readonly Product[];
  raw: string | null;
  mappingsRaw: string | null;
}>;
export class OrderUnavailableError extends Error {
  readonly status = 503;
  constructor(readonly code: string) {
    super(code);
    this.name = 'OrderUnavailableError';
  }
}
export const orderInputHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function orderText(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Invalid persisted order text');
  return value;
}
export function orderBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountWriteError(400, 'invalid_order_body');
  return structuredClone(value) as Record<string, unknown>;
}
export function orderTextField(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}
export function orderFromRow(row: SqlRow): Order {
  const payload = JSON.parse(orderText(row.payload));
  const items = payload.items || [],
    standItems = payload.standItems || [];
  if (
    !['accessories', 'stands', 'sim', 'combined', 'stand_client'].includes(
      orderText(row.kind),
    ) ||
    !['draft', 'finalized'].includes(orderText(row.status))
  )
    throw new Error('Invalid stored order kind or status');
  return {
    ...payload,
    items,
    standItems,
    serials: payload.serials || [],
    itemCount:
      Array.isArray(payload.items) || Array.isArray(payload.standItems)
        ? items.length + standItems.length
        : (payload.itemCount ?? 0),
    id: orderText(row.id),
    number: orderText(row.number),
    userId: orderText(row.user_id),
    warehouseId: orderText(row.warehouse_id),
    kind: row.kind as Order['kind'],
    status: row.status as Order['status'],
    createdAt: orderText(row.created_at),
    finalizedAt: row.finalized_at === null ? null : orderText(row.finalized_at),
    sourceOrderId:
      row.source_order_id === null ? null : orderText(row.source_order_id),
    revision: accountRevision(row.revision),
  };
}
export async function readOrderForWrite(
  tx: SqlReader,
  schema: string,
  id: string,
  actor: AccountRecord,
): Promise<SqlRow> {
  const found = await tx.query(
    sqlQuery(
      'read',
      'SELECT * FROM ' + schema + '.orders WHERE id=?',
      'SELECT * FROM ' + schema + '.orders WHERE id=$1',
    ),
    [id],
  );
  const row = found.rows.length === 1 ? found.rows[0] : null;
  if (
    !row ||
    row.status === 'deleted' ||
    !(await orderAgentAllowed(tx, schema, actor, orderText(row.user_id)))
  ) {
    throw new AccountWriteError(404, 'order_not_found');
  }
  return row;
}
export async function orderSetting(
  tx: SqlReader,
  schema: string,
  key: string,
): Promise<string | null> {
  const found = await tx.query(
    sqlQuery(
      'read',
      'SELECT value FROM ' + schema + '.settings WHERE key=?',
      'SELECT value FROM ' + schema + '.settings WHERE key=$1',
    ),
    [key],
  );
  return found.rows.length ? orderText(found.rows[0].value) : null;
}

/** Keep the shared catalog read on this caller's transaction and retain its public projection. */
export async function readFinalizationCatalog(
  tx: SqlReader,
  schema: string,
  seed: readonly Product[],
): Promise<FinalizationCatalog> {
  const { raw, mappingsRaw, products } = await readCatalogSnapshot(tx, schema, seed);
  return { raw, mappingsRaw, products };
}

export function customerHasWarehouse(
  data: Record<string, unknown>,
  fallback: unknown,
  warehouseId: string,
): boolean {
  // Legacy JSON1 parses a JSON string's SQL value again. Null/missing fall back;
  // [] does not. Objects expose values, and a malformed bare string must fail.
  let root = data.warehouseIds ?? [fallback];
  if (typeof root === 'string') root = JSON.parse(root);
  const values = Array.isArray(root)
    ? root
    : root && typeof root === 'object'
      ? Object.values(root)
      : [root];
  return values
    .map((value) =>
      typeof value === 'boolean'
        ? Number(value)
        : value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : value,
    )
    .some((value) => value === warehouseId);
}
export const needsFinalizationClient = (order: Order) =>
  order.kind === 'stand_client' ||
  ((order.kind === 'sim' || order.kind === 'combined') &&
    order.serials.length > 0);
export const countsWeeklyOrder = (order: Order) =>
  order.kind === 'accessories' ||
  (order.kind === 'combined' && order.items.length > 0);

export async function readFinalizationClient(
  tx: SqlReader,
  schema: string,
  order: Order,
): Promise<string | null> {
  if (!needsFinalizationClient(order)) return null;
  if (!order.client) throw new AccountWriteError(400, 'client_required');
  const result = await tx.query(
    sqlQuery(
      'read',
      'SELECT data,warehouse_id FROM ' +
        schema +
        '.customers WHERE id=? AND active=1',
      'SELECT data,warehouse_id FROM ' +
        schema +
        '.customers WHERE id=$1 AND active=1',
    ),
    [order.client.id],
  );
  if (result.rows.length !== 1)
    throw new AccountWriteError(409, 'client_changed');
  const raw = orderText(result.rows[0].data),
    client = JSON.parse(raw) as Client & Record<string, unknown>;
  if (
    !customerWarehouseValues(raw, orderText(result.rows[0].warehouse_id))
      .some(value => value === order.warehouseId)
  ) {
    throw new AccountWriteError(409, 'client_changed');
  }
  for (const key of [
    'name',
    'cui',
    'city',
    'county',
    'address',
    'route',
  ] as const) {
    if (client[key] !== order.client[key])
      throw new AccountWriteError(409, 'client_changed');
  }
  return raw;
}
export function validateFinalizationProducts(
  order: Order,
  catalog: FinalizationCatalog,
): void {
  if (order.kind === 'sim') return;
  const products = new Map(
    catalog.products.map((product) => [product.id, product]),
  );
  for (const line of [
    ...order.items,
    ...(order.kind === 'combined' ? order.standItems || [] : []),
  ]) {
    const product = products.get(line.id);
    if (!product) throw new AccountWriteError(409, 'product_removed');
    if (
      (
        [
          'code',
          'name',
          'brand',
          'category',
          'price',
          'netPrice',
          'sourceRow',
        ] as const
      ).some((key) => product[key] !== line[key])
    )
      throw new AccountWriteError(409, 'catalog_changed');
  }
}

/** Exactly the existing Monday key in Europe/Bucharest, including DST weeks. */
export function finalizationWeekKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const day = new Date(
    `${get('year')}-${get('month')}-${get('day')}T00:00:00Z`,
  );
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
