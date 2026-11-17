import type { NotificationFeed, NotificationItem } from './leave-types';
import { operationalWriteGuard } from './operational-write-guard';
import { db, fail, jsonBody, response } from './server';
import type { User } from './types';

const categories = ['all', 'leave', 'partner', 'activation', 'order'] as const;
type Category = typeof categories[number];
type Filters = { category: Category; unreadOnly: boolean; limit: number; offset: number };
type Guard = { sql: string; args: Parameters<ReturnType<ReturnType<typeof db>['prepare']>['bind']> };
type EventInput = {
  recipientId: string; eventKey: string; category: string; title: string; body: string;
  targetType: string; targetId: string; createdAt: string;
};

const pageSize = 30;
const legacyPrefix = 'partner:';

// The caller may place this after its domain write in the same transaction.
export function notificationInsert(event: EventInput, guard: Guard = { sql: '1', args: [] }) {
  return db().prepare(`
    INSERT INTO notifications(id,recipient_id,event_key,category,title,body,target_type,target_id,created_at)
    SELECT ?,?,?,?,?,?,?,?,?
    FROM users recipient WHERE recipient.id=? AND recipient.active=1 AND (${guard.sql})
    ON CONFLICT(recipient_id,event_key) DO NOTHING
  `).bind(crypto.randomUUID(), event.recipientId, event.eventKey, event.category, event.title, event.body,
    event.targetType, event.targetId, event.createdAt, event.recipientId, ...guard.args);
}

// Notification queries and optional push delivery use the recipient's current access.
export const notificationRecipientScope = `
  (n.category != 'leave' OR EXISTS (
    SELECT 1 FROM leave_requests lr WHERE lr.id=n.target_id AND (
      (recipient.role='agent' AND lr.agent_id=recipient.id) OR
      (recipient.role='manager' AND (recipient.manager_scope='global' OR EXISTS (
        SELECT 1 FROM manager_agents ma WHERE ma.manager_id=recipient.id AND ma.agent_id=lr.agent_id
      )))
    )
  ))`;
const partnerScope = `
  recipient.role='manager' AND pr.status='confirmed' AND pr.confirmed_by=pr.agent_id
  AND (recipient.manager_scope='global' OR EXISTS (
    SELECT 1 FROM manager_agents ma WHERE ma.manager_id=recipient.id AND ma.agent_id=pr.agent_id
  ))`;
const recipientCte = (guard: Guard) => `
  recipient AS (
    SELECT id,role,manager_scope FROM users WHERE id=? AND ${guard.sql}
  )`;

type DbRow = NotificationItem & Pick<NotificationFeed, 'unread' | 'categoryUnread' | 'total'>;
function category(value: unknown): Category {
  if (value === null || value === undefined) return 'all';
  if (categories.includes(value as Category)) return value as Category;
  fail(400, 'Categoria notificărilor este invalidă.');
}

function readFilters(req: Request): Filters {
  const params = new URL(req.url).searchParams;
  const offset = Number(params.get('offset') ?? 0);
  const limit = Number(params.get('limit') ?? pageSize);
  const unread = params.get('unread');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > pageSize ||
    (unread !== null && unread !== '0' && unread !== '1')) fail(400, 'Filtrele notificărilor sunt invalide.');
  return { category: category(params.get('category')), unreadOnly: unread === '1', limit, offset };
}

async function feed(user: User, guard: Guard, filters: Filters): Promise<NotificationFeed> {
  // Counts and sorting touch only inbox metadata. Expand text for the selected page.
  const result = await db().prepare(`
    WITH ${recipientCte(guard)},
    selection(category,unread_only) AS (VALUES (?,?)),
    inbox AS (
      SELECT n.id rawId,n.id,n.category,n.created_at createdAt,n.read_at readAt,NULL partnerAgentId
      FROM recipient CROSS JOIN notifications n ON n.recipient_id=recipient.id
      WHERE ${notificationRecipientScope}
      UNION ALL
      SELECT pr.id,'partner:'||pr.id,'partner',pr.created_at,s.value,pr.agent_id
      FROM recipient CROSS JOIN partner_requests pr
      LEFT JOIN settings s ON s.key='partner-read:'||recipient.id||':'||pr.id
      WHERE ${partnerScope} AND json_valid(pr.payload)
    ), categorized AS (
      SELECT inbox.*,selection.category='all' OR inbox.category=selection.category categoryMatch
      FROM inbox CROSS JOIN selection
    ), page AS (
      SELECT * FROM categorized CROSS JOIN selection WHERE categoryMatch AND (NOT unread_only OR readAt IS NULL)
      ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?
    ), totals AS (
      SELECT COUNT(*) FILTER (WHERE readAt IS NULL) unread,
        COUNT(*) FILTER (WHERE categoryMatch AND readAt IS NULL) categoryUnread,
        COUNT(*) FILTER (WHERE categoryMatch AND (NOT unread_only OR readAt IS NULL)) total
      FROM categorized CROSS JOIN selection
    )
    SELECT page.id,page.category,page.createdAt,page.readAt,totals.*,
      CASE WHEN page.partnerAgentId IS NULL THEN n.title
        ELSE COALESCE(NULLIF(json_extract(pr.payload,'$.company'),''),'Partener nou') END title,
      CASE WHEN page.partnerAgentId IS NULL THEN n.body
        ELSE u.name||COALESCE(' · '||NULLIF(json_extract(pr.payload,'$.location'),''),'')
          ||COALESCE(' · '||NULLIF(json_extract(pr.payload,'$.county'),''),'') END body,
      COALESCE(n.target_type,'partner') targetType,COALESCE(n.target_id,pr.id) targetId
    FROM recipient CROSS JOIN totals LEFT JOIN page ON 1=1
    LEFT JOIN notifications n ON page.partnerAgentId IS NULL AND n.id=page.rawId
    LEFT JOIN partner_requests pr ON page.partnerAgentId IS NOT NULL AND pr.id=page.rawId
    LEFT JOIN users u ON u.id=page.partnerAgentId
    ORDER BY page.createdAt DESC,page.id DESC
  `).bind(user.id, ...guard.args, filters.category, Number(filters.unreadOnly), filters.limit, filters.offset).all<DbRow>();
  const first = result.results[0];
  if (!first) fail(409, 'Sesiunea sau accesul s-a schimbat. Reîncarcă aplicația.');
  const items = result.results
    .filter(row => row.id !== null)
    .map(({ id, category, title, body, targetType, targetId, createdAt, readAt }) =>
      ({ id, category, title: String(title), body, targetType, targetId, createdAt, readAt }));
  return {
    items, unread: first.unread, categoryUnread: first.categoryUnread, total: first.total,
    hasMore: filters.offset + items.length < first.total,
  };
}

async function markRead(req: Request, user: User, guard: Guard) {
  const body = await jsonBody(req);
  const selectedCategory = category(body.category);
  const all = body.all === true;
  const ids = body.ids;
  if ((all && ids !== undefined) || (!all && (!Array.isArray(ids) || ids.length < 1 || ids.length > pageSize ||
    ids.some(id => typeof id !== 'string' || !/^(?:partner:)?[0-9a-f-]{36}$/i.test(id))))) {
    fail(400, 'Notificările selectate sunt invalide.');
  }
  const nativeIds: string[] = [];
  const partnerIds: string[] = [];
  if (Array.isArray(ids)) {
    for (const id of new Set<string>(ids)) {
      if (id.startsWith(legacyPrefix)) partnerIds.push(id.slice(legacyPrefix.length));
      else nativeIds.push(id);
    }
  }

  const statements = [];
  const now = new Date().toISOString();
  if (all || nativeIds.length) {
    const selection = all ? "(?='all' OR n.category=?)" : `n.id IN (${nativeIds.map(() => '?').join(',')})`;
    statements.push(db().prepare(`
      WITH ${recipientCte(guard)}
      UPDATE notifications SET read_at=?
      WHERE id IN (
        SELECT n.id FROM notifications n JOIN recipient ON n.recipient_id=recipient.id
        WHERE n.read_at IS NULL AND ${notificationRecipientScope} AND ${selection}
      )
    `).bind(user.id, ...guard.args, now, ...(all ? [selectedCategory, selectedCategory] : nativeIds)));
  }
  if ((all && (selectedCategory === 'all' || selectedCategory === 'partner')) || partnerIds.length) {
    const selection = all ? '1' : `pr.id IN (${partnerIds.map(() => '?').join(',')})`;
    statements.push(db().prepare(`
      WITH ${recipientCte(guard)}
      INSERT INTO settings(key,value)
      SELECT 'partner-read:'||recipient.id||':'||pr.id,?
      FROM recipient CROSS JOIN partner_requests pr WHERE ${partnerScope} AND json_valid(pr.payload) AND ${selection}
      ON CONFLICT(key) DO NOTHING
    `).bind(user.id, ...guard.args, now, ...partnerIds));
  }
  if (statements.length) await db().batch(statements);
  return feed(user, guard, { category: selectedCategory, unreadOnly: body.unread === true, limit: pageSize, offset: 0 });
}

export async function notificationCenter(req: Request, user: User, path: string[]): Promise<Response | null> {
  if (path.length !== 2 || path[0] !== 'notifications') return null;
  if (path[1] === 'feed' && req.method === 'GET') {
    return response(await feed(user, operationalWriteGuard(req, user), readFilters(req)));
  }
  if (path[1] === 'read' && req.method === 'POST') {
    return response(await markRead(req, user, operationalWriteGuard(req, user)));
  }
  return null;
}
