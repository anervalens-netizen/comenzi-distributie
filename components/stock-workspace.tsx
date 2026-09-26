'use client';
import { ClipboardCheck, Package } from 'lucide-react';
import {Tabs,TabsContent,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {StockPanel} from './stock-panel';
import {InventoryPanel} from './inventory-panel';
export function StockWorkspace({warehouseId,title,manager=false}:{warehouseId?:string|null;title?:string;manager?:boolean}) {
  return <Tabs defaultValue="stock" className="stock-workspace"><TabsList className="stock-mode-tabs"><TabsTrigger value="stock"><Package size={17}/>Stoc</TabsTrigger><TabsTrigger value="inventory"><ClipboardCheck size={17}/>Inventar</TabsTrigger></TabsList><TabsContent value="stock"><StockPanel warehouseId={warehouseId} title={title} showImportMeta={manager}/></TabsContent><TabsContent value="inventory"><InventoryPanel key={warehouseId} warehouseId={warehouseId}/></TabsContent></Tabs>;
}
