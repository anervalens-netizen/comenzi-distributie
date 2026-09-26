import assert from 'node:assert/strict';
import { api, ApiError, SESSION_EXPIRED_EVENT, orderDateKey, orderEffectiveDate } from '../lib/client-api.ts';
import { readLocalWork, setLocalWorkUserId, writeLocalWork } from '../lib/local-work.ts';

const originalFetch=globalThis.fetch;
const originalWindow=globalThis.window;
try {
  class MemoryStorage { map=new Map(); get length(){return this.map.size;} key(i){return Array.from(this.map.keys())[i]??null;} getItem(k){return this.map.has(k)?this.map.get(k):null;} setItem(k,v){this.map.set(k,String(v));} removeItem(k){this.map.delete(k);} }
  const events=new EventTarget(),storage=new MemoryStorage();events.localStorage=storage;globalThis.window=events;let expired=0;events.addEventListener(SESSION_EXPIRED_EVENT,()=>expired++);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Conflict test'}),{status:409,headers:{'Content-Type':'application/json'}});
  await assert.rejects(()=>api('orders/o1','PUT',{}),error=>error instanceof ApiError && error.status===409 && error.message==='Conflict test');

  globalThis.fetch=async()=>new Response('not-json',{status:502});
  await assert.rejects(()=>api('x'),error=>error instanceof ApiError && error.status===502 && error.message==='Operațiunea nu a reușit.');

  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Sesiune expirată'}),{status:401,headers:{'Content-Type':'application/json'}});
  await assert.rejects(()=>api('orders/o1'),error=>error instanceof ApiError&&error.status===401);
  assert.equal(expired,1);

  globalThis.fetch=async()=>new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
  assert.deepEqual(await api('health'),{ok:true});
  setLocalWorkUserId('user-a',storage);writeLocalWork('order','user-a','o-final',{notes:'local recovery'},storage);
  globalThis.fetch=async()=>new Response(JSON.stringify({order:{id:'o-final',status:'finalized'}}),{status:200,headers:{'Content-Type':'application/json'}});
  await api('orders/o-final');
  assert.equal(readLocalWork('order','user-a','o-final',storage).value?.notes,'local recovery');
  const finalized={createdAt:'2026-09-14T10:00:00Z',finalizedAt:'2026-09-15T22:30:00Z'};
  assert.equal(orderEffectiveDate(finalized),finalized.finalizedAt);
  assert.equal(orderDateKey(finalized),'2026-09-16');
  assert.equal(orderDateKey({createdAt:'2026-09-14T10:00:00Z',finalizedAt:null}),'2026-09-14');
  console.log('7 client-api tests passed');
} finally {
  globalThis.fetch=originalFetch;
  if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;
}
