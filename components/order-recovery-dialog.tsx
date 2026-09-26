'use client';
import { useRef, useState } from 'react';
import { Copy, Eye, LoaderCircle, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/client-api';
import { removeLocalWork } from '@/lib/local-work';
import { orderSaveBody } from '@/lib/order-draft';
import type { OrderRecovery } from '@/lib/order-recovery';
import type { Order } from '@/lib/types';

export function OrderRecoveryDialog({recovery,userId,onView,onRecovered,onDiscard}:{recovery:OrderRecovery;userId:string;onView:(order:Order)=>void;onRecovered:(order:Order)=>void;onDiscard:(order:Order|null)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const recoveryId=useRef(crypto.randomUUID());
  const {remote,local}=recovery;
  const localLines=local.items.length+(local.standItems?.length||0);
  const remoteLines=remote?remote.items.length+(remote.standItems?.length||0):0;

  async function recover() {
    if(busy)return;
    setBusy(true);setError('');
    try {
      const created=(await api<{order:Order}>('orders','POST',{id:recoveryId.current,kind:local.kind,agentId:local.userId,...(remote?{sourceOrderId:remote.id}:{})})).order;
      const candidate:Order={...local,id:created.id,number:created.number,userId:created.userId,agentName:created.agentName,warehouseId:created.warehouseId,warehouseName:created.warehouseName,status:'draft',createdAt:created.createdAt,finalizedAt:null,sourceOrderId:remote?.id||null,revision:created.revision};
      const saved=(await api<{order:Order}>(`orders/${created.id}`,'PUT',orderSaveBody(candidate,created.revision))).order;
      removeLocalWork('order',userId,local.id);onRecovered(saved);
    } catch(err) {setError(errorMessage(err));setBusy(false);}
  }

  function discard() {
    if(!window.confirm('Renunți definitiv la modificările locale neconfirmate?'))return;
    removeLocalWork('order',userId,local.id);onDiscard(remote);
  }

  return <Dialog open onOpenChange={()=>{}}><DialogContent className="admin-dialog" showCloseButton={false}>
    <DialogHeader><DialogTitle>Modificări locale recuperabile</DialogTitle><DialogDescription>{remote?'Comanda a fost finalizată în altă sesiune, dar browserul păstrează încă modificările tale neconfirmate.':'Comanda nu mai există pe server, dar browserul păstrează modificările tale neconfirmate.'}</DialogDescription></DialogHeader>
    <div className="recovery-compare">
      <div><small>LOCAL</small><strong>{local.pieces} buc. · {localLines} linii</strong><span>{local.notes||'Fără observații locale'}</span></div>
      {remote?<div><small>FINALIZAT</small><strong>{remote.pieces} buc. · {remoteLines} linii</strong><span>{remote.notes||'Fără observații'}</span></div>:<div><small>SERVER</small><strong>Comandă indisponibilă</strong><span>Poți salva munca locală ca o ciornă nouă.</span></div>}
    </div>
    {local.serials.length>0&&<p className="notice">Ciorna recuperată poate conține serii SIM deja folosite în documentul finalizat. Verifică seriile înainte de o nouă finalizare.</p>}
    {error&&<p className="error-banner" role="alert">{error}</p>}
    <div className="recovery-actions">
      <button className="primary" disabled={busy} onClick={()=>void recover()}>{busy?<LoaderCircle className="spin" size={18}/>:<Copy size={18}/>} Copiază modificările într-o ciornă nouă</button>
      {remote&&<button className="secondary" disabled={busy} onClick={()=>onView(remote)}><Eye size={18}/> Vezi documentul finalizat</button>}
      <button className="quiet danger-text" disabled={busy} onClick={discard}><Trash2 size={17}/> Renunță la modificările locale</button>
    </div>
  </DialogContent></Dialog>;
}
