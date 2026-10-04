/** Empty is optional; otherwise require a real ISO calendar date on a weekday. */
export function visitDateError(value:string):string {
 if(!value)return '';
 const date=new Date(value+'T12:00:00Z');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'2020-01-01'||value>'2100-12-31'||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)return 'Data revenirii este invalidă.';
 return date.getUTCDay()===0||date.getUTCDay()===6?'Planifică revenirea de luni până vineri.':'';
}
