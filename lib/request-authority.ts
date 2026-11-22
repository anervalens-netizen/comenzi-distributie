import type {RequestAuthority} from './request-write-context';
import {db, fail, sessionToken, sha256} from './server';
import type {User} from './types';

/** Capture the authenticated profile and the assignment generation before any body or scope lookup. */
export async function captureRequestAuthority(req:Request,user:User):Promise<RequestAuthority> {
  const table = (clock:string)=>`FROM sessions s JOIN users u ON u.id=s.user_id CROSS JOIN portfolio_revision p
    WHERE p.id=1 AND s.token_hash=?
    AND u.id=? AND u.active=1 AND u.profile_revision=? AND u.role=? AND u.warehouse_id IS ?
    AND (u.role!='manager' OR (u.manager_scope=? AND u.must_change_password=?)) AND s.expires_at>${clock}`;
  const args=[sha256(sessionToken(req)),user.id,Number(user.profileVersion),user.role,user.warehouseId,user.managerScope,Number(user.mustChangePassword)];
  const denied=()=>fail(409,'Sesiunea sau drepturile s-au modificat. Reautentifică-te și reîncearcă.');
  const scope=await db().prepare('SELECT p.scope_revision '+table('?')).bind(...args,Date.now()).first<{scope_revision:number}>();
  if(!scope)return denied();
  const writeClock="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
  return {sql:'SELECT 1 '+table(writeClock)+' AND p.scope_revision=?',args:[...args,scope.scope_revision],denied};
}

export async function assertRequestAuthority(authority:RequestAuthority) {
  if(!await db().prepare(authority.sql).bind(...authority.args).first())authority.denied();
}
