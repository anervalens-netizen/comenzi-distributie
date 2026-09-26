'use client';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '@/lib/client-api';
import type {
  PartnerDetail,
  PortfolioPartner,
} from '@/lib/partner-portfolio-types';
import { PartnerPlanning } from './partner-planning';
import { PartnerNew } from './partner-new';
import type { PartnerSummary, PartnerBrowse } from '@/lib/partner-map-types';
import './partner-portfolio.css';
const PartnerMap = lazy(() => import('./partner-map'));
const date = (s: string) => new Date(s).toLocaleString('ro-RO');
export function PartnerPortfolio({ userId }: { userId: string }) {
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
    [query, setQuery] = useState(''),
    [county, setCounty] = useState(''),
    [city, setCity] = useState(''),
    [route, setRoute] = useState(''),
    [position, setPosition] = useState(''),
    [days, setDays] = useState(''),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [refreshIndex, setRefreshIndex] = useState(0);
  const filterKey = useMemo(
    () =>
      new URLSearchParams({
        q: query,
        county,
        city,
        route,
        position,
        days,
      }).toString(),
    [query, county, city, route, position, days],
  );
  const [requestKey, setRequestKey] = useState(filterKey),
    [dataKey, setDataKey] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      if (filterKey !== requestKey) {
        setLoading(true);
        setRequestKey(filterKey);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [filterKey, requestKey]);
  const refresh = useCallback(() => {
    setLoading(true);
    setOffset(0);
    setRefreshIndex((n) => n + 1);
  }, []);
  useEffect(() => {
    // No full portfolio/contact download on opening Parteneri. Only 100 list rows.
    const controller = new AbortController();
    api<PartnerBrowse>(
      `partner/browse?${requestKey}&offset=${offset}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setData((previous) => ({
          ...result,
          partners:
            offset && previous
              ? [
                  ...new Map(
                    [...previous.partners, ...result.partners].map((p) => [
                      p.id,
                      p,
                    ]),
                  ).values(),
                ]
              : result.partners,
        }));
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
  }, [requestKey, offset, refreshIndex]);
  useEffect(() => {
    if (!planning) return;
    const controller = new AbortController();
    // Planner needs its search catalog only when explicitly opened, not on map pan.
    api<{ partners: PartnerSummary[] }>(
      'partner/summary',
      'GET',
      undefined,
      controller.signal,
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
  }, [planning, planRefresh, refreshIndex, catalogReload]);
  const current = dataKey === filterKey && requestKey === filterKey;
  const filtered = current ? data?.partners || [] : [];
  const counties = data?.facets.counties || [],
    cities = data?.facets.cities || [],
    routes = data?.facets.routes || [];
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
    <section className="partner-hub">
      <div className="page-heading">
        <div>
          <span className="eyebrow">PORTOFOLIUL MEU</span>
          <h1>Parteneri</h1>
          <p>Puncte de lucru, contacte și vizite.</p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
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
        </button>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error} <button onClick={() => refresh()}>Reîncearcă</button>
        </div>
      )}
      <div className="partner-filters">
        <label>
          Caută partener
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
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
              setOffset(0);
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
              setOffset(0);
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
              setOffset(0);
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
              setOffset(0);
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
              setOffset(0);
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
      <p className="muted" aria-live="polite">
        {loading || !current
          ? 'Se încarcă portofoliul…'
          : `${data?.total || 0} puncte de lucru · ${data?.located || 0} pe hartă · ${(data?.total || 0) - (data?.located || 0)} fără poziție`}
      </p>
      <Suspense fallback={<div className="partner-map">Se încarcă harta…</div>}>
        {data && (
          <PartnerMap
            filters={requestKey}
            bounds={current ? data.bounds : undefined}
            styleUrl={data.styleUrl}
            refreshKey={refreshIndex}
            onSelect={setSelected}
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
      <div className="partner-list">
        {filtered.map((p) => (
          <button
            type="button"
            className="partner-card"
            key={p.id}
            onClick={() => setSelected(p.id)}
          >
            <strong>{p.name}</strong>
            <span>{p.address || 'Adresă necompletată'}</span>
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
      {!loading && current && !data?.total && !error && (
        <p>Nu există parteneri pentru filtrele alese.</p>
      )}
      {current && data?.nextOffset != null && (
        <button
          className="secondary"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setOffset(data.nextOffset!);
          }}
        >
          Arată încă 100
        </button>
      )}
      {selected && (
        <PartnerSheet
          key={selected}
          id={selected}
          onClose={() => setSelected(null)}
          onSaved={() => refresh()}
        />
      )}
    </section>
  );
}
function PartnerSheet({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
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
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    api<PartnerDetail>(`partner/portfolio/${encodeURIComponent(id)}`)
      .then((data) => {
        if (alive) {
          setDetail(data);
          setForm(data.partner);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  async function save() {
    if (!form) return;
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
      setNotice('Datele au fost salvate.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function gps() {
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
    setBusy(true);
    setError('');
    setNotice('');
    const payload = pending || { id: crypto.randomUUID(), notes };
    setPending(payload);
    try {
      const d = await api<PartnerDetail>(
        `partner/portfolio/${encodeURIComponent(id)}/visits`,
        'POST',
        payload,
      );
      setDetail(d);
      setNotes('');
      setPending(null);
      setNotice('Vizita a fost înregistrată.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
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
            {form.city}, {form.county}
          </p>
          <p className="muted">
            CUI {form.cui} · Punct {form.id} · Ruta {form.route || '—'}
          </p>
          {detail && (
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
              {detail.partner.positionSource === 'geocoding' &&
                detail.partner.positionQuality?.endsWith('_approximate') && (
                  <p className="muted">
                    Navigarea duce la un pin aproximativ. Verifică adresa și
                    numărul magazinului la sosire.
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="form-stack"
          >
            <fieldset disabled={busy}>
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
              <details className="partner-position-correction">
                <summary>Corectează poziția magazinului</summary>
                <p className="muted">
                  Folosește această opțiune doar dacă pinul lipsește sau este
                  greșit și ești în fața magazinului. Preia poziția GPS, apoi
                  confirmă prin „Salvează datele”.
                </p>
                <button
                  type="button"
                  className="partner-position-link"
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
          <section>
            <h3>Vizite {detail ? `(${detail.visitCount})` : ''}</h3>
            <label>
              Notă vizită
              <textarea
                maxLength={2000}
                disabled={busy || !!pending}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void visit()}
            >
              {pending
                ? 'Reîncearcă salvarea vizitei'
                : 'Înregistrează vizita acum'}
            </button>
            <p className="muted">
              Vizita se înregistrează doar la apăsarea butonului.
            </p>
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
          </section>
          <section>
            <h3>Vânzări și facturi</h3>
            <p className="muted">
              Date indisponibile momentan. Istoricul va fi disponibil după
              importul CRM.
            </p>
          </section>
        </>
      )}
    </dialog>
  );
}

function positionLabel(p: PartnerSummary) {
  if (p.latitude === null) return 'Fără poziție';
  if (p.positionSource === 'gps') return 'Poziție GPS';
  if (p.positionSource !== 'geocoding') return 'Poziție salvată';
  if (p.positionQuality === 'street_approximate')
    return 'Aproximativ · pe stradă';
  if (p.positionQuality === 'address_approximate')
    return 'Aproximativ · adresă potrivită';
  return 'Poziție din adresă';
}
