export const monthlyAxisNumber=(value:number)=>value.toLocaleString('ro-RO',Math.abs(value)<1000?{maximumFractionDigits:3}:{notation:'compact',maximumFractionDigits:1});
