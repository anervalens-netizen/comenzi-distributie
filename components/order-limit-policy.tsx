'use client';

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { ApiError, errorMessage, networkApi } from '@/lib/client-api';
import './order-limit-policy.css';

const categories = [
  { key: 'casesFilms', label: 'Huse și folii' },
  { key: 'chargers', label: 'Încărcătoare' },
  { key: 'cablesAdapters', label: 'Cabluri și adaptoare' },
  { key: 'prepaidSim', label: 'Cartele preplătite' },
] as const;

type FloorKey = (typeof categories)[number]['key'];
type Floors = Record<FloorKey, number>;
type Policy = { revision: number; floors: Floors; canEdit: boolean };
type Editor = { saved: Policy; fields: Record<FloorKey, string> };

const validFloor = (value: unknown) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 9999;

function editPolicy(policy: Policy): Editor {
  if (
    !policy ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 0 ||
    typeof policy.canEdit !== 'boolean' ||
    !categories.every(({ key }) => validFloor(policy.floors?.[key]))
  ) {
    throw new Error('Aplicația nu a putut citi pragurile salvate.');
  }
  const fields = Object.fromEntries(
    categories.map(({ key }) => [key, String(policy.floors[key])]),
  ) as Editor['fields'];
  return { saved: policy, fields };
}

function PolicyEditor({ userId }: { userId: string }) {
  const [editor, setEditor] = useState<Editor>();
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const write = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void networkApi<Policy>(
      'order-limit-policy',
      'GET',
      undefined,
      controller.signal,
      undefined,
      userId,
    )
      .then((policy) => {
        if (!controller.signal.aborted) setEditor(editPolicy(policy));
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [userId, reload]);

  useEffect(() => () => write.current?.abort(), []);

  function reloadPolicy() {
    setEditor(undefined);
    setError('');
    setNotice('');
    setNeedsReload(false);
    setReload((value) => value + 1);
  }

  const changed =
    editor &&
    categories.some(
      ({ key }) => Number(editor.fields[key]) !== editor.saved.floors[key],
    );

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor?.saved.canEdit || !changed || write.current || needsReload)
      return;
    const floors = Object.fromEntries(
      categories.map(({ key }) => [key, Number(editor.fields[key])]),
    ) as Floors;
    if (!categories.every(({ key }) => validFloor(floors[key]))) {
      setError(
        'Introdu pentru fiecare categorie un număr întreg între 1 și 9.999.',
      );
      return;
    }
    const controller = new AbortController();
    write.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await networkApi<Policy>(
        'order-limit-policy',
        'PUT',
        { revision: editor.saved.revision, floors },
        controller.signal,
        undefined,
        userId,
      );
      if (!controller.signal.aborted) {
        setEditor(editPolicy(result));
        setNotice('Pragurile au fost salvate.');
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof ApiError && failure.status === 409) {
          setNeedsReload(true);
          setError(
            'Pragurile s-au schimbat. Reîncarcă și verifică valorile înainte de a salva.',
          );
        } else {
          setError(errorMessage(failure));
        }
      }
    } finally {
      write.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section
      className="panel order-policy-card"
      aria-labelledby="order-policy-title"
      aria-busy={busy || (!editor && !error)}
    >
      <div className="order-policy-head">
        <div>
          <h2 id="order-policy-title">Praguri minime pe categorii</h2>
          <p>
            Pragurile se aplică produselor cu istoric de vânzări insuficient.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy || (!editor && !error)}
          onClick={reloadPolicy}
        >
          <RefreshCw size={17} aria-hidden /> Reîncarcă pragurile
        </button>
      </div>
      {!editor && !error && <output>Se încarcă pragurile…</output>}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && <output className="order-policy-notice">{notice}</output>}
      {editor && (
        <>
          <p className="order-policy-version">
            Versiunea {editor.saved.revision}
            {editor.saved.revision === 0 && ' · valori implicite'}
          </p>
          {editor.saved.canEdit ? (
            <form
              className="order-policy-form"
              onSubmit={(event) => void save(event)}
            >
              <div className="order-policy-fields">
                {categories.map(({ key, label }) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={9999}
                      step={1}
                      required
                      value={editor.fields[key]}
                      disabled={busy || needsReload}
                      onChange={(event) => {
                        const field = event.currentTarget.value;
                        setEditor(
                          (current) =>
                            current && {
                              ...current,
                              fields: { ...current.fields, [key]: field },
                            },
                        );
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="order-policy-submit">
                <button
                  type="submit"
                  className="primary"
                  disabled={!changed || busy || needsReload}
                >
                  <Check size={17} aria-hidden />{' '}
                  {busy ? 'Se salvează…' : 'Salvează pragurile'}
                </button>
                <p>
                  Comenzile sunt verificate din nou la finalizare după
                  modificarea pragurilor.
                </p>
              </div>
            </form>
          ) : (
            <dl className="order-policy-fields order-policy-readonly">
              {categories.map(({ key, label }) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>
                    {editor.saved.floors[key].toLocaleString('ro-RO')} buc.
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

export function OrderLimitPolicy({ userId }: { userId: string }) {
  return <PolicyEditor key={userId} userId={userId} />;
}
