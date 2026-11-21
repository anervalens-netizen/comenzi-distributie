'use client';

import {useEffect, useState} from 'react';
import {api} from '@/lib/client-api';
import type {PartnerStandsReport, StandTiming} from '@/lib/partner-stands-types';

const date = (value: string) => value.split('-').reverse().join('.');
const timing: Record<StandTiming, string> = {
  'earlier': 'Înainte de prima factură identificată',
  'same-day': 'În ziua primei facturi identificate',
  'later': 'După prima factură identificată',
  'unknown': 'Prima factură nu a putut fi identificată',
};

export function PartnerStands({id}: {id: string}) {
  const [read, setRead] = useState<{data?: PartnerStandsReport; error?: string}>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<PartnerStandsReport>('partner/portfolio/' + encodeURIComponent(id) + '/stands', 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setRead({data}); })
      .catch(error => { if (!controller.signal.aborted) setRead({error: error.message}); });
    return () => controller.abort();
  }, [id, attempt]);
  const result = read.data;
  const quantity = result?.stands.reduce((sum, stand) => sum + stand.quantity, 0) ?? 0;
  return <details className="partner-sales partner-sales-overview">
    <summary>{quantity ? 'Standuri avizate (' + quantity + ' buc.)' : 'Standuri'}</summary>
    {read.error && <><p role="alert">{read.error}</p><button type="button" className="secondary" onClick={() => {setRead({}); setAttempt(attempt + 1);}}>Reîncearcă</button></>}
    {!read.error && !result && <output>Se consultă avizele…</output>}
    {result && <>
      {result.firstBilling && <p>Prima factură identificată · {date(result.firstBilling)}</p>}
      {!result.stands.length && <p>Fișa nu are standuri în avizele finalizate disponibile.</p>}
      {result.stands.length > 0 && <div className="partner-sales-scroll"><table>
        <thead><tr><th scope="col">Tip stand</th><th scope="col">Bucăți</th><th scope="col">Aviz</th><th scope="col">Față de prima factură</th></tr></thead>
        <tbody>{result.stands.map(stand => <tr key={stand.orderId + ':' + stand.lineId}>
          <td>{stand.type}<small>{stand.code}</small></td>
          <td>{stand.quantity}</td>
          <td><time dateTime={stand.date}>{date(stand.date)}</time><small>{stand.reference}</small></td>
          <td>{timing[stand.timing]}</td>
        </tr>)}</tbody>
      </table></div>}
      {result.availableFrom && <p className="muted">Primul aviz de stand identificat la acest punct · {date(result.availableFrom)}.</p>}
    </>}
  </details>;
}
