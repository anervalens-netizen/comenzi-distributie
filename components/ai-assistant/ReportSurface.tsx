'use client';

import {useMemo} from 'react';
import {z} from 'zod';
import {A2uiSurface, createComponentImplementation, type ReactCatalogComponent} from '@a2ui/react';
import {Catalog, MessageProcessor} from '@a2ui/web_core/v1_0';
import {reportCatalogId} from '@/lib/manager-ai-report-card';

const reportTable = createComponentImplementation({
  name:'ReportTable',
  schema:z.object({
    title:z.string(), columns:z.array(z.string()), rows:z.array(z.array(z.string())),
    exported:z.number(), total:z.number(), sources:z.array(z.string()),
  }),
}, ({props}) => <section className="min-w-0 rounded-lg border border-slate-300/60 p-3">
  <strong>{props.title}</strong>
  <p>{props.rows.length} rânduri afișate · {props.exported} în fișier · {props.total} disponibile</p>
  {props.rows.length > 0 && <div className="max-h-80 overflow-auto" tabIndex={0} aria-label={props.title}>
    <table className="border-collapse text-left text-xs">
      <thead><tr>{props.columns.map((column,index) => <th className="p-2" key={index} scope="col">{column}</th>)}</tr></thead>
      <tbody>{props.rows.map((row,index) => <tr key={index}>{row.map((value,cell) =>
        <td className="border-t border-slate-200 p-2" key={cell}>{value}</td>)}</tr>)}</tbody>
    </table>
  </div>}
  {props.sources.map(source => <p key={source} className="mt-1 text-xs">{source}</p>)}
</section>);

const catalog = new Catalog(reportCatalogId,'1.0',[reportTable]);
export default function ReportSurface({wire,id}:{wire:unknown;id:string}) {
  const surface = useMemo(() => {
    const processor = new MessageProcessor<ReactCatalogComponent>([catalog]);
    if (processor.processMessagesWithErrors(wire).length) return undefined;
    return processor.model.surfacesMap.get(id);
  },[wire,id]);
  return surface ? <A2uiSurface surface={surface}/> : <p role="status">Fișa nu poate fi afișată. Raportul este disponibil la descărcare.</p>;
}
