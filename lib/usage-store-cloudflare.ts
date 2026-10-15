// The preview deployment is read-only; usage belongs to the production host.
export const recordUsageAuth=(..._args:unknown[])=>false;
export const recordUsagePulse=(..._args:unknown[])=>false;
export const readUsage=(..._args:unknown[]):import('./usage-model').UsageSnapshot=>{throw new Error('Usage is available on the production host.');};
