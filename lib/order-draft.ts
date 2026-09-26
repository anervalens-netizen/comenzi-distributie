import type { Client, Line, Order } from './types';

export type OrderConflictField = 'items' | 'standItems' | 'serials' | 'client' | 'notes';
export type OrderConflictChoice = 'local' | 'remote';

export type OrderConflictMerge = {
  order: Order;
  conflicts: OrderConflictField[];
};

export const orderConflictLabels: Record<OrderConflictField, string> = {
  items: 'produsele de accesorii',
  standItems: 'produsele de standuri / telefoane',
  serials: 'seriile SIM',
  client: 'clientul',
  notes: 'observațiile',
};

function clientId(client: Client | null) {
  return client?.id ?? null;
}

function sameStrings(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function quantityMap(lines: Line[] | undefined) {
  return new Map((lines ?? []).map(line => [line.id, line.quantity]));
}

function sameLineQuantities(a: Line[] | undefined, b: Line[] | undefined) {
  const left = quantityMap(a);
  const right = quantityMap(b);
  if (left.size !== right.size) return false;
  for (const [id, quantity] of left) if (right.get(id) !== quantity) return false;
  return true;
}

function chooseScalar<T>(base: T, local: T, remote: T, prefer: OrderConflictChoice) {
  const localChanged = local !== base;
  const remoteChanged = remote !== base;
  const conflict = localChanged && remoteChanged && local !== remote;
  if (conflict) return { value: prefer === 'local' ? local : remote, conflict: true };
  if (localChanged) return { value: local, conflict: false };
  return { value: remote, conflict: false };
}

function chooseStrings(base: string[], local: string[], remote: string[], prefer: OrderConflictChoice) {
  const localChanged = !sameStrings(local, base);
  const remoteChanged = !sameStrings(remote, base);
  const sameResult = sameStrings(local, remote);
  const conflict = localChanged && remoteChanged && !sameResult;
  if (conflict) return { value: prefer === 'local' ? local : remote, conflict: true };
  if (localChanged) return { value: local, conflict: false };
  return { value: remote, conflict: false };
}

function mergeLines(base: Line[] | undefined, local: Line[] | undefined, remote: Line[] | undefined, prefer: OrderConflictChoice) {
  const baseMap = new Map((base ?? []).map(line => [line.id, line]));
  const localMap = new Map((local ?? []).map(line => [line.id, line]));
  const remoteMap = new Map((remote ?? []).map(line => [line.id, line]));
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const result: Line[] = [];
  let conflict = false;

  for (const id of ids) {
    const baseQuantity = baseMap.get(id)?.quantity ?? 0;
    const localQuantity = localMap.get(id)?.quantity ?? 0;
    const remoteQuantity = remoteMap.get(id)?.quantity ?? 0;
    const localChanged = localQuantity !== baseQuantity;
    const remoteChanged = remoteQuantity !== baseQuantity;
    const lineConflict = localChanged && remoteChanged && localQuantity !== remoteQuantity;
    if (lineConflict) conflict = true;

    const quantity = lineConflict
      ? (prefer === 'local' ? localQuantity : remoteQuantity)
      : localChanged
        ? localQuantity
        : remoteQuantity;
    if (!quantity) continue;

    // Prefer canonical metadata from the server whenever the selected product
    // still exists there. For a locally-added product, keep the local snapshot
    // until the next PUT canonicalizes it against the current catalog.
    const source = remoteMap.get(id) ?? localMap.get(id) ?? baseMap.get(id);
    if (source) result.push({ ...source, quantity });
  }

  result.sort((a, b) => a.sourceRow - b.sourceRow);
  return { value: result, conflict };
}

export function recalculateOrder(order: Order): Order {
  const standItems = order.kind === 'combined' ? (order.standItems ?? []) : order.standItems;
  const pieces = order.kind === 'sim'
    ? order.serials.length
    : order.items.reduce((sum, line) => sum + line.quantity, 0)
      + (order.kind === 'combined' ? (standItems ?? []).reduce((sum, line) => sum + line.quantity, 0) : 0)
      + (order.kind === 'combined' ? order.serials.length : 0);
  const total = Math.round(order.items.reduce((sum, line) => sum + (line.price || 0) * line.quantity, 0) * 100) / 100;
  return { ...order, standItems, pieces, total };
}

export function orderSaveBody(order: Order, revision: number) {
  return {
    items: order.items.map(line => ({ id: line.id, quantity: line.quantity })),
    ...(order.kind === 'combined'
      ? { standItems: (order.standItems ?? []).map(line => ({ id: line.id, quantity: line.quantity })) }
      : {}),
    serials: order.serials,
    clientId: order.client?.id || null,
    notes: order.notes,
    revision,
  };
}

export function sameEditableOrder(a: Order, b: Order) {
  return sameLineQuantities(a.items, b.items)
    && sameLineQuantities(a.standItems, b.standItems)
    && sameStrings(a.serials, b.serials)
    && clientId(a.client) === clientId(b.client)
    && a.notes === b.notes;
}

export function mergeConcurrentOrders(
  base: Order,
  local: Order,
  remote: Order,
  prefer: OrderConflictChoice,
): OrderConflictMerge {
  const conflicts: OrderConflictField[] = [];
  const items = mergeLines(base.items, local.items, remote.items, prefer);
  if (items.conflict) conflicts.push('items');

  const standItems = mergeLines(base.standItems, local.standItems, remote.standItems, prefer);
  if (standItems.conflict) conflicts.push('standItems');

  const serials = chooseStrings(base.serials, local.serials, remote.serials, prefer);
  if (serials.conflict) conflicts.push('serials');

  const selectedClient = chooseScalar(clientId(base.client), clientId(local.client), clientId(remote.client), prefer);
  if (selectedClient.conflict) conflicts.push('client');
  const client = selectedClient.value === clientId(remote.client)
    ? remote.client
    : selectedClient.value === clientId(local.client)
      ? local.client
      : null;

  const notes = chooseScalar(base.notes, local.notes, remote.notes, prefer);
  if (notes.conflict) conflicts.push('notes');

  return {
    order: recalculateOrder({
      ...remote,
      items: items.value,
      standItems: remote.kind === 'combined' ? standItems.value : remote.standItems,
      serials: serials.value,
      client,
      notes: notes.value,
    }),
    conflicts,
  };
}
