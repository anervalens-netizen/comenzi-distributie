import {sha256,sessionToken} from './server';
import type {User} from './types';

/** SQL predicate evaluated by the mutation, after all asynchronous preparation. */
export function operationalWriteGuard(req:Request,user:User,options:{agentId?:string;nationalManager?:boolean;globalOnly?:boolean}={}) {
  const nowMs="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
  return {
    sql:`EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.active=1 AND actor.role=? AND actor.profile_revision=? AND (actor.role!='manager' OR actor.must_change_password=0) AND (?=0 OR actor.role='manager' AND actor.manager_scope='global') AND (? IS NULL OR actor.role='agent' AND actor.id=? OR actor.role='manager' AND (?=1 OR actor.manager_scope='global' OR EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=actor.id AND ma.agent_id=?))) AND EXISTS (SELECT 1 FROM sessions actor_session WHERE actor_session.token_hash=? AND actor_session.user_id=actor.id AND actor_session.expires_at>${nowMs}))`,
    args:[user.id,user.role,Number(user.profileVersion),options.globalOnly?1:0,options.agentId??null,options.agentId??null,options.nationalManager?1:0,options.agentId??null,sha256(sessionToken(req))],
  };
}
