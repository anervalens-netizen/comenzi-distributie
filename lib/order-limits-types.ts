export type OrderLimitFloors = {
  casesFilms: number;
  chargers: number;
  cablesAdapters: number;
  prepaidSim: number;
};
export type OrderLimitPolicy = { revision: number; floors: OrderLimitFloors };

export type OrderLimitPeriod = { from: string; to: string };

export type OrderProductLimit = {
  productId: string;
  code: string;
  name: string;
  salesQuantity: number | null;
  floor: number;
  limit: number;
  source: 'sales' | 'floor' | 'partial' | 'unavailable';
  period: OrderLimitPeriod;
};

export type OrderLimitViolation = OrderProductLimit & { requested: number };
export type OrderLimitApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'consumed'
  | 'superseded';

export type OrderLimitApproval = {
  id: string;
  orderId: string;
  orderNumber: string;
  agentId: string;
  agentName: string;
  orderRevision: number;
  revision: number;
  status: OrderLimitApprovalStatus;
  reason: string;
  comment: string;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  violations: OrderLimitViolation[];
  canDecide: boolean;
};

export type OrderLimitsView = {
  enabled: boolean;
  orderId: string;
  revision: number;
  period: OrderLimitPeriod;
  products: OrderProductLimit[];
  violations: OrderLimitViolation[];
  request: OrderLimitApproval | null;
};
