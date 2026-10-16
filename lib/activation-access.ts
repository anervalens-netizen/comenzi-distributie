/** Explicit two-account pilot. Unconfigured and other accounts are denied. */
export function canViewActivations(user:{id:string;role:string;active?:number}):boolean {
  if(user.active===0)return false;
  const expected=user.role==='manager'?process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID:user.role==='agent'?process.env.MOBIUP_ACTIVATIONS_PILOT_AGENT_ID:undefined;
  return !!expected?.trim()&&user.id===expected.trim();
}
