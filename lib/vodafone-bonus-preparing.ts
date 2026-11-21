export class VodafoneBonusPreparing extends Error {}

export async function observeVodafoneBonus<T>(operation:Promise<T>, waitMs=2_000) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([operation,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new VodafoneBonusPreparing()),waitMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
