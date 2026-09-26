import { db, fail, isGlobalManager, sha256, textField } from './server';
import type { Client, User } from './types';
import type { PortfolioPartner, PartnerVisit } from './partner-portfolio-types';

type Row = {
  id: string;
  warehouse_id: string;
  data: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  position_source: 'manual' | 'gps' | 'geocoding' | null;
  position_provider: string | null;
  position_accuracy: number | null;
  position_metadata: string | null;
  address_fingerprint: string | null;
  revision: number | null;
  updated_at: string | null;
  last_visited_at: string | null;
};
const membership =
  "SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w";
export function partnerScope(user: User): { sql: string; args: string[] } {
  if (isGlobalManager(user)) return { sql: '1=1', args: [] };
  if (user.role === 'agent')
    return {
      sql: `EXISTS (${membership} WHERE w.value=?)`,
      args: [user.warehouseId || ''],
    };
  return {
    sql: `EXISTS (${membership} JOIN users a ON a.warehouse_id=w.value JOIN manager_agents ma ON ma.agent_id=a.id WHERE ma.manager_id=? AND a.active=1)`,
    args: [user.id],
  };
}
function fingerprint(c: Client) {
  return sha256(
    JSON.stringify([c.address || '', c.city || '', c.county || '']),
  );
}
function view(row: Row): PortfolioPartner {
  const c = JSON.parse(row.data) as Client,
    fp = fingerprint(c),
    valid = row.address_fingerprint === fp;
  let quality: PortfolioPartner['positionQuality'] = null;
  if (valid && row.position_source === 'geocoding') {
    try {
      const metadata = JSON.parse(row.position_metadata || '{}');
      quality = [
        'address',
        'address_approximate',
        'street_approximate',
      ].includes(metadata.positionQuality)
        ? metadata.positionQuality
        : 'address';
    } catch {
      quality = 'address_approximate';
    }
  }
  return {
    ...c,
    positionQuality: quality,
    id: row.id,
    warehouseIds: c.warehouseIds || [row.warehouse_id],
    contact: row.contact || '',
    phone: row.phone || '',
    email: row.email || '',
    latitude: valid ? row.latitude : null,
    longitude: valid ? row.longitude : null,
    positionSource: valid ? row.position_source : null,
    positionAccuracy: valid ? row.position_accuracy : null,
    positionProvider: valid ? row.position_provider : null,
    addressFingerprint: fp,
    revision: row.revision || 0,
    updatedAt: row.updated_at,
    lastVisitedAt: row.last_visited_at,
  };
}
const select = `SELECT c.id,c.warehouse_id,c.data,COALESCE(p.contact,json_extract(r.payload,'$.contact'),'') contact,COALESCE(p.phone,json_extract(r.payload,'$.phone'),'') phone,COALESCE(p.email,json_extract(r.payload,'$.email'),'') email,p.latitude,p.longitude,p.position_source,p.position_accuracy,p.position_provider,p.position_metadata,p.address_fingerprint,p.revision,p.updated_at,(SELECT MAX(v.visited_at) FROM partner_visits v WHERE v.customer_id=c.id) last_visited_at FROM customers c LEFT JOIN partner_profiles p ON p.customer_id=c.id LEFT JOIN partner_requests r ON r.id=(SELECT pr.id FROM partner_requests pr WHERE pr.customer_id=c.id AND pr.status='confirmed' ORDER BY pr.confirmed_at DESC,pr.id DESC LIMIT 1)`;
export async function portfolio(user: User) {
  const s = partnerScope(user);
  const rows = await db()
    .prepare(
      `${select} WHERE c.active=1 AND ${s.sql} ORDER BY json_extract(c.data,'$.name'),c.id`,
    )
    .bind(...s.args)
    .all<Row>();
  return {
    partners: rows.results.map(view),
    observedAt: new Date().toISOString(),
  };
}
async function get(user: User, id: string) {
  const s = partnerScope(user);
  const row = await db()
    .prepare(`${select} WHERE c.id=? AND c.active=1 AND ${s.sql}`)
    .bind(id, ...s.args)
    .first<Row>();
  if (!row) fail(404, 'Partenerul nu a fost găsit.');
  return view(row);
}
export async function partnerDetail(
  user: User,
  id: string,
  cursor: string | null,
) {
  const partner = await get(user, id);
  let before = '';
  let args: string[] = [id];
  if (cursor) {
    let parts: unknown;
    try {
      parts = JSON.parse(cursor);
    } catch {
      fail(400, 'Pagina este invalidă.');
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== 2 ||
      parts.some((x) => typeof x !== 'string')
    )
      fail(400, 'Pagina este invalidă.');
    before = ' AND (visited_at<? OR (visited_at=? AND id<?))';
    args = [id, parts[0], parts[0], parts[1]];
  }
  const rows = (
    await db()
      .prepare(
        `SELECT id,customer_id customerId,agent_id agentId,agent_name agentName,visited_at visitedAt,notes,created_at createdAt FROM partner_visits WHERE customer_id=?${before} ORDER BY visited_at DESC,id DESC LIMIT 51`,
      )
      .bind(...args)
      .all<PartnerVisit>()
  ).results;
  const visits = rows.slice(0, 50),
    last = visits.at(-1);
  const count = await db()
    .prepare('SELECT COUNT(*) n FROM partner_visits WHERE customer_id=?')
    .bind(id)
    .first<{ n: number }>();
  return {
    partner,
    visits,
    visitCount: count?.n || 0,
    nextCursor:
      rows.length > 50 && last
        ? JSON.stringify([last.visitedAt, last.id])
        : null,
  };
}
export async function updatePartner(
  user: User,
  id: string,
  body: Record<string, unknown>,
) {
  const current = await get(user, id),
    expected = body.revision;
  if (
    !Number.isSafeInteger(expected) ||
    expected !== current.revision ||
    body.addressFingerprint !== current.addressFingerprint
  )
    fail(409, 'Datele s-au modificat. Reîncarcă fișa înainte de salvare.');
  const contact = textField(body.contact, 200),
    phone = textField(body.phone, 80),
    email = textField(body.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail(400, 'Adresa de email este invalidă.');
  const latitude = body.latitude,
    longitude = body.longitude,
    source = body.positionSource,
    accuracy = body.positionAccuracy ?? null;
  if (latitude === null && longitude === null) {
    if (source !== null || accuracy !== null) fail(400, 'Poziție invalidă.');
  } else if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    (source !== 'manual' &&
      source !== 'gps' &&
      !(
        source === 'geocoding' &&
        current.positionSource === source &&
        latitude === current.latitude &&
        longitude === current.longitude &&
        accuracy === current.positionAccuracy
      )) ||
    (accuracy !== null &&
      (typeof accuracy !== 'number' ||
        !Number.isFinite(accuracy) ||
        accuracy < 0))
  )
    fail(400, 'Coordonate invalide.');
  const s = partnerScope(user),
    now = new Date().toISOString();
  const result = await db()
    .prepare(
      `INSERT INTO partner_profiles(customer_id,contact,phone,email,latitude,longitude,position_source,position_accuracy,position_provider,position_metadata,address_fingerprint,revision,updated_at,updated_by) SELECT c.id,?,?,?,?,?,?,?,(SELECT position_provider FROM partner_profiles WHERE customer_id=c.id),(SELECT position_metadata FROM partner_profiles WHERE customer_id=c.id),?,1,?,? FROM customers c WHERE c.id=? AND c.active=1 AND ${s.sql} AND COALESCE(json_extract(c.data,'$.address'),'')=? AND COALESCE(json_extract(c.data,'$.city'),'')=? AND COALESCE(json_extract(c.data,'$.county'),'')=? AND (?=0 OR EXISTS(SELECT 1 FROM partner_profiles WHERE customer_id=c.id AND revision=?)) ON CONFLICT(customer_id) DO UPDATE SET contact=excluded.contact,phone=excluded.phone,email=excluded.email,latitude=excluded.latitude,longitude=excluded.longitude,position_source=excluded.position_source,position_accuracy=excluded.position_accuracy,position_provider=CASE WHEN excluded.position_source='geocoding' THEN partner_profiles.position_provider ELSE NULL END,position_metadata=CASE WHEN excluded.position_source='geocoding' THEN partner_profiles.position_metadata ELSE NULL END,address_fingerprint=excluded.address_fingerprint,revision=partner_profiles.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE partner_profiles.revision=?`,
    )
    .bind(
      contact,
      phone,
      email,
      latitude as number | null,
      longitude as number | null,
      source as string | null,
      accuracy as number | null,
      current.addressFingerprint,
      now,
      user.id,
      id,
      ...s.args,
      current.address || '',
      current.city || '',
      current.county || '',
      expected as number,
      expected as number,
      expected as number,
    )
    .run();
  if (!result.meta.changes)
    fail(409, 'Datele s-au modificat. Reîncarcă fișa înainte de salvare.');
  return { partner: await get(user, id) };
}
export async function recordVisit(
  user: User,
  id: string,
  body: Record<string, unknown>,
) {
  await get(user, id);
  const visitId = body.id,
    notes = textField(body.notes, 2000);
  if (
    typeof visitId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      visitId,
    )
  )
    fail(400, 'Identificator vizită invalid.');
  const s = partnerScope(user),
    now = new Date().toISOString();
  await db()
    .prepare(
      `INSERT INTO partner_visits(id,customer_id,agent_id,agent_name,visited_at,notes,created_at) SELECT ?,c.id,?,?,?,?,? FROM customers c WHERE c.id=? AND c.active=1 AND ${s.sql} ON CONFLICT(id) DO NOTHING`,
    )
    .bind(visitId, user.id, user.name, now, notes, now, id, ...s.args)
    .run();
  const saved = await db()
    .prepare('SELECT customer_id,agent_id,notes FROM partner_visits WHERE id=?')
    .bind(visitId)
    .first<{ customer_id: string; agent_id: string; notes: string }>();
  if (
    !saved ||
    saved.customer_id !== id ||
    saved.agent_id !== user.id ||
    saved.notes !== notes
  )
    fail(409, 'Vizita nu a putut fi salvată cu acest identificator.');
  return partnerDetail(user, id, null);
}

// Lightweight read projection for lists/maps. No contact/request/financial data.
// Reuse the canonical fingerprint and scope, including shared work locations.
export async function portfolioSummary(user: User, bbox?: import('./partner-map-types').MapBounds) {
  const scope = partnerScope(user);
  const args: (string | number)[] = [...scope.args];
  let area = '';
  if (bbox) {
    const [west, south, east, north] = bbox;
    area = ` AND p.latitude BETWEEN ? AND ? AND ${west <= east ? 'p.longitude BETWEEN ? AND ?' : '(p.longitude>=? OR p.longitude<=?)'}`;
    args.push(south, north, west, east);
  }
  const rows = await db().prepare(`SELECT c.id,c.warehouse_id,c.data,
    '' contact,'' phone,'' email,p.latitude,p.longitude,p.position_source,
    p.position_accuracy,p.position_provider,p.position_metadata,p.address_fingerprint,
    p.revision,p.updated_at,
    (SELECT MAX(v.visited_at) FROM partner_visits v WHERE v.customer_id=c.id) last_visited_at
    FROM customers c LEFT JOIN partner_profiles p ON p.customer_id=c.id
    WHERE c.active=1 AND ${scope.sql}${area}
    ORDER BY json_extract(c.data,'$.name'),c.id`).bind(...args).all<Row>();
  return rows.results.map(row => {
    const p = view(row);
    // Finite range checks also protect against malformed legacy/imported coordinates.
    const located = typeof p.latitude === 'number' && Number.isFinite(p.latitude) &&
      Math.abs(p.latitude) <= 90 && typeof p.longitude === 'number' &&
      Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
    return {
      id: p.id, name: p.name, cui: p.cui, address: p.address, city: p.city,
      county: p.county, route: p.route, latitude: located ? p.latitude : null,
      longitude: located ? p.longitude : null,
      positionSource: located ? p.positionSource : null,
      positionQuality: located ? p.positionQuality : null, lastVisitedAt: p.lastVisitedAt,
    } satisfies import('./partner-map-types').PartnerSummary;
  });
}
