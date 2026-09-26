'use client';

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, FileSpreadsheet, Filter, LoaderCircle, RefreshCw, Search, TrendingUp, Upload } from 'lucide-react';
import type { User } from '@/lib/types';
import type { SalesAggregate, SalesPreview, SalesView } from '@/lib/sales-types';
import { errorMessage, money } from '@/lib/client-api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import './sales.css';

const SalesChart = lazy(() => import('./sales-chart'));

const MAX_SIZE = 8_000_000;
const monthFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit' });
const currentMonth = () => monthFormatter.format(new Date());

async function responseData<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: T & { error?: string };
  try { data = JSON.parse(text) as T & { error?: string }; } catch { throw new Error('Răspuns invalid de la server.'); }
  if (!response.ok) throw new Error(data.error || 'Operațiunea nu a reușit.');
  return data;
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00+02:00`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: 'short', year: 'numeric' });
}
function formatDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function monthLabel(month: string) {
  const date = new Date(`${month}-01T00:00:00+02:00`);
  return Number.isNaN(date.valueOf()) ? month : date.toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest', month: 'long', year: 'numeric' });
}

export function SalesPanel({ user, users }: { user: User; users: User[] }) {
  const manager = user.role === 'manager';
  const [view, setView] = useState<'current' | 'history'>('current');
  const [month, setMonth] = useState(currentMonth);
  const [siteCode, setSiteCode] = useState('all');
  const [siteQuery, setSiteQuery] = useState('');
  const [snapshot, setSnapshot] = useState<SalesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [fromMonth, setFromMonth] = useState(() => `${currentMonth().slice(0, 4)}-01`);
  const [toMonth, setToMonth] = useState(currentMonth);
  const requestId = useRef(0);
  const [knownSites, setKnownSites] = useState<Array<{ siteCode: string; location: string }>>([]);

  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    queueMicrotask(() => { if (id === requestId.current) { setLoading(true); setError(''); setSnapshot(null); } });
    const params = new URLSearchParams({ month });
    if (view === 'history') { params.set('fromMonth', fromMonth); params.set('toMonth', toMonth); }
    if (manager && siteCode !== 'all') params.set('siteCode', siteCode);
    fetch(`/api/sales?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(responseData<SalesView>)
      .then(result => { if (id === requestId.current) { if (siteCode === 'all') setKnownSites(previous => { const merged = new Map(previous.map(site => [site.siteCode, site])); for (const site of result.sites) merged.set(site.siteCode, { siteCode: site.siteCode, location: site.location }); return [...merged.values()]; }); setSnapshot(result); } })
      .catch(err => { if (id === requestId.current && (err as Error)?.name !== 'AbortError') setError(errorMessage(err)); })
      .finally(() => { if (id === requestId.current) setLoading(false); });
    return () => controller.abort();
  }, [fromMonth, manager, month, siteCode, reload, toMonth, view]);
  useEffect(() => {
    const refresh = () => setReload(value => value + 1);
    window.addEventListener('sales-imported', refresh);
    return () => window.removeEventListener('sales-imported', refresh);
  }, []);

  function selectMonth(next: string) {
    setMonth(next);
    if (next < fromMonth) setFromMonth(`${next.slice(0, 4)}-01`);
    if (next > toMonth) setToMonth(next);
  }

  const agents = useMemo(() => users.filter(item => item.role === 'agent' && item.active !== 0 && item.siteCode).sort((a, b) => a.name.localeCompare(b.name, 'ro')), [users]);
  const siteOptions = useMemo(() => {
    const known = new Set(agents.map(agent => agent.siteCode));
    const allSites = [...knownSites, ...(snapshot?.sites || []).map(site => ({ siteCode: site.siteCode, location: site.location }))];
    const uniqueSites = [...new Map(allSites.map(site => [site.siteCode, site])).values()];
    const missing = uniqueSites.filter(site => !known.has(site.siteCode)).map(site => ({ id: `missing-${site.siteCode}`, name: 'Fără agent alocat încă', siteCode: site.siteCode }));
    return [...agents, ...missing];
  }, [agents, knownSites, snapshot?.sites]);
  const filteredSiteOptions = useMemo(() => {
    const filtered = siteOptions.filter(option => `${option.name} ${option.siteCode}`.toLocaleLowerCase('ro').includes(siteQuery.toLocaleLowerCase('ro')));
    if (siteCode !== 'all' && !filtered.some(option => option.siteCode === siteCode)) {
      const selected = siteOptions.find(option => option.siteCode === siteCode);
      return selected ? [selected, ...filtered] : filtered;
    }
    return filtered;
  }, [siteCode, siteOptions, siteQuery]);

  const salesBody=<>
      {(view === 'history' || manager) && <div className="sales-toolbar">{view === 'history' && <label>Luna {snapshot?.months.length ? <select aria-label="Luna vânzărilor" value={month} onChange={event => selectMonth(event.target.value)}>{snapshot.months.map(item => <option key={item.month} value={item.month}>{monthLabel(item.month)} · {item.rowCount.toLocaleString('ro-RO')} rânduri</option>)}</select> : <input aria-label="Luna vânzărilor" type="month" value={month} max={currentMonth()} onChange={event => selectMonth(event.target.value || currentMonth())}/>}</label>}{manager && <><label className="sales-filter-search"><span><Search size={14}/> Caută</span><input aria-label="Caută gestiune sau agent" placeholder="Agent sau SiteCode" value={siteQuery} onChange={event => setSiteQuery(event.target.value)}/></label><label className="sales-target"><span><Filter size={14}/> Gestiune / agent</span><select aria-label="Filtrează vânzările după gestiune sau agent" value={siteCode} onChange={event => setSiteCode(event.target.value)}><option value="all">Toată echipa</option>{filteredSiteOptions.map(agent => <option key={agent.id} value={agent.siteCode}>{agent.name} · {agent.siteCode}</option>)}</select></label></>}</div>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {manager && <div className="sales-freshness">{snapshot?.filename ? <><FileSpreadsheet size={15}/><span>Fișier: <strong>{snapshot.filename}</strong> · importat {formatDateTime(snapshot.importedAt)}</span></> : <><AlertTriangle size={15}/><span>Nu există un import pentru {monthLabel(month)}.</span></>}<span className="sales-scope">{siteCode === 'all' ? 'Toată echipa' : `SiteCode ${siteCode}`}</span></div>}
      {loading ? <div className="sales-loading"><LoaderCircle className="spin" size={22}/> Se încarcă vânzările…</div> : error ? <div className="sales-empty sales-load-error"><AlertTriangle size={25}/><strong>Vânzările nu au putut fi încărcate.</strong><span>Verifică conexiunea și încearcă din nou.</span></div> : snapshot?.filename ? <SalesData view={snapshot} history={view === 'history'} showGlobalStats={user.role === 'manager' && user.managerScope === 'global'} showSites={manager} fromMonth={fromMonth} toMonth={toMonth} onFromMonth={setFromMonth} onToMonth={setToMonth}/> : <div className="sales-empty sales-no-import"><AlertTriangle size={25}/><strong>Datele pentru {monthLabel(month)} nu sunt disponibile.</strong><span>Managerul poate încărca datele cumulate ale lunii din caseta de import.</span></div>}
  </>;
  return <div className="sales-page">
    <div className="page-heading sales-heading"><div><span className="eyebrow">PERFORMANȚĂ COMERCIALĂ</span><h1>Vânzări</h1></div><div className="heading-controls"><button className="icon-button refresh" aria-label="Actualizează vânzările" title="Actualizează" disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={19}/></button></div></div>
    <Tabs className="sales-tabs" value={view} onValueChange={value=>{const next=String(value) as 'current'|'history';setView(next);if(next==='current')selectMonth(currentMonth());else{const previous=snapshot?.months.find(item=>item.month<currentMonth())?.month||snapshot?.months[0]?.month;if(previous)selectMonth(previous);}}}>
      <TabsList className="sales-subnav" variant="line" aria-label="Vânzări"><TabsTrigger value="current"><TrendingUp size={17}/>Luna curentă</TabsTrigger><TabsTrigger value="history"><Clock3 size={17}/>Istoric</TabsTrigger></TabsList>
      <TabsContent className="sales-tab-content" value="current" keepMounted>{view==='current'?salesBody:null}</TabsContent>
      <TabsContent className="sales-tab-content" value="history" keepMounted>{view==='history'?salesBody:null}</TabsContent>
    </Tabs>
  </div>;
}

function SalesData({ view, history, showGlobalStats, showSites, fromMonth, toMonth, onFromMonth, onToMonth }: { view: SalesView; history: boolean; showGlobalStats: boolean; showSites: boolean; fromMonth: string; toMonth: string; onFromMonth: (month: string) => void; onToMonth: (month: string) => void }) {
  return <>{history ? <MonthlyOverview monthly={view.monthly} from={fromMonth} to={toMonth} onFrom={onFromMonth} onTo={onToMonth}/> : null}<SegmentCards segments={view.segments}/>{showGlobalStats ? <div className="sales-stats"><div><span>TR · CANTITATE</span><strong>{view.summary.quantity.toLocaleString('ro-RO')}</strong><small>rânduri filtrate din Locatie TR</small></div><div><span>VALOARE TOTALĂ</span><strong>{money(view.summary.value)}</strong><small>din datele lunii</small></div><div><span>RÂNDURI</span><strong>{view.summary.rows.toLocaleString('ro-RO')}</strong><small>în fișier</small></div><div><span>ZILE</span><strong>{view.daily.length.toLocaleString('ro-RO')}</strong><small>cu vânzări</small></div></div> : null}{showSites ? <SitesTable view={view}/> : null}{view.daily.length ? <DailyBreakdown daily={view.daily}/> : null}{view.products.length ? <ProductBreakdown products={view.products}/> : null}</>;
}

function averagePrice(product: Pick<SalesAggregate, 'quantity' | 'value'>) {
  return product.quantity ? product.value / product.quantity : 0;
}

function SegmentProducts({ products, limit = 6 }: { products: SalesView['products']; limit?: number }) {
  const visible = products.slice(0, limit);
  if (!visible.length) return <p className="sales-segment-empty">Nu există produse în această categorie.</p>;
  return <div className="sales-segment-products">{visible.map(product => <div className="sales-segment-product" key={`${product.itemCode}-${product.itemName}`}><span><strong>{product.itemName}</strong><small>{product.itemCode}</small></span><span className="sales-segment-product-qty">{product.quantity.toLocaleString('ro-RO')} buc.<small>medie {money(averagePrice(product))}</small></span><b>{money(product.value)}</b></div>)}</div>;
}

function AccessoryCategoryOverview({ products }: { products: SalesView['products'] }) {
  const byCategory = new Map<string, SalesAggregate>();
  for (const product of products) {
    const name = product.category.trim() || 'Alte accesorii';
    const current = byCategory.get(name) || { rows: 0, quantity: 0, value: 0 };
    current.rows += product.rows;
    current.quantity += product.quantity;
    current.value += product.value;
    byCategory.set(name, current);
  }
  const ranked = [...byCategory.entries()].map(([name, aggregate]) => ({ name, ...aggregate })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'ro'));
  const primary = ranked.slice(0, 5);
  const rest = ranked.slice(5);
  if (rest.length) primary.push(rest.reduce((sum, item) => ({ name: 'Altele', rows: sum.rows + item.rows, quantity: sum.quantity + item.quantity, value: sum.value + item.value }), { name: 'Altele', rows: 0, quantity: 0, value: 0 }));
  const totalValue = primary.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  return <div className="sales-accessory-overview"><div className="sales-accessory-overview-heading"><div><h3>Mix accesorii pe categorii</h3><span>Pondere după valoarea vânzărilor</span></div><small>{ranked.length} categorii</small></div><div className="sales-accessory-category-list">{primary.map(item => { const share = totalValue > 0 ? Math.max(0, item.value) / totalValue * 100 : 0; return <div className="sales-accessory-category" key={item.name}><div className="sales-accessory-category-title"><strong>{item.name}</strong><span>{share.toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%</span></div><div className="sales-accessory-category-track" aria-hidden="true"><i style={{ width: `${share}%` }}/></div><div className="sales-accessory-category-meta"><span>{item.quantity.toLocaleString('ro-RO')} buc.</span><b>{money(item.value)}</b></div></div>; })}</div></div>;
}

function SegmentCards({ segments }: { segments: SalesView['segments'] }) {
  const valueVouchers = segments.cardsSim.products.filter(product => product.subsegment === 'vouchers');
  const numberedProducts = segments.cardsSim.products.filter(product => product.subsegment !== 'vouchers');
  const valueVoucherSummary = segments.cardsSim.subsegments.valueVouchers;
  const numberedCards = { rows: segments.cardsSim.subsegments.cards.rows + segments.cardsSim.subsegments.sim.rows, quantity: segments.cardsSim.subsegments.cards.quantity + segments.cardsSim.subsegments.sim.quantity, value: segments.cardsSim.subsegments.cards.value + segments.cardsSim.subsegments.sim.value };
  return <div className="sales-segments"><article className="sales-segment-card sales-segment-main"><span className="sales-segment-kicker">CARTELE CU NUMĂR</span><strong>{numberedCards.quantity.toLocaleString('ro-RO')} buc.</strong><div className="sales-segment-secondary"><span>Valoare totală</span><b>{money(numberedCards.value)}</b></div><small>{numberedCards.rows.toLocaleString('ro-RO')} rânduri · medie produs {money(averagePrice(numberedCards))}</small><h3>Produse cartele cu număr</h3><SegmentProducts products={numberedProducts} limit={4}/></article>{valueVoucherSummary.rows > 0 && <article className="sales-segment-card sales-segment-vouchers"><span className="sales-segment-kicker">CARTELE VALORICE / VOUCHERE</span><strong>{valueVoucherSummary.quantity.toLocaleString('ro-RO')} buc.</strong><div className="sales-segment-secondary"><span>Valoare totală</span><b>{money(valueVoucherSummary.value)}</b></div><small>{valueVoucherSummary.rows.toLocaleString('ro-RO')} rânduri · medie produs {money(averagePrice(valueVoucherSummary))}</small><SegmentProducts products={valueVouchers} limit={3}/></article>}<article className="sales-segment-card sales-segment-accessories"><div className="sales-accessories-head"><span className="sales-segment-kicker">ACCESORII</span><div className="sales-accessories-metrics"><div className="sales-accessories-metric"><span>Cantitate</span><strong>{segments.accessories.summary.quantity.toLocaleString('ro-RO')} buc.</strong></div><div className="sales-accessories-metric"><span>Rânduri</span><strong>{segments.accessories.summary.rows.toLocaleString('ro-RO')}</strong></div><div className="sales-accessories-metric sales-accessories-metric-value"><span>Valoare totală</span><strong>{money(segments.accessories.summary.value)}</strong></div></div></div><AccessoryCategoryOverview products={segments.accessories.products}/></article><article className="sales-segment-card sales-segment-phones"><span className="sales-segment-kicker">TELEFOANE</span><strong>{segments.phones.summary.quantity.toLocaleString('ro-RO')} buc.</strong><div className="sales-segment-secondary"><span>Valoare totală</span><b>{money(segments.phones.summary.value)}</b></div><small>{segments.phones.summary.rows.toLocaleString('ro-RO')} rânduri · medie produs {money(averagePrice(segments.phones.summary))}</small><SegmentProducts products={segments.phones.products} limit={3}/></article>{segments.unclassified.summary.rows > 0 && <article className="sales-segment-card sales-segment-unclassified"><span className="sales-segment-kicker">NECLASIFICATE</span><strong>{segments.unclassified.summary.quantity.toLocaleString('ro-RO')} buc.</strong><div className="sales-segment-secondary"><span>Valoare totală</span><b>{money(segments.unclassified.summary.value)}</b></div><small>{segments.unclassified.summary.rows.toLocaleString('ro-RO')} rânduri · necesită verificare</small></article>}</div>;
}

function DailyBreakdown({ daily }: { daily: SalesView['daily'] }) {
  const [mode, setMode] = useState<'chart' | 'list'>('chart');
  return <section className="panel sales-table-panel sales-breakdown"><div className="panel-heading"><div><h2>Evoluție zilnică</h2><span className="count-pill">{daily.length}</span></div><div className="sales-view-switch"><button className={mode === 'chart' ? 'active' : ''} onClick={() => setMode('chart')}>Grafic</button><button className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>Listă</button></div></div>{mode === 'chart' ? <Suspense fallback={<div className="sales-chart sales-chart-loading">Se încarcă graficul…</div>}><SalesChart daily={daily}/></Suspense> : <BreakdownRows headers={['DATA', 'RÂNDURI', 'CANTITATE', 'VALOARE']} rows={daily.map(day => [formatDate(day.date), day.rows.toLocaleString('ro-RO'), day.quantity.toLocaleString('ro-RO'), money(day.value)])}/>}</section>;
}

function MonthlyOverview({ monthly, from, to, onFrom, onTo }: { monthly: SalesView['monthly']; from: string; to: string; onFrom: (month: string) => void; onTo: (month: string) => void }) {
  const filtered = monthly.filter(item => item.month >= from && item.month <= to);
  const maxValue = Math.max(...filtered.map(item => Math.abs(item.value)), 1);
  const totalQuantity = filtered.reduce((sum, item) => sum + item.quantity, 0);
  const totalValue = filtered.reduce((sum, item) => sum + item.value, 0);
  const defaultFrom = `${currentMonth().slice(0, 4)}-01`;
  return <section className="panel sales-monthly"><div className="panel-heading"><div><h2>Overview · evoluție lunară</h2><span className="count-pill">{filtered.length}</span></div><div className="sales-range"><label>De la<input aria-label="Prima lună din evoluție" type="month" value={from} max={to} onChange={event => onFrom(event.target.value || defaultFrom)}/></label><label>Până la<input aria-label="Ultima lună din evoluție" type="month" value={to} min={from} max={currentMonth()} onChange={event => onTo(event.target.value || currentMonth())}/></label></div></div><div className="sales-month-summary"><strong>{totalQuantity.toLocaleString('ro-RO')} buc.</strong><span>{money(totalValue)} valoare totală</span><span>{filtered.length} luni cu vânzări</span></div>{filtered.length ? <div className="sales-month-bars">{filtered.map(item => <div className="sales-month-column" key={item.month} title={`${monthLabel(item.month)} · ${item.quantity.toLocaleString('ro-RO')} buc. · ${money(item.value)}`}><div className="sales-month-bar" style={{ height: `${Math.max(4, Math.abs(item.value) / maxValue * 100)}%` }}/><span>{monthLabel(item.month).replace(/\s+\d{4}$/,'')}</span></div>)}</div> : <div className="sales-empty sales-month-empty"><TrendingUp size={22}/><span>Nu există luni cu vânzări în intervalul ales.</span></div>}</section>;
}

function BreakdownRows({ headers, rows }: { headers: string[]; rows: string[][] }) { return <div className="sales-table-wrap"><table className="sales-table"><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}>{cellIndex === 0 ? <strong>{cell}</strong> : cell}</td>)}</tr>)}</tbody></table></div>; }

function salesProductCategory(product: SalesView['products'][number]) {
  if (product.segment === 'cardsSim') return product.subsegment === 'vouchers' ? 'Cartele valorice / vouchere' : 'Cartele cu număr';
  if (product.segment === 'phones') return 'Telefoane';
  if (product.segment === 'unclassified') return 'Neclasificate';
  return product.category.trim() || 'Alte accesorii';
}

function ProductBreakdown({ products }: { products: SalesView['products'] }) {
  const [category, setCategory] = useState('Toate');
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(30);
  const categories = useMemo(() => ['Toate', ...new Set(products.map(salesProductCategory))], [products]);
  const activeCategory = categories.includes(category) ? category : 'Toate';
  const categoryProducts = activeCategory === 'Toate' ? products : products.filter(product => salesProductCategory(product) === activeCategory);
  const normalizedQuery = query.trim().toLocaleLowerCase('ro');
  const filtered = normalizedQuery ? categoryProducts.filter(product => `${product.itemName} ${product.itemCode} ${product.brand}`.toLocaleLowerCase('ro').includes(normalizedQuery)) : categoryProducts;
  const visible = filtered.slice(0, visibleCount);
  return <section className="panel sales-table-panel sales-breakdown sales-products-panel"><div className="panel-heading"><div><h2>Produse</h2><span className="count-pill">{visible.length}/{filtered.length}</span></div><label className="sales-sites-filter"><Search size={15}/><input aria-label="Caută produs după denumire sau cod" placeholder="Caută produs sau cod" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(30); }}/></label></div><div className="sales-category-list" aria-label="Categorii produse">{categories.map(item => <button key={item} className={item === activeCategory ? 'active' : ''} aria-pressed={item === activeCategory} onClick={() => { setCategory(item); setVisibleCount(30); }}>{item}<span>{item === 'Toate' ? products.length : products.filter(product => salesProductCategory(product) === item).length}</span></button>)}</div>{filtered.length ? <><div className="sales-table-wrap sales-products-table"><table className="sales-table"><thead><tr><th>PRODUS</th><th>COD</th><th>CANTITATE</th><th>VALOARE</th></tr></thead><tbody>{visible.map(product => <tr key={`${product.itemCode}-${product.itemName}`}><td><strong>{product.itemName}</strong></td><td>{product.itemCode}</td><td>{product.quantity.toLocaleString('ro-RO')}</td><td>{money(product.value)}</td></tr>)}</tbody></table></div><div className="sales-product-cards">{visible.map(product => <article key={`${product.itemCode}-${product.itemName}`}><div><strong>{product.itemName}</strong><small>{product.itemCode} · {salesProductCategory(product)}</small></div><span>{product.quantity.toLocaleString('ro-RO')} buc.</span><b>{money(product.value)}</b></article>)}</div><div className="sales-view-switch sales-product-more">{visible.length < filtered.length && <button onClick={() => setVisibleCount(count => count + 30)}>Arată încă {Math.min(30, filtered.length - visible.length)}</button>}{visibleCount > 30 && <button onClick={() => setVisibleCount(30)}>Arată mai puține</button>}</div></> : <div className="sales-empty sales-sites-empty"><Search size={22}/><span>Nu există produse pentru căutarea „{query}”.</span></div>}</section>;
}

function SitesTable({ view }: { view: SalesView | null }) {
  const [query, setQuery] = useState('');
  if (!view || !view.sites.length) return <section className="panel sales-table-panel"><div className="sales-empty"><TrendingUp size={25}/><strong>Datele pentru {monthLabel(view?.month || currentMonth())} nu sunt disponibile.</strong><span>Managerul poate încărca datele cumulate ale lunii din caseta de import.</span></div></section>;
  const normalizedQuery = query.trim().toLocaleLowerCase('ro');
  const sites = normalizedQuery ? view.sites.filter(site => `${site.siteCode} ${site.location} ${site.agent}`.toLocaleLowerCase('ro').includes(normalizedQuery)) : view.sites;
  return <section className="panel sales-table-panel sales-sites-panel"><div className="panel-heading"><div><h2>Pe gestiuni și agenți</h2><span className="count-pill">{sites.length}/{view.sites.length}</span></div><label className="sales-sites-filter"><Search size={15}/><input aria-label="Caută SiteCode sau agent" placeholder="Caută SiteCode sau agent" value={query} onChange={event => setQuery(event.target.value)}/></label></div>{sites.length ? <div className="sales-table-wrap sales-sites-scroll"><table className="sales-table"><thead><tr><th>SITECODE</th><th>LOCAȚIE</th><th>AGENT</th><th>RÂNDURI</th><th>CANT.</th><th>VALOARE</th></tr></thead><tbody>{sites.map(site => <tr key={site.siteCode}><td><strong>{site.siteCode}</strong></td><td>{site.location || '—'}</td><td>{site.agent || <span className="unassigned-label">Fără agent alocat încă</span>}</td><td>{site.rows.toLocaleString('ro-RO')}</td><td>{site.quantity.toLocaleString('ro-RO')}</td><td>{money(site.value)}</td></tr>)}</tbody></table></div> : <div className="sales-empty sales-sites-empty"><Search size={22}/><span>Nu există gestiuni pentru căutarea „{query}”.</span></div>}</section>;
}

export function SalesImport({lastImportText}:{lastImportText:string}) {
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<SalesPreview | null>(null), [month, setMonth] = useState(currentMonth), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [regressionAcknowledged, setRegressionAcknowledged] = useState(false);
  const uploadId = useRef(0);
  async function chooseFile(next: File | null) {
    const id = ++uploadId.current;
    setFile(next); setPreview(null); setRegressionAcknowledged(false); setError(''); setMessage('');
    if (!next) return;
    if (next.size > MAX_SIZE || !/\.xls[x]?$/i.test(next.name)) { setError('Alege un fișier .xls sau .xlsx de maximum 8 MB.'); return; }
    setBusy(true);
    try { const response = await fetch('/api/sales/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Sales-Filename': encodeURIComponent(next.name), 'X-Sales-Month': month }, body: next }); const result = await responseData<SalesPreview>(response); if (id === uploadId.current) setPreview(result); }
    catch (err) { if (id === uploadId.current) setError(errorMessage(err)); } finally { if (id === uploadId.current) setBusy(false); }
  }
  async function importFile() {
    if (!file || !preview || busy || (preview.requiresRegressionAcknowledgement && !regressionAcknowledged)) return;
    setBusy(true); setError(''); setMessage('');
    try { const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Sales-Filename': encodeURIComponent(file.name), 'X-Sales-Month': month, 'X-Sales-Version': String(preview.revision), 'X-Sales-Revision': String(preview.revision), 'X-Sales-Hash': preview.fileHash, 'X-Sales-Mapping-Hash': preview.mappingHash, 'X-Sales-Allow-Historical': '1' }; if (regressionAcknowledged) headers['X-Sales-Allow-Regression'] = '1'; const response = await fetch('/api/sales/import', { method: 'POST', credentials: 'same-origin', headers, body: file }); const result = await responseData<{ rows: number; month: string }>(response); setMessage(`Datele pentru ${monthLabel(result.month)} au fost înlocuite cu ${result.rows.toLocaleString('ro-RO')} rânduri.`); setFile(null); setPreview(null); setRegressionAcknowledged(false); window.dispatchEvent(new Event('sales-imported')); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  const onMonth = (value: string) => { setMonth(value); setFile(null); setPreview(null); setRegressionAcknowledged(false); setError(''); setMessage(''); };
  const onFile = (next: File | null) => { void chooseFile(next); };
  const onImport = () => { void importFile(); };
  const onRegression = (value: boolean) => setRegressionAcknowledged(value);
  const missingCodes = [...new Set((preview?.mappings || []).filter(mapping => mapping.status === 'missing').map(mapping => mapping.siteCode).filter(Boolean))];
  const duplicateCodes = [...new Set((preview?.mappings || []).filter(mapping => mapping.status === 'duplicate').map(mapping => mapping.siteCode).filter(Boolean))];
  return <section className="panel sales-import"><div className="panel-heading"><div><h2><Upload size={18}/> Import vânzări zilnice</h2><p>Previzualizează fișierul, apoi înlocuiește datele cumulate ale lunii.</p></div></div><p className="import-last-status">{lastImportText}</p><div className="sales-import-controls"><label>Luna importului<input aria-label="Luna importului de vânzări" type="month" value={month} max={currentMonth()} disabled={busy} onChange={event => onMonth(event.target.value || currentMonth())}/></label><label className="sales-upload"><FileSpreadsheet size={19}/><span>{file ? file.name : 'Alege fișier .xls / .xlsx'}</span><input aria-label="Fișier vânzări Excel" disabled={busy} type="file" accept=".xls,.xlsx" onChange={event => { onFile(event.target.files?.[0] || null); event.target.value = ''; }}/></label></div>{busy && <p className="notice"><LoaderCircle className="spin" size={17}/> Se procesează fișierul…</p>}{error && <p className="error-banner" role="alert">{error}</p>}{message && <p className="notice"><Check size={17}/> {message}</p>}{preview && <div className="sales-preview"><div className="sales-preview-summary"><strong>{preview.rowCount.toLocaleString('ro-RO')} rânduri TR</strong><span>{preview.summary.quantity.toLocaleString('ro-RO')} buc.</span><span>{money(preview.summary.value)}</span><span>{preview.sites.length} SiteCode</span><span>{formatDate(preview.firstDate)} – {formatDate(preview.lastDate)}</span></div>{missingCodes.length > 0 && <div className="sales-warning compact"><AlertTriangle size={17}/><div><strong>SiteCode fără agent alocat încă: {missingCodes.join(', ')}</strong><span>Toate rândurile TR rămân în import și vor fi atribuite automat când agentul este configurat.</span></div></div>}{duplicateCodes.length > 0 && <div className="sales-warning compact"><AlertTriangle size={17}/><div><strong>SiteCode cu mai mulți agenți: {duplicateCodes.join(', ')}</strong><span>Rândurile rămân în datele lunii; clarifică maparea pentru vizualizarea individuală.</span></div></div>}{preview.requiresRegressionAcknowledgement && <div className="sales-warning compact"><AlertTriangle size={17}/><div><strong>Fișierul reduce acoperirea datelor deja importate.</strong><span>{preview.coverageChange.rowDelta<0?`${Math.abs(preview.coverageChange.rowDelta).toLocaleString('ro-RO')} rânduri mai puține. `:''}{preview.coverageChange.missingSiteCodes.length?`Dispar SiteCode: ${preview.coverageChange.missingSiteCodes.join(', ')}. `:''}Poate fi o corecție legitimă; confirmă doar dacă vrei să înlocuiești luna.</span></div></div>}{preview.requiresRegressionAcknowledgement && <label className="sales-regression-check"><input type="checkbox" checked={regressionAcknowledged} disabled={busy} onChange={event => onRegression(event.target.checked)}/><span>Confirm că vreau să înlocuiesc luna cu această acoperire mai mică.</span></label>}<div className="sales-preview-actions"><span>Locatie TR este criteriul de includere. Verifică luna și valorile înainte de înlocuire.</span><button className="primary" disabled={busy || (preview.requiresRegressionAcknowledgement && !regressionAcknowledged)} onClick={onImport}><Upload size={17}/> Confirmă înlocuirea</button></div></div>}</section>;
}
