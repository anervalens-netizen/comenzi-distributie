'use client';

import {useEffect,useRef,useState} from 'react';
import {api,errorMessage} from '@/lib/client-api';
import {bucharestMonthKey} from '@/lib/bucharest-month';
import {filterVodafoneBonusRows,firstVodafoneBonusMonth,vodafoneBonusPageSize,vodafoneBonusReasonLabels,type VodafoneBonusScreen} from '@/lib/vodafone-bonus-types';
import './vodafone-bonus.css';

type View = 'points' | 'documents' | 'unresolved';
const labels: Record<View,string> = {points:'Registru pe punct',documents:'Facturi și stingeri',unresolved:'De identificat'};
const count = (n: number|null) => n===null ? '—' : n.toLocaleString('ro-RO');
const monthLabel = (month: string) => new Date(month+'-15T12:00:00Z').toLocaleDateString('ro-RO',{timeZone:'Europe/Bucharest',year:'numeric',month:'long'});
const dateLabel = (date: string|null) => date ? date.split('-').reverse().join('.') : '—';

export function VodafoneBonus({scopeQuery}: {scopeQuery: string}) {
  const [choice,setChoice] = useState('');
  const [view,setView] = useState<View>('points');
  const [limit,setLimit] = useState(vodafoneBonusPageSize);
  const [wantFull,setWantFull] = useState(false);
  const [find,setFind] = useState('');
  const [reload,setReload] = useState(0);
  const [read,setRead] = useState<{key: string; report?: VodafoneBonusScreen; error?: string}>();
  const [exporting,setExporting] = useState(false);
  const [exportError,setExportError] = useState('');
  const exportRequest = useRef<AbortController|undefined>(undefined);
  const params = new URLSearchParams();
  const scope = new URLSearchParams(scopeQuery);
  for (const key of ['agentId','managerId','siteCode','projects']) {
    const value=scope.get(key);
    if(value!==null)params.set(key,value);
  }
  const suppliedMonth = scope.get('months')?.split(',')[0] || scope.get('month') || '';
  const currentMonth = bucharestMonthKey(new Date());
  const month = choice || (suppliedMonth>=firstVodafoneBonusMonth && suppliedMonth<=currentMonth ? suppliedMonth : currentMonth);
  params.set('month',month);
  const key = params.toString();
  const visible = read?.key===key ? read : undefined;
  const report = visible?.report;
  const coverage = report?.months.find(row=>row.month===month);
  useEffect(()=>{
    const request = new AbortController();
    const url='vodafone/bonuses?'+key+(wantFull?'':'&view=preview');
    api<VodafoneBonusScreen>(url,'GET',undefined,request.signal)
      .then(report=>{if(!request.signal.aborted)setRead({key,report});})
      .catch(error=>{
        if(!request.signal.aborted)setRead(previous=>({key,report:previous?.key===key ? previous.report : undefined,error:errorMessage(error)}));
      });
    return ()=>request.abort();
  },[key,reload,wantFull]);
  useEffect(()=>()=>exportRequest.current?.abort(),[key,find]);

  async function download(all: boolean) {
    const request = new AbortController();
    exportRequest.current?.abort();
    exportRequest.current = request;
    setExportError('');
    setExporting(true);
    const params = new URLSearchParams(key);
    params.set('view','export');
    if (all) params.set('all','1');
    if (find.trim()) params.set('q',find.trim());
    if (report?.revision) params.set('revision',report.revision);
    try {
      const {workbook} = await api<{workbook: string}>('vodafone/bonuses?'+params,'GET',undefined,request.signal);
      if (request.signal.aborted) return;
      const bytes=Uint8Array.from(atob(workbook),char=>char.charCodeAt(0));
      const file=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const link=document.createElement('a');
      link.href=file;
      link.download=all?'vodafone-registru-bonus.xlsx':'vodafone-registru-bonus-'+month+'.xlsx';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(file),0);
    } catch (error) {
      if (!request.signal.aborted) setExportError(errorMessage(error));
    } finally {
      if (exportRequest.current===request) setExporting(false);
    }
  }
  const {points,documents,unresolved} = report ? filterVodafoneBonusRows(report,find) : {points:[],documents:[],unresolved:[]};
  const selectedRows = {points,documents,unresolved}[view];
  const rowCount = report?.preview?.counts[view] ?? selectedRows.length;
  const incompleteSearch = !!(report?.preview && find.trim());
  const loadingFull = wantFull && !!report?.preview && !visible?.error;


  return <section className="panel distribution-card vodafone-bonus" aria-label="Registru bonus Vodafone">
    <div className="panel-heading"><h2>Bonusuri Vodafone</h2></div>
    <div className="vodafone-bonus-actions">
      {report && <label>Luna <select value={month} onChange={event=>{setChoice(event.target.value);setLimit(vodafoneBonusPageSize);}}>
        {[...report.months].reverse().map(row=><option key={row.month} value={row.month}>{monthLabel(row.month)}</option>)}
      </select></label>}
      <button type="button" className="secondary" disabled={!report || exporting} onClick={()=>void download(false)}>{find.trim()?'Excel selecția din lună':'Excel luna selectată'}</button>
      <button type="button" className="secondary" disabled={!report || exporting} onClick={()=>void download(true)}>{find.trim()?'Excel selecția din istoric':'Excel tot istoricul'}</button>
      <button type="button" className="secondary" onClick={()=>{setRead(undefined);setReload(x=>x+1);}}>Reîncarcă</button>
    </div>
    {visible?.error && <p className="error-banner" role="alert">{visible.error}</p>}
    {exportError && <p className="error-banner" role="alert">{exportError}</p>}
    {!visible && <output className="commerce-loading">Se încarcă registrul Vodafone…</output>}
    {coverage && <>
      <p className="commerce-source">{coverage.publishedOn ? 'Raport final din '+dateLabel(coverage.publishedOn) : 'Raportul final nu este disponibil'} · Date până la {dateLabel(coverage.sourceThrough)} · {count(coverage.activations)} activări partenere · {count(coverage.unresolvedActivations)} fără franciză identificată</p>
      {!report?.fiscalKindsComplete && <p className="commerce-source-warning">Tipul fiscal lipsește pentru unele documente. Acestea pot apărea în simulare când vânzarea sau factura la zero se reconciliază între surse.</p>}
      {(report?.preview?.hasPartialPoints ?? report?.points.some(row=>row.partial)) && <p className="commerce-source-warning">Punctele comune cu alte gestiuni arată numai contribuțiile accesibile. Sumele pe punct apar când selecția include întreaga lui activitate.</p>}
      <div className="vodafone-bonus-actions">
        <div className="vodafone-bonus-views" aria-label="Vederi registru">
          {(['points','documents','unresolved'] as const).map(item=><button type="button" className="secondary" aria-pressed={view===item} key={item} onClick={()=>{setView(item);setLimit(vodafoneBonusPageSize);}}>{labels[item]}</button>)}
        </div>
        <input aria-label="Caută în registru" type="search" maxLength={180} placeholder="Partener, franciză, CUI sau TR" value={find} onChange={event=>{setFind(event.target.value);setLimit(vodafoneBonusPageSize);if (report?.preview && event.target.value.trim()) setWantFull(true);}}/>
      </div>
      {loadingFull && <output className="commerce-loading">Se încarcă detaliile registrului…</output>}
      {!incompleteSearch && <div className="distribution-table-scroll">
        {view==='points' && <table className="distribution-table"><thead><tr>
          <th>Partener / punct</th><th>TR</th><th>SIM 0</th><th>Target</th><th>Top Locații</th><th>Bonus SIM 0 calculat</th><th>Total calculat</th><th>Acordat în lună</th><th>Stins confirmat</th><th>Rest confirmat</th><th>Rest SIM 0 simulat</th>
        </tr></thead><tbody>{points.slice(0,limit).map(row=><tr key={row.pointCode}>
          <th>{row.partner}<small>{row.pointCode} · {row.cui}</small></th>
          <td>{row.sites.map(site=><div key={site.site}>{site.site || 'Gestiune neprecizată'} · {count(site.activations)}</div>)}</td>
          <td>{count(row.activations)}<small>{count(row.confirmedActivations)} confirmate</small></td>
          <td>{count(row.target)}</td><td>{count(row.topBonus)}</td><td>{count(row.sim0Bonus)}</td><td>{count(row.totalBonus)}</td>
          <td>{count(row.partial?null:row.givenOnDocuments)}{!row.partial && row.candidateOnDocuments>0 && <small>{count(row.candidateOnDocuments)} cu tip neconfirmat</small>}</td>
          <td>{count(row.applied)}</td><td>{count(row.remaining)}</td><td>{count(row.simulatedRemaining)}</td>
        </tr>)}</tbody></table>}
        {view==='documents' && <table className="distribution-table"><thead><tr>
          <th>Factură</th><th>Partener / punct</th><th>TR</th><th>Cantitate</th><th>Stare</th><th>Luni stinse</th>
        </tr></thead><tbody>{documents.slice(0,limit).map(row=><tr key={JSON.stringify([row.date,row.number,row.company,row.siteId])}>
          <th>{row.number || 'Fără număr'}<small>{dateLabel(row.date)}{row.company && ' · '+row.company}</small></th>
          <td>{row.partner}<small>{row.pointCode || 'Fără franciză'} · {row.cui}</small></td><td>{row.sites.join(', ')}</td>
          <td>{count(row.quantity)}</td><td>{vodafoneBonusReasonLabels[row.reason]}</td>
          <td>{row.allocations.map((item,index)=><div key={index}>{monthLabel(item.month)} · {item.kind} · {count(item.quantity)}{item.status==='simulation'?' · simulare':''}</div>)}</td>
        </tr>)}</tbody></table>}
        {view==='unresolved' && <table className="distribution-table"><thead><tr>
          <th>Partener</th><th>CUI</th><th>TR</th><th>Motiv</th><th>Activări</th>
        </tr></thead><tbody>{unresolved.slice(0,limit).map(row=><tr key={JSON.stringify([row.month,row.site,row.cui,row.reason])}>
          <th>{row.partner}</th><td>{row.cui}</td><td>{row.site}</td><td>{vodafoneBonusReasonLabels[row.reason]}</td><td>{count(row.count)}</td>
        </tr>)}</tbody></table>}
      </div>}
      {view==='points' && !incompleteSearch && (report?.preview?.hasUnknownTopBonus ?? points.some(row=>row.topBonus===null)) && <p className="commerce-source">Totalul combinat și restul confirmat necesită decontul Top Locații pentru punct și lună.</p>}
      {!incompleteSearch && !selectedRows.length && <p className="commerce-empty">Niciun rezultat pentru selecția curentă.</p>}
      {!incompleteSearch && rowCount>limit && <button type="button" className="secondary" disabled={loadingFull} onClick={()=>{
        if (report?.preview) setWantFull(true);
        setLimit(value=>value+vodafoneBonusPageSize);
      }}>Arată încă {Math.min(vodafoneBonusPageSize,rowCount-limit)}</button>}
    </>}
  </section>;
}
