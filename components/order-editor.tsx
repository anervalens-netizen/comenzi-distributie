'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Search, Plus, Minus, X, ShoppingBag, Save, Check, ScanBarcode, MapPin, Package, LoaderCircle, FileCheck2, Trash2 } from 'lucide-react';
import Image from 'next/image';
import { PartnerNew } from './partner-new';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { api, errorMessage, money, normalize, kindLabels } from '@/lib/client-api';
import { stockCode } from '@/lib/stock-types';
import type { Order, Product, Client } from '@/lib/types';
import { StockQuantity, StockMetadata, useAgentStock } from '@/components/stock-panel';
import { useOrderDraftSave } from '@/components/use-order-draft-save';
import { OrderSaveConflictDialog } from '@/components/order-save-conflict-dialog';

export function OrderEditor({initial,products,onClose,onSaved,onFinalized,onRecovered,partnerUserId}:{partnerUserId?:string;initial:Order;products:Product[];onClose:()=>void;onSaved:(o:Order)=>void;onFinalized:(o:Order)=>void;onRecovered:(o:Order)=>void}) {
  const [partnerOpen,setPartnerOpen]=useState(false),[clientRefresh,setClientRefresh]=useState(0);
  const [query,setQuery]=useState(''),[category,setCategory]=useState('Toate'),[selectedOnly,setSelectedOnly]=useState(false),[page,setPage]=useState(1),[quantityDrafts,setQuantityDrafts]=useState<Record<string,string>>({});
  const [clients,setClients]=useState<Client[]>([]),[clientsError,setClientsError]=useState(''),[scanner,setScanner]=useState(''),[scanError,setScanError]=useState(''),[lastScan,setLastScan]=useState('');
  const [actionError,setActionError]=useState(''),[busy,setBusy]=useState(false),[review,setReview]=useState(false);
  const {order,update:updateDraft,save,saveState,saveError,conflict,remoteFinalized,remoteDeleted,resolveConflict,recoverToNewDraft,discardRemoteRecovery,getCurrent,getRevision}=useOrderDraftSave({initial,onSaved});
  const error=actionError||saveError;
  const locked=!!conflict||!!remoteFinalized||remoteDeleted;
  function update(change:Partial<Order>){setActionError('');updateDraft(change);}
  const { lookup: stockLookup, view: stockView, loading: stockLoading, error: stockError } = useAgentStock(initial.warehouseId);
  const scanInput=useRef<HTMLInputElement>(null);
  const cartRef=useRef<HTMLElement>(null);
  useEffect(()=>{
    if(initial.kind!=='sim'&&initial.kind!=='stand_client') return;
    void api<{clients:Client[]}>(`clients?warehouseId=${encodeURIComponent(initial.warehouseId)}`).then(r=>setClients(r.clients)).catch(err=>setClientsError(errorMessage(err)));
  },[initial.kind,initial.warehouseId,clientRefresh]);
  const kindProducts=useMemo(()=>products.filter(p=>order.kind==='stand_client'?p.kind==='stands'&&p.category==='Standuri':p.kind===order.kind),[products,order.kind]);
  const categories=useMemo(()=>['Toate',...new Set(kindProducts.map(p=>p.category))],[kindProducts]);
  const filtered=kindProducts.filter(p=>(category==='Toate'||p.category===category)&&(!selectedOnly||order.items.some(l=>l.id===p.id))&&normalize(p.name+' '+p.code+' '+p.brand).includes(normalize(query)));
  const shown=filtered.slice(0,page*30);
  function quantity(p:Product,qty:number) {
    if(!Number.isInteger(qty)||qty<0||qty>9999)return;
    const current=getCurrent();
    const others=current.items.filter(l=>l.id!==p.id);
    update({items:qty?[...others,{...p,quantity:qty}].sort((a,b)=>a.sourceRow-b.sourceRow):others});
  }
  function editQuantity(p:Product,raw:string) {
    setQuantityDrafts(d=>({...d,[p.id]:raw}));
    if(raw==='')return;
    const qty=Number(raw);
    if(Number.isInteger(qty)&&qty>=0&&qty<=9999){quantity(p,qty);setQuantityDrafts(d=>{const next={...d};delete next[p.id];return next;});}
  }
  function finishQuantity(p:Product,current:number) {
    const raw=quantityDrafts[p.id];
    if(raw===undefined)return;
    if(raw===''){setQuantityDrafts(d=>{const next={...d};delete next[p.id];return next;});return;}
    const qty=Number(raw);
    if(!Number.isInteger(qty)||qty<0||qty>9999){setQuantityDrafts(d=>{const next={...d};delete next[p.id];return next;});quantity(p,current);}
  }
  function scan(raw:string) {
    const batch=raw.trim().split(/[\s,;]+/).filter(Boolean);
    const current=getCurrent();
    const existing=new Set(current.serials);
    if(!batch.length)return;
    for(const s of batch) {
      if(!/^\d{18,22}$/.test(s)){setScanError(`Seria „${s.slice(0,30)}” trebuie să aibă 18–22 de cifre.`);scanInput.current?.select();return;}
      if(existing.has(s)){setScanError(`Seria ${s} este deja în acest aviz.`);scanInput.current?.select();return;}
      existing.add(s);
    }
    if(existing.size>1000){setScanError('Un aviz poate conține maximum 1.000 de serii.');return;}
    update({serials:[...current.serials,...batch]});setScanner('');setScanError('');setLastScan(batch.at(-1)!);scanInput.current?.focus();
  }
  async function back() {setBusy(true);setActionError('');try{await save();onClose();}catch{setBusy(false);}}
  async function recover(){setBusy(true);setActionError('');try{const recovered=await recoverToNewDraft();toast.success('Modificările au fost copiate într-o ciornă nouă.');onRecovered(recovered);}catch(err){setActionError(errorMessage(err));setBusy(false);}}
  function discardRecovery(){discardRemoteRecovery();onClose();}
  async function discardDraft() {if(busy||locked||!window.confirm('Renunți la această ciornă?'))return;setBusy(true);setActionError('');try{await api(`orders/${order.id}`,'DELETE',{revision:getRevision()});toast.success('Ciorna a fost ștearsă.');onClose();}catch(err){setActionError(errorMessage(err));setBusy(false);}}
  async function openReview(){if(busy||locked)return;setBusy(true);setActionError('');try{await save(true);setReview(true);}catch{}finally{setBusy(false);}}
  async function finalize() {
    setBusy(true);setActionError('');
    try {const {order:finalOrder}=await api<{order:Order}>(`orders/${order.id}/finalize`,'POST',{revision:getRevision()});onFinalized(finalOrder);}
    catch(err){setActionError(errorMessage(err));setReview(false);setBusy(false);}
  }
  return <div className="editor-page">
    <div className="editor-top"><button className="quiet back-link" disabled={busy||locked} onClick={()=>void back()}><ArrowLeft size={19}/> Comenzi</button><div className="editor-top-actions"><button className="quiet discard-draft" disabled={busy||locked} onClick={()=>void discardDraft()}><Trash2 size={16}/> Renunță la ciornă</button><span className={'save-state '+(saveState==='Salvat'?'saved':'')}>{saveState==='Salvat'?<Check size={15}/>:<Save size={15}/>} {saveState}</span></div></div>
    <div className="page-heading"><div><span className="eyebrow">{order.number}</span><h1>{order.kind==='stand_client'?'Aviz pentru standuri':order.kind==='sim'?'Aviz pentru SIM 0':`Comandă ${order.kind==='stands'?'standuri & telefoane':'accesorii'}`}</h1><p>{order.warehouseName} <span className="meta-separator">·</span> {order.agentName}</p></div><span className="badge draft">Ciornă</span></div>
    {error&&<div className="error-banner" role="alert">{error}</div>}
    {(remoteFinalized||remoteDeleted)&&<div className="recovery-banner" role="alert"><div><strong>{remoteDeleted?'Comanda a fost ștearsă în altă sesiune.':'Comanda a fost finalizată în altă sesiune.'}</strong><p>Modificările locale nu au fost șterse. Le poți copia într-o ciornă nouă sau poți renunța explicit la ele.</p></div><div className="recovery-actions"><button className="primary" disabled={busy} onClick={()=>void recover()}><Plus size={17}/> Copiază într-o ciornă nouă</button><button className="secondary" disabled={busy} onClick={discardRecovery}>Renunță la modificările locale</button></div></div>}
    <StockMetadata view={stockView} loading={stockLoading} error={stockError}/><div className="editor-layout"><fieldset disabled={busy||locked} className="catalog-area">
      {order.kind==='stand_client'&&<section className="step-card"><div className="step-title"><span>1</span><div><h2>Alege clientul</h2><p>Caută în portofoliul agentului după denumire, CUI sau localitate.</p></div></div>
          {clientsError?<p className="error-banner">{clientsError}</p>:clients.length===0?<p className="notice">Nu există clienți importați pentru această gestiune. Managerul poate încărca portofoliul din zona Echipă.</p>:<Combobox items={clients} value={order.client} onValueChange={c=>update({client:c})} itemToStringLabel={c=>`${c.name} · ${c.cui} · ${c.city} · ${c.address}`} isItemEqualToValue={(a,b)=>a.id===b.id}>
            <ComboboxInput className="client-combobox" placeholder="Denumire, CUI sau localitate…" aria-label="Caută client" showClear/>
            <ComboboxContent><ComboboxEmpty>Niciun client găsit.</ComboboxEmpty><ComboboxList>{(c:Client)=><ComboboxItem key={c.id} value={c} className="client-option"><div><strong>{c.name}</strong><small>CUI {c.cui} · {c.city} · {c.address}</small></div></ComboboxItem>}</ComboboxList></ComboboxContent>
          </Combobox>}
          {order.client&&<div className="selected-client"><span className="client-icon"><MapPin size={22}/></span><div><strong>{order.client.name}</strong><p>CUI {order.client.cui} · {order.client.city}, {order.client.county}</p><small>{order.client.address}</small></div><Check size={18}/></div>}
        {partnerUserId&&<button type="button" className="secondary" onClick={()=>setPartnerOpen(true)}><Plus size={17}/> Adaugă partener / punct de lucru</button>}<button type="button" className="quiet" onClick={()=>setClientRefresh(v=>v+1)}>Actualizează lista clienților</button></section>}
      {order.kind!=='sim'?<>
        <div className="catalog-controls"><div className="catalog-toolbar"><div className="search-box"><Search size={19}/><input value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder="Caută după denumire sau cod produs…" aria-label="Caută produse"/>{query&&<button className="icon-button" onClick={()=>{setQuery('');setPage(1);}} aria-label="Șterge căutarea"><X size={17}/></button>}</div><label className="selected-switch" htmlFor="selected-products"><Switch id="selected-products" checked={selectedOnly} onCheckedChange={v=>{setSelectedOnly(v);setPage(1);}}/> Doar selectate</label></div>
        <div className="category-list" aria-label="Categorii de produse">{categories.map(c=><button key={c} className={c===category?'active':''} aria-pressed={c===category} onClick={()=>{setCategory(c);setPage(1);}}>{c}<span>{c==='Toate'?kindProducts.length:kindProducts.filter(p=>p.category===c).length}</span></button>)}</div>
        </div><div className="catalog-caption"><span>{filtered.length} produse</span><span>{order.kind==='accessories'?'Prețuri din catalog, cu TVA':'Cantități în bucăți'}</span></div>
        <div className="product-grid">{shown.map(p=>{
          const qty=order.items.find(l=>l.id===p.id)?.quantity||0;
          return <article className={'product-card '+(qty?'selected':'')} key={p.id}><div className="product-image">{p.image?<Image unoptimized width={240} height={150} loading="lazy" src={p.image} alt={p.name}/>:<div className="product-placeholder"><Package size={34}/><span>{p.brand||p.category}</span></div>}{qty>0&&<span className="selected-check"><Check size={13}/></span>}</div><div className="product-info"><span className="product-code">{p.code}</span><h3>{p.name}</h3><span className="product-category">{p.category}</span><div className="product-bottom"><strong>{p.price!==null?money(p.price):'buc.'}</strong>{qty?<div className="quantity-control"><span className="quantity-manual-label">Cantitate manuală</span><div className="quantity-stepper"><button onClick={()=>quantity(p,qty-1)} aria-label={`Scade ${p.name}`}><Minus size={17}/></button><input type="number" inputMode="numeric" min="0" max="9999" value={quantityDrafts[p.id]??qty} onChange={e=>editQuantity(p,e.target.value)} onBlur={()=>finishQuantity(p,qty)} aria-label={`Cantitate manuală ${p.name}`}/><button onClick={()=>quantity(p,qty+1)} aria-label={`Adaugă ${p.name}`}><Plus size={17}/></button></div></div>:<button className="add-product" onClick={()=>quantity(p,1)}><Plus size={17}/> Adaugă</button>}</div><StockQuantity row={stockLookup.get(stockCode(p.code))} depotQuantity={stockView?.depot[stockCode(p.code)]} loading={stockLoading} error={stockError}/></div></article>;
        })}</div>
        {!filtered.length&&<Empty><EmptyHeader><EmptyTitle>Niciun produs găsit</EmptyTitle><EmptyDescription>Încearcă altă denumire sau selectează toate categoriile.</EmptyDescription></EmptyHeader></Empty>}
        {shown.length<filtered.length&&<button className="secondary load-more" onClick={()=>setPage(p=>p+1)}>Arată încă {Math.min(30,filtered.length-shown.length)} de produse</button>}
      </>:<div className="sim-workspace">
        <section className="step-card"><div className="step-title"><span>1</span><div><h2>Alege clientul</h2><p>Caută în portofoliul agentului după denumire, CUI sau localitate.</p></div></div>
          {clientsError?<p className="error-banner">{clientsError}</p>:clients.length===0?<p className="notice">Nu există clienți importați pentru această gestiune. Managerul poate încărca portofoliul din zona Echipă.</p>:<Combobox items={clients} value={order.client} onValueChange={c=>update({client:c})} itemToStringLabel={c=>`${c.name} · ${c.cui} · ${c.city} · ${c.address}`} isItemEqualToValue={(a,b)=>a.id===b.id}>
            <ComboboxInput className="client-combobox" placeholder="Denumire, CUI sau localitate…" aria-label="Caută client" showClear/>
            <ComboboxContent><ComboboxEmpty>Niciun client găsit.</ComboboxEmpty><ComboboxList>{(c:Client)=><ComboboxItem key={c.id} value={c} className="client-option"><div><strong>{c.name}</strong><small>CUI {c.cui} · {c.city} · {c.address}</small></div></ComboboxItem>}</ComboboxList></ComboboxContent>
          </Combobox>}
          {order.client&&<div className="selected-client"><span className="client-icon"><MapPin size={22}/></span><div><strong>{order.client.name}</strong><p>CUI {order.client.cui} · {order.client.city}, {order.client.county}</p><small>{order.client.address}</small></div><Check size={18}/></div>}
        {partnerUserId&&<button type="button" className="secondary" onClick={()=>setPartnerOpen(true)}><Plus size={17}/> Adaugă partener / punct de lucru</button>}<button type="button" className="quiet" onClick={()=>setClientRefresh(v=>v+1)}>Actualizează lista clienților</button></section>
        <section className="step-card"><div className="step-title"><span>2</span><div><h2>Scanează seriile SIM</h2><p>sim 0 vodafone <span className="meta-separator">·</span> Scanner conectat la tabletă</p></div><ScanBarcode className="step-icon" size={28}/></div>
          <div className="scanner-entry"><div className="scanner-input"><ScanBarcode size={21}/><input ref={scanInput} value={scanner} disabled={!order.client} onChange={e=>setScanner(e.target.value)} onKeyDown={e=>{if((e.key==='Enter'||e.key==='Tab')&&scanner.trim()){e.preventDefault();scan(scanner);}}} onPaste={e=>{const pasted=e.clipboardData.getData('text');if(/[\r\n]/.test(pasted.trim())){e.preventDefault();scan(pasted);}}} placeholder="Scanează sau introdu seria SIM" inputMode="numeric" autoComplete="off" aria-label="Serie SIM"/></div><button className="primary" disabled={!scanner.trim()||!order.client} onClick={()=>scan(scanner)}><Plus size={19}/> Adaugă</button></div>
          <p className="scanner-hint">Scannerul trebuie să trimită Enter sau Tab după fiecare serie. Seriile au 18–22 de cifre.</p>
          {scanError&&<p className="error-banner" role="alert">{scanError}</p>}{lastScan&&!scanError&&<output className="scan-success"><Check size={16}/> Adăugată: <code>{lastScan}</code></output>}
          <div className="serial-heading"><h3>Serii scanate</h3><span className="count-pill">{order.serials.length}</span></div>
          {order.serials.length?<ol className="serial-list">{order.serials.map((s,i)=><li key={s}><span className="serial-index">{i+1}</span><code>{s}</code><span className="serial-ok">Adăugată</span><button className="icon-button" onClick={()=>update({serials:order.serials.filter(x=>x!==s)})} aria-label={`Elimină seria ${s}`}><X size={17}/></button></li>)}</ol>:<div className="scanner-empty"><ScanBarcode size={44}/><p>Pregătit pentru prima scanare</p><small>{order.client?'Atinge câmpul de scanare și începe.':'Selectează întâi clientul.'}</small></div>}
        </section>
      </div>}
    </fieldset><aside className="cart" ref={cartRef}><div className="cart-heading"><ShoppingBag size={21}/><h2>{(order.kind==='sim'||order.kind==='stand_client')?'Rezumat aviz':'Comanda ta'}</h2><span>{order.kind==='sim'?order.serials.length:order.items.length}</span></div>
      {order.kind==='sim'?<div className="sim-cart-client"><small>CLIENT</small><strong>{order.client?.name||'Neselectat'}</strong>{order.client&&<span>CUI {order.client.cui}</span>}<div className="sim-count"><ScanBarcode size={23}/><b>{order.serials.length}</b><span>SIM-uri scanate</span></div></div>:order.items.length?<div className="cart-lines">{order.items.map(l=><div className="cart-line" key={l.id}><div><strong>{l.name}</strong><small>{l.code}</small></div><button disabled={busy||locked} className="icon-button" onClick={()=>quantity(l,0)} aria-label={`Elimină ${l.name}`}><X size={15}/></button><div className="quantity-control"><span className="quantity-manual-label">Cantitate</span><div className="quantity-stepper"><button disabled={busy||locked} onClick={()=>quantity(l,l.quantity-1)} aria-label={`Scade cantitatea ${l.code}`}><Minus size={15}/></button><input disabled={busy||locked} type="number" inputMode="numeric" min="0" max="9999" value={quantityDrafts[l.id]??l.quantity} onChange={e=>editQuantity(l,e.target.value)} onBlur={()=>finishQuantity(l,l.quantity)} aria-label={`Cantitate manuală în coș ${l.code}`}/><button disabled={busy||locked} onClick={()=>quantity(l,l.quantity+1)} aria-label={`Crește cantitatea ${l.code}`}><Plus size={15}/></button></div></div><b>{l.price!==null?money(l.price*l.quantity):`${l.quantity} buc.`}</b></div>)}</div>:<div className="cart-empty"><ShoppingBag size={32}/><h3>Coșul este gol</h3><p>Adaugă produse din catalog pentru a pregăti comanda.</p></div>}
      <div className="cart-footer"><label>Observații <span className="optional">opțional</span><textarea disabled={busy||locked} rows={2} maxLength={2000} value={order.notes} onChange={e=>update({notes:e.target.value})} placeholder="Detalii pentru echipa de comenzi…"/></label><div className="cart-totals"><span>Total bucăți</span><b>{order.pieces}</b>{order.kind==='accessories'&&<><strong>Total cu TVA</strong><strong>{money(order.total)}</strong></>}</div><button className="primary" disabled={busy||locked||!order.pieces||((order.kind==='sim'||order.kind==='stand_client')&&!order.client)} onClick={()=>void openReview()}>Verifică {(order.kind==='sim'||order.kind==='stand_client')?'avizul':'comanda'} <ArrowRight size={18}/></button><button className="quiet" disabled={busy||locked} onClick={()=>void save(true).then(()=>toast.success('Ciorna a fost salvată și revalidată.')).catch(()=>{})}><Save size={17}/> Salvează ciorna</button><span className="cart-note">{order.kind==='stand_client'?'Finalizarea pregătește e-mailul cu detaliile avizului.':'Finalizarea pregătește fișierul Excel.'}</span></div>
    </aside></div>
    <div className="mobile-order-bar"><button className="mobile-cart-button" onClick={()=>cartRef.current?.scrollIntoView({behavior:'smooth',block:'start'})}><ShoppingBag size={20}/><span><strong>{order.pieces} bucăți</strong><small>{order.kind==='accessories'?money(order.total):'Vezi rezumatul'}</small></span></button><button className="primary" disabled={busy||locked||!order.pieces||((order.kind==='sim'||order.kind==='stand_client')&&!order.client)} onClick={()=>void openReview()}>Verifică <ArrowRight size={18}/></button></div>
    <Dialog open={review} onOpenChange={open=>{if(!busy&&!conflict)setReview(open);}}><DialogContent className="review-dialog" showCloseButton={!busy}><DialogHeader><DialogTitle className="text-xl"><FileCheck2 size={24}/> Verifică înainte de finalizare</DialogTitle><DialogDescription>{order.warehouseName} · {order.agentName}</DialogDescription></DialogHeader><div className="review-content">
      {order.client&&<div className="client-summary"><strong>{order.client.name}</strong><span>CUI {order.client.cui} · {order.client.city}</span><span>{order.client.address}</span></div>}
      {order.kind==='sim'?<><p><b>sim 0 vodafone</b> · {order.serials.length} bucăți</p><div className="review-serials">{order.serials.map((s,i)=><code key={s}>{i+1}. {s}</code>)}</div></>:<div className="summary-lines">{order.items.map(l=><div key={l.id}><span><strong>{l.name}</strong><small>{l.code}</small></span><b>{l.quantity} buc.</b></div>)}</div>}
      <div className="summary-total"><span>{order.pieces} bucăți</span><strong>{order.kind==='accessories'?money(order.total):kindLabels[order.kind]}</strong></div>{order.notes&&<p className="notice">{order.notes}</p>}<p className="muted">După finalizare, comanda rămâne în istoric. O poți copia pentru săptămâna următoare.</p></div><div className="dialog-actions"><button className="secondary" disabled={busy} onClick={()=>setReview(false)}>Înapoi la editare</button><button className="primary" disabled={busy} onClick={()=>void finalize()}>{busy?<LoaderCircle size={18} className="spin"/>:<Check size={18}/>} {order.kind==='stand_client'?(busy?'Se pregătește avizul…':'Finalizează avizul'):(busy?'Se pregătește Excelul…':'Finalizează și exportă Excel')}</button></div></DialogContent></Dialog>
    <Dialog open={partnerOpen} onOpenChange={open=>{setPartnerOpen(open);if(!open)setClientRefresh(v=>v+1);}}><DialogContent className="admin-dialog" style={{maxHeight:'90dvh',overflowY:'auto'}}><DialogHeader><DialogTitle>Adaugă partener / punct de lucru</DialogTitle><DialogDescription>După confirmarea managerului, punctul de lucru apare în lista de clienți.</DialogDescription></DialogHeader>{partnerUserId&&<PartnerNew userId={partnerUserId}/>}</DialogContent></Dialog>
    <OrderSaveConflictDialog conflict={conflict} onResolve={resolveConflict}/>
  </div>;
}
