'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, Package } from 'lucide-react';
import { api, errorMessage, normalize } from '@/lib/client-api';
import { stockCode } from '@/lib/stock-types';
import type { StockView, StockRow } from '@/lib/stock-types';
import './stock.css';
import './interaction-ui.css';

export function useAgentStock(warehouseId?: string | null) {
  const [view, setView] = useState<StockView | null>(null);
  const generation = useRef(0);
  const activeRequest=useRef<AbortController|null>(null);
  const [loading, setLoading] = useState(Boolean(warehouseId));
  const [error, setError] = useState('');
  const load = useCallback((forceRefresh=false) => {
    const requestGeneration = ++generation.current;
    activeRequest.current?.abort();activeRequest.current=null;
    if (!warehouseId) {setLoading(false);return;}
    const controller=new AbortController();activeRequest.current=controller;
    setLoading(true);
    setError('');
    return api<StockView>(
      `stock?warehouseId=${encodeURIComponent(warehouseId)}`,
      'GET',
      undefined,
      controller.signal,
      {preferCache:true,maxAgeMs:15000,forceRefresh},
    )
      .then(next => { if (requestGeneration === generation.current) {setView(next);setError('');} })
      .catch(e => { if (requestGeneration === generation.current && (e as Error)?.name!=='AbortError') setError(errorMessage(e)); })
      .finally(() => { if (requestGeneration === generation.current) setLoading(false); });
  }, [warehouseId]);
  const refresh=useCallback(()=>load(true),[load]);
  const invalidate=useCallback(()=>{generation.current++;activeRequest.current?.abort();activeRequest.current=null;},[]);
  useEffect(() => { let alive=true;queueMicrotask(()=>{if(alive)void load(false);}); const onImported = () => void refresh(); window.addEventListener('stock-imported', onImported); window.addEventListener('focus', onImported); return () => { alive=false;invalidate(); window.removeEventListener('stock-imported', onImported); window.removeEventListener('focus', onImported); }; }, [load,refresh,invalidate]);
  const lookup = useMemo(() => new Map((view?.rows || []).map(row => [stockCode(row.code), row])), [view]);
  const currentView=view?.warehouseId===warehouseId?view:null;
  return { view:currentView, lookup:currentView?lookup:new Map<string,StockRow>(), loading:Boolean(warehouseId)&&(loading||(!currentView&&!error)), error, refresh };
}

export function StockMetadata({view,loading,error}:{view:StockView|null;loading:boolean;error:string}) {
  if(loading)return <p className="stock-editor-meta">Se actualizează stocurile…</p>;
  if(error)return <output className="stock-editor-meta">Stocuri indisponibile. Reîncearcă actualizarea paginii.</output>;
  const date=(value:string)=>new Date(value).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'});
  return <p className="stock-editor-meta">Stoc agent: {view?.importedAt?date(view.importedAt):'neimportat'} · Depozit: {view?.depotImportedAt?date(view.depotImportedAt):'neimportat'}. {view?.coverage?.mode==='partial'?'Gestiune: import parțial, produsele omise păstrează valorile și vechimea anterioare. ':''}{view?.depotCoverage?.mode==='partial'?'Depozit: import parțial; data afișată este ultimul snapshot complet, nu o confirmare de acoperire actuală. ':''}— înseamnă informație absentă.</p>;
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
  const [page,setPage]=useState(0);
  const format = (value: number) => value.toLocaleString('ro-RO');
  const indexed=useMemo(()=>(view?.rows||[]).map(row=>{const group=row.category||'Necategorizate';return {row,group,search:normalize(`${row.code} ${row.name} ${group}`)};}),[view]);
  const normalizedQuery=normalize(query);
  const rows = useMemo(() => indexed.filter(({group,search})=>(!category||group===category)&&search.includes(normalizedQuery)).map(({row})=>row),[indexed,normalizedQuery,category]);
  const categories = useMemo(() => [...new Set((view?.rows || []).map(r => r.category || 'Necategorizate'))].sort((a,b) => a === 'Necategorizate' ? 1 : b === 'Necategorizate' ? -1 : a.localeCompare(b, 'ro')), [view]);
  const totalPieces = useMemo(()=>(view?.rows || []).reduce((sum, row) => sum + row.quantity, 0),[view]);
  const distinctCodes=useMemo(()=>new Set((view?.rows||[]).map(row=>stockCode(row.code))).size,[view]);
  const shownPieces = useMemo(()=>rows.reduce((sum, row) => sum + row.quantity, 0),[rows]);
  const pageSize=100;
  const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));
  const currentPage=Math.min(page,pageCount-1);
  const pageRows=useMemo(()=>rows.slice(currentPage*pageSize,(currentPage+1)*pageSize),[rows,currentPage]);
  useEffect(()=>{queueMicrotask(()=>setPage(0));},[query,category,view?.warehouseId,view?.importedAt]);
  const grouped = useMemo(() => {
    const groups=new Map<string,{group:string;rows:StockRow[];pieces:number}>();
    for(const row of pageRows){const group=row.category||'Necategorizate',existing=groups.get(group);if(existing){existing.rows.push(row);existing.pieces+=row.quantity;}else groups.set(group,{group,rows:[row],pieces:row.quantity});}
    return [...groups.values()].sort((a,b)=>a.group==='Necategorizate'?1:b.group==='Necategorizate'?-1:a.group.localeCompare(b.group,'ro'));
  }, [pageRows]);
  return <section className="panel stock-panel">
    <div className="panel-heading"><div><h2><Package size={19} /> {title}</h2></div><button className="icon-button" onClick={() => void refresh()} disabled={loading} aria-label="Actualizează stocul"><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div>
    {view?.coverage?.mode==='partial'&&<p className="stock-meta">Import parțial: produsele omise nu au fost actualizate. Ultimul snapshot complet confirmat: {view.coverage.fullSnapshotAt?new Date(view.coverage.fullSnapshotAt).toLocaleString('ro-RO'):'necunoscut'}.</p>}{showImportMeta && view?.importedAt && <p className="stock-meta">Importat la {new Date(view.importedAt).toLocaleString('ro-RO')} {view.filename && `· ${view.filename}`}</p>}
    {error ? <p className="error-banner" role="alert">{error}</p> : loading ? <output className="portfolio-message">Se încarcă stocul…</output> : !view?.importedAt ? <p className="portfolio-message">Nu există un import de stoc pentru această gestiune.</p> : <>
      <div className="stock-summary"><div><small>Coduri distincte</small><b>{format(distinctCodes)}</b></div><div><small>Stoc total</small><b>{format(totalPieces)} <em>buc.</em></b></div><div><small>Categorii</small><b>{format(categories.length)}</b></div></div>
      <div className="stock-filters"><div className="search-box"><Search size={17} /><input aria-label="Caută în stoc" placeholder="Caută produs, cod sau categorie…" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="Filtrează după categorie" value={category} onChange={e => setCategory(e.target.value)}><option value="">Toate categoriile</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
      <p className="stock-result-count">{format(rows.length)} coduri găsite · {format(shownPieces)} buc. · pagina {currentPage+1} din {pageCount}</p>
      {!rows.length ? <p className="portfolio-message">Niciun produs găsit.</p> : <div className="stock-list">{grouped.map(({group, rows: groupRows,pieces}) => <section className="stock-category" key={group}><h3>{group}<small>{format(groupRows.length)} coduri · {format(pieces)} buc.</small></h3>{groupRows.map(row => <div className="stock-row" key={row.code}><span><strong>{row.name}</strong><small>{row.code}</small></span><b>{format(row.quantity)} buc.</b></div>)}</section>)}</div>}
      {rows.length>pageSize&&<nav className="bounded-pagination" aria-label="Pagini stoc"><button className="secondary" disabled={currentPage===0} onClick={()=>setPage(value=>Math.max(0,value-1))}>Pagina anterioară</button><span>{currentPage*pageSize+1}–{Math.min((currentPage+1)*pageSize,rows.length)} din {rows.length}</span><button className="secondary" disabled={currentPage>=pageCount-1} onClick={()=>setPage(value=>Math.min(pageCount-1,value+1))}>Pagina următoare</button></nav>}
    </>}
  </section>;
}
