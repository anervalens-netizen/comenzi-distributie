import { listLocalWork, readLocalWork, type StorageLike } from './local-work.ts';
import type { Order } from './types.ts';

export type StoredOrderWork = { base: Order; local: Order };
export type FinalizedOrderRecovery = { remote: Order; local: Order };
export type OrphanedOrderRecovery = { remote: null; local: Order };
export type OrderRecovery = FinalizedOrderRecovery | OrphanedOrderRecovery;

export function readFinalizedOrderRecovery(
  remote: Order,
  userId: string,
  storage?: StorageLike | null,
): FinalizedOrderRecovery | null {
  if (!userId || remote.status === 'draft') return null;
  const stored = readLocalWork<StoredOrderWork>('order', userId, remote.id, storage);
  const value = stored.value;
  if (!value || value.base.id !== remote.id || value.local.id !== remote.id) return null;
  return { remote, local: value.local };
}

export function readOrphanedOrderRecoveries(
  remoteOrders: readonly Order[],
  userId: string,
  storage?: StorageLike | null,
): { recoveries: OrphanedOrderRecovery[]; error: string } {
  if (!userId) return { recoveries: [], error: '' };
  const known = new Set(remoteOrders.map(order => order.id));
  const listed = listLocalWork<StoredOrderWork>('order', userId, storage);
  const recoveries = listed.entries
    .filter(entry => !known.has(entry.documentId))
    .map(entry => entry.value)
    .filter(value => value?.base?.id && value.base.id === value.local?.id && value.local.status === 'draft')
    .map(value => ({ remote: null, local: value.local }) satisfies OrphanedOrderRecovery);
  return { recoveries, error: listed.error };
}
