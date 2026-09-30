export type Kind = 'accessories' | 'stands' | 'sim' | 'combined' | 'stand_client';
export type User = { id: string; username: string; name: string; role: 'manager' | 'agent'; managerScope: 'global' | 'assigned'; warehouseId: string | null; warehouseName: string | null; siteCode: string; profileVersion: string; mustChangePassword: boolean; active?: number; clientCount?: number; managedAgentIds?: string[] };
export type Warehouse = { id: string; name: string };
export type Product = { version?: string; ean?: string; eans?: string[]; id: string; code: string; name: string; brand: string; category: string; kind: string; price: number | null; netPrice: number | null; sourceRow: number; image: string | null };
export type Client = { historyCatalog?: {kind?: string; franchiseCode?: string; countySource?: string}; warehouseIds?: string[]; id: string; warehouseId: string; name: string; cui: string; city: string; county: string; address: string; route: string };
export type Line = Product & { quantity: number };
export type Order = { itemCount?: number; id: string; number: string; kind: Kind; userId: string; agentName: string; warehouseId: string; warehouseName: string; status: 'draft' | 'finalized'; items: Line[]; standItems?: Line[]; serials: string[]; client: Client | null; notes: string; createdAt: string; finalizedAt: string | null; sourceOrderId: string | null; revision: number; total: number; pieces: number };
export type Mail = { to: string; cc: string[]; subject: string; body: string; filename: string; mailto: string };
export type Settings = { accessoriesEmail: string; standsEmail: string; simEmail: string; accessoriesCc: string[]; standsCc: string[]; simCc: string[]; partnerTo: string[]; partnerCc: string[]; weeklyLimit: number };
export type OperationalMailSettings = Pick<Settings, 'accessoriesEmail' | 'standsEmail' | 'simEmail' | 'accessoriesCc' | 'standsCc' | 'simCc' | 'partnerTo' | 'partnerCc'>;
export type ManagerMailSettings = { accessories: string; stands: string; sim: string; partner: string };
export type ImportStatusItem = { importedAt: string; filename: string; rows: number; month?: string; warehouses?: number };
export type ImportStatus = { sales: ImportStatusItem | null; stock: ImportStatusItem | null };
export type PartnerRequest = { company: string; location: string; cui: string; storeType: string; contact: string; phone: string; email: string; address: string; county: string };
export type PartnerMail = { to: string; cc: string[]; subject: string; body: string; mailto: string; emlFilename: string };
export type PartnerLocation = { id: string; name: string; cui: string; city: string; county: string; address: string; warehouseIds: string[] };
export type PartnerRequestRecord = PartnerRequest & { id: string; agentId: string; agentName: string; warehouseId: string; warehouseName: string; status: 'requested' | 'confirmed'; createdAt: string; updatedAt: string; confirmedAt: string | null; confirmedBy: string | null; customerId: string | null; revision: number; existingLocations: PartnerLocation[] };
export type TeamActivityAgent = { agentId: string; agentName: string; warehouseName: string; active: boolean; clientCount: number; partnerRequests: number; partnerConfirmed: number; inventories: number; finalizedInventories: number; inventoryDelta: number; inventoryShortage: number; inventorySurplus: number; inventoryDiscrepantLines: number; latestInventory: null | { id: string; createdAt: string; status: 'draft' | 'finalized'; scopeLabel: string; delta: number | null; shortage: number | null; surplus: number | null; discrepantLines: number | null } };
export type TeamActivityView = { month: string; agents: TeamActivityAgent[]; totals: { partnerRequests: number; partnerConfirmed: number; activeAgents: number; agentsWithInventory: number; finalizedInventories: number; inventoryDelta: number; inventoryShortage: number; inventorySurplus: number; inventoryDiscrepantLines: number }; partnerRequests: PartnerRequestRecord[] };
export type ManagerRequestInboxItem = { id:string; type:'partner'; title:string; agentId:string; agentName:string; createdAt:string; location:string; county:string };
export type ManagerRequestInbox = { count:number; items:ManagerRequestInboxItem[] };

/** Operational writes use the authenticated identity, never national read filters. */
export function writePermissions(user: User | null | undefined, users: User[] = []) {
  const global = user?.role === 'manager' && user.managerScope === 'global';
  const assigned = new Set(user?.role === 'manager' && user.managerScope === 'assigned'
    ? users.find(row => row.id === user.id)?.managedAgentIds ?? [] : []);
  const agent = (id: string | null | undefined) => !!id && !!user &&
    (user.role === 'agent' ? user.id === id : global || assigned.has(id));
  // Match canAccessWarehouse: inactive assignments still authorize warehouse writes.
  const warehouse = (id: string | null | undefined) => !!id && !!user &&
    (user.role === 'agent' ? user.warehouseId === id : global || users.some(row => assigned.has(row.id) && row.warehouseId === id));
  const createOrder = (id: string | null | undefined) => agent(id) &&
    (user?.role === 'agent' || users.some(row => row.id === id && row.role === 'agent' && row.active === 1));
  const startInventory = (id: string | null | undefined) => warehouse(id) &&
    (user?.role === 'agent' || users.some(row => row.warehouseId === id && row.role === 'agent' && row.active === 1));
  return { agent, warehouse, createOrder, startInventory };
}
