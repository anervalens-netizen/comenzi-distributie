import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {fail,sessionToken,sha256} from './server';
import type {User} from './types';

/** Identity captured from the authenticated HTTP request, never the raw cookie. */
export function importAuthorization(req:Request,user:User) {
  return {userId:user.id,profileVersion:Number(user.profileVersion),managerScope:user.managerScope,tokenHash:sha256(sessionToken(req))};
}
export type ImportAuthorization=ReturnType<typeof importAuthorization>;

/** Hold the application writer lock until the separate ledger has committed. */
export function withImportAuthorization<T>(req:Request,user:User,write:(check:()=>void,connection:DatabaseSync)=>T):T {
  return withCapturedImportAuthorization(importAuthorization(req,user),write);
}

export function withCapturedImportAuthorization<T>(auth:ImportAuthorization,write:(check:()=>void,connection:DatabaseSync)=>T):T {
  const path=resolve(process.env.MOBIUP_DATA_DIR || './work/server-data','mobiup.sqlite');
  const connection=new DatabaseSync(path,{open:true});
  try {
    connection.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
    const check=()=>{
      const valid=connection.prepare(`SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=? AND u.role='manager' AND u.active=1 AND u.must_change_password=0
        AND u.profile_revision=? AND u.manager_scope=? AND s.token_hash=? AND s.expires_at>?`)
        .get(auth.userId,auth.profileVersion,auth.managerScope,auth.tokenHash,Date.now());
      if(!valid)fail(401,'Sesiunea sau drepturile managerului s-au schimbat. Autentifică-te din nou.');
    };
    check();
    return write(check,connection);
  } finally {
    try{connection.exec('ROLLBACK;');}catch{/* transaction may not have started */}
    connection.close();
  }
}
