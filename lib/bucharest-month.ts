const BUCHAREST_TIME_ZONE='Europe/Bucharest';
const monthFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:BUCHAREST_TIME_ZONE,year:'numeric',month:'2-digit'});
const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:BUCHAREST_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const offsetFormatter=new Intl.DateTimeFormat('en-US',{timeZone:BUCHAREST_TIME_ZONE,timeZoneName:'longOffset',year:'numeric'});

function offsetMinutes(at:Date) {
  const label=offsetFormatter.formatToParts(at).find(part=>part.type==='timeZoneName')?.value||'';
  const match=/^GMT([+-])(\d{2}):(\d{2})$/.exec(label);
  if(!match)throw new Error(`Offset Europe/Bucharest indisponibil: ${label}`);
  const minutes=Number(match[2])*60+Number(match[3]);
  return match[1]==='-'?-minutes:minutes;
}

function localMonthStartUtc(year:number,monthIndex:number) {
  const approximate=Date.UTC(year,monthIndex,1,0,0,0,0);
  return new Date(approximate-offsetMinutes(new Date(approximate))*60_000).toISOString();
}

export function bucharestDayStartUtc(dateKey:string) {
  const match=/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(dateKey);
  if(!match)throw new Error('Data este invalidă.');
  const approximate=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),0,0,0,0);
  const result=new Date(approximate-offsetMinutes(new Date(approximate))*60_000);
  if(dateFormatter.format(result)!==dateKey)throw new Error('Data este invalidă.');
  return result.toISOString();
}

export function bucharestMonthUtcRange(month:string) {
  const match=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if(!match)throw new Error('Luna este invalidă.');
  const year=Number(match[1]),monthIndex=Number(match[2])-1;
  return {start:localMonthStartUtc(year,monthIndex),end:localMonthStartUtc(year,monthIndex+1)};
}

export function bucharestMonthKey(timestamp:string|Date) {
  const date=timestamp instanceof Date?timestamp:new Date(timestamp);
  return monthFormatter.format(date);
}


export function bucharestReportingMonthKey(timestamp:string|Date=new Date()) {
  const date=timestamp instanceof Date?timestamp:new Date(timestamp);
  const parts=dateFormatter.formatToParts(date);
  const year=Number(parts.find(part=>part.type==='year')?.value);
  const month=Number(parts.find(part=>part.type==='month')?.value);
  const day=Number(parts.find(part=>part.type==='day')?.value);
  if(!year||!month||!day)throw new Error('Data Europe/Bucharest este invalidă.');
  if(day!==1)return `${year}-${String(month).padStart(2,'0')}`;
  const previousMonth=month===1?12:month-1;
  const previousYear=month===1?year-1:year;
  return `${previousYear}-${String(previousMonth).padStart(2,'0')}`;
}
