import type {ActivitySnapshot,ActivitySnapshotRow} from './partner-activity-snapshot';
export function validBillingPeriod(value:string) {
  return ['', 'recent90','recent365','older365','unknown'].includes(value)||/^year:20[2-9][0-9]$/.test(value);
}
export function billingPeriodMatches(row:ActivitySnapshotRow|undefined,period:string,asOf:string) {
  if(!validBillingPeriod(period))throw new Error('Invalid billing period');
  if(!period)return true;
  if(period==='unknown')return !row||!row.coverageComplete;
  if(!row)return false;
  if(period.startsWith('year:'))return (row.movementYears||row.billingYears).includes(period.slice(5));
  const last=period==='older365'?row.activity.lastBilling:row.lastMovement||row.activity.lastBilling;
  if(!last)return false;
  const age=Math.floor((Date.parse(asOf)-Date.parse(last))/86400000);
  if(period==='older365')return row.coverageComplete&&age>=365;
  return age>=0&&age<(period==='recent90'?90:365);
}
export function selectBillingPeriod<T extends {id:string}>(partners:T[],snapshot:Extract<ActivitySnapshot,{state:'ready'}>,period:string){
  return partners.filter(p=>billingPeriodMatches(snapshot.rows.get(p.id),period,snapshot.asOf));
}
