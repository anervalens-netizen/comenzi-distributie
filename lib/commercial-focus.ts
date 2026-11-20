const validMonth = (value: unknown): value is string =>
  typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);

type Product = {code: string; name: string};
export type FocusOffer = {
  fromMonth: string;
  throughMonth?: string;
  simulation?: boolean;
  accessories: Product[];
  phones: (Product & {belowTargetCents: number; reachedTargetCents: number})[];
  targets: {userId: string; units: number}[];
};
export type FocusActor = {id: string; name: string; siteCode: string};
export type FocusItem = Product & {
  quantity: number;
  rateCents: number | null;
  incentiveCents: number | null;
};
export type FocusSeller = FocusActor & {
  units: number;
  accessoriesCents: number;
  target: number | null;
  targetReached: boolean | null;
  phoneCents: number | null;
  accessories: FocusItem[];
  phones: FocusItem[];
};
export type CommercialFocusReport = {
  month: string;
  available: boolean;
  lastDate: string | null;
  importedAt: string | null;
  state: 'ready' | 'no-offer' | 'no-sales';
  fromMonth: string | null;
  throughMonth: string | null;
  simulation: boolean;
  excludedRows: number;
  unmatchedRows: number;
  accessoriesCents: number | null;
  phonesCents: number | null;
  sellers: FocusSeller[];
};

const hasText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !/\p{Cc}/u.test(value);
const cents = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
const invalid = () => new Error('Invalid commercial Focus policy');
const isProduct = (product: unknown): product is Product => {
  if (!product || typeof product !== 'object') return false;
  const p = product as Partial<Product>;
  return hasText(p.code, 80) && p.code === p.code.toUpperCase() && hasText(p.name, 250);
};

export function focusOffers(value: unknown): FocusOffer[] {
  if (!value || typeof value !== 'object') throw invalid();
  const rules = value as {version?: unknown; periods?: unknown};
  if (rules.version !== 1 || !Array.isArray(rules.periods) || rules.periods.length > 120) throw invalid();
  const offers: FocusOffer[] = [];
  for (const period of rules.periods as FocusOffer[]) {
    if (!period || !validMonth(period.fromMonth) ||
        (period.simulation !== undefined && typeof period.simulation !== 'boolean') ||
        (period.throughMonth !== undefined && (!validMonth(period.throughMonth) || period.throughMonth < period.fromMonth)) ||
        !Array.isArray(period.accessories) || period.accessories.length > 50 ||
        !Array.isArray(period.phones) || period.phones.length > 100 ||
        !Array.isArray(period.targets) || period.targets.length > 500) throw invalid();
    const codes = new Set<string>(), users = new Set<string>();
    for (const product of [...period.accessories, ...period.phones]) {
      if (!isProduct(product) || codes.has(product.code)) throw invalid();
      codes.add(product.code);
    }
    for (const product of period.phones) {
      if (!cents(product.belowTargetCents) || !cents(product.reachedTargetCents) ||
          product.belowTargetCents > product.reachedTargetCents) throw invalid();
    }
    for (const target of period.targets) {
      if (!target || !hasText(target.userId, 128) || users.has(target.userId) ||
          !Number.isInteger(target.units) || target.units < 1 || target.units > 10000) throw invalid();
      users.add(target.userId);
    }
    offers.push(period);
  }
  offers.sort((a, b) => a.fromMonth.localeCompare(b.fromMonth));
  for (let i = 1; i < offers.length; i++) {
    const previous = offers[i - 1];
    if (!previous.throughMonth || previous.throughMonth >= offers[i].fromMonth) throw invalid();
  }
  return offers;
}

function line(product: Product, quantity: number, rateCents: number | null): FocusItem {
  return {code: product.code, name: product.name, quantity, rateCents, incentiveCents: rateCents === null ? null : Math.round(quantity * rateCents)};
}

export function calculateFocus(offer: FocusOffer, actor: FocusActor, quantities: ReadonlyMap<string, number>): FocusSeller {
  const target = offer.targets.find(candidate => candidate.userId === actor.id)?.units ?? null;
  const accessories = offer.accessories.map(product => line(product, quantities.get(product.code) ?? 0, 500));
  const units = offer.phones.reduce((total, product) => total + (quantities.get(product.code) || 0), 0);
  const targetReached = target === null ? null : units >= target;
  const phones = target === null ? [] : offer.phones.map(product =>
    line(product, quantities.get(product.code) ?? 0, targetReached ? product.reachedTargetCents : product.belowTargetCents)
  );
  return {
    ...actor, units, accessoriesCents: accessories.reduce((total, product) => total + (product.incentiveCents ?? 0), 0),
    target, targetReached, phoneCents: target === null ? null : phones.reduce((total, product) => total + (product.incentiveCents ?? 0), 0),
    accessories, phones,
  };
}
