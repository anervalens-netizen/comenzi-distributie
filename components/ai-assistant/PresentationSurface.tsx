'use client';

import {useMemo} from 'react';
import {A2uiSurface, createComponentImplementation, type ReactCatalogComponent} from '@a2ui/react';
import {Catalog, MessageProcessor} from '@a2ui/web_core/v1_0';
import {z} from 'zod-a2ui';
import {parsePresentationData} from '@/lib/manager-ai-presentation';

const catalogId='urn:comenzi:manager-presentation:1';
const presentation=createComponentImplementation({
  name:'InformationCard',
  schema:z.object({
    title:z.string(), layout:z.enum(['table','steps','facts']),
    columns:z.array(z.string()), rows:z.array(z.array(z.string())),
  }),
},({props}) => <section className="min-w-0 rounded-lg border border-slate-300/60 p-3">
  <h3 className="mb-2 font-semibold">{props.title}</h3>
  {props.layout==='table' ? <div className="max-h-80 overflow-auto">
    <table className="border-collapse text-left text-sm"><thead><tr>
      {props.columns.map((column,index)=><th className="px-2 py-1" key={index} scope="col">{column}</th>)}
    </tr></thead><tbody>{props.rows.map((row,index)=><tr key={index}>
      {row.map((value,cell)=><td key={cell} className="border-t border-slate-300/60 px-2 py-1">{value}</td>)}
    </tr>)}</tbody></table>
  </div> : props.layout==='steps' ? <ol className="list-decimal space-y-2 pl-5">
    {props.rows.map(([label,value],index)=><li key={index}><strong>{label}</strong><div>{value}</div></li>)}
  </ol> : <dl className="grid gap-2 sm:grid-cols-2">
    {props.rows.map(([label,value],index)=><div className="rounded-md bg-slate-100 px-2 py-1 dark:bg-slate-800" key={index}>
      <dt className="text-xs">{label}</dt><dd className="font-semibold">{value}</dd>
    </div>)}
  </dl>}
</section>);

const catalog=new Catalog(catalogId,'1.0',[presentation]);

export default function PresentationSurface({data,id}:{data:unknown;id:string}) {
  const surface=useMemo(() => {
    // Only bounded literal fields enter the official processor, including during history replay.
    const checked=parsePresentationData(data);
    if(!checked) return undefined;
    const processor=new MessageProcessor<ReactCatalogComponent>([catalog]);
    const wire=[
      {version:'1.0',createSurface:{surfaceId:id,catalogId}},
      {version:'1.0',updateComponents:{surfaceId:id,components:[{id:'root',component:'InformationCard',...checked}]}},
    ];
    if(processor.processMessagesWithErrors(wire).length) return undefined;
    return processor.model.surfacesMap.get(id);
  },[data,id]);
  return surface ? <A2uiSurface surface={surface}/> : <p>Fișa nu poate fi afișată.</p>;
}
