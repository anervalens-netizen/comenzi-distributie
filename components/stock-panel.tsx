'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, Package } from 'lucide-react';
import { errorMessage, normalize } from '@/lib/client-api';
import { stockCode } from '@/lib/stock-types';
import type { StockView, StockRow } from '@/lib/stock-types';
import './stock.css';

export function useAgentStock(warehouseId?: string | null) {
  const [view, setView] = useState<StockView | null>(null);
  const generation = useRef(0);
  const [loading, setLoading] = useState(Boolean(warehouseId));
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    const requestGeneration = ++generation.current;
    if (!warehouseId) return;
    return fetch(`/api/stock?warehouseId=${encodeURIComponent(warehouseId)}`, { credentials: 'same-origin' })
      .then(async r => { const data = await r.json() as StockView & { error?: string }; if (!r.ok) throw new Error(data.error || 'Stocul nu a putut fi încărcat.'); return data; })
      .then(next => { if (requestGeneration === generation.current) {setView(next);setError('');} }).catch(e => { if (requestGeneration === generation.current) setError(errorMessage(e)); }).finally(() => { if (requestGeneration === generation.current) setLoading(false); });
  }, [warehouseId]);
  const invalidate=useCallback(()=>{generation.current++;},[]);
  useEffect(() => { void refresh(); const onImported = () => void refresh(); window.addEventListener('stock-imported', onImported); window.addEventListener('focus', onImported); return () => { invalidate(); window.removeEventListener('stock-imported', onImported); window.removeEventListener('focus', onImported); }; }, [refresh,invalidate]);
  const lookup = useMemo(() => new Map((view?.rows || []).map(row => [stockCode(row.code), row])), [view]);
  const currentView=view?.warehouseId===warehouseId?view:null;
  return { view:currentView, lookup:currentView?lookup:new Map<string,StockRow>(), loading:Boolean(warehouseId)&&(loading||(!currentView&&!error)), error, refresh };
}

export function StockMetadata({view,loading,error}:{view:StockView|null;loading:boolean;error:string}) {
  if(loading)return <p className="stock-editor-meta">Se actualizează stocurile…</p>;
  if(error)return <output className="stock-editor-meta">Stocuri indisponibile. Reîncearcă actualizarea paginii.</output>;
  const date=(value:string)=>new Date(value).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'});
  return <p className="stock-editor-meta">Stoc agent: {view?.importedAt?date(view.importedAt):'neimportat'} · Depozit: {view?.depotImportedAt?date(view.depotImportedAt):'neimportat'}. Valorile sunt din ultimul import; — înseamnă informație absentă.</p>;
}

export function StockQuantity({ row, depotQuantity, loading, error }: { row?: StockRow; depotQuantity?: number | null; loading?: boolean; error?: string }) {
  if (loading) return <small className="stock-inline">Stoc actual: se încarcă…</small>;
  if (error) return <small className="stock-inline stock-muted">Stoc indisponibil</small>;
  return <small className="stock-inline">Stoc agent: {row ? `${row.quantity.toLocaleString('ro-RO')} buc.` : '—'} · Depozit: {depotQuantity == null ? '—' : `${depotQuantity.toLocaleString('ro-RO')} buc.`}</small>;
}

export function StockPanel({ warehouseId, title = 'Stoc actual', showImportMeta = true }: { warehouseId?: string | null; title?: string; showImportMeta?: boolean }) {
  return <StockPanelContent key={warehouseId || 'none'} warehouseId={warehouseId} title={title} showImportMeta={showImportMeta} />;
}

function StockPanelContent({ warehouseId, title, showImportMeta }: { warehouseId?: string | null; title: string; showImportMeta: boolean }) {
  const { view, loading, error, refresh } = useAgentStock(warehouseId);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const format = (value: number) => value.toLocaleString('ro-RO');
  const rows = useMemo(() => (view?.rows || []).filter(r => {
    const group = r.category || 'Necategorizate';
    return (!category || group === category) && normalize(`${r.code} ${r.name} ${group}`).includes(normalize(query));
  }), [view, query, category]);
  const categories = useMemo(() => [...new Set((view?.rows || []).map(r => r.category || 'Necategorizate'))].sort((a,b) => a === 'Necategorizate' ? 1 : b === 'Necategorizate' ? -1 : a.localeCompare(b, 'ro')), [view]);
  const totalPieces = (view?.rows || []).reduce((sum, row) => sum + row.quantity, 0);
  const shownPieces = rows.reduce((sum, row) => sum + row.quantity, 0);
  const grouped = useMemo(() => [...new Set(rows.map(r => r.category || 'Necategorizate'))].sort((a,b) => a === 'Necategorizate' ? 1 : b === 'Necategorizate' ? -1 : a.localeCompare(b, 'ro')).map(group => ({ group, rows: rows.filter(r => (r.category || 'Necategorizate') === group) })), [rows]);
  return <section className="panel stock-panel">
    <div className="panel-heading"><div><h2><Package size={19} /> {title}</h2></div><button className="icon-button" onClick={() => void refresh()} disabled={loading} aria-label="Actualizează stocul"><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div>
    {showImportMeta && view?.importedAt && <p className="stock-meta">Importat la {new Date(view.importedAt).toLocaleString('ro-RO')} {view.filename && `· ${view.filename}`}</p>}
    {error ? <p className="error-banner" role="alert">{error}</p> : loading ? <output className="portfolio-message">Se încarcă stocul…</output> : !view?.importedAt ? <p className="portfolio-message">Nu există un import de stoc pentru această gestiune.</p> : <>
      <div className="stock-summary"><div><small>Coduri distincte</small><b>{format(new Set(view.rows.map(r=>stockCode(r.code))).size)}</b></div><div><small>Stoc total</small><b>{format(totalPieces)} <em>buc.</em></b></div><div><small>Categorii</small><b>{format(categories.length)}</b></div></div>
      <div className="stock-filters"><div className="search-box"><Search size={17} /><input aria-label="Caută în stoc" placeholder="Caută produs, cod sau categorie…" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="Filtrează după categorie" value={category} onChange={e => setCategory(e.target.value)}><option value="">Toate categoriile</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
      <p className="stock-result-count">Afișate {format(rows.length)} coduri · {format(shownPieces)} buc.</p>
      {!rows.length ? <p className="portfolio-message">Niciun produs găsit.</p> : <div className="stock-list">{grouped.map(({group, rows: groupRows}) => <section className="stock-category" key={group}><h3>{group}<small>{format(groupRows.length)} coduri · {format(groupRows.reduce((sum, row) => sum + row.quantity, 0))} buc.</small></h3>{groupRows.map(row => <div className="stock-row" key={row.code}><span><strong>{row.name}</strong><small>{row.code}</small></span><b>{format(row.quantity)} buc.</b></div>)}</section>)}</div>}
    </>}
  </section>;
}
