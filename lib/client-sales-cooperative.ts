import {setImmediate} from 'node:timers/promises';
/** Bound CPU runs between I/O turns, including warm projections and sorting. */
export const salesYield=()=>setImmediate();
export async function salesSort<T>(values:T[],compare:(a:T,b:T)=>number):Promise<T[]>{
  let source=[...values],target=Array.from<T>({length:values.length}),work=0;
  for(let width=1;width<source.length;width*=2){
    for(let start=0;start<source.length;start+=width*2){
      const middle=Math.min(start+width,source.length),end=Math.min(start+width*2,source.length);
      let left=start,right=middle;
      for(let i=start;i<end;i++){
        target[i]=left<middle&&(right>=end||compare(source[left],source[right])<=0)?source[left++]:source[right++];
        if(++work%4096===0)await salesYield();
      }
    }
    [source,target]=[target,source];
  }
  return source;
}
