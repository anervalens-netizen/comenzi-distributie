import { getSalesView } from './sales-store';

export async function getSalesViewRuntime(...args:Parameters<typeof getSalesView>){
  return getSalesView(...args);
}
