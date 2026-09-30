/** Explainable partner activity indicators. Billing days are NOT order counts. */
export type BillingDay = { date: string; valueCents: number };
export type ActivityRules = {
  minimumDays: number; minimumSpanDays: number; sampleDays: number;
  baselineWindowDays: number; maximumCadenceDays: number; maximumRelativeMad: number;
  overdueFactor: number; minimumOverdueDays: number; inactiveFactor: number;
  minimumInactiveDays: number; newPartnerDays: number; reactivationWindowDays: number;
  staleAfterDays: number;
};
export const defaultActivityRules: ActivityRules = {
  minimumDays: 6, minimumSpanDays: 28, sampleDays: 12, baselineWindowDays: 365,
  maximumCadenceDays: 90, maximumRelativeMad: 0.5, overdueFactor: 1.5,
  minimumOverdueDays: 14, inactiveFactor: 3, minimumInactiveDays: 60,
  newPartnerDays: 60, reactivationWindowDays: 30, staleAfterDays: 3,
};
export type PartnerActivity = {
  status: 'no_billing' | 'insufficient_history' | 'occasional' | 'regular' | 'overdue' | 'inactive';
  asOf: string; sourceLagDays: number; stale: boolean; alertEligible: boolean;
  firstBilling: string | null; lastBilling: string | null; daysSinceBilling: number | null;
  billingDays: number; cadenceDays: number | null; cadenceMadDays: number | null;
  previouslyRegular: boolean; isNew: boolean; reactivated: boolean; seasonalPossible: boolean;
  overdueAfterDays: number | null; inactiveAfterDays: number | null;
  sampleCount: number; reason: string;
};
const DAY = 86_400_000;
function day(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid ISO date');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10)!==value) throw new Error('Invalid ISO date');
  return time / DAY;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a,b)=>a-b), middle=Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
function baseline(dates: number[], rules: ActivityRules) {
  const last=dates.at(-1);
  const sample=last===undefined ? [] : dates.filter(d=>d>=last-rules.baselineWindowDays).slice(-rules.sampleDays);
  const gaps=sample.slice(1).map((d,i)=>d-sample[i]);
  const cadence=gaps.length ? median(gaps) : null;
  const mad=cadence===null ? null : median(gaps.map(g=>Math.abs(g-cadence)));
  const sufficient=sample.length>=rules.minimumDays && sample.at(-1)!-sample[0]>=rules.minimumSpanDays;
  return {sampleCount:sample.length,cadence,mad,sufficient,
    regular:sufficient && cadence!==null && cadence<=rules.maximumCadenceDays && mad!==null && mad/cadence<=rules.maximumRelativeMad};
}
function seasonalPattern(dates: number[], asOf: number): boolean {
  const currentDate=new Date(asOf*DAY), currentYear=currentDate.getUTCFullYear();
  const years=new Map<number,Set<number>>();
  for(const value of dates){
    const date=new Date(value*DAY),year=date.getUTCFullYear();
    if(year>=currentYear || year<currentYear-2)continue;
    const months=years.get(year)||new Set<number>();months.add(date.getUTCMonth());years.set(year,months);
  }
  const a=years.get(currentYear-1),b=years.get(currentYear-2);
  if(!a||!b||a.size>4||b.size>4)return false;
  const union=new Set([...a,...b]),overlap=[...a].filter(m=>b.has(m)).length;
  return overlap/union.size>=0.75 && !union.has(currentDate.getUTCMonth());
}
export function partnerActivity(input: BillingDay[], sourceThrough: string, today: string, coverageComplete=true, overrides: Partial<ActivityRules>={}): PartnerActivity {
  const rules={...defaultActivityRules,...overrides};
  for (const value of Object.values(rules)) if (!Number.isFinite(value)||value<0) throw new Error('Invalid activity rule');
  if(rules.minimumDays<2 || rules.sampleDays<rules.minimumDays || !Number.isInteger(rules.sampleDays) || !Number.isInteger(rules.minimumDays)) throw new Error('Invalid sample rules');
  const source=day(sourceThrough),current=day(today),asOf=Math.min(source,current);
  // Input consists of commercial billing days, net of document cancellations.
  // Aggregate repeated day entries, do not turn missing amounts into zero sales.
  const totals=new Map<number,number>();
  for(const row of input){
    const date=day(row.date);
    if(!Number.isSafeInteger(row.valueCents)) throw new Error('Invalid billing amount');
    if(date<=asOf) totals.set(date,(totals.get(date)||0)+row.valueCents);
  }
  const dates=[...totals].filter(([,value])=>value>0).map(([date])=>date).sort((a,b)=>a-b);
  const lag=Math.max(0,current-source),stale=lag>rules.staleAfterDays;
  const output:PartnerActivity={status:coverageComplete?'no_billing':'insufficient_history',asOf:new Date(asOf*DAY).toISOString().slice(0,10),sourceLagDays:lag,stale,
    alertEligible:false,firstBilling:null,lastBilling:null,daysSinceBilling:null,billingDays:dates.length,cadenceDays:null,cadenceMadDays:null,
    previouslyRegular:false,isNew:false,reactivated:false,seasonalPossible:false,overdueAfterDays:null,inactiveAfterDays:null,sampleCount:0,
    reason:coverageComplete?'Fără facturare comercială în datele disponibile.':'Istoric incomplet sau neasociat; activitatea nu poate fi evaluată sigur.'};
  if(!dates.length)return output;
  const last=dates.at(-1)!,first=dates[0],gap=asOf-last,b=baseline(dates,rules);
  output.firstBilling=new Date(first*DAY).toISOString().slice(0,10);output.lastBilling=new Date(last*DAY).toISOString().slice(0,10);
  output.daysSinceBilling=gap;output.isNew=asOf-first<=rules.newPartnerDays;output.cadenceDays=b.cadence;output.cadenceMadDays=b.mad;
  output.sampleCount=b.sampleCount;output.previouslyRegular=b.regular;
  if(dates.length>1){
    const prior=baseline(dates.slice(0,-1),rules);
    output.reactivated=prior.regular && gap<=rules.reactivationWindowDays &&
      last-dates[dates.length-2]>Math.max(rules.minimumInactiveDays,rules.inactiveFactor*prior.cadence!);
  }
  if(!coverageComplete){output.isNew=false;output.reactivated=false;output.status='insufficient_history';output.reason='Acoperirea istoricului nu este completă; nu generăm alertă de inactivitate.';return output;}
  if(!b.sufficient){output.status='insufficient_history';output.reason='Prea puține zile de facturare sau perioadă prea scurtă pentru un ritm stabil.';return output;}
  if(!b.regular){output.status='occasional';output.reason='Ritmul disponibil nu este suficient de regulat pentru o alertă bazată pe frecvență.';return output;}
  const overdue=Math.ceil(Math.max(rules.minimumOverdueDays,rules.overdueFactor*b.cadence!+b.mad!));
  const inactive=Math.ceil(Math.max(rules.minimumInactiveDays,rules.inactiveFactor*b.cadence!));
  output.overdueAfterDays=overdue;output.inactiveAfterDays=Math.max(inactive,overdue);
  output.status=gap>output.inactiveAfterDays?'inactive':gap>overdue?'overdue':'regular';
  output.seasonalPossible=seasonalPattern(dates,asOf);
  output.alertEligible=!stale && !output.seasonalPossible && ['inactive','overdue'].includes(output.status);
  output.reason=output.status==='regular'?'Facturarea este în ritmul obișnuit.':
    `Ultima facturare acum ${gap} zile; ritmul obișnuit este de aproximativ ${b.cadence} zile.`;
  if(output.seasonalPossible)output.reason+=' Posibil tipar sezonier în cei doi ani anteriori; verifică înainte de a interpreta pauza ca pierdere.';
  if(stale)output.reason+=' Datele sunt întârziate; alerta curentă este suspendată.';
  return output;
}
