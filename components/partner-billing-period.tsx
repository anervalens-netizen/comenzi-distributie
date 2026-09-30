'use client';
export function PartnerBillingPeriod({value,onChange}:{value:string;onChange:(value:string)=>void}){
  const current=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Europe/Bucharest'}).format(new Date()));
  const years=Array.from({length:Math.max(1,current-2022)},(_,i)=>current-i);
  return <label>Facturare comercială<select value={value} onChange={e=>onChange(e.target.value)}>
    <option value="">Toți partenerii</option>
    {years.map(year=><option key={year} value={'year:'+year}>Cu facturare în {year}</option>)}
    <option value="recent90">Cu facturare în ultimele 90 zile</option>
    <option value="recent365">Cu facturare în ultimele 365 zile</option>
    <option value="older365">Ultima facturare: cel puțin 365 zile</option>
    <option value="unknown">Istoric neasociat sau incomplet</option>
  </select></label>;
}
