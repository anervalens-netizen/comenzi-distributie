import { bucharestDayStartUtc } from './bucharest-month';
import { AccountWriteError, accountClock, accountRevision, captureSessionIdentity,
  requireSessionInTransaction, type AccountRecord, type SessionIdentity } from './session-repository-async';
import { safeSqlInteger, sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader,
  type SqlRow, type SqlValue } from './sql-database';
import type { Order } from './types';

type Cursor = Readonly<{ createdAt: string; id: string }>;
type Condition = Readonly<{ sqlite: string; postgresql: string }>;
type Filter = { conditions: Condition[]; values: SqlValue[] };
export type OrderListPage = Readonly<{ orders: Order[]; weekKey: string; orderPage: {
  revision: string; total: number; limit: number; nextCursor: string | null;
  stats: { drafts: number; weekly: number };
} }>;
export class OrderListChangedError extends AccountWriteError {
  constructor(readonly currentRevision: string) { super(409, 'order_list_changed'); }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid order list text');
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function compactOrder(row: SqlRow): Order {
  const payload = JSON.parse(text(row.payload));
  const detailed = Array.isArray(payload.items) || Array.isArray(payload.standItems);
  const items = payload.items || [], standItems = payload.standItems || [];
  return { ...payload, items, standItems, serials: payload.serials || [],
    itemCount: detailed ? items.length + standItems.length : payload.itemCount ?? 0,
    id: text(row.id), number: text(row.number), userId: text(row.user_id), warehouseId: text(row.warehouse_id),
    kind: text(row.kind) as Order['kind'], status: text(row.status) as Order['status'],
    createdAt: text(row.created_at), finalizedAt: nullableText(row.finalized_at),
    sourceOrderId: nullableText(row.source_order_id), revision: accountRevision(row.revision) };
}
export function orderSearchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('ro');
}
export function encodeOrderListCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify([value.createdAt, value.id])).toString('base64url');
}
export function decodeOrderListCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
      && value[0].length <= 40 && value[1].length <= 100) return { createdAt: value[0], id: value[1] };
  } catch { /* Preserve the existing cursor acceptance grammar. */ }
  throw new AccountWriteError(400, 'invalid_order_cursor');
}
const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function orderWeekKey(date: Date): string {
  const parts = localDate.formatToParts(date);
  const get = (kind: string) => parts.find(part => part.type === kind)!.value;
  const day = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
function cutoff(date: Date, range: string): string {
  const days = range === 'day' ? 0 : range === '7d' ? 6 : 29;
  const noon = new Date(localDate.format(date) + 'T12:00:00Z');
  noon.setUTCDate(noon.getUTCDate() - days);
  return bucharestDayStartUtc(noon.toISOString().slice(0, 10));
}
function clause(filter: Filter, sqlite: string, postgresql = sqlite, values: readonly SqlValue[] = []): void {
  filter.conditions.push({ sqlite, postgresql }); filter.values.push(...values);
}
function copyFilter(filter: Filter): Filter { return { conditions: [...filter.conditions], values: [...filter.values] }; }
function where(filter: Filter, dialect: 'sqlite' | 'postgresql'): string {
  return filter.conditions.map(condition => condition[dialect]).join(' AND ');
}
function count(value: unknown): number {
  const number = safeSqlInteger(value ?? 0);
  if (number < 0) throw new Error('Invalid order list count');
  return number;
}

/** Prepared reads only. A backend selector and HTTP mapping are separate work. */
export class OrderListRepository {
  private readonly schema: string;
  constructor(private readonly database: AsyncSqlDatabase, applicationSchema: string,
    private readonly clock: () => number = Date.now) { this.schema = sqlIdentifier(applicationSchema); }

  private async user(tx: SqlReader, identity: SessionIdentity, now: number): Promise<AccountRecord> {
    const { user } = await requireSessionInTransaction(tx, this.schema, identity, now);
    if (user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
    return user;
  }
  private select(dialect: 'sqlite' | 'postgresql'): string {
    const fields = 'o.id,o.number,o.user_id,o.warehouse_id,o.kind,o.status,o.created_at,o.finalized_at,o.source_order_id,o.revision,';
    const payload = dialect === 'sqlite'
      ? "json_set(json_remove(o.payload,'$.items','$.standItems','$.serials','$.exportKey'),'$.itemCount',COALESCE(json_array_length(o.payload,'$.items'),0)+COALESCE(json_array_length(o.payload,'$.standItems'),0))"
      : "jsonb_set(o.payload::jsonb - ARRAY['items','standItems','serials','exportKey'],'{itemCount}',to_jsonb("
        + "CASE WHEN jsonb_typeof(o.payload::jsonb->'items')='array' THEN jsonb_array_length(o.payload::jsonb->'items') ELSE 0 END + "
        + "CASE WHEN jsonb_typeof(o.payload::jsonb->'standItems')='array' THEN jsonb_array_length(o.payload::jsonb->'standItems') ELSE 0 END))::text";
    return 'SELECT ' + fields + payload + ' AS payload FROM ' + this.schema + '.orders o';
  }
  private order(dialect: 'sqlite' | 'postgresql'): string {
    return dialect === 'postgresql' ? ' ORDER BY o.created_at COLLATE "C" DESC,o.id COLLATE "C" DESC'
      : ' ORDER BY o.created_at COLLATE BINARY DESC,o.id COLLATE BINARY DESC';
  }
  private scope(user: AccountRecord): Filter {
    const filter: Filter = { conditions: [], values: [] };
    clause(filter, "o.status!='deleted'");
    if (user.role === 'agent') clause(filter, 'o.user_id=?', 'o.user_id=$1', [user.id]);
    else if (user.role !== 'manager') clause(filter,
      'EXISTS (SELECT 1 FROM ' + this.schema + '.manager_agents own WHERE own.manager_id=? AND own.agent_id=o.user_id)',
      'EXISTS (SELECT 1 FROM ' + this.schema + '.manager_agents own WHERE own.manager_id=$1 AND own.agent_id=o.user_id)', [user.id]);
    // Every manager has national READ scope, including an assigned manager.
    // This method grants no write capability and never changes actor authority.
    return filter;
  }
  private async managerFilter(tx: SqlReader, user: AccountRecord, params: URLSearchParams): Promise<string[] | null> {
    const managerId = params.get('managerId') || '', agentId = params.get('agentId') || '';
    if (!managerId && !agentId) return null;
    if (user.role !== 'manager') throw new AccountWriteError(403, 'manager_filter_required');
    if (managerId.length > 128 || agentId.length > 128) throw new AccountWriteError(400, 'invalid_manager_filter');
    const filter: Filter = { conditions: [{ sqlite: "u.role='agent'", postgresql: "u.role='agent'" }], values: [] };
    if (managerId === '__unassigned') {
      clause(filter, 'NOT EXISTS (SELECT 1 FROM ' + this.schema + '.manager_agents region JOIN ' + this.schema
        + ".users m ON m.id=region.manager_id WHERE region.agent_id=u.id AND m.role='manager' AND m.manager_scope='assigned' AND m.active=1)");
    } else if (managerId) {
      const region = await tx.query(sqlQuery('read', 'SELECT id FROM ' + this.schema
        + ".users WHERE id=? AND role='manager' AND manager_scope='assigned' AND active=1", 'SELECT id FROM ' + this.schema
        + ".users WHERE id=$1 AND role='manager' AND manager_scope='assigned' AND active=1"), [managerId]);
      if (region.rows.length !== 1) throw new AccountWriteError(404, 'manager_region_not_found');
      clause(filter, 'EXISTS (SELECT 1 FROM ' + this.schema + '.manager_agents region WHERE region.manager_id=? AND region.agent_id=u.id)',
        'EXISTS (SELECT 1 FROM ' + this.schema + '.manager_agents region WHERE region.manager_id=$1 AND region.agent_id=u.id)', [managerId]);
    }
    const rows = await tx.query(sqlQuery('read', 'SELECT u.id FROM ' + this.schema + '.users u WHERE ' + where(filter, 'sqlite') + ' ORDER BY u.id COLLATE BINARY',
      'SELECT u.id FROM ' + this.schema + '.users u WHERE ' + where(filter, 'postgresql') + ' ORDER BY u.id COLLATE "C"'), filter.values);
    const ids = rows.rows.map(row => text(row.id));
    if (agentId && !ids.includes(agentId)) throw new AccountWriteError(404, 'agent_not_in_selection');
    return agentId ? [agentId] : ids;
  }
  private async revision(tx: SqlReader): Promise<string> {
    const result = await tx.query(sqlQuery('read', 'SELECT revision FROM ' + this.schema + '.order_list_revision WHERE id=1',
      'SELECT revision FROM ' + this.schema + '.order_list_revision WHERE id=1'));
    const raw = result.rows[0]?.revision;
    // Preserve the historical missing/zero singleton fallback, with no BIGINT loss.
    const value = raw === undefined || raw === null ? 1 : safeSqlInteger(raw);
    if (value < 0) throw new Error('Invalid order list revision');
    return String(value || 1);
  }

  listOrders(identity: SessionIdentity): Promise<Order[]> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const user = await this.user(tx, actor, accountClock(this.clock)), filter = this.scope(user);
      const result = await tx.query(sqlQuery('read',
        this.select('sqlite') + ' WHERE ' + where(filter, 'sqlite') + this.order('sqlite'),
        this.select('postgresql') + ' WHERE ' + where(filter, 'postgresql') + this.order('postgresql')), filter.values);
      return result.rows.map(compactOrder);
    });
  }

  async listOrdersPage(identity: SessionIdentity, input: URLSearchParams): Promise<OrderListPage> {
    const actor = captureSessionIdentity(identity), params = new URLSearchParams(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.database.read(async tx => {
        const now = accountClock(this.clock), user = await this.user(tx, actor, now), date = new Date(now);
        const requested = Number(params.get('limit') || 40);
        const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 40;
        const kind = params.get('kind') || 'orders', status = params.get('status') || 'all', range = params.get('range') || '7d';
        const query = (params.get('q') || '').trim().slice(0, 200);
        if (!['orders', 'sim', 'all'].includes(kind) || !['all', 'draft', 'finalized'].includes(status)
          || !['day', '7d', '30d', 'all'].includes(range)) throw new AccountWriteError(400, 'invalid_order_list_filter');
        const scope = this.scope(user), agents = await this.managerFilter(tx, user, params);
        if (agents !== null) {
          const offset = scope.values.length;
          clause(scope, agents.length ? 'o.user_id IN (' + agents.map(() => '?').join(',') + ')' : '0',
            agents.length ? 'o.user_id IN (' + agents.map((_, index) => '$' + (offset + index + 1)).join(',') + ')' : 'FALSE', agents);
        }
        const filter = copyFilter(scope);
        if (kind === 'orders') clause(filter, "o.kind NOT IN ('sim','stand_client')");
        if (kind === 'sim') clause(filter, "o.kind IN ('sim','stand_client')");
        if (status !== 'all') clause(filter, 'o.status=?', 'o.status=$' + (filter.values.length + 1), [status]);
        if (range !== 'all') clause(filter, "(o.status='draft' OR COALESCE(o.finalized_at,o.created_at)>=?)",
          "(o.status='draft' OR COALESCE(o.finalized_at,o.created_at) COLLATE \"C\">=$" + (filter.values.length + 1) + ')', [cutoff(date, range)]);
        const revision = await this.revision(tx), expected = params.get('revision');
        if (expected && expected !== revision) throw new OrderListChangedError(revision);
        const cursor = decodeOrderListCursor(params.get('cursor'));
        let rows: SqlRow[], total: number;
        if (query) {
          const result = await tx.query(sqlQuery('read', this.select('sqlite') + ' WHERE ' + where(filter, 'sqlite') + this.order('sqlite'),
            this.select('postgresql') + ' WHERE ' + where(filter, 'postgresql') + this.order('postgresql')), filter.values);
          const needle = orderSearchText(query), filtered = result.rows.filter(row => {
            const order = compactOrder(row);
            return orderSearchText([order.number, order.agentName, order.warehouseName, order.client?.name, order.client?.cui].join(' ')).includes(needle);
          });
          total = filtered.length;
          // Preserve the legacy JS comparison specifically on the search path.
          const after = cursor ? filtered.filter(row => text(row.created_at) < cursor.createdAt
            || text(row.created_at) === cursor.createdAt && text(row.id) < cursor.id) : filtered;
          rows = after.slice(0, limit + 1);
        } else {
          const result = await tx.query(sqlQuery('read', 'SELECT COUNT(*) AS count FROM ' + this.schema + '.orders o WHERE ' + where(filter, 'sqlite'),
            'SELECT COUNT(*) AS count FROM ' + this.schema + '.orders o WHERE ' + where(filter, 'postgresql')), filter.values);
          total = count(result.rows[0]?.count);
          const page = copyFilter(filter);
          if (cursor) {
            const offset = page.values.length;
            clause(page, '(o.created_at COLLATE BINARY<? OR (o.created_at COLLATE BINARY=? AND o.id COLLATE BINARY<?))',
              '(o.created_at COLLATE "C"<$' + (offset + 1) + ' OR (o.created_at COLLATE "C"=$' + (offset + 2)
              + ' AND o.id COLLATE "C"<$' + (offset + 3) + '))', [cursor.createdAt, cursor.createdAt, cursor.id]);
          }
          rows = (await tx.query(sqlQuery('read', this.select('sqlite') + ' WHERE ' + where(page, 'sqlite') + this.order('sqlite') + ' LIMIT ?',
            this.select('postgresql') + ' WHERE ' + where(page, 'postgresql') + this.order('postgresql') + ' LIMIT $' + (page.values.length + 1)), [...page.values, limit + 1])).rows;
        }
        const statsFilter = copyFilter(scope);
        if (kind === 'orders') clause(statsFilter, "o.kind NOT IN ('sim','stand_client')");
        if (kind === 'sim') clause(statsFilter, "o.kind IN ('sim','stand_client')");
        const weekKey = orderWeekKey(date);
        const statistics = await tx.query(sqlQuery('read',
          "SELECT SUM(CASE WHEN s.status='draft' THEN 1 ELSE 0 END) AS drafts,SUM(CASE WHEN s.status='finalized' AND s.week_key=c.current_week THEN 1 ELSE 0 END) AS weekly FROM "
            + '(SELECT o.status,o.week_key FROM ' + this.schema + '.orders o WHERE ' + where(statsFilter, 'sqlite')
            + ') AS s CROSS JOIN (SELECT ? AS current_week) AS c',
          "SELECT SUM(CASE WHEN s.status='draft' THEN 1 ELSE 0 END) AS drafts,SUM(CASE WHEN s.status='finalized' AND s.week_key=c.current_week THEN 1 ELSE 0 END) AS weekly FROM "
            + '(SELECT o.status,o.week_key FROM ' + this.schema + '.orders o WHERE ' + where(statsFilter, 'postgresql')
            + ') AS s CROSS JOIN (SELECT $' + (statsFilter.values.length + 1) + '::text AS current_week) AS c'), [...statsFilter.values, weekKey]);
        const selected = rows.slice(0, limit), last = selected.at(-1);
        const value: OrderListPage = { orders: selected.map(compactOrder), weekKey, orderPage: { revision, total, limit,
          nextCursor: rows.length > limit && last ? encodeOrderListCursor({ createdAt: text(last.created_at), id: text(last.id) }) : null,
          stats: { drafts: count(statistics.rows[0]?.drafts), weekly: count(statistics.rows[0]?.weekly) } } };
        return { value, bound: Boolean(cursor || expected) };
      });
      // A second transaction is necessary: re-reading within REPEATABLE READ
      // would conceal a concurrent writer. Each returned page is one snapshot.
      const currentRevision = await this.database.read(tx => this.revision(tx));
      if (currentRevision === snapshot.value.orderPage.revision) return snapshot.value;
      if (snapshot.bound || attempt === 2) throw new OrderListChangedError(currentRevision);
    }
    throw new Error('Unreachable order list retry state');
  }

}
