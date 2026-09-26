const BUCHAREST_TIME_ZONE='Europe/Bucharest';
const monthFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:BUCHAREST_TIME_ZONE,year:'numeric',month:'2-digit'});
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
