'use client';

import {useEffect, useRef, useState} from 'react';
import {api, errorMessage} from '@/lib/client-api';
import {activationDateLabel} from '@/lib/activation-labels';
import {focusCategoryLabel, focusCountyLabel, focusKindLabels, focusTerritoryLabels} from '@/lib/vodafone-focus-labels';
import {focusProjects, focusTerritories, type FocusKind, type FocusReport} from '@/lib/vodafone-focus';
import type {Territory} from '@/lib/distribution-rules';
import type {ActivationReport} from '@/lib/activation-types';

const number = (value: number) => value.toLocaleString('ro-RO');
type Selection = {kind: FocusKind; site?: string; title: string};
type Read = {key: string; report?: FocusReport; error?: string};

export function VodafoneFocusPanel({query, userId, reload}: {query: string; userId: string; reload: number}) {
  const params = new URLSearchParams(query);
  const projects = params.has('projects') ? params.getAll('projects').flatMap(value => value.split(',')) : Object.values(focusProjects);
  return <>{focusTerritories.filter(territory => projects.includes(focusProjects[territory])).map(territory => {
    const scoped = new URLSearchParams(params);
    scoped.set('focusTerritory', territory);
    const key = JSON.stringify([userId, scoped.toString(), reload]);
    return <VodafoneFocusSelection key={key} query={scoped.toString()} territory={territory}/>;
  })}</>;
}

function VodafoneFocusSelection({query, territory}: {query: string; territory: Territory}) {
  const name = focusTerritoryLabels[territory];
  const [read, setRead] = useState<Read>();
  const [detail, setDetail] = useState<Read>();
  const [selection, setSelection] = useState<Selection>();
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportController = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const visible = read?.report;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(query);
    params.set('view', 'focus');
    void api<ActivationReport>('activations?' + params, 'GET', undefined, controller.signal)
      .then(result => {if (!controller.signal.aborted) setRead({key: query, report: result.focus});})
      .catch(error => {if (!controller.signal.aborted) setRead({key: query, error: errorMessage(error)});});
    return () => controller.abort();
  }, [query]);

  const selectedParams = new URLSearchParams(query);
  selectedParams.set('view', 'focus');
  if (selection) {
    selectedParams.set('focusKind', selection.kind);
    if (selection.site) selectedParams.set('focusSite', selection.site);
    selectedParams.set('page', String(page));
  }
  const detailKey = selection ? selectedParams.toString() : '';

  useEffect(() => {
    const controller = new AbortController();
    if (detailKey) {
      void api<ActivationReport>('activations?' + detailKey, 'GET', undefined, controller.signal)
        .then(result => {if (!controller.signal.aborted) setDetail({key: detailKey, report: result.focus});})
        .catch(error => {if (!controller.signal.aborted) setDetail({key: detailKey, error: errorMessage(error)});});
    }
    return () => controller.abort();
  }, [detailKey]);

  useEffect(() => () => exportController.current?.abort(), []);

  function select(entry: Selection) {
    setPage(0);
    setSelection(entry);
    requestAnimationFrame(() => heading.current?.focus());
  }

  async function exportFocus(includeDetail: boolean) {
    const controller = new AbortController();
    exportController.current?.abort();
    exportController.current = controller;
    setExporting(true);
    setExportError('');
    const params = new URLSearchParams(includeDetail ? selectedParams : query);
    params.set('view', 'focus-export');
    params.delete('page');
    const revision = includeDetail ? detail?.report?.revision : visible?.revision;
    if (revision) params.set('revision', revision);
    try {
      const result = await api<{workbook: string}>('activations?' + params, 'GET', undefined, controller.signal);
      if (controller.signal.aborted) return;
      const bytes = Uint8Array.from(atob(result.workbook), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'vodafone-focus-' + territory.replace('_', '-') + '.xlsx';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!controller.signal.aborted) setExportError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  }

  if (read?.error) return <p role="alert">Focus {name} · {read.error}</p>;
  if (!visible) return null;
  const region = visible.regional;
  const currentDetail = detail?.key === detailKey ? detail : undefined;
  const selectedRows = currentDetail?.report?.detail;
  const covered = visible.months.some(month => month.coveredThrough);
  const metric = (kind: FocusKind, title: string, value: number, showDetails = true) =>
    <div><dt>{title}</dt><dd>{showDetails ? <button type="button" className="activation-trend-value"
      aria-label={title + ' · detalii'} disabled={!value} onClick={() => select({kind, title})}>{number(value)}</button>
      : <strong>{number(value)}</strong>}</dd></div>;

  return <section className="vodafone-focus" aria-label={'Focus Vodafone ' + name}>
    <div className="distribution-partner-toolbar">
      <h3>Focus Vodafone {name}</h3>
      {covered && <button type="button" className="secondary" disabled={exporting} onClick={() => void exportFocus(false)}>Exportă sinteza Excel</button>}
    </div>
    {!covered ? <p>Nu există observații Vodafone pentru lunile selectate.</p> : <>
      <dl className="activation-eligibility">
        {region && metric('regional', 'Total regional Focus ' + name, region.total, visible.regionalDetails)}
        {metric('attributed', 'Realizare TR ' + name, visible.attributed)}
        {metric('possibleStock', 'Posibile activări din stoc', visible.possibleStock)}
      </dl>
      {!!visible.possibleStock && <p>Stocul posibil se bazează pe un document ulterior activării și rămâne în verificare până la confirmarea atribuirii.{region && ' Este inclus în totalul regional și în activările fără atribuire sigură.'}</p>}
      {region && <p>În regional sunt incluse și {number(region.otherTR)} atribuite altor TR-uri, {number(region.otherChannels)} din alte canale și {number(region.unassigned)} fără atribuire sigură. {number(region.unassignedCounty)} au județ nealocat.</p>}
      {!!region?.sourceConflicts && <p>{number(region.sourceConflicts)} înregistrări cu date de verificat au fost excluse din calcul.</p>}
      <details className="commerce-details">
        <summary>Realizare și stoc posibil pe TR</summary>
        <div className="distribution-table-scroll"><table className="distribution-table">
          <thead><tr><th scope="col">Gestiune</th><th scope="col">Realizare TR {name}</th><th scope="col">Stoc posibil</th></tr></thead>
          <tbody>{visible.sites.map(site => <tr key={site.site}>
            <th scope="row">{site.label}</th>
            {(['attributed', 'possibleStock'] as const).map(kind => <td key={kind}>{site[kind] ?
              <button type="button" className="activation-trend-value" aria-label={focusKindLabels[kind] + ' · ' + site.label}
                onClick={() => select({kind, site: site.site, title: focusKindLabels[kind] + ' · ' + site.label})}>{number(site[kind])}</button> : '0'}</td>)}
          </tr>)}</tbody>
        </table></div>
      </details>
    </>}
    <details className="commerce-details">
      <summary>Istoric lunar Focus</summary>
      <div className="distribution-table-scroll"><table className="distribution-table">
        <thead><tr><th scope="col">Lună</th><th scope="col">Sursă</th>{region && <th scope="col">Regional</th>}<th scope="col">Realizare TR</th><th scope="col">Stoc posibil</th></tr></thead>
        <tbody>{visible.months.map(month => <tr key={month.month}>
          <th scope="row">{month.month}</th>
          <td>{month.complete ? 'Completă' : month.coveredThrough ? 'Parțială · ' + activationDateLabel(month.coveredThrough) : 'Fără sursă'}</td>
          {month.coveredThrough ? <>{region && <td>{number(month.regional?.total ?? 0)}</td>}<td>{number(month.attributed)}</td><td>{number(month.possibleStock)}</td></>
            : <td colSpan={region ? 3 : 2}>—</td>}
        </tr>)}</tbody>
      </table></div>
    </details>
    {selection && <section>
      <div className="distribution-partner-toolbar">
        <h4 tabIndex={-1} ref={heading}>{selection.title}</h4>
        <button type="button" className="secondary" onClick={() => setSelection(undefined)}>Închide detaliul</button>
        <button type="button" className="secondary" disabled={exporting || !selectedRows?.total} onClick={() => void exportFocus(true)}>Exportă detaliul Excel</button>
      </div>
      {currentDetail?.error ? <p role="alert">{currentDetail.error}</p> : !selectedRows ? <output>Se încarcă detaliul Focus…</output> : <>
        <p>{number(selectedRows.total)} activări în selecție</p>
        <div className="distribution-table-scroll"><table className="distribution-table">
          <thead><tr><th scope="col">Activare</th><th scope="col">Județ</th><th scope="col">Categorie</th><th scope="col">Rezultat</th><th scope="col">TR</th>
            {selectedRows.rows.some(row => row.serial) && <th scope="col">ICCID</th>}<th scope="col">CIF / punct de lucru</th><th scope="col">Document</th></tr></thead>
          <tbody>{selectedRows.rows.map(row => <tr key={row.id}>
            <td>{activationDateLabel(row.date)}</td><td>{focusCountyLabel(row.county)}</td><td>{focusCategoryLabel(row.category, territory)}</td>
            <td>{focusKindLabels[row.kind]}</td><td>{row.site || '—'}</td>{row.serial && <td>{row.serial}</td>}
            <td>{[row.clientCode, row.pointCode].filter(Boolean).join(' · ') || '—'}</td>
            <td>{row.document ? [row.document.source === 'erp' ? 'ERP' : 'Aviz SIM', activationDateLabel(row.document.date), row.document.reference].filter(Boolean).join(' · ') : '—'}</td>
          </tr>)}</tbody>
        </table></div>
        <div className="distribution-partner-toolbar">
          <button type="button" className="secondary" disabled={!page} onClick={() => setPage(value => value - 1)}>Înapoi</button>
          <span>Pagina {page + 1}</span>
          <button type="button" className="secondary" disabled={!selectedRows.hasMore} onClick={() => setPage(value => value + 1)}>Înainte</button>
        </div>
      </>}
    </section>}
    {exportError && <p role="alert">{exportError}</p>}
  </section>;
}
