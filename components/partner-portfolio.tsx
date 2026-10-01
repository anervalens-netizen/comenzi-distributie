'use client';
import {PartnerBillingPeriod} from './partner-billing-period';
import { PartnerActivity } from './partner-activity';
import { PartnerSales } from './partner-sales';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { currentLocalWorkUserId } from '@/lib/local-work';
const userIdForWork=()=>currentLocalWorkUserId();
import { enqueue, readWork, saveWork, removeWork } from '@/lib/offline-work';
import { api, ApiError, invalidateApiReadCache } from '@/lib/client-api';
import type {
  PartnerDetail,
  PortfolioPartner,
} from '@/lib/partner-portfolio-types';
import { PartnerPlanning } from './partner-planning';
import { PartnerNew } from './partner-new';
import type { PartnerSummary, PartnerBrowse } from '@/lib/partner-map-types';
import './partner-portfolio.css';
import './interaction-ui.css';
import type { PartnerMapView } from './partner-map';
const PartnerMap = lazy(() => import('./partner-map'));
const preloadPartnerMap = () => { void import('./partner-map').catch(()=>{}); };
const date = (s: string) => new Date(s).toLocaleString('ro-RO');
export function PartnerPortfolio({ userId, manager=false, scopeQuery='', active=true }: { userId: string; manager?: boolean; scopeQuery?: string; active?: boolean }) {
  const stateKey='mobiup-partner-view|'+userId+'|'+scopeQuery;
  const savedView=()=>{if(typeof window==='undefined')return {};try{return JSON.parse(localStorage.getItem(stateKey)||'{}');}catch{return {};}};
  const mapView=useRef<PartnerMapView|null>(savedView().map||null);
  const getMapView=useCallback(()=>mapView.current,[]);
  const saveMapView=useCallback((view:PartnerMapView)=>{mapView.current=view;try{const state=JSON.parse(localStorage.getItem(stateKey)||'{}');localStorage.setItem(stateKey,JSON.stringify({...state,map:view}));}catch{}},[stateKey]);
  const [salesPeriod,setSalesPeriod]=useState('');
  const [activityOpen,setActivityOpen]=useState(false);
  const [layout,setLayout]=useState<'split'|'list'|'map'>(()=>{const saved=savedView().layout;return ['split','list','map'].includes(saved)?saved:typeof window!=='undefined'&&window.innerWidth<700?'list':'split';});
  const [highlighted,setHighlighted]=useState<string|null>(null);
  const [planning, setPlanning] = useState(false),
    [planRefresh, setPlanRefresh] = useState(0),
    [adding, setAdding] = useState(false),
    [partners, setPartners] = useState<PartnerSummary[]>([]),
    [catalogLoading, setCatalogLoading] = useState(true),
    [catalogError, setCatalogError] = useState(''),
    [catalogReload, setCatalogReload] = useState(0),
    [data, setData] = useState<PartnerBrowse | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [query, setQuery] = useState(()=>savedView().query||''),
    [county, setCounty] = useState(()=>savedView().county||''),
    [city, setCity] = useState(()=>savedView().city||''),
    [route, setRoute] = useState(()=>savedView().route||''),
    [position, setPosition] = useState(()=>savedView().position||''),
    [days, setDays] = useState(()=>savedView().days||''),
    [selected, setSelected] = useState<string | null>(null),
    [refreshIndex, setRefreshIndex] = useState(0);
  useEffect(()=>{try{localStorage.setItem(stateKey,JSON.stringify({query,county,city,route,position,days,layout,map:mapView.current}));}catch{}},[stateKey,query,county,city,route,position,days,layout]);
  const openPartner=(id:string|null)=>{setSelected(id);if(id)setHighlighted(id);};
  const filterKey = useMemo(
    () =>
      new URLSearchParams({
        ...Object.fromEntries(new URLSearchParams(scopeQuery)),
        q: query,
        county,
        city,
        route,
        position,
        days,
        salesPeriod,
      }).toString(),
    [query, county, city, route, position, days, scopeQuery, salesPeriod],
  );
  const [request, setRequest] = useState({key:filterKey,offset:0});
  const {key:requestKey,offset}=request;
  const [dataKey, setDataKey] = useState('');
  const refreshSeen=useRef(refreshIndex);
  const browseActive=active&&!planning&&!adding&&!activityOpen;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (filterKey !== requestKey) {
        setLoading(true);
        setRequest({key:filterKey,offset:0});
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [filterKey, requestKey]);
  const refresh = useCallback(() => {
    setLoading(true);
    setRequest({key:filterKey,offset:0});
    setRefreshIndex((n) => n + 1);
  }, [filterKey]);
  useEffect(() => {
    if (!browseActive || requestKey!==filterKey) return;
    // No full portfolio/contact download on opening Parteneri. Only 100 list rows.
    const controller = new AbortController();
    const forceRefresh=refreshSeen.current!==refreshIndex;
    refreshSeen.current=refreshIndex;
    api<PartnerBrowse>(
      `partner/browse?${requestKey}&offset=${offset}`,
      'GET',
      undefined,
      controller.signal,
      {preferCache:true,maxAgeMs:15000,forceRefresh},
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setDataKey(requestKey);
        setError('');
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [browseActive, filterKey, requestKey, offset, refreshIndex]);
  useEffect(() => {
    if (!active || !planning) return;
    const controller = new AbortController();
    // Planner needs its search catalog only when explicitly opened, not on map pan.
    api<{ partners: PartnerSummary[] }>(
      'partner/summary',
      'GET',
      undefined,
      controller.signal,
      {preferCache:true,maxAgeMs:15000,forceRefresh:refreshIndex!==0||catalogReload!==0},
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setPartners(result.partners);
          setCatalogLoading(false);
          setCatalogError('');
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setCatalogLoading(false);
          setCatalogError(e.message);
        }
      });
    return () => controller.abort();
  }, [active, planning, planRefresh, refreshIndex, catalogReload]);
  const current = dataKey === filterKey && requestKey === filterKey;
  const filtered = data?.partners || [];
  const counties = data?.facets.counties || [],
    cities = data?.facets.cities || [],
    routes = data?.facets.routes || [];
  if (!active) return null;
  if (planning)
    return (
      <>
        {catalogLoading && <output>Se încarcă lista de magazine…</output>}
        {catalogError && (
          <p role="alert" className="error-banner">
            Lista de magazine nu a putut fi încărcată: {catalogError}{' '}
            <button
              type="button"
              onClick={() => {
                setCatalogLoading(true);
                setCatalogError('');
                setCatalogReload((n) => n + 1);
              }}
            >
              Reîncarcă lista de magazine
            </button>
          </p>
        )}
        <PartnerPlanning
          partners={partners}
          catalogStatus={
            catalogLoading ? 'loading' : catalogError ? 'error' : 'ready'
          }
          onBack={() => setPlanning(false)}
          onOpen={setSelected}
          refreshKey={planRefresh}
        />
        {selected && (
          <PartnerSheet
            key={selected}
            id={selected}
            onClose={() => setSelected(null)}
            onSaved={() => {
              refresh();
              setPlanRefresh((n) => n + 1);
            }}
          />
        )}
      </>
    );
  if(activityOpen)return <><PartnerActivity key={scopeQuery} scopeQuery={scopeQuery} salesPeriod={salesPeriod} onPeriodChange={setSalesPeriod} onBack={()=>setActivityOpen(false)} onOpen={openPartner}/>{selected&&<PartnerSheet key={selected} id={selected} onClose={()=>setSelected(null)} onSaved={refresh}/>}</>;
  if (adding)
    return (
      <section className="partner-hub">
        <button className="secondary" onClick={() => setAdding(false)}>
          ← Înapoi la Parteneri
        </button>
        <PartnerNew userId={userId} />
      </section>
    );
  return (
    <section className={'partner-hub'+(manager?' manager-partner-hub':'')} data-layout={layout}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{manager?'PORTOFOLIUL ECHIPEI':'PORTOFOLIUL MEU'}</span>
          <h1>Parteneri</h1>
          <p>Puncte de lucru, contacte și vizite.</p>
        </div>
        <button type="button" className="secondary" onClick={()=>setActivityOpen(true)}>Activitate și vânzări</button>
        {!manager&&<><button className="primary" onClick={() => setAdding(true)}>
          + Adaugă partener
        </button>
        <button
          className="secondary"
          onClick={() => {
            setCatalogLoading(true);
            setCatalogError('');
            setPlanning(true);
          }}
        >
          Vizite și traseu
        </button></>}
        {<div className="manager-map-modes" aria-label="Afișarea partenerilor">{([['split','Listă + Hartă'],['list','Listă'],['map','Hartă']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={layout===value} onPointerEnter={value==='list'?undefined:preloadPartnerMap} onFocus={value==='list'?undefined:preloadPartnerMap} onClick={()=>setLayout(value)}>{label}</button>)}</div>}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error} <button onClick={() => refresh()}>Reîncearcă</button>
        </div>
      )}
      <div className="partner-filters">
        <PartnerBillingPeriod value={salesPeriod} onChange={v=>{setSalesPeriod(v);}}/>
        <label>
          Caută partener
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Nume, CUI, localitate sau adresă"
          />
        </label>
        <label>
          Județ
          <select
            value={county}
            onChange={(e) => {
              setCounty(e.target.value);
              setCity('');
              setRoute('');
            }}
          >
            <option value="">Toate județele</option>
            {counties.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Localitate
          <input
            type="search"
            list="partner-localities"
            value={city}
            placeholder="Caută localitatea…"
            onChange={(e) => {
              setCity(e.target.value);
            }}
          />
          <datalist id="partner-localities">
            {cities.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          Rută
          <select
            value={route}
            onChange={(e) => {
              setRoute(e.target.value);
            }}
          >
            <option value="">Toate rutele</option>
            {routes.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Poziție
          <select
            value={position}
            onChange={(e) => {
              setPosition(e.target.value);
            }}
          >
            <option value="">Toate</option>
            <option value="yes">Cu poziție</option>
            <option value="no">Fără poziție</option>
          </select>
        </label>
        <label>
          Vizite
          <select
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
            }}
          >
            <option value="">Toate</option>
            <option value="never">Fără vizite înregistrate</option>
            {[7, 14, 30, 60, 90].map((d) => (
              <option key={d} value={d}>
                Nevizitat de {d} zile
              </option>
            ))}
          </select>
        </label>
      </div>
      {salesPeriod&&<p className="muted">Lista și harta folosesc aceeași perioadă de facturare, conform ultimului import. Istoricul neasociat se vede separat în filtru.</p>}
      <p className="muted" aria-live="polite">
        {error
          ? filtered.length ? 'Datele afișate au rămas disponibile, dar actualizarea a eșuat.' : 'Portofoliul nu a putut fi încărcat.'
          : loading || !current
          ? 'Se încarcă portofoliul…'
          : `${data?.total || 0} puncte de lucru · ${data?.located || 0} pe hartă · ${(data?.total || 0) - (data?.located || 0)} fără poziție`}
      </p>
      <div className={manager?'manager-partner-grid':undefined}>
      <div className={manager?'manager-partner-map-pane':undefined}>
      <Suspense fallback={<div className="partner-map">Se încarcă harta…</div>}>
        {data && browseActive && layout!=='list' && (
          <PartnerMap
            getView={getMapView}
            onView={saveMapView}
            active={current}
            filters={requestKey}
            bounds={current ? data.bounds : undefined}
            styleUrl={data.styleUrl}
            refreshKey={refreshIndex}
            onSelect={openPartner}
            selectedId={manager?highlighted:undefined}
            focusPoint={manager?filtered.find(partner=>partner.id===highlighted):undefined}
          />
        )}
      </Suspense>
      {current && !loading && !data?.located && (
        <p className="muted">
          Niciun punct localizat în selecție. Harta arată zona generală;
          adresele sunt disponibile în listă.
        </p>
      )}
      {!!data?.geocoded && (
        <p className="muted">
          Coordonate din adrese:{' '}
          <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">
            Powered by Geoapify
          </a>{' '}
          ·{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            © OpenStreetMap contributors
          </a>
          . Pinii galbeni indică poziții aproximative. Pozițiile pot fi
          corectate în fișă.
        </p>
      )}
      </div>
      <div className={manager?'manager-partner-list-pane':undefined}>
      <div className="partner-list">
        {filtered.map((p) => (
          <button
            type="button"
            className={'partner-card'+(manager&&highlighted===p.id?' partner-card-selected':'')}
            key={p.id}
            onClick={() => openPartner(p.id)}
          >
            <strong>{p.name}</strong>
            <span>{p.address || 'Adresă de identificat'}</span>
            {p.historyCatalog?.kind==='company'&&<small>Firmă din istoric · punct de lucru de identificat</small>}
            {p.historyCatalog?.franchiseCode&&<small>Cod punct: {p.historyCatalog.franchiseCode}</small>}
            <span>
              {p.city} · {p.county}
            </span>
            <small>
              CUI {p.cui} · Ruta {p.route || '—'}
            </small>
            <span className="partner-badges">
              <span>{positionLabel(p)}</span>
              <span>
                {p.lastVisitedAt
                  ? `Ultima vizită: ${date(p.lastVisitedAt)}`
                  : 'Fără vizite înregistrate'}
              </span>
            </span>
          </button>
        ))}
      </div>
      {!loading && current && !filtered.length && !error && (
        <p>Nu există parteneri pentru filtrele alese.</p>
      )}
      {current && data && (offset>0 || data.nextOffset != null) && (
        <nav className="bounded-pagination" aria-label="Pagini parteneri">
          <button
            className="secondary"
            disabled={loading||offset===0}
            onClick={() => {
              setLoading(true);
              setRequest({key:requestKey,offset:Math.max(0,offset-100)});
            }}
          >
            Pagina anterioară
          </button>
          <span>{offset+1}–{Math.min(offset+filtered.length,data.total)} din {data.total}</span>
          <button
            className="secondary"
            disabled={loading||data.nextOffset==null}
            onClick={() => {
              if(data.nextOffset==null)return;
              setLoading(true);
              setRequest({key:requestKey,offset:data.nextOffset});
            }}
          >
            Pagina următoare
          </button>
        </nav>
      )}
      </div></div>
      {selected && (
        <PartnerSheet
          key={selected}
          id={selected}
          manager={manager}
          onClose={() => setSelected(null)}
          onSaved={() => refresh()}
        />
      )}
    </section>
  );
}
export function PartnerSheet({
  id,
  onClose,
  onSaved,
  manager=false,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
  manager?: boolean;
}) {
  const [detail, setDetail] = useState<PartnerDetail | null>(null),
    [form, setForm] = useState<PortfolioPartner | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [notes, setNotes] = useState(''),
    [pending, setPending] = useState<{ id: string; notes: string } | null>(
      null,
    );
  const dialog = useRef<HTMLDialogElement>(null);
  const contactEditor = useRef<HTMLDetailsElement>(null);
  const positionEditor = useRef<HTMLDetailsElement>(null);
  const gpsButton = useRef<HTMLButtonElement>(null);
  function openPositionEditor() {
    if (form?.canEdit !== true) return;
    if (contactEditor.current) contactEditor.current.open = true;
    if (positionEditor.current) {
      positionEditor.current.open = true;
      positionEditor.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    gpsButton.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;const controller=new AbortController();
    api<PartnerDetail>(`partner/portfolio/${encodeURIComponent(id)}`,'GET',undefined,controller.signal)
      .then(async (data) => {
        if (alive) {
          setDetail(data);
          setForm(await readWork<PortfolioPartner>(userIdForWork(),'partner',id)||data.partner);
          setPending(await readWork<{id:string;notes:string}>(userIdForWork(),'visit',id)||null);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;controller.abort();
    };
  }, [id]);
  useEffect(()=>{if(form)void saveWork(userIdForWork(),'partner',id,form).catch(e=>setError(e.message));},[form,id]);
  useEffect(()=>{
    const synced=(event:Event)=>{const value=(event as CustomEvent).detail;if(value.userId!==userIdForWork())return;
      if(value.path===`partner/portfolio/${encodeURIComponent(id)}`&&value.result?.partner){const saved=value.result.partner as PortfolioPartner;setForm(current=>current?{...current,revision:saved.revision}:saved);setDetail(current=>current?{...current,partner:saved}:current);setNotice('Datele trimise au fost sincronizate. Modificările noi rămân în fișă.');}
      if(value.path===`partner/portfolio/${encodeURIComponent(id)}/visits`&&value.result?.visits){setDetail(value.result);setPending(null);void removeWork(userIdForWork(),'visit',id).catch(e=>setError(e.message));setNotice('Vizita a fost sincronizată.');}
    };window.addEventListener('mobiup-sync-confirmed',synced);return()=>window.removeEventListener('mobiup-sync-confirmed',synced);
  },[id]);
  async function save() {
    if (form?.canEdit!==true) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await api<{ partner: PortfolioPartner }>(
        `partner/portfolio/${encodeURIComponent(id)}`,
        'PATCH',
        form,
      );
      setForm(data.partner);
      setDetail((d) => (d ? { ...d, partner: data.partner } : d));
      await removeWork(userIdForWork(),'partner',id);setNotice('Datele au fost sincronizate.');
      invalidateApiReadCache('partner/');
      onSaved();
    } catch (e) {
      if(!(e instanceof ApiError)||e.status>=500){try{await enqueue(userIdForWork(),`partner/portfolio/${encodeURIComponent(id)}`,'PATCH',form,{scope:'partner',id,value:form});setNotice('Salvat pe telefon · În așteptare.');}catch(storage){setError((storage as Error).message);}}else setError((e as Error).message);
    } finally {setBusy(false);}
  }
  function gps() {
    if(form?.canEdit!==true)return;
    if (!navigator.geolocation) {
      setError('Localizarea nu este disponibilă în acest browser.');
      return;
    }
    setBusy(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setForm((f) =>
          f
            ? {
                ...f,
                latitude: p.coords.latitude,
                longitude: p.coords.longitude,
                positionSource: 'gps',
                positionAccuracy: p.coords.accuracy,
              }
            : f,
        );
        setNotice(
          'Poziția a fost preluată. Verifică dacă ești la partener, apoi salvează.',
        );
        setBusy(false);
      },
      (e) => {
        setError(e.message);
        setBusy(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }
  async function visit() {
    if(manager||form?.canEdit!==true)return;
    setBusy(true);
    setError('');
    setNotice('');
    const payload = pending || { id: crypto.randomUUID(), notes };
    setPending(payload);
    try {
      await saveWork(userIdForWork(),'visit',id,payload);
      const d = await api<PartnerDetail>(
        `partner/portfolio/${encodeURIComponent(id)}/visits`,
        'POST',
        payload,
      );
      setDetail(d);
      setNotes('');
      setPending(null);
      await removeWork(userIdForWork(),'visit',id);setNotice('Vizita a fost sincronizată.');
      invalidateApiReadCache('partner/');
      onSaved();
    } catch (e) {
      if(!(e instanceof ApiError)||e.status>=500){try{await enqueue(userIdForWork(),`partner/portfolio/${encodeURIComponent(id)}/visits`,'POST',payload,{scope:'visit',id,value:payload});setNotice('Vizită salvată pe telefon · În așteptare.');}catch(storage){setError((storage as Error).message);}}else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!detail?.nextCursor) return;
    setBusy(true);
    try {
      const d = await api<PartnerDetail>(
        `partner/portfolio/${encodeURIComponent(id)}?cursor=${encodeURIComponent(detail.nextCursor)}`,
      );
      setDetail((old) =>
        old ? { ...d, visits: [...old.visits, ...d.visits] } : d,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={dialog} className="partner-sheet" onCancel={onClose}>
      <header>
        <h2>{form?.name || 'Fișa partenerului'}</h2>
        <button
          className="secondary"
          onClick={onClose}
          aria-label="Închide fișa"
        >
          Închide
        </button>
      </header>
      {form?.canEdit === true && (
        <button
          type="button"
          className="primary partner-position-update"
          onClick={openPositionEditor}
          disabled={busy}
          aria-controls={'partner-position-' + id}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          Actualizează poziția magazinului
        </button>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && <output>{notice}</output>}
      {!form && !error && <p>Se încarcă…</p>}
      {form && (
        <>
          <p>
            {form.address}
            <br />
            {[form.city,form.county].filter(Boolean).join(', ')}
          </p>
          <p className="muted">
            CUI {form.cui}{form.route&&<> · Ruta {form.route}</>}
          </p>
          {form.historyCatalog?.kind==='company'&&<p className="muted">Firmă identificată în istoricul de vânzări. Punctul de lucru și adresa necesită confirmare.</p>}
          {form.historyCatalog?.franchiseCode&&<p className="muted">Cod punct de lucru: {form.historyCatalog.franchiseCode}</p>}
          {form.historyCatalog?.countySource==='historical_seller_inferred'&&<p className="muted">Județ dedus din teritoriile agenților care au facturat. Adresa fizică trebuie confirmată.</p>}
          {detail && ((detail.partner.latitude !== null && detail.partner.longitude !== null) || (form.address && form.city)) && (
            <details>
              <summary>Navighează către magazin</summary>
              <div className="partner-actions">
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href={`https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(detail.partner.latitude !== null && detail.partner.longitude !== null ? `${detail.partner.latitude},${detail.partner.longitude}` : [form.address, form.city, form.county, 'România'].filter(Boolean).join(', '))}`}
                >
                  Google Maps
                </a>
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href={
                    detail.partner.latitude !== null &&
                    detail.partner.longitude !== null
                      ? `https://waze.com/ul?ll=${encodeURIComponent(`${detail.partner.latitude},${detail.partner.longitude}`)}&navigate=yes`
                      : `https://waze.com/ul?q=${encodeURIComponent([form.address, form.city, form.county, 'România'].filter(Boolean).join(', '))}`
                  }
                >
                  Waze
                </a>
              </div>
              {detail.partner.positionQuality?.endsWith('_approximate') && (
                  <p className="muted">
                    Navigarea duce la un pin aproximativ. Confirmă poziția
                    magazinului la sosire.
                  </p>
                )}
              {detail.partner.latitude === null && (
                <p className="muted">
                  Fără poziție salvată: verifică adresa găsită în aplicația de
                  navigare.
                </p>
              )}
            </details>
          )}
          {(detail?.partner.contact||detail?.partner.phone)&&<p className="partner-contact-summary">{detail.partner.contact}{detail.partner.contact&&detail.partner.phone?' · ':''}{detail.partner.phone&&<a href={'tel:'+detail.partner.phone}>{detail.partner.phone}</a>}</p>}
          <PartnerSales key={id} id={id}/>
          <details ref={contactEditor} className="partner-contact-edit">
            <summary>Date de contact și poziția magazinului</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="form-stack"
          >
            <fieldset disabled={busy||form.canEdit!==true}>
              <legend>Contact și poziție</legend>
              {(['contact', 'phone', 'email'] as const).map((field, i) => (
                <label key={field}>
                  {['Persoană de contact', 'Telefon', 'Email'][i]}
                  <input
                    type={
                      field === 'email'
                        ? 'email'
                        : field === 'phone'
                          ? 'tel'
                          : 'text'
                    }
                    value={form[field]}
                    onChange={(e) =>
                      setForm({ ...form, [field]: e.target.value })
                    }
                  />
                </label>
              ))}
              <p className="muted">
                {form.latitude === null
                  ? 'Fără poziție'
                  : `${positionLabel(form)}${form.positionAccuracy !== null ? ` · precizie raportată ${Math.round(form.positionAccuracy)} m` : ''}`}
              </p>
              {form.positionSource === 'geocoding' &&
                form.positionQuality === 'street_approximate' && (
                  <p className="muted">
                    Pin aproximativ pe strada identificată în localitatea și
                    județul din adresă. Numărul magazinului nu a fost localizat;
                    verifică poziția la sosire.
                  </p>
                )}
              {form.positionSource === 'geocoding' &&
                form.positionQuality === 'address_approximate' && (
                  <p className="muted">
                    Adresa returnată corespunde străzii, numărului, localității
                    și județului. Poziția este estimată și poate necesita
                    ajustare la magazin.
                  </p>
                )}
              {form.positionQuality === 'locality_approximate' && (
                <p className="muted">
                  Reper aproximativ în localitate. Verifică poziția
                  magazinului înainte de navigare.
                </p>
              )}
              <details ref={positionEditor} id={'partner-position-' + id} className="partner-position-correction">
                <summary>Corectează poziția magazinului</summary>
                <p className="muted">
                  Folosește această opțiune doar dacă pinul lipsește sau este
                  greșit și ești în fața magazinului. Preia poziția GPS, apoi
                  confirmă prin „Salvează datele”.
                </p>
                <button
                  type="button"
                  className="partner-position-link"
                  ref={gpsButton}
                  onClick={gps}
                >
                  Preia poziția GPS a magazinului
                </button>
              </details>
              <div className="partner-actions">
                <button className="primary" type="submit">
                  Salvează datele
                </button>
              </div>
            </fieldset>
          </form>
          </details>
          <details className="partner-visits">
            <summary>Vizite {detail ? `(${detail.visitCount})` : ''}</summary>
            {!manager&&<><label>
              Notă vizită
              <textarea
                maxLength={2000}
                disabled={busy || !!pending || form.canEdit!==true}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={busy||form.canEdit!==true}
              onClick={() => void visit()}
            >
              {pending
                ? 'Reîncearcă salvarea vizitei'
                : 'Înregistrează vizita acum'}
            </button>
            <p className="muted">
              Vizita se înregistrează doar la apăsarea butonului.
            </p></>}
            {manager&&<p className="muted">Istoricul vizitelor înregistrate de agenți.</p>}
            {detail?.visits.map((v) => (
              <article className="partner-visit" key={v.id}>
                <strong>{date(v.visitedAt)}</strong> · {v.agentName}
                {v.notes && <p>{v.notes}</p>}
              </article>
            ))}
            {!detail?.visits.length && <p>Fără vizite înregistrate.</p>}
            {detail?.nextCursor && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void more()}
              >
                Vizite mai vechi
              </button>
            )}
          </details>
        </>
      )}
    </dialog>
  );
}

function positionLabel(p: PartnerSummary) {
  if (p.latitude === null) return 'Fără poziție';
  if (p.positionSource === 'gps') return 'Poziție GPS';
  if (p.positionQuality === 'locality_approximate')
    return 'Reper aproximativ în localitate';
  if (p.positionQuality?.endsWith('_approximate'))
    return p.positionQuality === 'street_approximate'
      ? 'Aproximativ · pe stradă'
      : 'Aproximativ · adresă potrivită';
  if (p.positionSource !== 'geocoding') return 'Poziție salvată';
  return 'Poziție din adresă';
}
