import {realpathSync,statSync} from 'node:fs';
import {resolve} from 'node:path';

/** Capture BEFORE opening SQLite, then compare after pinning/reading its snapshot.
 * A pathname stat after open alone says nothing about the opened inode. */
export function historyFileGeneration(file:string):string|null {
  try {
    file=realpathSync(file);
    return file+'|'+['','-wal'].map(suffix=>{
      try {
        const s=statSync(file+suffix,{bigint:true});
        // A read-only WAL open may create an empty file; it has no frames.
        if(suffix&&s.size===BigInt(0))return '-';
        return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
      }
      catch(error){if(suffix&&(error as NodeJS.ErrnoException).code==='ENOENT')return '-';throw error;}
    }).join('|');
  } catch {return null;}
}
export function fileGeneration(directory:string){
  return ['client-sales-history.sqlite','partner-activity.sqlite'].map(name=>historyFileGeneration(resolve(directory,'client-history',name))||'missing').join('|');
}
