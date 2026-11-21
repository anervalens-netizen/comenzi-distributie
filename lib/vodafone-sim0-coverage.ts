import {bonusDate} from './vodafone-bonus-evidence';

export type Sim0MonthCoverage={
  month:string;sourceThrough:string|null;lastObserved:string|null;reported:boolean;
  status:'complete'|'current'|'partial'|'observed'|'missing';ranges:string[];expectedThrough:string;
};
type Window={start:string;end:string};
const nextDay=(date:string)=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);

/** Only operator intervals certify zeroes. Observed positive facts may exist outside those intervals. */
export function sim0Coverage(from:string,to:string,today:string,windows:Window[],observed:Map<string,string>) {
  const valid=windows.filter(w=>bonusDate(w.start)&&bonusDate(w.end)&&w.start<=w.end).sort((a,b)=>a.start.localeCompare(b.start));
  const result:Sim0MonthCoverage[]=[];
  const cursor=new Date(from+'-01T00:00:00Z');
  while (cursor.toISOString().slice(0,7)<=to) {
    const first=cursor.toISOString().slice(0,10),month=first.slice(0,7);
    cursor.setUTCMonth(cursor.getUTCMonth()+1);
    const last=new Date(cursor.getTime()-86400000).toISOString().slice(0,10);
    const expectedThrough=last<today?last:today;
    const ranges:Window[]=[];
    for(const window of valid) {
      if(window.end<first||window.start>expectedThrough)continue;
      const start=window.start<first?first:window.start,end=window.end>expectedThrough?expectedThrough:window.end;
      const prior=ranges.at(-1);
      if(prior&&start<=nextDay(prior.end)){if(end>prior.end)prior.end=end;}
      else ranges.push({start,end});
    }
    const sourceThrough=ranges[0]?.start===first?ranges[0].end:null;
    const reported=sourceThrough===expectedThrough,lastObserved=observed.get(month)??null;
    const status=reported?(month===today.slice(0,7)?'current':'complete'):ranges.length?'partial':lastObserved?'observed':'missing';
    result.push({month,sourceThrough,lastObserved,reported,status,expectedThrough,ranges:ranges.map(r=>r.start+'–'+r.end)});
  }
  return result;
}
