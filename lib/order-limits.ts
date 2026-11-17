import { bucharestMonthKey, bucharestMonthUtcRange } from './bucharest-month';
import type { Order, Product } from './types';
import type {
  OrderLimitFloors,
  OrderLimitPeriod,
  OrderLimitViolation,
  OrderProductLimit,
} from './order-limits-types';

export function orderLimitWindow(now = new Date()) {
  const current = bucharestMonthKey(now);
  const [year, month] = current.split('-').map(Number);
  const key = (offset: number) =>
    new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
  return {
    period: { from: key(-3), to: key(-1) } satisfies OrderLimitPeriod,
    validity: bucharestMonthUtcRange(current),
  };
}

export function orderLimitPeriod(now = new Date()): OrderLimitPeriod {
  return orderLimitWindow(now).period;
}

export const defaultOrderLimitFloors: OrderLimitFloors = {
  casesFilms: 5,
  chargers: 10,
  cablesAdapters: 10,
  prepaidSim: 250,
};

function categoryKey(value: string) {
  return value.trim().normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
}

export function orderLimitFloor(
  product: Pick<Product, 'kind' | 'category'>,
  floors = defaultOrderLimitFloors,
) {
  const category = categoryKey(product.category);
  if (product.kind === 'stands' && category === 'CARTELE')
    return floors.prepaidSim;
  if (product.kind !== 'accessories') return 0;
  if (category === 'HUSE & FOLII') return floors.casesFilms;
  if (category === 'INCARCATOARE') return floors.chargers;
  if (category === 'CABLURI & ADAPTOARE') return floors.cablesAdapters;
  return 0;
}

export function orderLimitCode(value: string) {
  return value.trim().toUpperCase();
}

export function productOrderLimits(
  products: readonly Product[],
  totals: ReadonlyMap<string, number>,
  period: OrderLimitPeriod,
  coveredMonths: number,
  floors = defaultOrderLimitFloors,
) {
  const codeCount = new Map<string, number>();
  const codeFloors = new Map<string, number>();
  for (const product of products) {
    const code = orderLimitCode(product.code);
    codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
    const configured = orderLimitFloor(product, floors);
    if (configured)
      codeFloors.set(
        code,
        Math.min(configured, codeFloors.get(code) ?? configured),
      );
  }
  const result: OrderProductLimit[] = [];
  for (const p of products) {
    const code = orderLimitCode(p.code);
    const floor = codeFloors.get(code);
    if (!floor) continue;
    // A duplicated code has one conservative allowance even when its catalog IDs differ.
    const available = coveredMonths > 0 && codeCount.get(code) === 1;
    const salesQuantity = available
      ? Math.max(0, Math.floor(totals.get(code) ?? 0))
      : null;
    const useSales =
      coveredMonths === 3 && salesQuantity !== null && salesQuantity > floor;
    const source =
      salesQuantity === null
        ? 'unavailable'
        : coveredMonths < 3
          ? 'partial'
          : useSales
            ? 'sales'
            : 'floor';
    result.push({
      productId: p.id,
      code: p.code,
      name: p.name,
      salesQuantity,
      floor,
      limit: useSales ? salesQuantity : floor,
      source,
      period,
    });
  }
  return result;
}

export function orderLimitViolations(
  order: Pick<Order, 'kind' | 'items' | 'standItems'>,
  productLimits: readonly OrderProductLimit[],
) {
  if (order.kind === 'sim' || order.kind === 'stand_client')
    return [] as OrderLimitViolation[];
  const quantities = new Map<string, number>();
  const selectedIds = new Set<string>();
  for (const line of [
    ...order.items,
    ...(order.kind === 'combined' ? (order.standItems ?? []) : []),
  ]) {
    const code = orderLimitCode(line.code);
    quantities.set(code, (quantities.get(code) ?? 0) + line.quantity);
    selectedIds.add(line.id);
  }
  const productsByCode = new Map<string, OrderProductLimit>();
  for (const product of productLimits) {
    const code = orderLimitCode(product.code),
      existing = productsByCode.get(code);
    if (
      !existing ||
      (!selectedIds.has(existing.productId) &&
        selectedIds.has(product.productId))
    )
      productsByCode.set(code, product);
  }
  const result: OrderLimitViolation[] = [];
  for (const [code, product] of productsByCode) {
    const requested = quantities.get(code) ?? 0;
    if (requested > product.limit) result.push({ ...product, requested });
  }
  return result.sort((a, b) => a.productId.localeCompare(b.productId));
}
