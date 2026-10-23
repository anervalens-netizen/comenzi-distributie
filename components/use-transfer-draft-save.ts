'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {networkApi,errorMessage} from '@/lib/client-api';
import {currentLocalWorkGeneration,currentLocalWorkUserId} from '@/lib/local-work';
import {OFFLINE_EVENT,pendingOperations,readWork,replay,resolveQueuedWork,saveTransferWork,setTransferEditorDirty} from '@/lib/offline-work';
import {sameTransferForm,transferBody,transferForm,type TransferForm,type TransferWork} from '@/lib/transfer-draft';
import type {TransferView} from '@/lib/transfer-types';

export function useTransferDraftSave(initial:TransferView,userId:string){
 const [record,setRecord]=useState(initial),[form,setForm]=useState(()=>transferForm(initial)),[ready,setReady]=useState(false),[saving,setSaving]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[conflicted,setConflicted]=useState(false),[comparison,setComparison]=useState<{remote:TransferView|null;work:TransferWork}|null>(null),[archived,setArchived]=useState(false);
 const [localForm,setLocalForm]=useState<TransferForm|null>(null);
 const formRef=useRef(form),recordRef=useRef(record),workRef=useRef<TransferWork|null>(null),tail=useRef<Promise<unknown>>(Promise.resolve()),alive=useRef(true),generation=useRef(currentLocalWorkGeneration());
 useEffect(()=>{formRef.current=form;recordRef.current=record;},[form,record]);
 const editorId=useRef(crypto.randomUUID()),retired=useRef(false);
 const assertOwner=useCallback(()=>{if(currentLocalWorkUserId()!==userId||currentLocalWorkGeneration()!==generation.current)throw new Error('Contul s-a schimbat. Redeschide transferul.');},[userId]);
 const transport=useCallback((path:string,method:string,body:unknown,id?:string)=>networkApi(path,method,body,undefined,id,userId),[userId]);
 const refresh=useCallback(async()=>{
  const [work,operations]=await Promise.all([readWork<TransferWork>(userId,'transfer',initial.id),pendingOperations(userId)]);assertOwner();if(!alive.current)return;
  const rows=operations.filter(op=>op.path==='transfers/'+initial.id);
  setPending(rows.length>0||!!work?.branches?.length);
  if(rows.some(op=>op.state==='blocked')||work?.branches?.length){setConflicted(true);setError(rows.find(op=>op.state==='blocked')?.error||'Există modificări păstrate din altă filă. Compară versiunile.');}
  if(work&&(work.version===workRef.current?.version||sameTransferForm(formRef.current,work.local))){workRef.current=work;setLocalForm(work.local);setRecord(work.base);}
 },[userId,initial.id,assertOwner]);
 useEffect(()=>{alive.current=true;void (async()=>{try{assertOwner();const work=await readWork<TransferWork>(userId,'transfer',initial.id);assertOwner();if(!alive.current)return;if(work){workRef.current=work;setLocalForm(work.local);setForm(work.local);formRef.current=work.local;setRecord(initial.revision>=work.base.revision?initial:work.base);}setReady(true);await refresh();}catch(e){if(alive.current)setError(errorMessage(e));}})();
  const changed=()=>{void refresh().catch(()=>{});};window.addEventListener(OFFLINE_EVENT,changed);return()=>{alive.current=false;window.removeEventListener(OFFLINE_EVENT,changed);};
 },[userId,initial.id,initial,assertOwner,refresh]);
 const persist=useCallback(async(snapshot:TransferForm)=>{
  const run=async()=>{assertOwner();if(retired.current)return;const previous=workRef.current;if(sameTransferForm(snapshot,previous?.local??transferForm(recordRef.current)))return;
   if(alive.current)setSaving(true);
   try{const result=await saveTransferWork(userId,initial.id,{version:'',base:previous?.base??recordRef.current,local:snapshot,branches:previous?.branches},previous?.version??null);assertOwner();workRef.current=result.work;if(alive.current){setLocalForm(result.work.local);setPending(true);setSaving(false);if(result.conflict){setConflicted(true);setError('Lucrul din ambele file este păstrat pe telefon. Compară versiunile înainte de sincronizare.');}else setError('');}}
   catch(e){if(alive.current){setSaving(false);setError(errorMessage(e));}throw e;}
  };const next=tail.current.then(run,run);tail.current=next.catch(()=>{});return next;
 },[userId,initial.id,assertOwner]);
 useEffect(()=>{if(!ready)return;void persist(form).catch(()=>{});},[ready,form,persist]);
 const sync=useCallback(async()=>{await persist(formRef.current);assertOwner();await replay(userId,transport,currentLocalWorkUserId);await refresh();},[persist,assertOwner,userId,transport,refresh]);
 useEffect(()=>{if(!ready||conflicted)return;const timer=setTimeout(()=>{if(navigator.onLine)void sync().catch(e=>{if(alive.current)setError(errorMessage(e));});},350);return()=>clearTimeout(timer);},[ready,form,pending,conflicted,sync]);
 const compare=useCallback(async()=>{try{await persist(formRef.current);let remote:TransferView|null=null;
  try{remote=(await networkApi<{transfer:TransferView}>('transfers/'+initial.id,'GET',undefined,undefined,undefined,userId)).transfer;}catch(e){if((e as {status?:number}).status!==404)throw e;}
  const work=await readWork<TransferWork>(userId,'transfer',initial.id);assertOwner();if(work&&alive.current)setComparison({remote,work});
 }catch(e){if(alive.current)setError(errorMessage(e));}},[persist,userId,initial.id,assertOwner]);
 const resolve=useCallback(async(local:TransferForm|null)=>{
  if(!comparison)return;setSaving(true);try{const {remote,work}=comparison;assertOwner();const terminal=!remote||remote.status==='finalized';if(terminal&&local)throw new Error('Transferul nu mai permite modificări. Arhivează copia locală pentru recuperare.');const replacement:TransferWork={version:crypto.randomUUID(),base:remote??work.base,local:local??transferForm(remote??work.base)};
   await resolveQueuedWork({expectedWork:work,userId,path:'transfers/'+initial.id,method:'PUT',remote,body:local&&remote?transferBody(local,remote.revision):null,local:{scope:'transfer',id:initial.id,value:replacement},transport,active:currentLocalWorkUserId});assertOwner();if(terminal){retired.current=true;setArchived(true);setTransferEditorDirty(editorId.current,false);}workRef.current=local?replacement:null;setLocalForm(local?replacement.local:null);setRecord(remote??work.base);setForm(replacement.local);formRef.current=replacement.local;setComparison(null);setConflicted(false);setError('');await refresh();
  }catch(e){setError(errorMessage(e));}finally{if(alive.current)setSaving(false);}
 },[comparison,userId,initial.id,transport,assertOwner,refresh]);
 const confirmed=ready&&!pending&&!saving&&!conflicted&&sameTransferForm(form,transferForm(record));
 const localSaved=ready&&!!localForm&&sameTransferForm(form,localForm);
 useEffect(()=>{setTransferEditorDirty(editorId.current,ready&&!localSaved&&!sameTransferForm(form,transferForm(record)));},[ready,localSaved,form,record]);
 useEffect(()=>()=>setTransferEditorDirty(editorId.current,false),[]);
 const changeForm:typeof setForm=useCallback(value=>{setTransferEditorDirty(editorId.current,true);setError('');setForm(value);},[]);
 return {record,form,archived,setForm:changeForm,formRef,recordRef,ready,saving,pending,error,setError,conflicted,comparison,compare,resolve,persist,sync,confirmed,localSaved,setRecord};
}
