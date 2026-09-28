import { db, fail, isGlobalManager } from './server';
import type { User } from './types';

export type ManagerFilter = { agentIds: string[]; warehouseIds: string[]; siteCodes: string[] };
type Agent = { id: string; warehouse_id: string | null; site_code: string | null };

/** Optional manager filters narrow the authenticated scope; they never replace it. */
export async function managerFilter(user: User, params: URLSearchParams): Promise<ManagerFilter | null> {
  const managerId = params.get('managerId') || '';
  const agentId = params.get('agentId') || '';
  if (!managerId && !agentId) return null;
  if (user.role !== 'manager') fail(403, 'Filtrul este disponibil doar managerilor.');
  if (managerId.length > 128 || agentId.length > 128) fail(400, 'Filtrul este invalid.');
  const clauses = ["u.role='agent'"], args: string[] = [];
  if (!isGlobalManager(user)) {
    clauses.push('EXISTS (SELECT 1 FROM manager_agents own WHERE own.manager_id=? AND own.agent_id=u.id)');
    args.push(user.id);
  }
  if (managerId) {
    if (managerId === '__unassigned') {
      if (!isGlobalManager(user)) fail(404, 'Regiunea nu a fost găsită.');
      clauses.push("NOT EXISTS (SELECT 1 FROM manager_agents region JOIN users m ON m.id=region.manager_id WHERE region.agent_id=u.id AND m.role='manager' AND m.manager_scope='assigned' AND m.active=1)");
    } else {
      const region = await db().prepare("SELECT id FROM users WHERE id=? AND role='manager' AND manager_scope='assigned' AND active=1").bind(managerId).first<{id: string}>();
      if (!region || (!isGlobalManager(user) && managerId !== user.id)) fail(404, 'Regiunea nu a fost găsită.');
      clauses.push('EXISTS (SELECT 1 FROM manager_agents region WHERE region.manager_id=? AND region.agent_id=u.id)');
      args.push(managerId);
    }
  }
  const rows = (await db().prepare(`SELECT u.id,u.warehouse_id,u.site_code FROM users u WHERE ${clauses.join(' AND ')} ORDER BY u.id`).bind(...args).all<Agent>()).results;
  if (agentId && !rows.some(row => row.id === agentId)) fail(404, 'Agentul nu a fost găsit în selecție.');
  const selected = agentId ? rows.filter(row => row.id === agentId) : rows;
  const unique = (values: (string | null)[]) => [...new Set(values.map(value => value?.trim() || '').filter(Boolean))];
  return { agentIds: selected.map(row => row.id), warehouseIds: unique(selected.map(row => row.warehouse_id)), siteCodes: unique(selected.map(row => row.site_code)) };
}
