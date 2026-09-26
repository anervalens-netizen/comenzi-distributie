export type InventoryScope='all'|'category'|'product';
export type InventoryLine={code:string;name:string;category:string;ean?:string;expected:number;counted:number|null};
export type Inventory={id:string;warehouseId:string;createdBy:string;createdByName:string;scope:InventoryScope;scopeLabel:string;status:'draft'|'finalized'|'cancelled';createdAt:string;updatedAt:string;finalizedAt:string|null;stockImportedAt:string;stockFilename:string;revision:number;lines:InventoryLine[];canEdit:boolean};
export type InventorySummary=Omit<Inventory,'lines'>&{totalCodes:number;checkedCodes:number;expectedTotal:number;countedTotal:number};
export type BarcodeMapping={ean:string;code:string};
