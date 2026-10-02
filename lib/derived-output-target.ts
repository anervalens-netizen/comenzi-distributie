import {lstatSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';

/** Resolve the physical parent even when the final file does not exist. Parents
 * must already exist: validating a destination never creates directories/files. */
function physicalTarget(path:string){return resolve(realpathSync(dirname(path)),basename(path));}
function optionalStat(path:string){
  try{return statSync(path,{bigint:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
/** Capture the destination before opening output, then revalidate before rename.
 * Never perform output operations through the caller's mutable symlink alias. */
export function derivedOutputTarget(requested:string,sources:string[]){
  const target=physicalTarget(requested);
  const check=()=>{
    if(physicalTarget(requested)!==target||physicalTarget(target)!==target)throw new Error('Derived output parent changed during snapshot build');
    let final;
    try{final=lstatSync(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // Reject even dangling final symlinks; neither their target nor provenance is
    // a safe staging destination. Hardlinks to authoritative inputs also fail.
    if(final?.isSymbolicLink())throw new Error('Derived output cannot replace a source database or final symlink');
    const output=optionalStat(target);
    for(const source of sources){
      const input=optionalStat(source);
      const canonical=input?realpathSync(source):physicalTarget(source);
      if(target===canonical||(input&&output&&input.dev===output.dev&&input.ino===output.ino))throw new Error('Derived output cannot replace a source database');
    }
  };
  check();
  return {target,check};
}
