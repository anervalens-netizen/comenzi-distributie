import { createHash } from 'node:crypto';
import type { RequestActorSnapshot } from './authority-repository-async';
import { validEan } from './barcodes';
import { stockCode } from './stock-types';
import { AccountWriteError, accountClock, accountRecord, accountRevision, captureSessionIdentity,
  requireSessionInTransaction, type AccountRecord, type SessionIdentity } from './session-repository-async';
import { orderAgentAllowed, withCapturedOrderWrite } from './order-write-authority-async';
import { sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader, type SqlRow } from './sql-database';
import type { Client, Kind, Line, Order, Product, Warehouse } from './types';

type Body = Readonly<Record<string, unknown>>;
export type DraftSeed = Readonly<{ products: readonly Product[]; warehouses: readonly Warehouse[] }>;
export type DraftCreated = Readonly<{ order: Order; created: boolean }>;
export type DraftDeleted = Readonly<{ ok: true; deletedId: string; revision: number }>;
const kinds: readonly string[] = ['accessories', 'stands', 'sim', 'combined', 'stand_client'];

function textField(value: unknown, maximum = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid order text');
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function bodyCopy(body: Body): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountWriteError(400, 'invalid_order_body');
  // The HTTP boundary still owns JSON/content-type/size checks. Retain a private
  // copy so a caller cannot change input while this transaction waits for a lock.
  return structuredClone(body);
}
function customerWarehouseValues(value: unknown, fallback: unknown): unknown[] {
  // Match json_each(COALESCE(json_extract(...),json_array(warehouse_id))).
  // SQLite json_extract returns a bare SQL string for a JSON string, so
  // json_each parses that string AGAIN. A plain warehouse name is malformed
  // JSON, not an authorization grant. JSON null/missing use the fallback;
  // an empty array does not. Native SQLite cases pin these legacy forms.
  let root = value ?? [fallback];
  if (typeof root === 'string') root = JSON.parse(root);
  const values = Array.isArray(root) ? root : root && typeof root === 'object' ? Object.values(root) : [root];
  return values.map(item => typeof item === 'boolean' ? Number(item)
    : item !== null && typeof item === 'object' ? JSON.stringify(item) : item);
}
function orderView(row: SqlRow): Order {
  const p = JSON.parse(text(row.payload));
  const hasDetailedLines = Array.isArray(p.items) || Array.isArray(p.standItems);
  const items = p.items || [], standItems = p.standItems || [];
  if (!kinds.includes(text(row.kind)) || !['draft', 'finalized'].includes(text(row.status))) {
    throw new Error('Invalid stored order kind or status');
  }
  return { ...p, items, standItems, serials: p.serials || [],
    itemCount: hasDetailedLines ? items.length + standItems.length : p.itemCount ?? 0,
    id: text(row.id), number: text(row.number), userId: text(row.user_id), warehouseId: text(row.warehouse_id),
    kind: row.kind as Kind, status: row.status as Order['status'], createdAt: text(row.created_at),
    finalizedAt: nullableText(row.finalized_at), sourceOrderId: nullableText(row.source_order_id),
    revision: accountRevision(row.revision) };
}
function lines(raw: unknown, kind: 'accessories' | 'stands' | 'stand_client', products: readonly Product[]): Line[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 600) throw new AccountWriteError(400, 'invalid_order_lines');
  const result: Line[] = [], seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new AccountWriteError(400, 'invalid_order_line');
    const product = products.find(p => p.id === item.id && (kind === 'stand_client'
      ? p.kind === 'stands' && p.category === 'Standuri' : p.kind === kind));
    if (!product || seen.has(product.id)) throw new AccountWriteError(400, 'unknown_or_duplicate_product');
    if (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 9999) {
      throw new AccountWriteError(400, 'invalid_order_quantity');
    }
    result.push({ ...product, quantity: item.quantity });
    seen.add(product.id);
  }
  return result;
}

/**
 * Prepared port of orders POST/GET-by-id/PUT/DELETE only. It does not activate a
 * backend selector, finalize an order, approve limits or publish an export.
 */
export class OrderDraftRepository {
  private readonly schema: string;
  private readonly seed: DraftSeed;
  constructor(private readonly database: AsyncSqlDatabase, private readonly applicationSchema: string,
    seed: DraftSeed, private readonly clock: () => number = Date.now) {
    this.schema = sqlIdentifier(applicationSchema);
    this.seed = structuredClone(seed);
  }

  private async row(tx: SqlReader, id: string): Promise<SqlRow | null> {
    const result = await tx.query(sqlQuery('read', 'SELECT * FROM ' + this.schema + '.orders WHERE id=?',
      'SELECT * FROM ' + this.schema + '.orders WHERE id=$1'), [id]);
    return result.rows.length === 1 ? result.rows[0] : null;
  }
  private async accessible(tx: SqlReader, id: string, user: AccountRecord, nationalRead = false): Promise<SqlRow> {
    const row = await this.row(tx, id);
    if (!row || row.status === 'deleted' || !await orderAgentAllowed(tx, this.schema, user, text(row.user_id), nationalRead)) {
      throw new AccountWriteError(404, 'order_not_found');
    }
    return row;
  }

  read(identity: SessionIdentity, id: string): Promise<Order> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const { user } = await requireSessionInTransaction(tx, this.schema, actor, accountClock(this.clock));
      if (user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
      return orderView(await this.accessible(tx, id, user, true));
    });
  }

  private async targetAgent(tx: SqlReader, user: AccountRecord, requested: unknown): Promise<AccountRecord> {
    if (user.role === 'agent') return user;
    const result = await tx.query(sqlQuery('read',
      'SELECT * FROM ' + this.schema + ".users WHERE id=? AND role='agent' AND active=1",
      'SELECT * FROM ' + this.schema + ".users WHERE id=$1 AND role='agent' AND active=1"), [textField(requested)]);
    if (result.rows.length !== 1) throw new AccountWriteError(400, 'active_agent_required');
    const target = accountRecord(result.rows[0]);
    if (!await orderAgentAllowed(tx, this.schema, user, target.id)) throw new AccountWriteError(404, 'agent_not_found');
    return target;
  }

  create(identity: RequestActorSnapshot, input: Body): Promise<DraftCreated> {
    const body = bodyCopy(input);
    return withCapturedOrderWrite(this.database, this.applicationSchema, identity, async (tx, user) => {
      if (typeof body.kind !== 'string' || !kinds.includes(body.kind)) throw new AccountWriteError(400, 'invalid_order_kind');
      const kind = body.kind as Kind, agent = await this.targetAgent(tx, user, body.agentId), id = textField(body.id, 80);
      // Preserve the existing accepted identifier grammar; do not silently
      // reinterpret historical offline identifiers as a stricter UUID version.
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new AccountWriteError(400, 'invalid_order_id');
      if (await this.row(tx, id)) return { created: false, order: orderView(await this.accessible(tx, id, user)) };
      if (agent.warehouseId === null) throw new AccountWriteError(409, 'order_or_authority_changed');
      const createdAt = new Date(accountClock(this.clock)).toISOString();
      const prefix = kind === 'stand_client' ? 'AVS' : kind === 'sim' ? 'SIM' : kind === 'stands' ? 'STD' : kind === 'combined' ? 'COM' : 'ACC';
      const number = prefix + '-' + createdAt.slice(0, 10).replaceAll('-', '') + '-' + id.slice(0, 8).toUpperCase();
      const warehouseName = agent.warehouseName || this.seed.warehouses.find(w => w.id === agent.warehouseId)?.name || null;
      let order: Order = { id, number, userId: agent.id, agentName: agent.name, warehouseId: agent.warehouseId,
        warehouseName: warehouseName!, kind, status: 'draft', items: [], standItems: kind === 'combined' ? [] : undefined,
        serials: [], client: null, notes: '', createdAt, finalizedAt: null, sourceOrderId: null, revision: 1, total: 0, pieces: 0 };
      if (body.sourceOrderId) {
        const source = orderView(await this.accessible(tx, textField(body.sourceOrderId), user));
        if (source.kind !== kind || source.userId !== agent.id) throw new AccountWriteError(400, 'copy_agent_or_kind_differs');
        order = { ...order, items: source.items, standItems: kind === 'combined' ? source.standItems || [] : undefined,
          serials: kind === 'combined' || kind === 'sim' ? [] : source.serials, client: source.client, notes: source.notes,
          sourceOrderId: source.id, total: source.total, pieces: kind === 'sim' ? 0 : kind === 'combined'
            ? source.items.reduce((sum, line) => sum + line.quantity, 0) + (source.standItems || []).reduce((sum, line) => sum + line.quantity, 0)
            : source.pieces };
      }
      const result = await tx.query(sqlQuery('write',
        'INSERT OR IGNORE INTO ' + this.schema + '.orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,source_order_id) '
          + "SELECT ?,?,?,?,?,'draft',?,?,? WHERE EXISTS (SELECT 1 FROM " + this.schema + ".users WHERE id=? AND active=1 AND role='agent' AND warehouse_id IS ?)",
        'INSERT INTO ' + this.schema + '.orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,source_order_id) '
          + "SELECT $1,$2,$3,$4,$5,'draft',$6,$7,$8 WHERE EXISTS (SELECT 1 FROM " + this.schema
          + ".users WHERE id=$9 AND active=1 AND role='agent' AND warehouse_id IS NOT DISTINCT FROM $10::text) ON CONFLICT DO NOTHING"),
      [id, number, agent.id, agent.warehouseId, kind, JSON.stringify(order), createdAt, order.sourceOrderId, agent.id, agent.warehouseId]);
      if (result.changes !== 1) {
        const existing = await this.row(tx, id);
        // A number collision with a different UUID never substitutes another
        // order. This is distinct from the early authorized UUID retry above.
        if (!existing || existing.status === 'deleted' || existing.user_id !== agent.id || existing.kind !== kind) {
          throw new AccountWriteError(409, 'order_or_authority_changed');
        }
        return { created: false, order: orderView(await this.accessible(tx, id, user)) };
      }
      return { created: true, order: orderView(await this.accessible(tx, id, user)) };
    }, this.clock);
  }

  private async catalog(tx: SqlReader): Promise<Product[]> {
    const read = async (key: string) => {
      const result = await tx.query(sqlQuery('read', 'SELECT value FROM ' + this.schema + '.settings WHERE key=?',
        'SELECT value FROM ' + this.schema + '.settings WHERE key=$1'), [key]);
      return result.rows.length ? text(result.rows[0].value) : null;
    };
    const raw = await read('catalog');
    const state: { overrides: Record<string, Product | null> } = raw === null ? { overrides: {} } : JSON.parse(raw);
    const products = new Map(this.seed.products.map(p => [p.id, p]));
    for (const [id, product] of Object.entries(state.overrides)) { if (product) products.set(id, product); else products.delete(id); }
    const mappingRaw = await read('inventory-ean-v1');
    const mappings: Record<string, string> = mappingRaw === null ? {} : JSON.parse(mappingRaw);
    return [...products.values()].map(p => {
      const eans = p.ean !== undefined ? p.ean ? [p.ean] : [] : Object.entries(mappings)
        .filter(([, code]) => code === stockCode(p.code)).map(([ean]) => ean);
      if (p.ean === undefined && validEan(p.code) && !eans.includes(p.code)) eans.push(p.code);
      const product = { ...p, ean: eans[0] || '', eans };
      return { ...product, version: createHash('sha256').update(JSON.stringify(product)).digest('hex') };
    });
  }

  private async payload(tx: SqlReader, body: Body, order: Order): Promise<Order> {
    const products = await this.catalog(tx);
    const items = order.kind === 'combined' ? lines(body.items, 'accessories', products)
      : order.kind === 'sim' ? [] : lines(body.items, order.kind, products);
    const standItems = order.kind === 'combined' ? lines(body.standItems, 'stands', products) : [];
    let serials: string[] = [];
    if (body.serials !== undefined) {
      if (!Array.isArray(body.serials) || body.serials.length > 1000) throw new AccountWriteError(400, 'invalid_order_serials');
      serials = body.serials.map(serial => {
        if (typeof serial !== 'string') throw new AccountWriteError(400, 'invalid_order_serial');
        const cleaned = serial.replace(/\s/g, '');
        if (!/^\d{18,22}$/.test(cleaned)) throw new AccountWriteError(400, 'invalid_order_serial');
        return cleaned;
      });
      if (new Set(serials).size !== serials.length) throw new AccountWriteError(400, 'duplicate_order_serial');
    }
    let client: Client | null = null;
    if (body.clientId) {
      const result = await tx.query(sqlQuery('read',
        'SELECT data,warehouse_id FROM ' + this.schema + '.customers WHERE id=? AND active=1',
        'SELECT data,warehouse_id FROM ' + this.schema + '.customers WHERE id=$1 AND active=1'), [textField(body.clientId)]);
      if (result.rows.length !== 1) throw new AccountWriteError(400, 'client_outside_warehouse');
      const value = JSON.parse(text(result.rows[0].data));
      const candidates = customerWarehouseValues(value.warehouseIds, result.rows[0].warehouse_id);
      if (!candidates.some(id => id === order.warehouseId)) throw new AccountWriteError(400, 'client_outside_warehouse');
      client = { ...value, warehouseId: order.warehouseId };
    }
    if (order.kind === 'stand_client' && serials.length) throw new AccountWriteError(400, 'stand_order_has_serials');
    if (order.kind !== 'sim' && order.kind !== 'stand_client' && (serials.length || client)) {
      throw new AccountWriteError(400, 'client_or_serials_not_allowed');
    }
    return { ...order, items, standItems: order.kind === 'combined' ? standItems : undefined, serials, client,
      notes: textField(body.notes, 2000), total: Math.round(items.reduce((sum, line) => sum + (line.price || 0) * line.quantity, 0) * 100) / 100,
      pieces: order.kind === 'sim' ? serials.length : items.reduce((sum, line) => sum + line.quantity, 0)
        + standItems.reduce((sum, line) => sum + line.quantity, 0) + serials.length };
  }

  save(identity: RequestActorSnapshot, id: string, input: Body): Promise<Order> {
    const body = bodyCopy(input);
    return withCapturedOrderWrite(this.database, this.applicationSchema, identity, async (tx, user) => {
      const order = orderView(await this.accessible(tx, id, user));
      if (order.status !== 'draft') throw new AccountWriteError(409, 'order_finalized');
      if (body.revision !== order.revision) throw new AccountWriteError(409, 'order_changed');
      const next = await this.payload(tx, body, order);
      if (JSON.stringify({ ...next, standItems: next.standItems ?? [] }) === JSON.stringify(order)) {
        const current = await this.row(tx, id);
        if (!current || current.status !== 'draft' || accountRevision(current.revision) !== order.revision) {
          throw new AccountWriteError(409, 'order_changed');
        }
        return order;
      }
      const changed = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".orders SET payload=?,revision=revision+1 WHERE id=? AND status='draft' AND revision=?",
        'UPDATE ' + this.schema + ".orders SET payload=$1,revision=revision+1 WHERE id=$2 AND status='draft' AND revision=$3"),
      [JSON.stringify(next), id, order.revision]);
      if (changed.changes !== 1) throw new AccountWriteError(409, 'order_changed');
      return orderView(await this.accessible(tx, id, user));
    }, this.clock);
  }

  remove(identity: RequestActorSnapshot, id: string, input: Body): Promise<DraftDeleted> {
    const body = bodyCopy(input);
    return withCapturedOrderWrite(this.database, this.applicationSchema, identity, async (tx, user) => {
      const row = await this.accessible(tx, id, user), order = orderView(row);
      if (user.role !== 'manager' && order.status !== 'draft') throw new AccountWriteError(403, 'only_own_draft_deletion');
      if (body.revision !== order.revision) throw new AccountWriteError(409, 'order_changed');
      const payload = { ...JSON.parse(text(row.payload)), deletedAt: new Date(accountClock(this.clock)).toISOString(),
        deletedBy: user.id, previousStatus: order.status };
      const changed = await tx.query(sqlQuery('write',
        'UPDATE ' + this.schema + ".orders SET status='deleted',payload=?,revision=revision+1 WHERE id=? AND status!='deleted' AND revision=?",
        'UPDATE ' + this.schema + ".orders SET status='deleted',payload=$1,revision=revision+1 WHERE id=$2 AND status!='deleted' AND revision=$3"),
      [JSON.stringify(payload), id, order.revision]);
      if (changed.changes !== 1) throw new AccountWriteError(409, 'order_changed');
      // The precise UPDATE count, in the same writer transaction, replaces the
      // old connection-local changes()/temporary settings proof-key sequence.
      await tx.query(sqlQuery('write', 'DELETE FROM ' + this.schema + '.serials WHERE order_id=?',
        'DELETE FROM ' + this.schema + '.serials WHERE order_id=$1'), [id]);
      return { ok: true, deletedId: id, revision: order.revision + 1 };
    }, this.clock);
  }
}
