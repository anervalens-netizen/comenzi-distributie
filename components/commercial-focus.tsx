'use client';

import {useEffect, useState} from 'react';
import {api, errorMessage, money} from '@/lib/client-api';
import {bucharestMonthKey} from '@/lib/bucharest-month';
import type {CommercialFocusReport, FocusItem} from '@/lib/commercial-focus';
import './commercial-focus.css';

const tabs = [
  {id: 'accessories', label: 'Incentive accesorii'},
  {id: 'phones', label: 'Telefoane cu incentive'},
  {id: 'contests', label: 'Concurs'},
  {id: 'promotions', label: 'Promoții'},
] as const;
type Tab = typeof tabs[number]['id'];
const amount = (cents: number | null) => cents === null ? '—' : money(cents / 100);
const units = (value: number) => value.toLocaleString('ro-RO');

function IncentiveItems({items}: {items: FocusItem[]}) {
  return <div className="commercial-focus-scroll"><table>
    <thead><tr><th scope="col">Produs</th><th scope="col">Bucăți nete</th><th scope="col">Lei / buc.</th><th scope="col">Incentive</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.code}>
      <td>{item.name}<small>{item.code}</small></td>
      <td>{units(item.quantity)}</td><td>{amount(item.rateCents)}</td><td>{amount(item.incentiveCents)}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function CommercialFocus({userId, scopeQuery = '', month: selectedMonth, onMonthChange}: {
  userId: string; scopeQuery?: string; month?: string; onMonthChange?: (next: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('accessories');
  const [localMonth, setLocalMonth] = useState(() => bucharestMonthKey(new Date()));
  const month=selectedMonth??localMonth;
  function selectMonth(next:string){
    if(selectedMonth===undefined)setLocalMonth(next);
    onMonthChange?.(next);
  }
  const [retry, setRetry] = useState(0);
  const [read, setRead] = useState<{key: string; data?: CommercialFocusReport; error?: string}>();
  const salesTab = tab === 'accessories' || tab === 'phones';
  const key = JSON.stringify([userId, month, scopeQuery, retry]);
  useEffect(() => {
    if (!salesTab || !month) return;
    const controller = new AbortController();
    const params = new URLSearchParams(scopeQuery);
    params.set('month', month);
    api<CommercialFocusReport>('focus/commercial?' + params, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setRead({key, data}); })
      .catch(error => { if (!controller.signal.aborted) setRead({key, error: errorMessage(error)}); });
    return () => controller.abort();
  }, [key, month, scopeQuery, salesTab]);
  const active = read?.key === key ? read : null;
  const report = active?.data;
  return <section className="commercial-focus">
    <header className="page-heading">
      <h1>Focus Vodafone</h1>
      {salesTab && <label>Luna <input type="month" value={month} max={bucharestMonthKey(new Date())} onChange={event => selectMonth(event.currentTarget.value)}/></label>}
    </header>
    <nav aria-label="Secțiuni Focus Vodafone" className="commercial-focus-tabs">
      {tabs.map(item => <button type="button" key={item.id} className={tab === item.id ? 'primary' : 'secondary'}
        aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </nav>
    {tab === 'contests' && <p>Nu sunt concursuri active.</p>}
    {tab === 'promotions' && <p>Nu sunt promoții active.</p>}
    {salesTab && <>
      {!month && <p>Alege luna de raportare.</p>}
      {month && !active && <output>Se calculează situația Focus…</output>}
      {active?.error && <><p className="error-banner" role="alert">{active.error}</p>
        <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Reîncearcă</button></>}
      {report?.state === 'no-offer' && <p>Nu există o grilă Focus configurată pentru luna selectată.</p>}
      {report?.state === 'no-sales' && <p>Vânzările pe TR pentru luna selectată nu sunt disponibile.</p>}
      {report?.available && <>
        {report.lastDate && <p className="muted">Date importate până la <time dateTime={report.lastDate}>{report.lastDate.split('-').reverse().join('.')}</time>.</p>}
        {report.simulation && <p className="muted">Simulare pe baza grilei furnizate.</p>}
        <p className="muted">Calcul pe cantitățile nete din vânzările pe TR.
          {report.excludedRows > 0 && <> Linii de document excluse pe baza sursei: {units(report.excludedRows)}.</>}
          {report.unmatchedRows > 0 && <> Linii incluse fără corespondent sigur în istoricul pe clienți: {units(report.unmatchedRows)}.</>}
        </p>
        {!report.sellers.length && <p>Selecția nu conține gestiuni Vodafone configurate.</p>}
        {tab === 'accessories' && report.sellers.length > 0 && <>
          <h2>Incentive accesorii · {amount(report.accessoriesCents)}</h2>
          {report.sellers.map(seller => <details key={seller.id} className="commercial-focus-seller">
            <summary><span>{seller.name} · {seller.siteCode}</span><strong>{amount(seller.accessoriesCents)}</strong></summary>
            {seller.accessories.length ? <IncentiveItems items={seller.accessories}/> : <p>Grila lunii nu are accesorii configurate.</p>}
          </details>)}
        </>}
        {tab === 'phones' && report.sellers.length > 0 && <>
          <h2>Incentive telefoane · {amount(report.phonesCents)}</h2>
          {report.sellers.map(seller => <details key={seller.id} className="commercial-focus-seller">
            <summary><span>{seller.name} · {seller.siteCode}</span>
              <strong>{seller.target === null ? 'Fără target' : units(seller.units) + ' / ' + units(seller.target) + ' · ' + amount(seller.phoneCents)}</strong></summary>
            {seller.target === null ? <p>Nu este configurat un target pentru agent în luna selectată.</p> : <>
              <p>{seller.targetReached ? 'Target atins' : 'Sub target'}. Tariful se aplică tuturor bucăților eligibile din lună.</p>
              <IncentiveItems items={seller.phones}/>
            </>}
          </details>)}
        </>}
      </>}
    </>}
  </section>;
}
