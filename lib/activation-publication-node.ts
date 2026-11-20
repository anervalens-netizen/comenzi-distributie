import {lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {historyFileGeneration} from './history-source-generation';
import type {ActivationProvider} from './activation-types';

/** Physical publication identity for in-flight and completed report reuse.
 * Checking both files and WALs also supports the older mutable layout. */
export function activationPublicationStamp(provider:ActivationProvider):string|null {
  const root=resolve(process.env.MOBIUP_ACTIVATIONS_DIR||process.env.MOBIUP_DATA_DIR||'./work/server-data');
  const base=provider==='digi'?resolve(root,'digi'):root;
  try {
    const pointer=resolve(base,'current');
    const info=lstatSync(pointer,{throwIfNoEntry:false});
    const directory=info?realpathSync(pointer):base;
    if(info&&(!info.isSymbolicLink()||dirname(directory)!==resolve(base,'generations')))return null;
    const report=historyFileGeneration(resolve(directory,'activation-report.sqlite'));
    const source=historyFileGeneration(resolve(directory,'activations.sqlite'));
    return report&&source?JSON.stringify([report,source]):null;
  }catch{return null;}
}
