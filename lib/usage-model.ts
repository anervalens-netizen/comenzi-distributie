/** Only coarse screen names and time intervals; never document content or keys. */
export const USAGE_SCREENS = ['orders','sim','partner','sales','activations','stock','catalog','activity','team','settings','editor','result'] as const;
export type Interval = [number, number];
export const USAGE_IDLE_MS = 120_000;
export const USAGE_PULSE_MS = 30_000;
export const USAGE_RETENTION_DAYS = 90;
export function unionIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a,b]) => Number.isFinite(a) && b > a).sort((a,b) => a[0]-b[0]);
  const result: Interval[] = [];
  for (const [start,end] of sorted) {
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1],end);
    else result.push([start,end]);
  }
  return result;
}
export const intervalDuration = (intervals: Interval[]) => intervals.reduce((sum,[a,b]) => sum+b-a,0);
export type UsagePulse = { owner:string; id:string; seq:number; screen:string; closed:boolean; spans:{from:number;to:number;active:boolean}[] };
export function parseUsagePulse(value:unknown): UsagePulse | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as UsagePulse;
  if(typeof p.owner !== 'string' || p.owner.length>128 || !/^[a-f0-9-]{36}$/.test(p.id) || !Number.isSafeInteger(p.seq) || p.seq<1 || p.seq>1_000_000 || !USAGE_SCREENS.includes(p.screen as typeof USAGE_SCREENS[number]) || typeof p.closed!=='boolean' || !Array.isArray(p.spans) || p.spans.length>24) return null;
  let previous=90_000;
  for(const s of p.spans) {
    if(!s || !Number.isFinite(s.from) || !Number.isFinite(s.to) || s.from<0 || s.from>90_000 || s.to<0 || s.to>=s.from || s.from>previous || typeof s.active!=='boolean')return null;
    previous=s.to;
  }
  return p;
}
export type UsageDay = {user_id:string;day:string;visible_ms:number;active_ms:number;opens:number;last_seen:number};
export type UsageVisit = {id:string;user_id:string;started_at:number;last_seen:number;ip:string;device:string;screen:string;visible_ms:number;active_ms:number;closed_at:number|null};
export type UsageAuth = {id:string;user_id:string;event:string;at:number;ip:string;device:string};
export type UsageSnapshot = {since:number;retentionDays:number;days:UsageDay[];visits:UsageVisit[];events:UsageAuth[];detailsLimited:boolean;logins:Record<string,number>};
