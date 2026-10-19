/** Only the explicitly configured owner manager may view usage reports. */
export function canViewUsageReport(user:{id:string;role:string;active?:number}):boolean {
  const owner=process.env.MOBIUP_USAGE_REPORT_OWNER_ID?.trim();
  return user.role==='manager' && user.active!==0 && !!owner && user.id===owner;
}
