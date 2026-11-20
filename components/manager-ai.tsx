'use client';

import {useEffect, useRef, useState, type SubmitEvent} from 'react';
import {Download, Send, Sparkles, Square} from 'lucide-react';
import {defaultManagerAiModel, managerAiModels, managerAiSuggestions, type ManagerAiAnswer, type ManagerAiModel, type ManagerAiReport, type ManagerAiTurn} from '@/lib/manager-ai';
import './manager-ai.css';

const modelNames: Record<ManagerAiModel,string> = {'gpt-6.1-terra':'GPT‑6.1 Terra','gpt-6.2-sol':'GPT‑6.2 Sol'};
const datasetNames: Record<string,string> = {
  sales:'Vânzări Vodafone',activations:'Activări Vodafone',activationsPartners:'Activări pe partener',
  partners:'Portofoliu curent',stands:'Avize de stand',bonuses:'Registru bonusuri',settlements:'Stingeri FIFO',
  orders:'Comenzi Vodafone',stock:'Stoc Vodafone',inventories:'Inventare Vodafone',transfers:'Transferuri Vodafone',
  bonusDocuments:'Documente la preț zero',bonusUnresolved:'Activări SIM 0 de verificat',
  focusAccessories:'Focus accesorii',focusPhones:'Focus telefoane',focusTargets:'Targeturi telefoane',
};
const columnNames: Record<string,string> = {
  month:'Lună',site:'SiteCode',sku:'Cod produs',product:'Produs',brand:'Marcă',category:'Categorie',productGroup:'Grupă',
  lines:'Linii',units:'Unități',valueLei:'Valoare (lei)',total:'Total',sim:'SIM',phoneBundles:'Pachete',other:'Altele',unassigned:'Nealocate',
  partner:'Partener',franchise:'Franciză',identity:'Tip identificare',activations:'Activări',county:'Județ',city:'Localitate',
  route:'Rută',points:'Puncte de lucru',date:'Data',document:'Document',warehouse:'Gestiune',status:'Stare',
  target:'Target',bonusSim5:'Bonus SIM 5',bonusTop:'Bonus Top Locații',amountDue:'Total de acordat',settled:'Stins confirmat',
  balance:'Rest confirmat',simulatedSettled:'Stins simulat',simulatedBalance:'Rest simulat',paymentDate:'Data documentului',
  destination:'Gestiune destinație',observedOn:'Dată stoc',expected:'Așteptat',counted:'Numărat',difference:'Diferență',
  paymentMonth:'Luna documentului',kind:'Tip bonus',seller:'Agent',incentiveLei:'Stimulent (lei)',
};
const formatter = new Intl.NumberFormat('ro-RO',{maximumFractionDigits:6});
const column = (name:string) => columnNames[name]||name;

async function exportReport(report:ManagerAiReport) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  // aoa_to_sheet creates ordinary text cells for strings, including values
  // starting with an Excel formula marker. This export never creates formulas.
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
    report.columns.map(column),...report.rows,
  ]),'Raport');
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
    ['Sursă','Lună','Disponibilă','Până la','Revizie','Observații'],
    ...report.coverage.map(c=>[c.source,c.month??'',c.available?'Da':'Nu',c.through??'',c.revision??'',c.note??'']),
    [],
    ['Rânduri în export',report.rows.length,'Rânduri potrivite',report.totalRows],
  ]),'Proveniență');
  XLSX.writeFile(workbook,`vodafone-analiza-${report.id.toLowerCase()}.xlsx`,{compression:true});
}

function Report({report}:{report:ManagerAiReport}) {
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  async function download() {
    setBusy(true);setError('');
    try { await exportReport(report); }
    catch { setError('Fișierul Excel nu a putut fi creat.'); }
    finally { setBusy(false); }
  }
  return <details className="manager-ai-report">
    <summary>{report.id} · {datasetNames[report.dataset]||report.dataset} · {formatter.format(report.totalRows)} rânduri</summary>
    <div className="manager-ai-report-inner">
      {report.coverage.map((c,i)=><p key={i} className="manager-ai-source">
        <strong>{c.source}</strong>{c.month&&` · ${c.month}`}{c.through&&` · până la ${c.through}`}{!c.available&&' · Sursă indisponibilă'}. {c.note}
      </p>)}
      {!!report.rows.length&&<>
        <div className="manager-ai-scroll">
          <table>
            <thead><tr>{report.columns.map(c=><th key={c} scope="col">{column(c)}</th>)}</tr></thead>
            <tbody>{report.rows.slice(0,12).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{typeof cell==='number'?formatter.format(cell):cell??'—'}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <button type="button" className="secondary" disabled={busy} onClick={()=>void download()}><Download size={16}/> Descarcă Excel</button>
        {report.totalRows>12&&<p className="manager-ai-source">Sunt afișate primele 12 rânduri. Fișierul conține {formatter.format(report.rows.length)} din {formatter.format(report.totalRows)}.</p>}
      </>}
      {error&&<p className="error-banner" role="alert">{error}</p>}
    </div>
  </details>;
}

type Exchange = {question:string; reply:ManagerAiAnswer|null};
export function ManagerAi({scopeQuery,scopeLabel}:{scopeQuery:string;scopeLabel:string}) {
  return <ManagerAiConversation key={scopeQuery} scopeQuery={scopeQuery} scopeLabel={scopeLabel}/>;
}

function ManagerAiConversation({scopeQuery,scopeLabel}:{scopeQuery:string;scopeLabel:string}) {
  const [available,setAvailable] = useState<boolean|null>(null);
  const [model,setModel] = useState<ManagerAiModel>(defaultManagerAiModel);
  const [question,setQuestion] = useState('');
  const [exchanges,setExchanges] = useState<Exchange[]>([]);
  const [working,setWorking] = useState(false);
  const [error,setError] = useState('');
  const active = useRef<AbortController|null>(null);
  const input = useRef<HTMLTextAreaElement|null>(null);
  const endpoint = '/api/manager-ai'+(scopeQuery?'?'+scopeQuery:'');
  useEffect(()=>{
    const controller=new AbortController();
    async function load() {
      try {
        const reply=await fetch(endpoint,{cache:'no-store',signal:controller.signal});
        if (!reply.ok) throw new Error('Asistentul AI nu este disponibil momentan.');
        const status=await reply.json() as {available:boolean};
        if (!controller.signal.aborted) setAvailable(status.available);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error?err.message:'Asistentul AI nu este disponibil momentan.');
      }
    }
    void load();
    return ()=>{controller.abort();active.current?.abort()};
  },[endpoint]);
  async function submit(event:SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const text=question.trim();
    if (!text||!available||active.current) return;
    const controller = new AbortController();
    active.current=controller;setWorking(true);setError('');setQuestion('');
    const complete=exchanges.filter(item=>item.reply);
    const history:ManagerAiTurn[]=complete.slice(-4).flatMap(e=>[
      {role:'user',content:e.question},{role:'assistant',content:e.reply!.answer.slice(0,12_000)},
    ]);
    setExchanges([...complete,{question:text,reply:null}]);
    try {
      const response=await fetch(endpoint,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({question:text,model,history}),signal:controller.signal});
      const result=await response.json();
      if (!response.ok) {
        const message = result && typeof result==='object' && 'error' in result ? result.error : null;
        throw new Error(typeof message==='string'?message:'Analiza nu a putut fi finalizată.');
      }
      if (!controller.signal.aborted) setExchanges([...complete,{question:text,reply:result as ManagerAiAnswer}]);
    } catch (err) {
      setExchanges(complete);
      setQuestion(text);
      if (!controller.signal.aborted) setError(err instanceof Error?err.message:'Analiza nu a putut fi finalizată.');
    } finally {
      active.current=null;setWorking(false);
    }
  }
  return <section className="manager-ai" aria-label="Analiză AI">
    <div className="page-heading manager-ai-heading"><div>
      <h1><Sparkles size={25} aria-hidden="true"/> Analiză AI</h1><p>{scopeLabel||'Portofoliul autorizat'} · Vodafone</p>
    </div>
    <label className="manager-ai-model">Model <select value={model} disabled={working} onChange={e=>setModel(e.target.value as ManagerAiModel)}>
      {managerAiModels.map(value=><option key={value} value={value}>{modelNames[value]}</option>)}
    </select></label></div>
    {available===false&&<p className="notice">Asistentul devine disponibil după configurarea serviciului OpenAI pentru aplicație.</p>}
    {!exchanges.length&&<div className="manager-ai-starters">
      {managerAiSuggestions.map(suggestion=><button type="button" className="secondary" disabled={!available} key={suggestion} onClick={()=>{setQuestion(suggestion);input.current?.focus()}}>{suggestion}</button>)}
    </div>}
    <div className="manager-ai-thread" aria-live="polite">
      {exchanges.map((exchange,i)=><article className="panel manager-ai-exchange" key={i}>
        <div className="manager-ai-question"><h2>Întrebarea ta</h2><p>{exchange.question}</p></div>
        {exchange.reply&&<div className="manager-ai-result">
          <h2>{modelNames[exchange.reply.model as ManagerAiModel]??exchange.reply.model}</h2>
          <p className="manager-ai-answer">{exchange.reply.answer}</p>
          {exchange.reply.reports.map(report=><Report key={report.id} report={report}/>)}
        </div>}
      </article>)}
      {working&&<output className="manager-ai-progress">Se verifică datele și se construiește raportul…</output>}
    </div>
    {error&&<p role="alert" className="error-banner">{error}</p>}
    <form className="panel manager-ai-form" onSubmit={submit}>
      <label htmlFor="manager-ai-question">Întrebare despre datele Vodafone</label>
      <textarea id="manager-ai-question" ref={input} value={question} onChange={e=>setQuestion(e.target.value)} maxLength={4000}
        disabled={!available||working} rows={3} placeholder="Ce vrei să afli din portofoliul selectat?"/>
      <div className="manager-ai-actions">
        {exchanges.length>0&&!working&&<button className="secondary" type="button" onClick={()=>{setExchanges([]);setError('');input.current?.focus()}}>Conversație nouă</button>}
        {working?<button className="secondary" type="button" onClick={()=>active.current?.abort()}><Square size={15}/> Oprește</button>:
          <button className="primary" type="submit" disabled={!available||!question.trim()}><Send size={16}/> Analizează</button>}
      </div>
    </form>
  </section>;
}
