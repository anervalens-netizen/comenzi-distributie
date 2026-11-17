'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ClipboardCheck, RefreshCw } from 'lucide-react';
import { ApiError, errorMessage, networkApi } from '@/lib/client-api';
import type { OrderLimitApproval as OrderApproval } from '@/lib/order-limits-types';
import { OrderLimitPolicy } from '@/components/order-limit-policy';
import { approvalLabels, isOrderApproval, LimitViolations } from './order-limit-controls';

const PAGE_SIZE = 30;
const invalid = 'Serverul a trimis date incompatibile despre confirmări.';
const formatter = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Bucharest' });
const formatDate = (input: string) => {
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? '' : formatter.format(date);
};
type ViewProps = { owner: string; manager: boolean; focusId?: string; onBack: () => void; onOpenOrder: (id: string) => void };
type Page = { items: OrderApproval[]; hasMore: boolean };

function orderRequest(value: { request?: unknown } | null, id: string) {
  if (!isOrderApproval(value?.request) || value.request.id !== id) throw new Error(invalid);
  return value.request;
}

function ApprovalDetail({ owner, id, onBack, onOpenOrder }: { owner: string; id: string; onBack: () => void; onOpenOrder: (id: string) => void }) {
  const [request, setRequest] = useState<OrderApproval>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const active = useRef<AbortController>(null);
  const mutation = useRef<AbortController>(null);

  const refresh = useCallback(async (keepError = false) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const value = await networkApi<{ request?: unknown }>(`order-limit-approvals/${id}`, 'GET', undefined, controller.signal, undefined, owner);
      const next = orderRequest(value, id);
      if (controller.signal.aborted) return;
      setRequest(next);
      if (!keepError) setError('');
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setRequest(undefined);
        setError(errorMessage(error));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [id, owner]);

  useEffect(() => {
    let current = true;
    queueMicrotask(() => { if (current) void refresh(); });
    return () => {
      current = false;
      active.current?.abort();
      mutation.current?.abort();
    };
  }, [refresh]);

  const pending = request?.status === 'pending';
  useEffect(() => {
    if (!pending || busy) return;
    const timer = window.setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') void refresh();
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [busy, pending, refresh]);

  async function decide(decision: 'approved' | 'rejected') {
    if (!request?.canDecide || !pending || busy || loading || mutation.current) return;
    active.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError('');
    try {
      const next = await networkApi<{ request?: unknown }>(`order-limit-approvals/${id}/decision`, 'POST',
        { revision: request.revision, decision, ...(comment.trim() ? { comment: comment.trim() } : {}) },
        controller.signal, undefined, owner);
      if (!controller.signal.aborted) setRequest(orderRequest(next, id));
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(errorMessage(error));
        void refresh(true);
      }
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <section className="panel order-approvals" aria-label="Detalii confirmare">
    <div className="order-approval-actions">
      <button className="quiet" type="button" onClick={onBack} disabled={busy}><ArrowLeft size={17}/> Înapoi</button>
      <button className="secondary" type="button" onClick={() => void refresh()} disabled={busy || loading}><RefreshCw size={17}/> Actualizează</button>
    </div>
    <div className="section-heading"><ClipboardCheck size={22}/><div><h1>Confirmare comandă</h1>
      {request && <p>{request.orderNumber} · {request.agentName} · {formatDate(request.createdAt)}</p>}
    </div></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!request && loading && <output>Se încarcă solicitarea…</output>}
    {request && <>
      <strong className="order-approval-state" aria-live="polite">{approvalLabels[request.status]}</strong>
      {request.status === 'superseded' && <p>Deschide comanda curentă pentru a verifica versiunea nouă. Dacă depășește limita, agentul poate trimite o solicitare nouă.</p>}
      <LimitViolations violations={request.violations}/>
      {request.reason && <div className="order-approval-meta"><strong>Motivul solicitării</strong><p>{request.reason}</p></div>}
      {request.decidedByName && <p>Decizie · {request.decidedByName} · {formatDate(request.decidedAt ?? request.updatedAt)}</p>}
      {request.comment && <div className="order-approval-meta"><strong>Comentariul managerului</strong><p>{request.comment}</p></div>}
      {request.canDecide && pending && <label className="order-approval-comment">Comentariu<textarea value={comment} maxLength={500}
        disabled={busy} rows={3} onChange={event => setComment(event.target.value)}/></label>}
      <div className="order-approval-actions">
        {request.canDecide && pending && <>
          <button type="button" className="primary" disabled={busy || loading} onClick={() => void decide('approved')}>Aprobă versiunea solicitată</button>
          <button type="button" className="secondary" disabled={busy || loading} onClick={() => void decide('rejected')}>Respinge solicitarea</button>
        </>}
        <button type="button" className="quiet" disabled={busy} onClick={() => onOpenOrder(request.orderId)}>Deschide comanda</button>
      </div>
    </>}
  </section>;
}

export function OrderApprovals({ owner, manager, focusId, onBack, onOpenOrder }: ViewProps) {
  const [selected, setSelected] = useState(focusId);
  const [showPolicy, setShowPolicy] = useState(false);
  const [filter, setFilter] = useState('pending');
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [received, setReceived] = useState<{ path: string; data: Page }>();
  const [failure, setFailure] = useState<{ path: string; message: string }>();
  const path = `order-limit-approvals?limit=${PAGE_SIZE}&offset=${offset}${filter === 'all' ? '' : '&status='+filter}`;
  const page = received?.path === path ? received.data : undefined;
  const error = failure?.path === path ? failure.message : '';

  useEffect(() => {
    if (!manager || selected || showPolicy) return;
    const controller = new AbortController();
    void networkApi<Partial<Page> | null>(path, 'GET', undefined, controller.signal, undefined, owner).then(data => {
      if (!data || typeof data.hasMore !== 'boolean' || !Array.isArray(data.items) || !data.items.every(isOrderApproval)) {
        throw new Error(invalid);
      }
      if (!controller.signal.aborted) {
        setReceived({ path, data: { items: data.items, hasMore: data.hasMore } });
        setFailure(undefined);
      }
    }).catch(error => {
      if (!controller.signal.aborted) setFailure({ path, message: errorMessage(error) });
    });
    return () => controller.abort();
  }, [manager, owner, path, reload, selected, showPolicy]);

  if (selected) return <ApprovalDetail key={selected} owner={owner} id={selected} onOpenOrder={onOpenOrder} onBack={() => {
    if (manager) { setSelected(undefined); setReload(value => value + 1); }
    else onBack();
  }}/>;
  if (!manager) return null;
  if (showPolicy) return <>
    <button type="button" className="quiet" onClick={() => {
      setShowPolicy(false);
      setReload(value => value + 1);
    }}><ArrowLeft size={17}/> Înapoi la confirmări</button>
    <OrderLimitPolicy userId={owner}/>
  </>;

  return <section className="panel order-approvals" aria-label="Confirmări comenzi">
    <div className="section-heading"><ClipboardCheck size={22}/><div><h1>Confirmări comenzi</h1>
      <p>Solicitări pentru cantități care depășesc limita pe produs.</p>
    </div></div>
    <div className="order-approvals-filters">
      <label>Stare<select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}>
        <option value="pending">În așteptare</option><option value="approved">Aprobate</option>
        <option value="rejected">Respinse</option><option value="all">Toate</option>
      </select></label>
      <button type="button" className="secondary" onClick={() => setReload(value => value + 1)}><RefreshCw size={17}/> Actualizează</button>
      <button type="button" className="secondary" onClick={() => setShowPolicy(true)}>Limite pe produs</button>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {page?.items.length ? <ul className="order-approvals-list">{page.items.map(request => <li key={request.id}>
      <div className="order-approval-meta"><strong>{request.orderNumber} · {request.agentName}</strong>
        <p>{approvalLabels[request.status]} · {formatDate(request.createdAt)}</p></div>
      <button type="button" className="secondary" onClick={() => setSelected(request.id)}
        aria-label={`Deschide confirmarea pentru ${request.orderNumber}`}>Deschide</button>
    </li>)}</ul> : !error && <output>{page ? 'Nicio solicitare pentru această stare.' : 'Se încarcă solicitările…'}</output>}
    {(offset > 0 || page?.hasMore) && <div className="order-approval-actions">
      <button type="button" className="secondary" disabled={!offset} onClick={() => setOffset(value => value - PAGE_SIZE)}>Pagina anterioară</button>
      <button type="button" className="secondary" disabled={!page?.hasMore} onClick={() => setOffset(value => value + PAGE_SIZE)}>Pagina următoare</button>
    </div>}
  </section>;
}
