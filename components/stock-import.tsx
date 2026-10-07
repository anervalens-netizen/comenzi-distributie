'use client';
import { useMemo, useRef, useState } from 'react';
import { Check, FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react';
import { errorMessage } from '@/lib/client-api';
import type { StockPreview, StockCoverageDecision, StockDelta } from '@/lib/stock-types';
import './stock.css';

const MAX_SIZE = 8_000_000;
async function responseData<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Operațiunea nu a reușit.');
  return data;
}

export function StockImport({lastImportText}:{lastImportText:string}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<StockPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [decision,setDecision]=useState<StockCoverageDecision>({warehouses:'partial',depot:'partial'});
  const token = useRef(0);

  const groups = useMemo(
    () => preview?.groups.filter(g => `${g.name} ${g.key} ${g.siteId}`.toLowerCase().includes(query.toLowerCase())) || [],
    [preview, query],
  );
  const selected=Object.values(mapping).filter(Boolean);
  const duplicates=new Set(selected).size!==selected.length;
  const previewMatchesSelection=!!preview
    && preview.decision.warehouses===decision.warehouses
    && preview.decision.depot===decision.depot
    && preview.groups.every(group=>(mapping[group.key]||null)===(group.warehouseId||null));

  async function choose(next: File | null) {
    const id = ++token.current;
    setFile(next); setPreview(null); setMessage(''); setError('');
    if (!next) return;
    if (next.size > MAX_SIZE || !/\.xlsx?$/i.test(next.name)) {
      setError('Alege un fișier .xls sau .xlsx de maximum 8 MB.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/admin/stock/preview', {
        method:'POST',
        credentials:'same-origin',
        headers:{
          'Content-Type':'application/octet-stream',
          'X-Stock-Filename':encodeURIComponent(next.name),
          'X-Stock-Coverage':JSON.stringify(decision),
        },
        body: next,
      });
      const result = await responseData<StockPreview>(response);
      if (id !== token.current) return;
      setPreview(result);
      setMapping(Object.fromEntries(result.groups.map(g => [g.key, g.warehouseId] as const)));
    } catch (e) {
      if (id === token.current) setError(errorMessage(e));
    } finally {
      if (id === token.current) setBusy(false);
    }
  }

  function impact(label:string,delta:StockDelta){
    return <details key={label}>
      <summary>{label}: {delta.before.codes} → {delta.after.codes} coduri · {delta.before.quantity} → {delta.after.quantity} buc. · {delta.before.unknown} → {delta.after.unknown} necunoscute</summary>
      <ul>{delta.changes.map(c=><li key={c.code}>{c.code}: {c.before??'—'} → {c.after??'—'} ({c.kind==='removed'?'eliminat':c.kind==='added'?'adăugat':'modificat'})</li>)}</ul>
    </details>;
  }

  async function currentPreview() {
    if (!file || !preview) throw new Error('Alege din nou fișierul de stoc.');
    if (previewMatchesSelection) return preview;
    const response=await fetch('/api/admin/stock/preview',{
      method:'POST',
      credentials:'same-origin',
      headers:{
        'Content-Type':'application/octet-stream',
        'X-Stock-Filename':encodeURIComponent(file.name),
        'X-Stock-Mappings':JSON.stringify(mapping),
        'X-Stock-Coverage':JSON.stringify(decision),
      },
      body:file,
    });
    const refreshed=await responseData<StockPreview>(response);
    setPreview(refreshed);
    return refreshed;
  }

  async function importFile() {
    if (!file || !preview || busy || !selected.length || duplicates) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const selectedMappings = Object.entries(mapping).map(([, value]) => value).filter(Boolean);
      if (new Set(selectedMappings).size !== selectedMappings.length) throw new Error('O gestiune poate fi selectată o singură dată.');
      const current=await currentPreview();
      const response = await fetch('/api/admin/stock/import', {
        method:'POST',
        credentials:'same-origin',
        headers:{
          'Content-Type':'application/octet-stream',
          'X-Stock-Filename':encodeURIComponent(file.name),
          'X-Stock-Version':current.version,
          'X-Stock-Hash':current.fileHash,
          'X-Stock-Mappings':JSON.stringify(mapping),
          'X-Stock-Coverage':JSON.stringify(decision),
          'X-Stock-Confirmation':current.confirmation,
        },
        body:file,
      });
      const result = await responseData<{warehouses:number;rows:number;importedAt:string}>(response);
      setMessage(`Import finalizat: ${result.rows} rânduri în ${result.warehouses} gestiuni.`);
      setPreview(null);
      setFile(null);
      window.dispatchEvent(new Event('stock-imported'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel stock-import stock-panel">
    <div className="panel-heading"><div>
      <h2><FileSpreadsheet size={19}/> Import stoc Excel</h2>
      <p className="muted">Actualizează gestiunile selectate și depozitul conform acoperirii confirmate.</p>
    </div></div>
    <p className="import-last-status">{lastImportText}</p>
    <label className="stock-upload"><Upload size={20}/><span>{file ? file.name : 'Alege fișier .xls / .xlsx'}</span>
      <input aria-label="Fișier stoc Excel" disabled={busy} type="file" accept=".xls,.xlsx" onChange={e => {void choose(e.target.files?.[0] || null);e.target.value='';}} />
    </label>
    {busy && <p className="notice"><LoaderCircle className="spin" size={17}/> Se procesează fișierul…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {message && <p className="notice"><Check size={17}/> {message}</p>}
    {preview && <>
      <div className="stock-import-summary">
        <strong>{preview.rowCount} rânduri</strong>
        <span>{preview.matchedRows} rânduri potrivite cu catalogul · {preview.unknownProducts} coduri în afara catalogului</span>
      </div>
      <p className="muted">Produsele din afara catalogului rămân în stoc. Gestiunile de prezentare sunt separate. Depozitul folosește valorile distincte din întregul fișier. Importul parțial păstrează codurile absente; snapshotul complet le elimină.</p>
      <input aria-label="Caută gestiune în import" className="stock-filter" placeholder="Caută gestiune…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="stock-groups">{groups.map(group => <div className="stock-group" key={group.key}>
        <div><strong>{group.name}</strong><small>SiteId {group.siteId} · {group.rowCount} rânduri · {group.quantity.toLocaleString('ro-RO')} buc.</small></div>
        <select disabled={busy} aria-label={`Asociază ${group.name}`} value={mapping[group.key] || ''} onChange={e => setMapping(m => ({...m, [group.key]: e.target.value || null}))}>
          <option value="">Nu importa</option>
          {preview.targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
        </select>
      </div>)}</div>
      <p className="muted">{selected.length} gestiuni vor fi actualizate · {preview.groups.length-selected.length} nu se importă. Gestiunile omise își păstrează stocul anterior.</p>
      {duplicates&&<p className="error-banner" role="alert">Aceeași gestiune este selectată de mai multe ori. Corectează asocierile.</p>}
      {(['warehouses','depot'] as const).map(key=><label key={key}>
        {key==='depot'?'Acoperire depozit global':'Acoperire gestiuni selectate'}
        <select disabled={busy} value={decision[key]} onChange={e=>setDecision(d=>({...d,[key]:e.target.value as 'full'|'partial'}))}>
          <option value="partial">Parțial — păstrează produsele absente și vechimea lor</option>
          <option value="full">Snapshot complet — elimină produsele absente</option>
        </select>
      </label>)}
      {previewMatchesSelection
        ? <output><p>Impact calculat pentru aceste asocieri și această acoperire:</p>{preview.impact.warehouses.map(w=>impact(preview.targets.find(t=>t.id===w.warehouseId)?.name||w.warehouseId,w))}{impact('Depozit global',preview.impact.depot)}</output>
        : <p className="muted">Ai modificat asocierea sau acoperirea. Impactul se recalculează automat la confirmare.</p>}
      <button className="primary" disabled={busy || !selected.length || duplicates} onClick={() => void importFile()}><Upload size={17}/> Confirmă importul</button>
    </>}
  </section>;
}
