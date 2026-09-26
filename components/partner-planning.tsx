'use client';
// Custom combobox uses a rich result list with name and address on separate lines.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import type { PartnerSummary as PortfolioPartner } from '@/lib/partner-map-types';
type Plan = { date: string; stops: string[]; revision: number };
type Visit = {
  id: string;
  customerId: string;
  customerName: string;
  visitedAt: string;
  date: string;
  notes: string;
};
type Week = { week: string; plans: Plan[]; visits: Visit[] };
const localDate = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const shift = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000)
    .toISOString()
    .slice(0, 10);
const monday = (date: string) =>
  shift(date, -((new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7));
export function PartnerPlanning({
  partners,
  catalogStatus,
  onBack,
  onOpen,
  refreshKey,
}: {
  partners: PortfolioPartner[];
  catalogStatus: 'loading' | 'error' | 'ready';
  onBack: () => void;
  onOpen: (id: string) => void;
  refreshKey: number;
}) {
  const [week, setWeek] = useState(() => monday(localDate())),
    [data, setData] = useState<Week | null>(null),
    [draft, setDraft] = useState<Record<string, string[]>>({}),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [query, setQuery] = useState(''),
    [day, setDay] = useState(0),
    [pick, setPick] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [activeChoice, setActiveChoice] = useState(-1);
  useEffect(() => {
    let alive = true;
    api<Week>('partner/planning?week=' + week)
      .then((d) => {
        if (alive) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [week, reload, refreshKey]);
  const dates = Array.from({ length: 5 }, (_, i) => shift(week, i));
  const labels = ['Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri'];
  const byId = new Map(partners.map((p) => [p.id, p]));
  const stops = (date: string) =>
    draft[date] ?? data?.plans.find((p) => p.date === date)?.stops ?? [];
  const change = (date: string, value: string[]) => {
    setDraft((d) => ({ ...d, [date]: value }));
    setNotice('');
  };
  const dirty = Object.keys(draft).length > 0;
  const switchWeek = (value: string) => {
    if (value === week) return;
    if (dirty && !window.confirm('Ai modificări nesalvate. Renunți la ele?'))
      return;
    setData(null);
    setDraft({});
    setError('');
    setNotice('');
    setWeek(value);
    setPick('');
  };
  async function save(date: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const plan = await api<Plan>('partner/planning', 'PUT', {
        date,
        stops: stops(date),
        revision: data?.plans.find((p) => p.date === date)?.revision ?? 0,
      });
      setData((d) =>
        d
          ? { ...d, plans: [...d.plans.filter((p) => p.date !== date), plan] }
          : d,
      );
      setDraft((d) => {
        const next = { ...d };
        delete next[date];
        return next;
      });
      setNotice('Planul zilei a fost salvat.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const normalize = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('ro')
      .trim();
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const choices = partners.filter((p) => {
    const text = normalize(
      [p.name, p.cui, p.city, p.county, p.address, p.route || ''].join(' '),
    );
    return words.every((word) => text.includes(word));
  });
  const visibleChoices = choices.slice(0, 100);
  const choose = (partner: PortfolioPartner) => {
    setPick(partner.id);
    setQuery(partner.name);
    setSearchOpen(false);
    setActiveChoice(-1);
  };
  return (
    <section className="partner-planning">
      <div className="planner-heading">
        <h2>Vizite și traseu</h2>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm('Renunți la modificările nesalvate?'))
              onBack();
          }}
        >
          Înapoi la parteneri
        </button>
      </div>
      <p className="muted">
        Organizează opririle pe zile. Înregistrează vizita din fișa magazinului.
      </p>
      <div className="planner-week-nav">
        <button
          className="secondary"
          disabled={busy}
          aria-label="Săptămâna precedentă"
          onClick={() => switchWeek(shift(week, -7))}
        >
          ‹
        </button>
        <label>
          Săptămâna
          <input
            type="date"
            value={week}
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) switchWeek(monday(e.target.value));
            }}
          />
        </label>
        <button
          className="secondary"
          disabled={busy}
          aria-label="Săptămâna următoare"
          onClick={() => switchWeek(shift(week, 7))}
        >
          ›
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => switchWeek(monday(localDate()))}
        >
          Azi
        </button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}{' '}
          <button
            disabled={busy}
            onClick={() => {
              if (
                !dirty ||
                window.confirm(
                  'Reîncarci și renunți la modificările nesalvate?',
                )
              ) {
                setDraft({});
                setData(null);
                setError('');
                setReload((n) => n + 1);
              }
            }}
          >
            Reîncarcă planul
          </button>
        </p>
      )}
      {notice && <output>{notice}</output>}
      {!data && !error && <p>Se încarcă…</p>}
      {data && (
        <>
          <fieldset disabled={busy || catalogStatus !== 'ready'}>
            <legend>Adaugă o oprire</legend>
            <div className="planner-add-controls">
              <div
                className="planner-store-search"
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    setSearchOpen(false);
                }}
              >
                <label>
                  Caută magazin
                  <input
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={searchOpen}
                    aria-controls="planner-store-options"
                    aria-activedescendant={
                      searchOpen && activeChoice >= 0
                        ? `planner-store-option-${activeChoice}`
                        : undefined
                    }
                    autoComplete="off"
                    value={query}
                    onFocus={() => setSearchOpen(true)}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPick('');
                      setSearchOpen(true);
                      setActiveChoice(-1);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setSearchOpen(false);
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSearchOpen(true);
                        const next = Math.max(
                          0,
                          Math.min(
                            visibleChoices.length - 1,
                            activeChoice + (e.key === 'ArrowDown' ? 1 : -1),
                          ),
                        );
                        setActiveChoice(visibleChoices.length ? next : -1);
                        requestAnimationFrame(() =>
                          document
                            .getElementById(`planner-store-option-${next}`)
                            ?.scrollIntoView({ block: 'nearest' }),
                        );
                      }
                      if (
                        e.key === 'Enter' &&
                        searchOpen &&
                        visibleChoices[activeChoice]
                      ) {
                        e.preventDefault();
                        choose(visibleChoices[activeChoice]);
                      }
                    }}
                    placeholder="Nume, CUI, localitate, adresă sau rută"
                  />
                </label>
                {searchOpen && (
                  <div
                    className="planner-store-options"
                    id="planner-store-options"
                    role="listbox"
                    aria-label="Magazine găsite"
                  >
                    {visibleChoices.map((p, index) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={pick === p.id || activeChoice === index}
                        id={`planner-store-option-${index}`}
                        key={p.id}
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(p)}
                      >
                        <strong>{p.name}</strong>
                        <span>
                          {[p.city, p.county, p.address]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </button>
                    ))}
                    {!choices.length && <p>Niciun magazin găsit.</p>}
                  </div>
                )}
              </div>
              <label>
                Zi
                <select
                  value={day}
                  onChange={(e) => setDay(Number(e.target.value))}
                >
                  {labels.map((l, i) => (
                    <option key={l} value={i}>
                      {l} · {dates[i]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="secondary"
                disabled={
                  !pick ||
                  stops(dates[day]).includes(pick) ||
                  stops(dates[day]).length >= 100
                }
                onClick={() => {
                  change(dates[day], [...stops(dates[day]), pick]);
                  setPick('');
                  setQuery('');
                  setSearchOpen(false);
                }}
              >
                Adaugă în plan
              </button>
            </div>
            <p className="planner-search-status" aria-live="polite">
              {catalogStatus !== 'ready'
                ? catalogStatus === 'loading'
                  ? 'Se încarcă lista de magazine…'
                  : 'Reîncarcă lista pentru a căuta magazine.'
                : pick
                  ? `Selectat: ${byId.get(pick)?.name} · ${byId.get(pick)?.address || ''}`
                  : choices.length > 100
                    ? `Primele 100 din ${choices.length} rezultate. Restrânge căutarea.`
                    : `${choices.length} magazine găsite. Selectează un magazin din rezultate.`}
            </p>
          </fieldset>
          <div className="planner-days" aria-label="Zilele săptămânii">
            {dates.map((date, i) => (
              <button
                key={date}
                aria-pressed={day === i}
                onClick={() => setDay(i)}
              >
                <strong>{labels[i]}</strong>
                <span>
                  {new Date(date + 'T12:00:00Z').toLocaleDateString('ro-RO', {
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </span>
                <small>{stops(date).length} opriri</small>
              </button>
            ))}
          </div>
          <div className="partner-week-grid">
            {dates.map((date, i) => (
              <section className="partner-day" key={date} hidden={day !== i}>
                <h3>
                  {labels[i]}{' '}
                  <small>
                    {new Date(date + 'T12:00:00Z').toLocaleDateString('ro-RO')}
                  </small>
                </h3>
                {!stops(date).length && (
                  <p className="muted">Nicio oprire planificată.</p>
                )}
                <ol>
                  {stops(date).map((id, index) => {
                    const p = byId.get(id),
                      done = data.visits.some(
                        (v) => v.customerId === id && v.date === date,
                      );
                    return (
                      <li key={id}>
                        <button
                          className="partner-stop-name"
                          disabled={busy || dirty}
                          title={
                            dirty
                              ? 'Salvează planul înainte de a deschide fișa'
                              : undefined
                          }
                          onClick={() => onOpen(id)}
                        >
                          {p?.name ||
                            (catalogStatus === 'loading'
                              ? 'Se încarcă magazinul…'
                              : catalogStatus === 'error'
                                ? 'Lista de magazine nu este încărcată'
                                : 'Magazin indisponibil')}
                        </button>
                        <p className="muted">
                          {p?.city} · {p?.address}
                        </p>
                        <strong>
                          {done
                            ? 'Efectuată'
                            : date < localDate()
                              ? 'Restantă'
                              : 'Planificată'}
                        </strong>
                        <div className="partner-stop-actions">
                          <button
                            disabled={busy || index === 0}
                            aria-label={'Mută mai sus ' + p?.name}
                            onClick={() => {
                              const a = [...stops(date)];
                              [a[index - 1], a[index]] = [
                                a[index],
                                a[index - 1],
                              ];
                              change(date, a);
                            }}
                          >
                            ↑
                          </button>
                          <button
                            disabled={busy || index === stops(date).length - 1}
                            aria-label={'Mută mai jos ' + p?.name}
                            onClick={() => {
                              const a = [...stops(date)];
                              [a[index + 1], a[index]] = [
                                a[index],
                                a[index + 1],
                              ];
                              change(date, a);
                            }}
                          >
                            ↓
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              change(
                                date,
                                stops(date).filter((x) => x !== id),
                              )
                            }
                          >
                            Scoate
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {draft[date] && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void save(date)}
                  >
                    Salvează {labels[i].toLowerCase()}
                  </button>
                )}
              </section>
            ))}
          </div>
          <section>
            <h3>Vizite efectuate în săptămână ({data.visits.length})</h3>
            <p className="muted">
              Include și vizitele neplanificate sau din weekend.
            </p>
            {!data.visits.length && (
              <p>Nicio vizită înregistrată în această săptămână.</p>
            )}
            {data.visits.map((v) => (
              <article className="partner-visit" key={v.id}>
                <button
                  disabled={busy || dirty}
                  className="partner-stop-name"
                  onClick={() => onOpen(v.customerId)}
                >
                  {v.customerName}
                </button>{' '}
                ·{' '}
                {new Date(v.visitedAt).toLocaleString('ro-RO', {
                  timeZone: 'Europe/Bucharest',
                })}
                {v.notes && <p>{v.notes}</p>}
              </article>
            ))}
          </section>
        </>
      )}
    </section>
  );
}
