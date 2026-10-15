declare module '#mobiup-usage-store' {
  export const recordUsageAuth:typeof import('./usage-store-node').recordUsageAuth;
  export const recordUsagePulse:typeof import('./usage-store-node').recordUsagePulse;
  export const readUsage:typeof import('./usage-store-node').readUsage;
}
