import assert from 'node:assert/strict';
import { currentLocalWorkUserId, listLocalWork, readLocalWork, removeLocalWork, setLocalWorkUserId, writeLocalWork } from '../lib/local-work.ts';
import { mergeInventoryDraftsForStorage, partitionInventoryDrafts } from '../lib/inventory-recovery.ts';
import { readFinalizedOrderRecovery } from '../lib/order-recovery.ts';
import { readClosedInventoryRecovery } from '../lib/inventory-recovery.ts';

class MemoryStorage {
  map=new Map();
  get length(){return this.map.size;}
  key(index){return Array.from(this.map.keys())[index]??null;}
  getItem(key){return this.map.has(key)?this.map.get(key):null;}
  setItem(key,value){this.map.set(key,String(value));}
  removeItem(key){this.map.delete(key);}
}
let checks=0;
const check=(condition,message)=>{assert.ok(condition,message);checks++;};
const storage=new MemoryStorage();

check(setLocalWorkUserId('user-a',storage)==='', 'Current user marker can be stored');
check(currentLocalWorkUserId(storage)==='user-a','Current user marker can be read');
check(writeLocalWork('order','user-a','doc-1',{quantity:3},storage)==='','Pending order can be written');
check(readLocalWork('order','user-a','doc-1',storage).value?.quantity===3,'Pending order round-trips');
check(readLocalWork('order','user-b','doc-1',storage).value===null,'Another user cannot read pending work');
check(writeLocalWork('inventory','user-a','inv-1',{queue:[1]},storage)==='','Inventory scope can coexist with order scope');
const listed=listLocalWork('order','user-a',storage).entries;
check(listed.length===1&&listed[0].documentId==='doc-1','Listing stays inside user and scope');
check(removeLocalWork('order','user-a','doc-1',storage)===''&&readLocalWork('order','user-a','doc-1',storage).value===null,'Confirmed work can be removed');
check(writeLocalWork('partner','user-a','new',{company:'AUDIT FIRMA',phone:'0700000000'},storage)==='','New-partner draft can be checkpointed');
check(readLocalWork('partner','user-a','new',storage).value?.company==='AUDIT FIRMA','New-partner draft survives component/session remount');
check(removeLocalWork('partner','user-a','new',storage)===''&&readLocalWork('partner','user-a','new',storage).value===null,'Explicit new request clears partner checkpoint');
const conflictInventory={id:'inv-conflict',warehouseId:'g-1',status:'draft',canEdit:true,lines:[{code:'AUD-A',counted:3},{code:'AUD-B',counted:null}]};
const partition=partitionInventoryDrafts(conflictInventory,{ 'AUD-A':{value:'7',baseCounted:null}, 'AUD-B':{value:'9',baseCounted:null} });
check(partition.active['AUD-B']?.value==='9'&&partition.conflicts['AUD-A']?.value==='7','Inventory restore separates server conflicts without discarding local values');
const persistedDrafts=mergeInventoryDraftsForStorage({...partition.active,'AUD-B':{value:'10',baseCounted:null}},partition.conflicts);
check(persistedDrafts['AUD-A']?.value==='7'&&persistedDrafts['AUD-B']?.value==='10','Unrelated inventory edit preserves unresolved conflicting values');
check(writeLocalWork('inventory','user-a','inv-conflict',{warehouseId:'g-1',scanQueue:[],drafts:persistedDrafts},storage)===''&&readLocalWork('inventory','user-a','inv-conflict',storage).value?.drafts['AUD-A']?.value==='7','Conflicting inventory value survives the next persistence');

const orderBase={id:'order-final',status:'draft',notes:''},orderLocal={...orderBase,notes:'UNSAVED LOCAL AUDIT NOTE'};
writeLocalWork('order','user-a','order-final',{base:orderBase,local:orderLocal},storage);
const orderRecovery=readFinalizedOrderRecovery({id:'order-final',status:'finalized'},'user-a',storage);
check(orderRecovery?.local.notes==='UNSAVED LOCAL AUDIT NOTE','Finalized order still exposes stored local recovery after reload');
check(readLocalWork('order','user-a','order-final',storage).value?.local.notes==='UNSAVED LOCAL AUDIT NOTE','Reading finalized recovery does not delete its checkpoint');
check(readFinalizedOrderRecovery({id:'order-final',status:'draft'},'user-a',storage)===null,'Draft orders continue through the normal editor recovery path');

writeLocalWork('inventory','user-a','inv-closed',{warehouseId:'g-5',scanQueue:[{operationId:'op-1',inventoryId:'inv-closed',ean:'123',quantity:2}],drafts:{DEMOACC2:{value:'7',baseCounted:null}}},storage);
const inventoryRecovery=readClosedInventoryRecovery({id:'inv-closed',warehouseId:'g-5',status:'finalized',canEdit:false},'user-a',storage);
check(inventoryRecovery?.drafts.DEMOACC2.value==='7'&&inventoryRecovery.scanQueue.length===1,'Closed inventory exposes local counts and scan queue for recovery');
check(readLocalWork('inventory','user-a','inv-closed',storage).value?.drafts.DEMOACC2.value==='7','Opening closed inventory does not delete persistent local counts');

const quota={length:0,key(){return null;},getItem(){return null;},removeItem(){},setItem(){throw new DOMException('full','QuotaExceededError');}};
check(/plin/.test(writeLocalWork('order','user-a','doc-2',{x:1},quota)),'Quota failure is reported');
check(/nu permite/.test(setLocalWorkUserId('memory-user',null)),'Unavailable storage is reported for current-user marker');
check(currentLocalWorkUserId(null)==='memory-user','Current user remains available in memory when storage is unavailable');

console.log(`PASS: ${checks} local-work checks.`);