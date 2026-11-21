import {runtimeKind} from '#mobiup-runtime';
import {normalizedCui} from './partner-company-identity';
import {partnerDetail} from './partner-portfolio';
import {readPartnerSalesAsync} from './partner-sales-store';
import type {PartnerStand, PartnerStandsReport} from './partner-stands-types';
import {db, fail, requireUser} from './server';
import type {User} from './types';

const formatDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
});
const bucharestDate = (stamp: string) => formatDate.format(new Date(stamp));
type Slip = {
  orderId: string; reference: string; finalizedAt: string; lineId: string;
  code: string; type: string; quantity: number; cui: string;
};

export async function partnerStands(req: Request, readUser: User, id: string, user: User): Promise<PartnerStandsReport> {
  if (runtimeKind !== 'node') fail(503, 'Istoricul standurilor este disponibil în instanța de producție.');
  const {partner} = await partnerDetail(readUser, id, null, user);
  const aliasesTable = await db().prepare("SELECT 1 FROM sqlite_schema WHERE name='customer_identity_aliases' AND type='table'").first();
  const pointIds = aliasesTable ? (await db().prepare('SELECT alias_id id FROM customer_identity_aliases WHERE canonical_id=?').bind(id).all<{id: string}>()).results.map(row => row.id) : [];
  const rows = (await db().prepare(`
    SELECT o.id orderId,o.number reference,o.finalized_at finalizedAt,CAST(line.key AS TEXT) lineId,
      json_extract(line.value,'$.code') code,json_extract(line.value,'$.name') type,
      json_extract(line.value,'$.quantity') quantity,COALESCE(json_extract(o.payload,'$.client.cui'),'') cui
    FROM orders o, json_each(o.payload,'$.items') line
    WHERE o.kind='stand_client' AND o.status='finalized' AND o.finalized_at IS NOT NULL
      AND json_extract(o.payload,'$.client.id') IN (SELECT value FROM json_each(?))
      AND json_type(line.value,'$.quantity')='integer' AND json_extract(line.value,'$.quantity')>0
      AND json_type(line.value,'$.name')='text' AND json_type(line.value,'$.code')='text'
    ORDER BY o.finalized_at DESC,o.number ASC,line.key
  `).bind(JSON.stringify([id, ...pointIds])).all<Slip>()).results;
  const cui = normalizedCui(partner.cui);
  const owned = rows.filter(row => cui && normalizedCui(row.cui) === cui);
  const sales = owned.length ? await readPartnerSalesAsync(id, partner.cui, new URLSearchParams('scope=point')) : null;
  const firstBilling = sales?.state === 'ready' ? sales.billingLifetime.firstBilling : null;
  const current = await requireUser(req);
  if (current.id !== user.id || current.role !== user.role) fail(409, 'Portofoliul s-a modificat. Reîncearcă fișa.');
  const refreshedScope = current.role === 'manager' ? {...current, managerScope: readUser.managerScope} : current;
  const refreshed = await partnerDetail(refreshedScope, id, null, current);
  if (refreshed.partner.cui !== partner.cui || refreshed.partner.addressFingerprint !== partner.addressFingerprint)
    fail(409, 'Fișa s-a modificat. Reîncearcă.');
  const stands = owned.map<PartnerStand>(row => {
    const date = bucharestDate(row.finalizedAt);
    return {
      orderId: row.orderId, reference: row.reference, date, lineId: row.lineId,
      code: row.code, type: row.type, quantity: row.quantity,
      timing: !firstBilling ? 'unknown' : date === firstBilling ? 'same-day' : date < firstBilling ? 'earlier' : 'later',
    };
  });
  return {
    firstBilling, billingThrough: sales?.state === 'ready' || sales?.state === 'unlinked' ? sales.through : null,
    availableFrom: stands.at(-1)?.date ?? null, stands,
  };
}
