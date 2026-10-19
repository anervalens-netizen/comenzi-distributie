/** Restricted pilot: preserve the original manager/agent and allow explicitly listed additional managers. */
export function canViewActivations(user:{id:string;role:string;active?:number}):boolean {
  if(user.active===0 || !user.id.trim())return false;
  const expected=user.role==='manager'?process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID:user.role==='agent'?process.env.MOBIUP_ACTIVATIONS_PILOT_AGENT_ID:undefined;
  const extra=user.role==='manager'?process.env.MOBIUP_ACTIVATIONS_PILOT_ADDITIONAL_MANAGER_IDS:undefined;
  return [expected,...(extra?.split(',')??[])].some(id=>!!id?.trim()&&id.trim()===user.id);
}
