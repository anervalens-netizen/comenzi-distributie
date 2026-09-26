export type StorageLike = Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;

export type LocalWorkRead<T> = { value: T | null; error: string };
export type LocalWorkEntry<T> = { documentId: string; value: T };

const PREFIX='mobiup-work-v1';
const USER_KEY='mobiup-work-user-v1';
let memoryUserId='';
const encode=(value:string)=>encodeURIComponent(value);
const decode=(value:string)=>decodeURIComponent(value);
const keyFor=(scope:string,userId:string,documentId:string)=>`${PREFIX}:${encode(scope)}:${encode(userId)}:${encode(documentId)}`;
const userPrefix=(scope:string,userId:string)=>`${PREFIX}:${encode(scope)}:${encode(userId)}:`;

function browserStorage(): StorageLike | null {
  if(typeof window==='undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

function message(error: unknown) {
  if(error instanceof Error && error.name==='QuotaExceededError') return 'Spațiul local al browserului este plin. Modificările neconfirmate nu pot fi păstrate local.';
  return 'Browserul nu permite păstrarea locală a modificărilor neconfirmate.';
}

export function currentLocalWorkUserId(storage:StorageLike|null=browserStorage()) {
  if(!storage)return memoryUserId;
  try{return storage.getItem(USER_KEY)||memoryUserId;}catch{return memoryUserId;}
}
export function setLocalWorkUserId(userId:string,storage:StorageLike|null=browserStorage()):string {
  memoryUserId=userId;
  if(!storage)return userId?'Browserul nu permite păstrarea locală a modificărilor neconfirmate.':'';
  try{if(userId)storage.setItem(USER_KEY,userId);else storage.removeItem(USER_KEY);return '';}catch(error){return message(error);}
}

export function readLocalWork<T>(scope:string,userId:string,documentId:string,storage:StorageLike|null=browserStorage()):LocalWorkRead<T> {
  if(!storage) return {value:null,error:'Browserul nu permite păstrarea locală a modificărilor neconfirmate.'};
  try {
    const raw=storage.getItem(keyFor(scope,userId,documentId));
    if(!raw) return {value:null,error:''};
    const parsed=JSON.parse(raw) as {version?:number;userId?:string;documentId?:string;value?:T};
    if(parsed.version!==1||parsed.userId!==userId||parsed.documentId!==documentId||!('value' in parsed)) {
      storage.removeItem(keyFor(scope,userId,documentId));
      return {value:null,error:'Datele locale neconfirmate erau invalide și au fost ignorate.'};
    }
    return {value:parsed.value??null,error:''};
  } catch(error) { return {value:null,error:message(error)}; }
}

export function writeLocalWork<T>(scope:string,userId:string,documentId:string,value:T,storage:StorageLike|null=browserStorage()):string {
  if(!storage) return 'Browserul nu permite păstrarea locală a modificărilor neconfirmate.';
  try {
    storage.setItem(keyFor(scope,userId,documentId),JSON.stringify({version:1,userId,documentId,updatedAt:new Date().toISOString(),value}));
    return '';
  } catch(error) { return message(error); }
}

export function removeLocalWork(scope:string,userId:string,documentId:string,storage:StorageLike|null=browserStorage()):string {
  if(!storage) return '';
  try { storage.removeItem(keyFor(scope,userId,documentId)); return ''; }
  catch(error) { return message(error); }
}

export function listLocalWork<T>(scope:string,userId:string,storage:StorageLike|null=browserStorage()):{entries:LocalWorkEntry<T>[];error:string} {
  if(!storage) return {entries:[],error:'Browserul nu permite păstrarea locală a modificărilor neconfirmate.'};
  const prefix=userPrefix(scope,userId),entries:LocalWorkEntry<T>[]=[];
  try {
    for(let index=0;index<storage.length;index++) {
      const key=storage.key(index);
      if(!key?.startsWith(prefix)) continue;
      const documentId=decode(key.slice(prefix.length));
      const result=readLocalWork<T>(scope,userId,documentId,storage);
      if(result.value!==null) entries.push({documentId,value:result.value});
    }
    return {entries,error:''};
  } catch(error) { return {entries,error:message(error)}; }
}