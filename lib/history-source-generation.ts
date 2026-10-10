import {realpathSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

const revisionTables=['history_meta','history_references','history_imports','history_identities','history_allocations','history_rows'];
/** Read inside the pinned SQLite transaction. Missing or changed coverage never
 * certifies a logical revision. The importer installs/repairs this protocol. */
export function historyLogicalRevision(c:DatabaseSync):string|null{
  try{
    const triggers=new Map(c.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all().map(row=>[String(row.name),String(row.sql)]));
    for(const table of revisionTables)for(const op of ['INSERT','UPDATE','DELETE']){
      const name='history_revision_'+table+'_'+op.toLowerCase();
      if(triggers.get(name)!=='CREATE TRIGGER '+name+' AFTER '+op+' ON '+table+' BEGIN UPDATE history_revision SET revision=revision+1 WHERE id=1; END')return null;
    }
    const row=c.prepare('SELECT epoch,revision FROM history_revision WHERE id=1').get();
    if(!row||!/^[a-f0-9]{32}$/.test(String(row.epoch))||!Number.isSafeInteger(row.revision)||Number(row.revision)<0)return null;
    const path=String(c.prepare('PRAGMA database_list').get()?.file||''),s=statSync(realpathSync(path),{bigint:true});
    const schema=c.prepare('PRAGMA schema_version').get()?.schema_version;
    return [s.dev,s.ino,row.epoch,row.revision,schema].join(':');
  }catch{return null;}
}
export function sameHistoryRevision(meta:{sourceLogicalRevision?:string|null;sourceGeneration?:string},stamp:{sourceLogicalRevision?:string|null;sourceGeneration?:string}){
  // Legacy derivatives use the original conservative physical guard.
  return meta.sourceLogicalRevision
    ? Boolean(stamp.sourceLogicalRevision&&meta.sourceLogicalRevision===stamp.sourceLogicalRevision)
    : !stamp.sourceLogicalRevision&&meta.sourceGeneration===stamp.sourceGeneration;
}


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
