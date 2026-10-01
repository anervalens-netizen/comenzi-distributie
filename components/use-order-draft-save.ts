'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/client-api';
import { currentLocalWorkUserId, readLocalWork, removeLocalWork, writeLocalWork } from '@/lib/local-work';
import {
  mergeConcurrentOrders,
  orderSaveBody,
  recalculateOrder,
  sameEditableOrder,
  type OrderConflictChoice,
  type OrderConflictField,
} from '@/lib/order-draft';
import { enqueue, pendingOperations, readWork, saveWork, removeWork } from '@/lib/offline-work';
import type { Order } from '@/lib/types';

export type PendingOrderConflict = {
  fields: OrderConflictField[];
  local: Order;
  remote: Order;
};
type StoredOrderWork={base:Order;local:Order};
type RestoreState={order:Order;conflict:PendingOrderConflict|null;storageError:string};

class ConflictNeedsChoice extends Error {
  constructor() { super('Rezolvă conflictul înainte de a continua.'); this.name='ConflictNeedsChoice'; }
}

function restore(initial:Order,storageOwnerId:string):RestoreState {
  if(!storageOwnerId||initial.status!=='draft') return {order:initial,conflict:null,storageError:''};
  const stored=readLocalWork<StoredOrderWork>('order',storageOwnerId,initial.id);
  if(!stored.value) return {order:initial,conflict:null,storageError:stored.error};
  try {
    const localMerge=mergeConcurrentOrders(stored.value.base,stored.value.local,initial,'local');
    if(!localMerge.conflicts.length) return {order:localMerge.order,conflict:null,storageError:stored.error};
    const remoteMerge=mergeConcurrentOrders(stored.value.base,stored.value.local,initial,'remote');
    return {order:localMerge.order,conflict:{fields:localMerge.conflicts,local:localMerge.order,remote:remoteMerge.order},storageError:stored.error};
  } catch {
    removeLocalWork('order',storageOwnerId,initial.id);
    return {order:initial,conflict:null,storageError:'Modificările locale vechi nu au putut fi restaurate și au fost ignorate.'};
  }
}

export function useOrderDraftSave({ initial, onSaved, storageOwnerId }: { initial: Order; onSaved: (order: Order) => void; storageOwnerId?:string }) {
  const [owner]=useState(()=>storageOwnerId||currentLocalWorkUserId());
  const [initialState]=useState<RestoreState>(()=>restore(initial,owner));
  const [order,setOrder]=useState(initialState.order);
  const [saveState,setSaveState]=useState(sameEditableOrder(initialState.order,initial)?'Salvat':initialState.conflict?'Conflict de rezolvat':'Modificări nesalvate');
  const [saveError,setSaveError]=useState(initialState.storageError);
  const [storageError,setStorageError]=useState(initialState.storageError);
  const [conflict,setConflict]=useState<PendingOrderConflict|null>(initialState.conflict);
  const [remoteFinalized,setRemoteFinalized]=useState<Order|null>(null);
  const [remoteDeleted,setRemoteDeleted]=useState(false);
  const original=useRef(initial);
  const clearCallback=useRef(()=>{});
  const latest=useRef(initialState.order);
  const confirmed=useRef(initial);
  const revision=useRef(initial.revision);
  const conflictRef=useRef<PendingOrderConflict|null>(initialState.conflict);
  const remoteFinalizedRef=useRef<Order|null>(null);
  const remoteDeletedRef=useRef(false);
  const onSavedRef=useRef(onSaved);
  const queue=useRef<Promise<void>>(Promise.resolve());
  const saveCallback=useRef<(force?:boolean)=>Promise<Order>>(async()=>initial);

  function persist(local=latest.current,base=confirmed.current) {
    if(!owner) return '';
    let issue='';
    if(local.status!=='draft') issue=removeLocalWork('order',owner,initial.id);
    else {issue=writeLocalWork<StoredOrderWork>('order',owner,initial.id,{base,local});void saveWork(owner,'order',initial.id,{base,local}).catch(err=>{setStorageError(errorMessage(err));});}
    setStorageError(issue);
    return issue;
  }
  function clearStoredWork() {
    if(!owner)return '';
    const issue=removeLocalWork('order',owner,initial.id);void removeWork(owner,'order',initial.id).catch(err=>setStorageError(errorMessage(err)));
    setStorageError(issue);
    return issue;
  }
  function setLocal(next: Order) {
    latest.current=next;
    setOrder(next);
  }

  function update(change: Partial<Order>) {
    const next=recalculateOrder({...latest.current,...change});
    setLocal(next);
    const issue=persist(next,confirmed.current);
    setSaveError(issue);
    setSaveState(sameEditableOrder(next,confirmed.current)?'Salvat':'Modificări nesalvate');
  }

  function markRemoteDeleted(base=confirmed.current) {
    const localCurrent=latest.current;
    const message='Comanda a fost ștearsă în altă sesiune. Modificările tale locale sunt păstrate până alegi ce faci cu ele.';
    remoteDeletedRef.current=true;
    setRemoteDeleted(true);
    setSaveState('Necesită recuperare');
    const issue=owner?writeLocalWork<StoredOrderWork>('order',owner,initial.id,{base,local:localCurrent}):'';
    setStorageError(issue);
    setSaveError([message,issue].filter(Boolean).join(' '));
  }

  async function saveNow(force=false): Promise<Order> {
    if(conflictRef.current) throw new ConflictNeedsChoice();
    if(remoteFinalizedRef.current||remoteDeletedRef.current) throw new Error('Alege cum recuperezi modificările locale înainte de a continua.');
    let forceRequest=force;
    for(let attempt=0;attempt<4;attempt++) {
      if(!forceRequest && sameEditableOrder(latest.current,confirmed.current)&&latest.current.number!=='Ciornă locală'&&!(await pendingOperations(owner)).some(op=>op.entity===`orders/${initial.id}`)) {
        setSaveState('Salvat');
        clearStoredWork();
        return confirmed.current;
      }
      const snapshot=latest.current;
      const base=confirmed.current;
      setSaveState('Se salvează…');
      setSaveError('');
      try {
        const queued=await pendingOperations(owner);
        if(queued.some(op=>op.entity===`orders/${snapshot.id}`&&op.state==='blocked'))throw new ApiError(403,'Operațiune în conflict. Deschide coada locală pentru verificare.',null);
        if(queued.some(op=>op.entity===`orders/${snapshot.id}`)){
          await enqueue(owner,`orders/${snapshot.id}`,'PUT',orderSaveBody(snapshot,revision.current),{scope:'order',id:snapshot.id,value:{base,local:snapshot}});
          setSaveState('Salvat pe telefon · În așteptare');throw new Error('Salvat pe telefon. Așteaptă sincronizarea înainte de finalizare.');
        }
        const {order:saved}=await api<{order:Order}>(`orders/${snapshot.id}`,'PUT',orderSaveBody(snapshot,revision.current));
        revision.current=saved.revision;
        confirmed.current=saved;
        onSavedRef.current(saved);
        const merged=mergeConcurrentOrders(snapshot,latest.current,saved,'local').order;
        setLocal(merged);
        forceRequest=false;
        if(sameEditableOrder(merged,saved)) {
          setSaveState('Salvat');
          clearStoredWork();
          return saved;
        }
        setSaveState('Modificări nesalvate');
        const issue=persist(merged,saved);
        if(issue)setSaveError(issue);
      } catch(err) {
        if(err instanceof ApiError && err.status===404) {
          markRemoteDeleted(base);
          throw err;
        }
        if(err instanceof ApiError && err.status===409) {
          let remote:Order;
          try {
            ({order:remote}=await api<{order:Order}>(`orders/${snapshot.id}`));
          } catch(refreshError) {
            if(refreshError instanceof ApiError&&refreshError.status===404){markRemoteDeleted(base);throw refreshError;}
            setSaveState('Nesalvat');
            const issue=persist();
            setSaveError([errorMessage(refreshError),issue].filter(Boolean).join(' '));
            throw refreshError;
          }
          revision.current=remote.revision;
          if(remote.status!=='draft') {
            const localCurrent=latest.current;
            const message='Comanda a fost finalizată în altă sesiune. Modificările tale locale sunt păstrate până alegi ce faci cu ele.';
            remoteFinalizedRef.current=remote;
            setRemoteFinalized(remote);
            onSavedRef.current(remote);
            setSaveState('Necesită recuperare');
            const issue=owner?writeLocalWork<StoredOrderWork>('order',owner,initial.id,{base,local:localCurrent}):'';
            setStorageError(issue);
            setSaveError([message,issue].filter(Boolean).join(' '));
            throw new Error(message);
          }
          confirmed.current=remote;
          onSavedRef.current(remote);
          const localCurrent=latest.current;
          const localMerge=mergeConcurrentOrders(base,localCurrent,remote,'local');
          if(localMerge.conflicts.length) {
            const remoteMerge=mergeConcurrentOrders(base,localCurrent,remote,'remote');
            const pending={fields:localMerge.conflicts,local:localMerge.order,remote:remoteMerge.order};
            conflictRef.current=pending;
            setConflict(pending);
            setSaveState('Conflict de rezolvat');
            const issue=persist(localCurrent,base);
            setSaveError(issue);
            throw new ConflictNeedsChoice();
          }
          setLocal(localMerge.order);
          forceRequest=false;
          if(sameEditableOrder(localMerge.order,remote)) {
            setSaveState('Salvat');
            clearStoredWork();
            return remote;
          }
          setSaveState('Modificări nesalvate');
          const issue=persist(localMerge.order,remote);
          if(issue)setSaveError(issue);
          continue;
        }
        if(!(err instanceof ApiError)||err.status>=500){
          try{await enqueue(owner,`orders/${snapshot.id}`,'PUT',orderSaveBody(latest.current,revision.current),{scope:'order',id:snapshot.id,value:{base,local:latest.current}});setSaveState('Salvat pe telefon · În așteptare');setSaveError('Salvarea pe server așteaptă sincronizarea.');}catch(storage){setSaveState('Nesalvat');setSaveError(errorMessage(storage));}
        }else{setSaveState('Necesită verificare');const issue=persist();setSaveError([errorMessage(err),issue].filter(Boolean).join(' '));}
        throw err;
      }
    }
    const message='Comanda s-a modificat repetat în timpul salvării. Încearcă din nou după ce termini editarea.';
    setSaveState('Nesalvat');
    const issue=persist();
    setSaveError([message,issue].filter(Boolean).join(' '));
    throw new Error(message);
  }

  function save(force=false) {
    const operation=queue.current.catch(()=>{}).then(()=>saveNow(force));
    queue.current=operation.then(()=>{},()=>{});
    return operation;
  }


  async function recoverToNewDraft() {
    const remote=remoteFinalizedRef.current;
    if(!remote&&!remoteDeletedRef.current) throw new Error('Nu există modificări locale de recuperat.');
    const local=latest.current;
    const {order:created}=await api<{order:Order}>('orders','POST',{id:crypto.randomUUID(),kind:local.kind,agentId:local.userId,...(remote?{sourceOrderId:remote.id}:{})});
    const candidate:Order={...local,id:created.id,number:created.number,userId:created.userId,agentName:created.agentName,warehouseId:created.warehouseId,warehouseName:created.warehouseName,status:'draft',createdAt:created.createdAt,finalizedAt:null,sourceOrderId:remote?.id||null,revision:created.revision};
    const {order:saved}=await api<{order:Order}>(`orders/${created.id}`,'PUT',orderSaveBody(candidate,created.revision));
    clearStoredWork();
    remoteFinalizedRef.current=null;remoteDeletedRef.current=false;
    setRemoteFinalized(null);setRemoteDeleted(false);
    return saved;
  }

  function discardRemoteRecovery() {
    clearStoredWork();
    remoteFinalizedRef.current=null;remoteDeletedRef.current=false;
    setRemoteFinalized(null);setRemoteDeleted(false);
  }

  function resolveConflict(choice: OrderConflictChoice) {
    const pending=conflictRef.current;
    if(!pending) return;
    const next=choice==='local'?pending.local:pending.remote;
    conflictRef.current=null;
    setConflict(null);
    setLocal(next);
    const clean=sameEditableOrder(next,confirmed.current);
    setSaveState(clean?'Salvat':'Modificări nesalvate');
    const issue=clean?clearStoredWork():persist(next,confirmed.current);
    setSaveError(issue);
  }

  // Editor is keyed by document/epoch; capture its initial recovery base once.
  useEffect(()=>{
    let alive=true;void readWork<StoredOrderWork>(owner,'order',original.current.id).then(stored=>{if(alive&&stored&&sameEditableOrder(latest.current,original.current)){const merged=mergeConcurrentOrders(stored.base,stored.local,original.current,'local');setLocal(merged.order);if(merged.conflicts.length){const remote=mergeConcurrentOrders(stored.base,stored.local,original.current,'remote');const pending={fields:merged.conflicts,local:merged.order,remote:remote.order};conflictRef.current=pending;setConflict(pending);}setSaveState('Modificări locale restaurate');}}).catch(err=>setStorageError(errorMessage(err)));
    const retry=()=>{if(document.visibilityState==='visible')void saveCallback.current(false).catch(()=>{});};
    const synced=(event:Event)=>{const d=(event as CustomEvent).detail;if(d.userId!==owner||d.path!==`orders/${original.current.id}`||!d.result?.order)return;const saved=d.result.order as Order;const base=confirmed.current;const merged=mergeConcurrentOrders(base,latest.current,saved,'local');revision.current=saved.revision;confirmed.current=saved;onSavedRef.current(saved);setLocal(merged.order);if(merged.conflicts.length){const remote=mergeConcurrentOrders(base,latest.current,saved,'remote');const pending={fields:merged.conflicts,local:merged.order,remote:remote.order};conflictRef.current=pending;setConflict(pending);setSaveState('Conflict de rezolvat');}else if(sameEditableOrder(merged.order,saved)){clearCallback.current();setSaveState('Sincronizat');setSaveError('');}};
    window.addEventListener('online',retry);document.addEventListener('visibilitychange',retry);window.addEventListener('mobiup-sync-confirmed',synced);
    return()=>{alive=false;window.removeEventListener('online',retry);document.removeEventListener('visibilitychange',retry);window.removeEventListener('mobiup-sync-confirmed',synced);};
  },[owner]);
  useEffect(()=>{onSavedRef.current=onSaved;saveCallback.current=save;clearCallback.current=clearStoredWork;});
  useEffect(()=>{
    if(conflictRef.current||sameEditableOrder(latest.current,confirmed.current)) return;
    const timer=setTimeout(()=>{void saveCallback.current(false).catch(()=>{});},1100);
    return()=>clearTimeout(timer);
  },[order,conflict]);
  useEffect(()=>{
    const beforeUnload=(event:BeforeUnloadEvent)=>{
      if(conflictRef.current||!sameEditableOrder(latest.current,confirmed.current)) event.preventDefault();
    };
    window.addEventListener('beforeunload',beforeUnload);
    return()=>window.removeEventListener('beforeunload',beforeUnload);
  },[]);

  return {
    order,
    update,
    save,
    saveState,
    saveError:saveError||storageError,
    storageError,
    conflict,
    remoteFinalized,
    remoteDeleted,
    resolveConflict,
    recoverToNewDraft,
    discardRemoteRecovery,
    clearStoredWork,
    getCurrent:()=>latest.current,
    getRevision:()=>revision.current,
  };
}