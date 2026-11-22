export const managerAiModels = ['gpt-6.1-terra', 'gpt-6.2-sol'] as const;
export type ManagerAiModel = typeof managerAiModels[number];
export const defaultManagerAiModel = managerAiModels[0];
export const managerAiNotConfiguredMessage = 'Asistentul AI nu este configurat pentru Comenzi.';

export type ManagerAiCell = string | number | null;
export type ManagerAiCoverage = {
  month?: string;
  source: string;
  available: boolean;
  through?: string | null;
  revision?: string;
  note?: string;
};
export type ManagerAiReport = {
  id: string;
  dataset: string;
  dimensions: string[];
  columns: string[];
  rows: ManagerAiCell[][];
  totalRows: number;
  coverage: ManagerAiCoverage[];
};
export type ManagerAiTurn = { role: 'user' | 'assistant'; content: string };
export type ManagerAiAnswer = { answer: string; model: string; reports: ManagerAiReport[] };

export const managerAiFields = {
  digiImports: {
    dimensions:['operation','state','declaredFrom','declaredTo'],
    measures:['sourceRows','distinctSIMs','rowsWithIssues','duplicateSourceRows','matchingTR','otherInternalChannel','withoutExactInternalMatch'],
    purpose:'Jurnal real al importurilor de activări Digi. Un rând per operație. Pentru reconciliere folosește groupBy gol. Nu aduna importuri cumulative. Drepturi globale și fără filtru de portofoliu.',
  },
  sales: {
    dimensions: ['month', 'site', 'sku', 'product', 'brand', 'category', 'productGroup'],
    measures: ['lines', 'units', 'valueLei'],
    purpose: 'Vânzări nete Vodafone ale produselor clasificate exact în catalogul Prepay. Grupează sau filtrează după site pentru detalierea gestiunilor. Un SiteCode gol reprezintă o gestiune fără cod confirmat în datele detaliate.',
  },
  salesByPoint: {
    dimensions: ['month', 'date', 'partner', 'franchise', 'seller', 'erpSite', 'document', 'sku', 'product'],
    measures: ['units', 'valueLei', 'lines', 'missingValueLines'],
    purpose: 'Vânzări Vodafone din istoricul comercial cu franciză explicită și asociere unică la punctul autorizat. Poți filtra după date AAAA-LL-ZZ, număr document sau SKU. Dacă sursa lunară de vânzări există și ea, nu aduna aceleași vânzări din ambele surse.',
  },
  billingDocuments: {
    dimensions: ['month', 'date', 'partner', 'franchise', 'seller', 'erpSite', 'document', 'status'],
    measures: ['units', 'valueLei', 'lines', 'missingValueLines', 'documentGroups'],
    purpose: 'Grupează pozițiile Vodafone pe franciză, dată, ERP SiteId și număr document. Folosește statusul pozitiv net pentru documentele comerciale cu taxare. Istoricul nu certifică emitentul sau tipul fiscal. Pentru filtru de SKU folosește salesByPoint.',
  },
  activations: {
    dimensions: ['month', 'site'],
    measures: ['total', 'sim', 'phoneBundles', 'other', 'unassigned'],
    purpose: 'Activări Vodafone pe lună și gestiune. Raportul activationsPartners oferă detaliul pe punct.',
  },
  sim0Clients: {
    dimensions: ['month', 'cui', 'partner', 'franchise'],
    measures: ['activations', 'confirmedActivations'],
    purpose: 'Activări Vodafone SIM 0 atribuite firmelor din catalog cu CUI valid și punct unic. Exclude clienții generici și identitățile incerte. Pentru un clasament anual pe firme grupează pe cui și partner și sortează descrescător după activations. Pentru detaliu pe punct adaugă franchise. confirmedActivations numără activările cu dovadă comercială fiscală.',
  },
  activationsPartners: {
    dimensions: ['month', 'partner', 'franchise', 'identity'],
    measures: ['activations', 'target'],
    purpose: 'Activări Vodafone și ținta Top Locații pe partener. O țintă lipsă rămâne necunoscută. Mai multe înregistrări pot reprezenta același punct, folosește bonuses pentru registrul pe punct. Datele de activări au tipul cu punct, generic sau neidentificat. Pentru premiul SIM 0 folosește bonuses.',
  },
  partners: {
    dimensions: ['partner', 'franchise', 'county', 'city', 'route'],
    measures: ['points'],
    purpose: 'Portofoliul curent de puncte de lucru. Filtrele lunare se aplică rapoartelor istorice.',
  },
  stands: {
    dimensions: ['month', 'date', 'document', 'partner', 'warehouse', 'sku', 'product'],
    measures: ['units', 'lines'],
    purpose: 'Avize de stand finalizate, cu data, numărul și tipul de pe linia avizului.',
  },
  orders: {
    dimensions: ['month', 'date', 'document', 'warehouse', 'sku', 'product', 'status'],
    measures: ['units', 'lines'],
    purpose: 'Linii de comandă pentru SKU-uri clasificate Vodafone în catalog. Filtrează statusul finalized dacă sunt cerute doar comenzi finalizate.',
  },
  stock: {
    dimensions: ['warehouse', 'site', 'sku', 'product', 'category', 'observedOn'],
    measures: ['units'],
    purpose: 'Ultimul stoc importat pe gestiune pentru SKU-uri clasificate Vodafone. Nu este istoric de stocuri.',
  },
  inventories: {
    dimensions: ['month', 'date', 'warehouse', 'sku', 'product'],
    measures: ['expected', 'counted', 'difference'],
    purpose: 'Linii Vodafone în inventarele finalizate, cu stocul așteptat, numărat și diferența numărat minus așteptat.',
  },
  transfers: {
    dimensions: ['month', 'date', 'document', 'warehouse', 'destination', 'sku', 'product'],
    measures: ['units'],
    purpose: 'Linii Vodafone în transferuri finalizate cu gestiune sursă în portofoliu. Destinațiile din afara portofoliului sunt omise.',
  },
  bonuses: {
    dimensions: ['month', 'partner', 'franchise', 'status'],
    measures: ['activations', 'target', 'bonusSim5', 'bonusTop', 'amountDue', 'settled', 'balance', 'simulatedSettled', 'simulatedBalance'],
    purpose: 'Registrul Vodafone pe lună și punct de lucru. Distinge previzualizarea de luna finalizată.',
  },
  bonusDocuments: {
    dimensions: ['month', 'date', 'document', 'site', 'franchise', 'partner', 'status'],
    measures: ['units'],
    purpose: 'Documente Vodafone la preț zero, candidate și confirmate. Month este luna emiterii. Vezi settlements pentru luna premiului.',
  },
  bonusUnresolved: {
    dimensions: ['month', 'site', 'partner', 'status'],
    measures: ['activations'],
    purpose: 'Activări SIM 0 care necesită identificarea sau verificarea punctului de lucru.',
  },
  settlements: {
    dimensions: ['month', 'paymentDate', 'paymentMonth', 'document', 'site', 'franchise', 'kind', 'status'],
    measures: ['units'],
    purpose: 'Alocări FIFO din documentele la preț zero. Month este luna premiului, paymentMonth este luna emiterii, iar status arată alocarea confirmată sau simulată.',
  },
  focusAccessories: {
    dimensions: ['month', 'seller', 'site', 'sku', 'product'],
    measures: ['units', 'incentiveLei'],
    purpose: 'Accesorii Focus Vodafone pe agent și produs.',
  },
  focusTargets: {
    dimensions: ['month', 'seller', 'site', 'status'],
    measures: ['units', 'target', 'incentiveLei'],
    purpose: 'Realizare target telefoane și stimulent pe agent și lună. Păstrează targetul individual.',
  },
  focusPhones: {
    dimensions: ['month', 'seller', 'site', 'sku', 'product'],
    measures: ['units', 'incentiveLei'],
    purpose: 'Telefoane Focus Vodafone pe agent și produs, cu tariful aplicat din grila lunii.',
  },
} as const;
export type ManagerAiDataset = keyof typeof managerAiFields;

export const managerAiSuggestions = [
  'Arată punctele cu restanțe SIM 0 din septembrie și documentele prin care s-au stins.',
  'Compară activările Vodafone și bonusurile SIM 0 pe ultimele trei luni.',
  'Ce stimulent Focus au agenții mei pe telefoane în luna curentă?',
];
