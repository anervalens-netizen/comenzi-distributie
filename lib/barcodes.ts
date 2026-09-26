export function validEan(value:string) {
  if(!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value))return false;
  let sum=0;
  for(let i=value.length-2,weight=3;i>=0;i--,weight=weight===3?1:3)sum+=Number(value[i])*weight;
  return (10-sum%10)%10===Number(value.at(-1));
}
