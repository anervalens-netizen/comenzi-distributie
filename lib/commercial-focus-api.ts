import {readFileSync, statSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {runtimeKind} from '#mobiup-runtime';
import {bucharestMonthKey} from './bucharest-month';
import {calculateFocus, focusOffers, type CommercialFocusReport} from './commercial-focus';
import {readFocusSalesAsync} from './sales-view-runtime';
import {readDistributionRules} from './distribution-config';
import {assignmentFor} from './distribution-rules';
import {managerFilter} from './manager-scope';
import {salesActorIdentities} from './sales-server';
import {fail, isGlobalManager} from './server';
import type {User} from './types';

async function focusScope(user: User, params: URLSearchParams) {
  const rules = await readDistributionRules();
  const filter = await managerFilter(user, params);
  const {primary, identities} = await salesActorIdentities();
  const allowed = user.role === 'agent' ? [user.id] : filter?.agentIds ??
    (isGlobalManager(user) ? null : (await managerFilter(user, new URLSearchParams({managerId: user.id})))?.agentIds ?? []);
  const sellers = primary.filter(seller => (!allowed || allowed.includes(seller.id)) &&
    rules && assignmentFor(rules, seller.id, seller.siteCode));
  return {sellers, identities};
}

export async function commercialFocus(user: User, params: URLSearchParams, revalidate?: () => Promise<User>): Promise<CommercialFocusReport> {
  if (runtimeKind !== 'node') fail(503, 'Raportul Focus este disponibil în instanța cu date de vânzări.');
  const month = params.get('month') || bucharestMonthKey(new Date());
  if (!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) fail(400, 'Alege o lună validă.');
  for (const key of params.keys()) if (!['month', 'managerId', 'agentId'].includes(key)) fail(400, 'Filtru Focus necunoscut.');
  if (user.role === 'agent' && (params.has('managerId') || params.has('agentId'))) fail(403, 'Filtrul nu este disponibil pentru acest cont.');
  const empty = {
    month, available: false, lastDate: null, importedAt: null, fromMonth: null, throughMonth: null,
    simulation: false, excludedRows: 0, unmatchedRows: 0, accessoriesCents: null, phonesCents: null, sellers: [],
  };
  const override = process.env.MOBIUP_COMMERCIAL_FOCUS_RULES;
  const path = override || resolve(process.env.MOBIUP_DATA_DIR || './work/server-data', 'vodafone-commercial-focus-rules.json');
  let offers;
  try {
    const file = statSync(path, {throwIfNoEntry: false});
    if (!file && !override) return {...empty, state: 'no-offer'};
    if (!isAbsolute(path) || !file?.isFile() || file.size > 1024 * 1024) throw new Error('Invalid Focus rules path');
    offers = focusOffers(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    fail(503, 'Grila Focus necesită verificare.');
  }
  const offer = offers.find(r => r.fromMonth <= month && (!r.throughMonth || month <= r.throughMonth));
  if (!offer) return {...empty, state: 'no-offer'};
  const scope = await focusScope(user, params);
  const codes = [...offer.accessories, ...offer.phones].map(p => p.code);
  let sales;
  try {
    sales = await readFocusSalesAsync(month, codes, scope.identities, new Set(scope.sellers.map(seller => seller.id)));
  } catch {
    fail(503, 'Datele Focus nu pot fi citite. Reîncearcă.');
  }
  if (revalidate) {
    const current = await revalidate();
    if (current.id !== user.id || current.role !== user.role ||
        JSON.stringify(await focusScope(current, params)) !== JSON.stringify(scope)) fail(409, 'Portofoliul s-a modificat. Reîncarcă raportul.');
  }
  if (!sales) return {...empty, fromMonth: offer.fromMonth, throughMonth: offer.throughMonth ?? null, simulation: !!offer.simulation, state: 'no-sales'};
  const sellers = scope.sellers.map(seller => calculateFocus(offer, seller, sales.quantities.get(seller.id) ?? new Map()));
  const phones = sellers.filter(seller => seller.phoneCents !== null);
  return {
    month, available: true, state: 'ready', lastDate: sales.lastDate, importedAt: sales.importedAt,
    fromMonth: offer.fromMonth, throughMonth: offer.throughMonth ?? null, simulation: !!offer.simulation,
    excludedRows: sales.excludedRows, unmatchedRows: sales.unmatchedRows, sellers,
    accessoriesCents: sellers.reduce((total, seller) => total + seller.accessoriesCents, 0),
    phonesCents: phones.length ? phones.reduce((total, seller) => total + (seller.phoneCents ?? 0), 0) : null,
  };
}
