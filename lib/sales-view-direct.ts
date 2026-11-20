import { getSalesView } from './sales-store';

export async function getSalesViewRuntime(...args:Parameters<typeof getSalesView>){
  return getSalesView(...args);
}

export async function readFocusSalesAsync(..._input: Parameters<typeof import('./commercial-focus-store').readFocusSales>): Promise<never> {
  throw new Error('Commercial Focus is unavailable in this runtime');
}
