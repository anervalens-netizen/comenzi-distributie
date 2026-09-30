import { parentPort, workerData } from 'node:worker_threads';
import { getSalesViewSnapshot } from './sales-store';
import type { SalesCatalogEntry } from './sales-classification';
import type { SalesScope } from './sales-location';

const input=workerData as {
  month:string;
  siteCode?:SalesScope;
  fromMonth:string;
  toMonth:string;
  catalog:SalesCatalogEntry[];
};
try {
  const view=getSalesViewSnapshot(input.month,input.siteCode,input.fromMonth,input.toMonth,input.catalog);
  parentPort?.postMessage({ok:true,view});
} catch(error) {
  parentPort?.postMessage({ok:false,error:error instanceof Error?error.message:'Raportul de vânzări nu a putut fi calculat.'});
}
