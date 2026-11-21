import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {deserialize,serialize} from 'node:v8';

const filenames={ledger:'current.bin',ranking:'ranking.bin',preview:'preview.bin'} as const;
type Slot=keyof typeof filenames;
export type VodafoneDiskCache<T>={load:(directory:string,key:string)=>T|undefined;save:(directory:string,key:string,value:T)=>void};
export function createVodafoneDiskCache<T>(slot:Slot): VodafoneDiskCache<T> {
  return {load:(directory,key)=>readCached<T>(slot,directory,key),save:(directory,key,value)=>writeCached(slot,directory,key,value)};
}

const maxBytes=48*1024*1024;
const digest=(bytes: Buffer)=>createHash('sha256').update(bytes).digest();
let workerIdentity: string | undefined;

/** Bind cached business rules to the immutable deployed executable that computed them. */
function releaseIdentity(slot: Slot) {
  if (!workerIdentity) {
    const name=['vodafone-bonus-worker.mjs','dist/standalone/vodafone-bonus-worker.mjs'].map(file=>resolve(file)).find(existsSync);
    if (name) workerIdentity=createHash('sha256').update(readFileSync(name)).digest('hex');
  }
  return workerIdentity && createHash('sha256').update(workerIdentity+':'+slot).digest('hex');
}

function readCached<T>(slot:Slot,directory:string,key:string): T|undefined {
  let fd: number | undefined;
  try {
    const release=releaseIdentity(slot);
    if (!release) return;
    const folder=join(directory,'.vodafone-bonus-cache');
    const folderInfo=lstatSync(folder);
    if (!folderInfo.isDirectory() || folderInfo.uid!==process.getuid?.() || (folderInfo.mode&0o077)!==0) return;
    fd=openSync(join(folder,filenames[slot]),constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=fstatSync(fd);
    if (!info.isFile() || info.size<160 || info.size>maxBytes || info.uid!==process.getuid?.() || (info.mode&0o077)!==0) return;
    const header=Buffer.alloc(160);
    if (readSync(fd,header,0,160,null)!==160 || header.toString('ascii',0,128)!==release+key) return;
    const data=readFileSync(fd);
    if (data.length!==info.size-160 || !timingSafeEqual(digest(data),header.subarray(128))) return;
    const snapshot=deserialize(data) as {key:string;value:T};
    if (snapshot.key===key) return snapshot.value;
  } catch {
    // A missing or incomplete derived cache is rebuilt from the authorized sources.
  } finally {
    if (fd!==undefined) closeSync(fd);
  }
}

function writeCached<T>(slot:Slot,directory:string,key:string,value:T) {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    const release=releaseIdentity(slot);
    if (!release) return;
    const folder=join(directory,'.vodafone-bonus-cache');
    mkdirSync(folder,{recursive:true,mode:0o700});
    const info=lstatSync(folder);
    if (!info.isDirectory() || (info.mode&0o077)!==0 || info.uid!==process.getuid?.()) return;
    for (const entry of readdirSync(folder)) {
      if (!/^\.[0-9a-f-]{36}\.tmp$/.test(entry)) continue;
      const path=join(folder,entry), file=lstatSync(path,{throwIfNoEntry:false});
      if (file?.isFile() && Date.now()-file.mtimeMs>3600000) unlinkSync(path);
    }
    const bytes=serialize({key,value});
    if (bytes.length+160>maxBytes) return;
    temporary=join(folder,'.'+randomUUID()+'.tmp');
    fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    writeFileSync(fd,Buffer.from(release+key,'ascii'));
    writeFileSync(fd,digest(bytes));
    writeFileSync(fd,bytes);
    closeSync(fd);
    fd=undefined;
    renameSync(temporary,join(folder,filenames[slot]));
    temporary=undefined;
  } catch {
    // Read-only deployments continue with the in-memory snapshot.
  } finally {
    if (fd!==undefined) closeSync(fd);
    if (temporary) try { unlinkSync(temporary); } catch {}
  }
}
