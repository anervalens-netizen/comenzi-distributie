import { readLocalWork, type StorageLike } from './local-work.ts';
import type { Inventory } from './inventory-types.ts';

export type InventoryScanOperation={operationId:string;inventoryId:string;ean:string;quantity:number};
export type InventoryDraftValue={value:string;baseCounted:number|null};
export type StoredInventoryWork={warehouseId:string;scanQueue:InventoryScanOperation[];drafts:Record<string,InventoryDraftValue>};
export type ClosedInventoryRecovery={drafts:Record<string,InventoryDraftValue>;scanQueue:InventoryScanOperation[]};

export function readClosedInventoryRecovery(inventory:Inventory,userId:string,storage?:StorageLike|null):ClosedInventoryRecovery|null {
  if(!userId||(inventory.status==='draft'&&inventory.canEdit))return null;
  const stored=readLocalWork<StoredInventoryWork>('inventory',userId,inventory.id,storage);
  if(!stored.value||stored.value.warehouseId!==inventory.warehouseId)return null;
  const drafts=stored.value.drafts||{},scanQueue=(stored.value.scanQueue||[]).filter(item=>item.inventoryId===inventory.id);
  if(!Object.keys(drafts).length&&!scanQueue.length)return null;
  return {drafts,scanQueue};
}
export type InventoryDraftPartition={active:Record<string,InventoryDraftValue>;conflicts:Record<string,InventoryDraftValue>};

export function partitionInventoryDrafts(inventory:Inventory,drafts:Record<string,InventoryDraftValue>):InventoryDraftPartition {
  const active:Record<string,InventoryDraftValue>={},conflicts:Record<string,InventoryDraftValue>={};
  for(const [code,draft] of Object.entries(drafts)) {
    const line=inventory.lines.find(item=>item.code===code);
    if(line&&line.counted===draft.baseCounted)active[code]=draft;else conflicts[code]=draft;
  }
  return {active,conflicts};
}

export function mergeInventoryDraftsForStorage(active:Record<string,InventoryDraftValue>,conflicts:Record<string,InventoryDraftValue>) {
  return {...conflicts,...active};
}
