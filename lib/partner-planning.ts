import { db, fail } from './server';
import type { User } from './types';
import { partnerScope } from './partner-portfolio';
export function planDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < '2020-01-01' ||
    value > '2100-12-31'
  )
    fail(400, 'Dată invalidă.');
  const d = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    fail(400, 'Dată invalidă.');
  return value;
}
function agent(user: User) {
  if (user.role !== 'agent')
    fail(403, 'Planificarea este disponibilă agenților.');
}
export async function saveDayPlan(user: User, body: Record<string, unknown>) {
  agent(user);
  const date = planDate(body.date);
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6)
    fail(400, 'Planifică magazinele de luni până vineri.');
  const revision = body.revision,
    stops = body.stops;
  if (
    !Number.isInteger(revision) ||
    Number(revision) < 0 ||
    !Array.isArray(stops) ||
    stops.length > 100 ||
    stops.some((x) => typeof x !== 'string' || !x || x.length > 200) ||
    new Set(stops).size !== stops.length
  )
    fail(400, 'Plan invalid; maximum 100 de magazine distincte pe zi.');
  const s = partnerScope(user),
    payload = JSON.stringify(stops);
  // Scope is checked in the same statement as the write, including common portfolios.
  const valid = `NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=requested.value AND c.active=1 AND ${s.sql}))`;
  const now = new Date().toISOString();
  const result = await db()
    .prepare(
      `INSERT INTO partner_day_plans(agent_id,plan_date,stops,revision,updated_at) SELECT ?,?,?,1,? WHERE ${valid} AND (?=0 OR EXISTS(SELECT 1 FROM partner_day_plans WHERE agent_id=? AND plan_date=?)) ON CONFLICT(agent_id,plan_date) DO UPDATE SET stops=excluded.stops,revision=partner_day_plans.revision+1,updated_at=excluded.updated_at WHERE partner_day_plans.revision=?`,
    )
    .bind(
      user.id,
      date,
      payload,
      now,
      payload,
      ...s.args,
      revision,
      user.id,
      date,
      revision,
    )
    .run();
  if (!result.meta.changes)
    fail(
      409,
      'Planul s-a modificat sau un magazin nu mai este în portofoliu. Reîncarcă planul.',
    );
  return { date, stops, revision: Number(revision) + 1 };
}
export async function visitWeek(user: User, value: string) {
  agent(user);
  const week = planDate(value);
  if (new Date(week + 'T12:00:00Z').getUTCDay() !== 1)
    fail(400, 'Selectează o săptămână care începe luni.');
  const add = (n: number) =>
    new Date(Date.parse(week + 'T12:00:00Z') + n * 86400000)
      .toISOString()
      .slice(0, 10);
  const end = add(7),
    s = partnerScope(user);
  const plans = await db()
    .prepare(
      'SELECT plan_date date,stops,revision FROM partner_day_plans WHERE agent_id=? AND plan_date>=? AND plan_date<? ORDER BY plan_date',
    )
    .bind(user.id, week, end)
    .all<{ date: string; stops: string; revision: number }>();
  const visible = await db()
    .prepare(`SELECT c.id FROM customers c WHERE c.active=1 AND ${s.sql}`)
    .bind(...s.args)
    .all<{ id: string }>();
  const ids = new Set(visible.results.map((x) => x.id));
  // Fetch a bounded UTC envelope; classify exact dates in Europe/Bucharest (DST safe).
  const rows = await db()
    .prepare(
      `SELECT v.id,v.customer_id customerId,v.visited_at visitedAt,v.notes,v.agent_name agentName,json_extract(c.data,'$.name') customerName FROM partner_visits v JOIN customers c ON c.id=v.customer_id WHERE v.agent_id=? AND v.visited_at>=? AND v.visited_at<? AND c.active=1 AND ${s.sql} ORDER BY v.visited_at DESC,v.id DESC`,
    )
    .bind(
      user.id,
      add(-1) + 'T00:00:00.000Z',
      end + 'T00:00:00.000Z',
      ...s.args,
    )
    .all<{
      id: string;
      customerId: string;
      visitedAt: string;
      notes: string;
      agentName: string;
      customerName: string;
    }>();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const visits = rows.results
    .map((v) => ({ ...v, date: fmt.format(new Date(v.visitedAt)) }))
    .filter((v) => v.date >= week && v.date < end);
  return {
    week,
    plans: plans.results.map((p) => ({
      ...p,
      stops: (JSON.parse(p.stops) as string[]).filter((id) => ids.has(id)),
    })),
    visits,
  };
}
