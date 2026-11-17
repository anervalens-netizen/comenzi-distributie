'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, ShieldCheck } from 'lucide-react';
import { errorMessage, networkApi } from '@/lib/client-api';
import { currentLocalWorkUserId } from '@/lib/local-work';
import { orderLimitCode, orderLimitViolations } from '@/lib/order-limits';
import type { Order, Product } from '@/lib/types';
import type {
  OrderLimitApproval as OrderApproval, OrderLimitApprovalStatus as ApprovalStatus, OrderLimitPeriod as Period,
  OrderLimitsView as Limits, OrderLimitViolation, OrderProductLimit as ProductLimit,
} from '@/lib/order-limits-types';
import './order-limits.css';

export const approvalLabels: Record<ApprovalStatus,string> = {
  pending: 'În așteptarea managerului',
  approved: 'Confirmare aprobată',
  rejected: 'Confirmare respinsă',
  consumed: 'Confirmare utilizată',
  superseded: 'Confirmare pentru o versiune anterioară',
};
const emptyProducts: ProductLimit[] = [];
const invalidLimits = 'Serverul a trimis date incompatibile despre limitele comenzii.';
const isPeriod = (p: Period | undefined) => !!p && typeof p.from === 'string' && typeof p.to === 'string';
const isQuantity = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isLimit(row: ProductLimit) {
  return !!row && typeof row.productId === 'string' && typeof row.code === 'string' && typeof row.name === 'string' && isPeriod(row.period)
    && isQuantity(row.limit) && isQuantity(row.floor)
    && (row.salesQuantity === null || Number.isFinite(row.salesQuantity))
    && ['sales', 'floor', 'partial', 'unavailable'].includes(row.source);
}
function isViolation(row: OrderLimitViolation) {
  return isLimit(row) && isQuantity(row.requested);
}
export function isOrderApproval(value: unknown): value is OrderApproval {
  if (!value || typeof value !== 'object') return false;
  const a = value as OrderApproval;
  return typeof a.id === 'string' && typeof a.orderId === 'string' && typeof a.orderNumber === 'string' &&
    typeof a.agentName === 'string' && typeof a.agentId === 'string' &&
    typeof a.status === 'string' && Object.hasOwn(approvalLabels, a.status) &&
    typeof a.canDecide === 'boolean' && isQuantity(a.revision) && isQuantity(a.orderRevision) &&
    typeof a.reason === 'string' && typeof a.comment === 'string' &&
    (a.decidedByName === null || typeof a.decidedByName === 'string') &&
    (a.decidedAt === null || typeof a.decidedAt === 'string') &&
    typeof a.createdAt === 'string' && typeof a.updatedAt === 'string' &&
    Array.isArray(a.violations) && a.violations.every(isViolation);
}
function isOrderLimits(value: unknown, orderId: string): value is Limits {
  if (!value || typeof value !== 'object') return false;
  const d = value as Limits;
  return d.orderId === orderId && isQuantity(d.revision) && isPeriod(d.period) &&
    Array.isArray(d.products) && d.products.every(isLimit) &&
    Array.isArray(d.violations) && d.violations.every(isViolation) &&
    (d.request === null || isOrderApproval(d.request) && d.request.orderId === orderId);
}

function isRestrictedKind(kind: Order['kind']) {
  return kind === 'accessories' || kind === 'stands' || kind === 'combined';
}

export function useOrderLimits(order: Order, saved: boolean) {
  const [owner] = useState(currentLocalWorkUserId);
  const enabled = isRestrictedKind(order.kind);
  const orderId = order.id;
  const [state, setState] = useState<{ data?: Limits; refreshing: boolean; error: string }>({ refreshing: enabled, error: '' });
  const [requestState, setRequestState] = useState({ busy: false, error: '' });
  const load = useRef<AbortController>(null);
  const operation = useRef<AbortController>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    load.current?.abort();
    const controller = new AbortController();
    load.current = controller;
    setState(current => ({ ...current, refreshing: true }));
    try {
      const value = await networkApi<unknown>(`orders/${orderId}/limits`, 'GET', undefined, controller.signal, undefined, owner);
      if (!isOrderLimits(value, orderId)) throw new Error(invalidLimits);
      if (!controller.signal.aborted) setState({ data: value, refreshing: false, error: '' });
    } catch (error) {
      if (!controller.signal.aborted) setState(current => ({ ...current, refreshing: false, error: errorMessage(error) }));
    }
  }, [enabled, orderId, owner]);

  useEffect(() => {
    let current = true;
    const sync = () => { if (current) void refresh(); };
    queueMicrotask(sync);
    window.addEventListener('online', sync);
    return () => {
      current = false;
      load.current?.abort();
      window.removeEventListener('online', sync);
    };
  }, [refresh, order.revision]);
  useEffect(() => () => operation.current?.abort(), []);

  const request = state.data?.request;
  const currentApproval = request && saved && request.orderRevision === order.revision && state.data?.revision === order.revision ? request : undefined;
  const pending = currentApproval?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const update = () => { if (document.visibilityState === 'visible' && navigator.onLine) void refresh(); };
    const timer = window.setInterval(update, 45_000);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  const products = state.data?.products ?? emptyProducts;
  const byProductId = useMemo(() => new Map(products.map(p => [p.productId, p])), [products]);
  const byCode = useMemo(() => new Map(products.map(p => [orderLimitCode(p.code), p])), [products]);
  const quantities = new Map<string, number>();
  for (const line of [...order.items, ...(order.kind === 'combined' ? order.standItems ?? [] : [])]) {
    const code = orderLimitCode(line.code);
    quantities.set(code, (quantities.get(code) ?? 0) + line.quantity);
  }
  const violations = orderLimitViolations(order, products);
  const approved = currentApproval?.status === 'approved';
  const ready = !enabled || (state.data?.revision === order.revision && !state.error);
  const blocked = !ready || state.refreshing || (violations.length > 0 && !approved);
  const canRequest = ready && violations.length > 0 && !approved && !pending
    && currentApproval?.status !== 'rejected' && owner === order.userId;
  function quantityLimit(product: Pick<Product, 'id' | 'code'>, lineQuantity: number) {
    const code = orderLimitCode(product.code);
    return { metric: byProductId.get(product.id) ?? byCode.get(code), quantity: quantities.get(code) ?? 0, lineQuantity };
  }

  async function requestApproval(save: (force?: boolean) => Promise<Order>, reason: string) {
    if (!canRequest || requestState.busy || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setRequestState({ busy: true, error: '' });
    try {
      const savedOrder = await save(true);
      if (controller.signal.aborted) return;
      const value = await networkApi<{request?: unknown}>(`orders/${orderId}/limit-approval`, 'POST',
        { revision: savedOrder.revision, ...(reason.trim() ? { reason: reason.trim() } : {}) }, controller.signal, undefined, owner);
      const submitted = value?.request;
      if (!isOrderApproval(submitted) || submitted.orderId !== orderId || submitted.orderRevision !== savedOrder.revision) {
        throw new Error(invalidLimits);
      }
      if (controller.signal.aborted) return;
      load.current?.abort();
      setState(current => current.data
        ? { data: { ...current.data, revision: savedOrder.revision, request: submitted }, refreshing: false, error: '' }
        : current);
      setRequestState({ busy: false, error: '' });
      void refresh();
    } catch (error) {
      if (!controller.signal.aborted) {
        setRequestState({ busy: false, error: errorMessage(error) });
        void refresh();
      }
    } finally {
      operation.current = null;
    }
  }

  return {
    enabled, ready, quantityLimit, violations, currentApproval, blocked, pending, approved, canRequest,
    error: state.error, refreshing: state.refreshing, requestState,
    refresh, requestApproval,
  };
}
type OrderLimitState = ReturnType<typeof useOrderLimits>;

export function QuantityLimit({ metric, quantity, lineQuantity }: { metric?: ProductLimit; quantity: number; lineQuantity: number }) {
  if (!metric) return null;
  const exceeded = quantity > metric.limit;
  return <small className={'order-limit-quantity'+(exceeded ? ' order-limit-quantity-exceeded' : '')}
    title={`Vânzări ${metric.salesQuantity ?? '—'} buc. în ${metric.period.from}–${metric.period.to}, minim ${metric.floor} buc.`}>
    Limită fără confirmare {metric.limit} buc.{quantity > lineQuantity && <> · Total pe cod {quantity}</>}{exceeded && <> · Depășită cu {quantity-metric.limit}</>}
  </small>;
}

export function LimitViolations({ violations }: { violations: OrderLimitViolation[] }) {
  if (!violations.length) return null;
  return <ul className="order-limit-violations">
    {violations.map(row => <li key={row.productId}>
      <strong>{row.name || row.code}</strong>
      <span>{row.requested} solicitate · limită {row.limit} · vânzări {row.salesQuantity ?? '—'} · minim {row.floor}{row.source === 'partial' && ' · istoric incomplet'}{row.source === 'unavailable' && ' · istoric indisponibil'}</span>
    </li>)}
  </ul>;
}

export function OrderLimitControls({ limits, disabled, review = false, onRequest, onApprovals }: {
  limits: OrderLimitState; disabled: boolean; review?: boolean;
  onRequest: (reason: string) => void; onApprovals?: () => void;
}) {
  const [reason, setReason] = useState('');
  if (!limits.enabled) return null;
  const { currentApproval, pending, approved, violations } = limits;
  const status = currentApproval?.status;
  const message = !limits.ready
    ? (limits.refreshing ? 'Se verifică limitele' : 'Limite indisponibile momentan')
    : status && status !== 'superseded' ? approvalLabels[status]
      : violations.length ? 'Este necesară confirmarea managerului' : '';
  if (!message && !limits.error && !review) return null;
  const Icon = approved ? CheckCircle2 : pending ? Clock3 : violations.length ? AlertTriangle : ShieldCheck;
  return <section className="order-limit-controls" aria-label="Limite și confirmări">
    <div className="order-limit-title" aria-live="polite"><Icon size={17} aria-hidden="true"/>
      <strong>{message || 'Comanda este în limite'}</strong>
    </div>
    {violations.length > 0 && <LimitViolations violations={violations}/>}
    {status === 'rejected' && <>
      {currentApproval?.comment && <p>{currentApproval.comment}</p>}
      <p>Modifică ciorna pentru a trimite o solicitare nouă.</p>
    </>}
    {pending && <p>Poți reveni la ciornă după decizie.</p>}
    {limits.error && <p role="alert">{limits.error}</p>}
    {limits.requestState.error && <p role="alert">{limits.requestState.error}</p>}
    {limits.canRequest && <label className="order-limit-reason">
      Motiv pentru manager <span>(opțional)</span>
      <textarea rows={2} maxLength={500} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)}/>
    </label>}
    <div className="order-limit-actions">
      {limits.canRequest && <button className="secondary" type="button" disabled={disabled || limits.requestState.busy}
        onClick={() => onRequest(reason)}>{limits.requestState.busy ? 'Se trimite…' : 'Solicită confirmarea managerului'}</button>}
      {(pending || !limits.ready) && <button type="button" className="quiet" disabled={disabled || limits.refreshing}
        onClick={() => void limits.refresh()}><RefreshCw size={15}/> Actualizează starea</button>}
      {review && onApprovals && <button className="quiet" type="button" disabled={disabled} onClick={onApprovals}>Confirmări comenzi</button>}
    </div>
  </section>;
}
