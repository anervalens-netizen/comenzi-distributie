'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/client-api';
import { currentLocalWorkUserId, readLocalWork, removeLocalWork, writeLocalWork } from '@/lib/local-work';
import type { Inventory } from '@/lib/inventory-types';
import { mergeInventoryDraftsForStorage, partitionInventoryDrafts, readClosedInventoryRecovery, type ClosedInventoryRecovery, type InventoryDraftValue as DraftValue, type InventoryScanOperation as ScanOperation, type StoredInventoryWork } from '@/lib/inventory-recovery';

type PendingCallbacks={
  onActive:(inventory:Inventory)=>void;
  onError:(message:string)=>void;
  onMessage:(message:string)=>void;
  onRefresh:()=>void;
};

export function useInventoryPending({active,onActive,onError,onMessage,onRefresh}:{active:Inventory|null;onActive:(inventory:Inventory)=>void;onError:(message:string)=>void;onMessage:(message:string)=>void;onRefresh:()=>void}) {
  const [owner]=useState(currentLocalWorkUserId);
  const activeRef=useRef(active);
  const callbacksRef=useRef<PendingCallbacks>({onActive,onError,onMessage,onRefresh});
  const processQueueRef=useRef<()=>Promise<void>>(async()=>{});
  const [scanQueue,setScanQueueState]=useState<ScanOperation[]>([]);
  const queueRef=useRef<ScanOperation[]>([]);
  const [drafts,setDraftsState]=useState<Record<string,DraftValue>>({});
  const [draftConflicts,setDraftConflictsState]=useState<Record<string,DraftValue>>({});
  const [closedRecovery,setClosedRecovery]=useState<ClosedInventoryRecovery|null>(null);
  const draftsRef=useRef<Record<string,DraftValue>>({});
  const draftConflictsRef=useRef<Record<string,DraftValue>>({});
  const [processing,setProcessing]=useState(false);
  const [paused,setPaused]=useState(false);
  const pausedRef=useRef(false);
  const [storageError,setStorageError]=useState('');
  const processingRef=useRef(false);
  const loadedId=useRef('');

  useEffect(()=>{activeRef.current=active;},[active]);
  useEffect(()=>{callbacksRef.current={onActive,onError,onMessage,onRefresh};},[onActive,onError,onMessage,onRefresh]);

  function setQueuePaused(value:boolean){pausedRef.current=value;setPaused(value);}
  function persist(queue=queueRef.current,draftValues=draftsRef.current,inventory=activeRef.current) {
    if(!owner||!inventory)return;
    const storedDrafts=mergeInventoryDraftsForStorage(draftValues,draftConflictsRef.current);
    if(!queue.length&&!Object.keys(storedDrafts).length) {
      setStorageError(removeLocalWork('inventory',owner,inventory.id));
      return;
    }
    setStorageError(writeLocalWork<StoredInventoryWork>('inventory',owner,inventory.id,{warehouseId:inventory.warehouseId,scanQueue:queue,drafts:storedDrafts}));
  }
  function setQueue(next:ScanOperation[]) {
    queueRef.current=next;setScanQueueState(next);persist(next,draftsRef.current);
  }
  function setDraftValues(next:Record<string,DraftValue>) {
    draftsRef.current=next;setDraftsState(next);persist(queueRef.current,next);
  }
  function setDraft(code:string,value:string) {
    const inventory=activeRef.current;if(!inventory)return;
    const current=inventory.lines.find(line=>line.code===code);
    const conflicts={...draftConflictsRef.current};
    const conflict=conflicts[code];
    if(conflict){delete conflicts[code];draftConflictsRef.current=conflicts;setDraftConflictsState(conflicts);}
    const existing=draftsRef.current[code];
    setDraftValues({...draftsRef.current,[code]:{value,baseCounted:existing?.baseCounted??current?.counted??null}});
  }
  function clearDraft(code:string) {
    const next={...draftsRef.current};delete next[code];setDraftValues(next);
  }
  function discardDrafts(){setDraftValues({});}
  function discardQueue(){setQueue([]);setQueuePaused(false);}

  async function processQueue() {
    if(processingRef.current||pausedRef.current||!queueRef.current.length)return;
    processingRef.current=true;setProcessing(true);
    try {
      while(queueRef.current.length) {
        const operation=queueRef.current[0];
        let inventory:Inventory|null=activeRef.current;
        if(!inventory||inventory.id!==operation.inventoryId||inventory.status!=='draft'||!inventory.canEdit) {
          callbacksRef.current.onError('Scanările neconfirmate nu pot fi reluate deoarece inventarul nu mai este editabil.');setQueuePaused(true);return;
        }
        let completed=false;
        for(let attempt=0;attempt<3&&!completed;attempt++) {
          try {
            const revision:number=inventory.revision;
            const result:{inventory:Inventory}=await api<{inventory:Inventory}>(`inventory/${operation.inventoryId}`,'PATCH',{action:'scan',ean:operation.ean,quantity:operation.quantity,revision,operationId:operation.operationId});
            inventory=result.inventory;activeRef.current=inventory;callbacksRef.current.onActive(inventory);
            setQueue(queueRef.current.slice(1));
            completed=true;
          } catch(error) {
            if(error instanceof ApiError&&(error.status===400||error.status===422)) {
              setQueue(queueRef.current.slice(1));callbacksRef.current.onError(error.message);completed=true;continue;
            }
            if(error instanceof ApiError&&error.status===409) {
              try {
                const result:{inventory:Inventory}=await api<{inventory:Inventory}>(`inventory/${operation.inventoryId}`);
                inventory=result.inventory;activeRef.current=inventory;callbacksRef.current.onActive(inventory);
                if(inventory.status!=='draft'||!inventory.canEdit) {
                  callbacksRef.current.onError('Inventarul a fost închis în altă sesiune. Scanările rămase nu au fost aplicate.');setQueuePaused(true);return;
                }
                continue;
              } catch(refreshError) {callbacksRef.current.onError(errorMessage(refreshError));setQueuePaused(true);return;}
            }
            callbacksRef.current.onError(errorMessage(error));setQueuePaused(true);return;
          }
        }
        if(!completed) {
          callbacksRef.current.onError('Inventarul se modifică simultan. Scanările neconfirmate sunt păstrate local; reîncearcă după actualizare.');setQueuePaused(true);return;
        }
      }
      callbacksRef.current.onMessage('Toate scanările au fost confirmate.');callbacksRef.current.onRefresh();
    } finally {processingRef.current=false;setProcessing(false);}
  }

  useEffect(()=>{processQueueRef.current=processQueue;});

  function enqueueScan(ean:string,quantity:number) {
    const inventory=activeRef.current;
    if(!inventory?.canEdit||inventory.status!=='draft')return false;
    const operation:ScanOperation={operationId:crypto.randomUUID(),inventoryId:inventory.id,ean,quantity};
    const next=[...queueRef.current,operation];
    queueRef.current=next;setScanQueueState(next);persist(next,draftsRef.current,inventory);
    callbacksRef.current.onMessage(next.length===1?'Scanare capturată. Se confirmă…':`${next.length} scanări în coadă.`);
    if(!pausedRef.current)queueMicrotask(()=>void processQueueRef.current());
    return true;
  }
  function retryQueue(){setQueuePaused(false);queueMicrotask(()=>void processQueueRef.current());}
  function resetInMemoryState(){
    queueRef.current=[];setScanQueueState([]);
    draftsRef.current={};setDraftsState({});
    draftConflictsRef.current={};setDraftConflictsState({});
    pausedRef.current=false;setPaused(false);setClosedRecovery(null);
  }

  const activeId=active?.id;
  const activeStatus=active?.status;
  const activeCanEdit=active?.canEdit;
  useEffect(()=>{
    let cancelled=false;
    queueMicrotask(()=>{
      if(cancelled)return;
      if(!activeId){loadedId.current='';resetInMemoryState();return;}
      const inventory=activeRef.current;
      if(!inventory||inventory.id!==activeId)return;
      const changed=loadedId.current!==activeId;
      if(changed){loadedId.current=activeId;resetInMemoryState();}
      if(!owner||activeStatus!=='draft'||!activeCanEdit) {
        const recovery=owner?readClosedInventoryRecovery(inventory,owner):null;
        resetInMemoryState();setClosedRecovery(recovery);
        if(recovery)callbacksRef.current.onError('Inventarul a fost închis în altă sesiune. Cantitățile și scanările locale neconfirmate sunt păstrate pentru recuperare.');
        return;
      }
      if(!changed)return;
      const restored=readLocalWork<StoredInventoryWork>('inventory',owner,activeId);
      if(restored.error)setStorageError(restored.error);
      if(!restored.value||restored.value.warehouseId!==inventory.warehouseId)return;
      const partition=partitionInventoryDrafts(inventory,restored.value.drafts||{});
      draftsRef.current=partition.active;setDraftsState(partition.active);
      draftConflictsRef.current=partition.conflicts;setDraftConflictsState(partition.conflicts);
      const skipped=Object.keys(partition.conflicts).length;
      const queue=(restored.value.scanQueue||[]).filter(item=>item.inventoryId===activeId);
      queueRef.current=queue;setScanQueueState(queue);pausedRef.current=false;setPaused(false);
      if(skipped)callbacksRef.current.onError(`${skipped} cantități locale nu au fost restaurate deoarece inventarul s-a modificat între timp.`);
      if(queue.length){callbacksRef.current.onMessage(`${queue.length} scanări neconfirmate au fost restaurate.`);queueMicrotask(()=>void processQueueRef.current());}
    });
    return()=>{cancelled=true;};
  },[activeId,activeStatus,activeCanEdit,owner]);
  useEffect(()=>{
    const online=()=>{if(queueRef.current.length){setQueuePaused(false);queueMicrotask(()=>void processQueueRef.current());}};
    window.addEventListener('online',online);return()=>window.removeEventListener('online',online);
  },[]);

  function keepLocalConflict(code:string) {
    const inventory=activeRef.current,conflict=draftConflictsRef.current[code];
    if(!inventory||!conflict||loadedId.current!==inventory.id)return;
    const line=inventory.lines.find(item=>item.code===code);
    if(!line)return;
    const conflicts={...draftConflictsRef.current};delete conflicts[code];draftConflictsRef.current=conflicts;setDraftConflictsState(conflicts);
    const activeDrafts={...draftsRef.current,[code]:{value:conflict.value,baseCounted:line.counted}};
    draftsRef.current=activeDrafts;setDraftsState(activeDrafts);persist(queueRef.current,activeDrafts,inventory);
  }
  function acceptServerConflict(code:string) {
    const inventory=activeRef.current;
    if(!inventory||loadedId.current!==inventory.id||!draftConflictsRef.current[code])return;
    const conflicts={...draftConflictsRef.current};delete conflicts[code];draftConflictsRef.current=conflicts;setDraftConflictsState(conflicts);
    persist();
  }
  function discardClosedRecovery() {
    const inventory=activeRef.current;
    if(owner&&inventory)removeLocalWork('inventory',owner,inventory.id);
    setClosedRecovery(null);
  }
  const draftValues=Object.fromEntries(Object.entries(drafts).map(([code,draft])=>[code,draft.value])) as Record<string,string>;
  return {drafts:draftValues,draftConflicts,setDraft,clearDraft,discardDrafts,keepLocalConflict,acceptServerConflict,scanQueue,processing,paused,enqueueScan,retryQueue,discardQueue,storageError,closedRecovery,discardClosedRecovery};
}