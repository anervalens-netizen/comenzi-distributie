'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ClipboardList,
  RefreshCw,
  Trash2,
  Pencil,
  Download,
} from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/client-api';
import {
  currentLocalWorkUserId,
  readLocalWork,
  removeLocalWork,
  writeLocalWork,
} from '@/lib/local-work';
import { useAgentStock } from './stock-panel';
import { useInventoryPending } from './use-inventory-pending';
import type {
  Inventory,
  InventorySummary,
  InventoryScope,
} from '@/lib/inventory-types';
import './inventory.css';

type Pending = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  inventoryId?: string;
};
type InventoryHistoryPage = {
  inventories: InventorySummary[];
  hasMore?: boolean;
  nextOffset?: number;
};
const HISTORY_PAGE_SIZE = 50;
const countValue = (v: string) =>
  /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) <= 1000000;
const fmt = (n: number) => n.toLocaleString('ro-RO');
function inventoryHistoryPath(
  warehouseId?: string | null,
  offset = 0,
  limit = HISTORY_PAGE_SIZE,
) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  if (warehouseId) params.set('warehouseId', warehouseId);
  return `inventory?${params}`;
}

export function InventoryPanel({
  warehouseId,
}: {
  warehouseId?: string | null;
}) {
  const { view } = useAgentStock(warehouseId);
  const [history, setHistory] = useState<InventorySummary[]>([]),
    [active, setActive] = useState<Inventory | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false),
    [historyNextOffset, setHistoryNextOffset] = useState(0),
    [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [scope, setScope] = useState<InventoryScope>('all'),
    [selection, setSelection] = useState('');
  const [ean, setEan] = useState(''),
    [quantity, setQuantity] = useState('1'),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Pending | null>(null),
    [manualRecovery, setManualRecovery] = useState<Pending | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [manualStorageError, setManualStorageError] = useState('');
  const working = useRef(false),
    historyLoadInFlight = useRef(false),
    scanner = useRef<HTMLInputElement>(null),
    [owner] = useState(currentLocalWorkUserId);
  const refresh = () =>
    api<InventoryHistoryPage>(inventoryHistoryPath(warehouseId)).then((r) => {
      setHistory(r.inventories);
      setHistoryHasMore(Boolean(r.hasMore));
      setHistoryNextOffset(r.nextOffset ?? r.inventories.length);
    });

  useEffect(() => {
    let cancelled = false;
    api<InventoryHistoryPage>(inventoryHistoryPath(warehouseId))
      .then((r) => {
        if (!cancelled) {
          setHistory(r.inventories);
          setHistoryHasMore(Boolean(r.hasMore));
          setHistoryNextOffset(r.nextOffset ?? r.inventories.length);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [warehouseId]);

  async function loadMoreHistory() {
    if (historyLoadInFlight.current || !historyHasMore) return;
    historyLoadInFlight.current = true;
    setHistoryLoadingMore(true);
    setError('');
    try {
      const result = await api<InventoryHistoryPage>(
        inventoryHistoryPath(warehouseId, historyNextOffset),
      );
      setHistory((items) => {
        const seen = new Set(items.map((item) => item.id));
        return [
          ...items,
          ...result.inventories.filter((item) => !seen.has(item.id)),
        ];
      });
      setHistoryHasMore(Boolean(result.hasMore));
      setHistoryNextOffset(
        result.nextOffset ?? historyNextOffset + result.inventories.length,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      historyLoadInFlight.current = false;
      setHistoryLoadingMore(false);
    }
  }

  const {
    drafts,
    draftConflicts,
    setDraft,
    clearDraft,
    discardDrafts,
    keepLocalConflict,
    acceptServerConflict,
    scanQueue,
    processing,
    paused,
    enqueueScan,
    retryQueue,
    discardQueue,
    storageError,
    closedRecovery,
    discardClosedRecovery,
  } = useInventoryPending({
    active,
    onActive: setActive,
    onError: setError,
    onMessage: setMessage,
    onRefresh: () => {
      void refresh().catch(() => {});
    },
  });

  const activeId = active?.id;
  const activeStatus = active?.status;
  const activeCanEdit = active?.canEdit;
  useEffect(() => {
    if (!activeId || !owner) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const restored = readLocalWork<Pending>(
        'inventory-manual',
        owner,
        activeId,
      );
      if (cancelled) return;
      if (restored.error) setManualStorageError(restored.error);
      if (restored.value && activeStatus === 'draft' && activeCanEdit) {
        setPending(restored.value);setManualRecovery(null);
      } else if (restored.value && (activeStatus !== 'draft' || !activeCanEdit)) {
        setPending(null);setManualRecovery(restored.value);
      } else setManualRecovery(null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, activeStatus, activeCanEdit, owner]);

  const locked = busy || !!pending;
  const hasDraftConflicts=Object.keys(draftConflicts).length>0;
  const manualLocked = locked || processing || scanQueue.length > 0;
  const dirty = Object.entries(drafts).some(
    ([code, v]) =>
      v !==
      (active?.lines.find((l) => l.code === code)?.counted?.toString() ?? ''),
  );
  useEffect(() => {
    if (active?.canEdit && !locked && !dirty) scanner.current?.focus();
  }, [active?.id, active?.canEdit, locked, dirty]);

  function persistManual(p: Pending) {
    if (!owner || !p.inventoryId) return;
    setManualStorageError(
      writeLocalWork('inventory-manual', owner, p.inventoryId, p),
    );
  }

  async function run(p: Pending) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setPending(p);
    setError('');
    setMessage('');
    if (p.method === 'PATCH' && p.inventoryId) persistManual(p);
    try {
      const r = await api<{ inventory: Inventory }>(p.path, p.method, p.body);
      setActive(r.inventory);
      setPending(null);setManualRecovery(null);
      if (p.inventoryId && owner)
        setManualStorageError(
          removeLocalWork('inventory-manual', owner, p.inventoryId),
        );
      if (p.body.action === 'set') clearDraft(String(p.body.code));
      setMessage(p.method === 'POST' ? 'Inventarul a fost pornit.' : 'Salvat.');
      void refresh().catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        if (e.status === 409 && p.inventoryId) {
          try {
            const latest=(await api<{ inventory: Inventory }>('inventory/' + p.inventoryId)).inventory;
            setActive(latest);
            if(latest.status!=='draft'||!latest.canEdit){setPending(null);setManualRecovery(p);}
            else {setPending(null);if(owner)setManualStorageError(removeLocalWork('inventory-manual',owner,p.inventoryId));}
          } catch {}
        } else {
          setPending(null);
          if (p.inventoryId && owner)setManualStorageError(removeLocalWork('inventory-manual', owner, p.inventoryId));
        }
      }
      setError(errorMessage(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function discardRecovery() {
    if(!active||!window.confirm('Renunți definitiv la cantitățile și scanările locale neconfirmate?'))return;
    discardClosedRecovery();
    if(owner)removeLocalWork('inventory-manual',owner,active.id);
    setManualRecovery(null);setError('');
  }

  function downloadRecovery() {
    if(!active)return;
    const lines=[['Tip','Cod / EAN','Valoare locală','Valoare server']];
    for(const [code,draft] of Object.entries(closedRecovery?.drafts||{}))lines.push(['Cantitate',code,draft.value,active.lines.find(line=>line.code===code)?.counted?.toString()||'']);
    for(const scan of closedRecovery?.scanQueue||[])lines.push(['Scanare',scan.ean,String(scan.quantity),'neconfirmată']);
    if(manualRecovery){const label=typeof manualRecovery.body.code==='string'?manualRecovery.body.code:typeof manualRecovery.body.action==='string'?manualRecovery.body.action:'';lines.push(['Operațiune manuală',label,JSON.stringify(manualRecovery.body),'neconfirmată']);}
    const csv=lines.map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
    a.href=url;a.download=`inventar-recuperare-${active.id}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }

  function mutate(body: Record<string, unknown>) {
    if (!active?.canEdit || manualLocked) return;
    void run({
      path: 'inventory/' + active.id,
      method: 'PATCH',
      inventoryId: active.id,
      body: {
        ...body,
        revision: active.revision,
        operationId: crypto.randomUUID(),
      },
    });
  }

  async function open(id: string) {
    if (locked || working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      setActive(
        (await api<{ inventory: Inventory }>('inventory/' + id)).inventory,
      );
      setMessage('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function remove(id: string, revision: number) {
    if (
      locked ||
      working.current ||
      !window.confirm(
        'Ștergi acest inventar? Numărătoarea și istoricul lui vor fi eliminate.',
      )
    )
      return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await api<{ ok: true }>('inventory/' + id, 'DELETE', { revision });
      setHistory((items) => items.filter((item) => item.id !== id));
      if (owner) {
        removeLocalWork('inventory', owner, id);
        removeLocalWork('inventory-manual', owner, id);
      }
      setMessage('Inventarul a fost șters.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const checked = active?.lines.filter((l) => l.counted !== null) || [];
  const minus = checked.reduce(
      (s, l) => s + Math.max(0, l.expected - l.counted!),
      0,
    ),
    plus = checked.reduce(
      (s, l) => s + Math.max(0, l.counted! - l.expected),
      0,
    );
  const categories = [
    ...new Set(view?.rows.map((l) => l.category || 'Necategorizate') || []),
  ].sort((a, b) => a.localeCompare(b, 'ro'));
  const rows =
    active?.lines.filter(
      (l) =>
        `${l.code} ${l.name} ${l.category} ${l.ean || ''}`
          .toLocaleLowerCase('ro')
          .includes(query.toLocaleLowerCase('ro')) &&
        (filter === 'all' ||
          (filter === 'unchecked'
            ? l.counted === null
            : l.counted !== null && l.counted !== l.expected)),
    ) || [];

  return (
    <section className="panel inventory-panel">
      <div className="panel-heading">
        <h2>
          <ClipboardList size={19} /> Inventar
        </h2>
        <button
          className="icon-button"
          aria-label="Actualizează istoricul inventarelor"
          disabled={locked || historyLoadingMore}
          onClick={() => void refresh().catch((e) => setError(errorMessage(e)))}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      {!active ? (
        <>
          <div className="inventory-start">
            <label>
              Ce inventariezi?
              <select
                disabled={locked}
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as InventoryScope);
                  setSelection('');
                }}
              >
                <option value="all">Tot stocul</option>
                <option value="category">O categorie</option>
                <option value="product">Un cod produs</option>
              </select>
            </label>
            {scope !== 'all' && (
              <label>
                {scope === 'category' ? 'Categorie' : 'Produs'}
                <select
                  disabled={locked}
                  value={selection}
                  onChange={(e) => setSelection(e.target.value)}
                >
                  <option value="">Alege…</option>
                  {scope === 'category'
                    ? categories.map((c) => <option key={c}>{c}</option>)
                    : view?.rows.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.code} · {l.name}
                        </option>
                      ))}
                </select>
              </label>
            )}
            <button
              className="primary"
              disabled={
                locked || !view?.importedAt || (scope !== 'all' && !selection)
              }
              onClick={() =>
                void run({
                  path: 'inventory',
                  method: 'POST',
                  body: {
                    id: crypto.randomUUID(),
                    warehouseId,
                    scope,
                    value: selection,
                  },
                })
              }
            >
              Pornește inventarul
            </button>
          </div>
          {!view?.importedAt && (
            <p className="notice">
              Este necesar un import de stoc pentru această gestiune.
            </p>
          )}
          <div className="inventory-history">
            {!history.length && <p>Niciun inventar salvat încă.</p>}
            {history.map((i) => (
              <div className="inventory-history-row" key={i.id}>
                <button
                  className="inventory-history-main"
                  disabled={locked}
                  onClick={() => void open(i.id)}
                >
                  <span>
                    <strong>{i.scopeLabel}</strong>
                    <small>
                      {new Date(i.createdAt).toLocaleString('ro-RO')} ·{' '}
                      {i.createdByName}
                    </small>
                  </span>
                  <b>
                    {i.status === 'draft'
                      ? 'În lucru'
                      : i.status === 'finalized'
                        ? 'Finalizat'
                        : 'Anulat'}{' '}
                    · {i.checkedCodes}/{i.totalCodes} coduri
                  </b>
                </button>
                <div className="inventory-history-actions">
                  <button
                    className="icon-button"
                    title="Deschide inventarul"
                    aria-label={`Deschide inventarul ${i.scopeLabel}`}
                    disabled={locked}
                    onClick={() => void open(i.id)}
                  >
                    {i.status === 'draft' ? (
                      <Pencil size={16} />
                    ) : (
                      <ArrowLeft size={16} />
                    )}
                  </button>
                  <button
                    className="icon-button delete-order"
                    title="Șterge inventarul"
                    aria-label={`Șterge inventarul ${i.scopeLabel}`}
                    disabled={locked}
                    onClick={() => void remove(i.id, i.revision)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
            {historyHasMore && (
              <button
                className="secondary load-more"
                disabled={locked || historyLoadingMore}
                onClick={() => void loadMoreHistory()}
              >
                {historyLoadingMore
                  ? 'Se încarcă…'
                  : `Arată încă ${HISTORY_PAGE_SIZE} de inventare`}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="inventory-header">
            <div>
              <strong>
                {active.scopeLabel} ·{' '}
                {active.status === 'draft'
                  ? 'În lucru'
                  : active.status === 'finalized'
                    ? 'Finalizat'
                    : 'Anulat'}
              </strong>
              <small>
                Stoc de referință:{' '}
                {new Date(active.stockImportedAt).toLocaleString('ro-RO')} ·{' '}
                {active.stockFilename}
              </small>
            </div>
            <button
              className="secondary inventory-back"
              disabled={manualLocked}
              onClick={() => {
                if (
                  dirty &&
                  !window.confirm(
                    'Renunți la cantitățile introduse și nesalvate?',
                  )
                )
                  return;
                if (dirty) discardDrafts();
                setActive(null);
                setError('');
                setMessage('');
              }}
            >
              <ArrowLeft size={18} /> Înapoi
            </button>
          </div>
          {active.canEdit && (
            <form
              className="inventory-scan"
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  !dirty &&
                  countValue(quantity) &&
                  Number(quantity) > 0 &&
                  ean.trim() &&
                  enqueueScan(ean.trim(), Number(quantity))
                ) {
                  setEan('');
                  queueMicrotask(() => scanner.current?.focus());
                }
              }}
            >
              <input
                ref={scanner}
                aria-label="EAN scanat"
                placeholder="Scanează EAN și apasă Enter"
                value={ean}
                disabled={locked || dirty}
                onChange={(e) => setEan(e.target.value)}
              />
              <input
                type="number"
                aria-label="Bucăți la scanare"
                min="1"
                max="1000000"
                step="1"
                value={quantity}
                disabled={locked || dirty}
                onChange={(e) => setQuantity(e.target.value)}
              />
              <button
                className="primary"
                disabled={
                  locked ||
                  dirty ||
                  !ean.trim() ||
                  !countValue(quantity) ||
                  Number(quantity) < 1
                }
              >
                {processing ? 'Adaugă în coadă' : 'Adaugă scanarea'}
              </button>
            </form>
          )}
          {scanQueue.length > 0 && (
            <div className="notice">
              <strong>{scanQueue.length} scanări neconfirmate.</strong>{' '}
              {paused
                ? 'Confirmarea este oprită; scanările sunt păstrate local.'
                : processing
                  ? 'Se confirmă în ordine, fără să blocheze scannerul.'
                  : 'Pregătite pentru confirmare.'}
              {paused && (
                <>
                  <button className="secondary" onClick={retryQueue}>
                    Reîncearcă
                  </button>
                  <button
                    className="quiet"
                    onClick={() =>
                      window.confirm('Renunți la scanările neconfirmate?') &&
                      discardQueue()
                    }
                  >
                    Renunță la coadă
                  </button>
                </>
              )}
            </div>
          )}
          {(closedRecovery||manualRecovery)&&<div className="inventory-recovery notice" role="alert"><div><strong>Muncă locală neconfirmată păstrată</strong><p>Inventarul este acum read-only. Valorile de pe server nu sunt modificate; poți compara sau exporta datele locale înainte să renunți la ele.</p></div>{closedRecovery&&Object.entries(closedRecovery.drafts).length>0&&<div className="inventory-recovery-list">{Object.entries(closedRecovery.drafts).map(([code,draft])=><span key={code}><b>{code}</b> local {draft.value||'—'} · server {active.lines.find(line=>line.code===code)?.counted??'—'}</span>)}</div>}{closedRecovery&&closedRecovery.scanQueue.length>0&&<p>{closedRecovery.scanQueue.length} scanări locale neconfirmate sunt păstrate.</p>}{manualRecovery&&<p>Există și o operațiune manuală neconfirmată.</p>}<div className="inventory-recovery-actions"><button className="secondary" onClick={downloadRecovery}><Download size={17}/> Descarcă recuperarea CSV</button><button className="quiet" onClick={discardRecovery}>Renunță la datele locale</button></div></div>}
          <div className="inventory-summary">
            <span>
              Verificate{' '}
              <b>
                {checked.length}/{active.lines.length} coduri
              </b>
            </span>
            <span>
              Numărate{' '}
              <b>{fmt(checked.reduce((s, l) => s + l.counted!, 0))} buc.</b>
            </span>
            <span>
              Minus <b>{fmt(minus)} buc.</b>
            </span>
            <span>
              Plus <b>{fmt(plus)} buc.</b>
            </span>
          </div>
          {dirty && (
            <p className="notice">
              Cantitățile introduse sunt păstrate local. Salvează-le înainte de
              scanare sau finalizare.
            </p>
          )}
          {Object.keys(draftConflicts).length>0&&<div className="inventory-recovery notice" role="alert"><div><strong>Cantități locale în conflict</strong><p>Inventarul s-a modificat în altă sesiune. Valorile locale rămân păstrate până alegi explicit ce păstrezi.</p></div><div className="inventory-recovery-list">{Object.entries(draftConflicts).map(([code,draft])=>{const server=active.lines.find(line=>line.code===code)?.counted;return <span className="inventory-conflict-row" key={code}><span><b>{code}</b> local {draft.value||'—'} · server {server??'—'}</span><span className="inventory-conflict-actions"><button className="secondary" onClick={()=>keepLocalConflict(code)}>Păstrează local</button><button className="quiet" onClick={()=>acceptServerConflict(code)}>Folosește server</button></span></span>;})}</div></div>}
          <div className="inventory-filters">
            <input
              aria-label="Caută în inventar după cod, EAN sau denumire"
              placeholder="Caută cod, EAN sau denumire…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Filtrează liniile inventarului"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">Toate codurile</option>
              <option value="unchecked">Nenumărate</option>
              <option value="differences">Cu diferențe</option>
            </select>
          </div>
          <div className="inventory-lines">
            {rows.map((l) => {
              const draft = drafts[l.code] ?? l.counted?.toString() ?? '',
                changed = draft !== (l.counted?.toString() ?? ''),
                delta = l.counted === null ? null : l.counted - l.expected;
              return (
                <div className="inventory-line" key={l.code}>
                  <span className="inventory-product">
                    <strong>{l.name}</strong>
                    <small>
                      {l.code}
                      {l.ean && ` · EAN ${l.ean}`} · {l.category}
                    </small>
                  </span>
                  <span className="inventory-expected">
                    Stoc <b>{fmt(l.expected)}</b>
                  </span>
                  <span className="inventory-count">
                    Numărat{' '}
                    {active.canEdit ? (
                      <input
                        aria-label={'Numărat ' + l.code}
                        inputMode="numeric"
                        value={draft}
                        placeholder="—"
                        disabled={manualLocked}
                        onChange={(e) => setDraft(l.code, e.target.value)}
                      />
                    ) : (
                      <b>{l.counted === null ? '—' : fmt(l.counted)}</b>
                    )}
                  </span>
                  {active.canEdit && (
                    <button
                      className="secondary"
                      disabled={manualLocked || !changed || !countValue(draft)}
                      onClick={() =>
                        mutate({
                          action: 'set',
                          code: l.code,
                          quantity: Number(draft),
                        })
                      }
                    >
                      Salvează
                    </button>
                  )}
                  <span
                    className={
                      'inventory-delta ' +
                      (delta === 0
                        ? 'equal'
                        : delta === null
                          ? ''
                          : 'difference')
                    }
                  >
                    {delta === null
                      ? 'Nenumărat'
                      : delta === 0
                        ? 'Conform'
                        : `${delta > 0 ? '+' : ''}${fmt(delta)} buc.`}
                  </span>
                </div>
              );
            })}
          </div>
          {active.canEdit && (
            <div className="inventory-actions">
              <button
                className="danger"
                disabled={manualLocked}
                onClick={() =>
                  window.confirm(
                    'Anulezi acest inventar? Numărătoarea salvată rămâne în istoric.',
                  ) && mutate({ action: 'cancel' })
                }
              >
                Anulează inventarul
              </button>
              <button
                className="primary"
                disabled={
                  manualLocked ||
                  dirty ||
                  hasDraftConflicts ||
                  checked.length !== active.lines.length
                }
                onClick={() => mutate({ action: 'finalize' })}
              >
                Finalizează inventarul
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {(storageError || manualStorageError) && (
        <p className="error-banner" role="alert">
          {storageError || manualStorageError}
        </p>
      )}
      {pending && !busy && (
        <p className="notice">
          Salvarea nu este confirmată. Reîncearcă aceeași operațiune pentru a
          verifica rezultatul.
          <button className="secondary" onClick={() => void run(pending)}>
            Reîncearcă salvarea
          </button>
        </p>
      )}
      {message && <output className="notice">{message}</output>}
    </section>
  );
}