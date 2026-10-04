export { env } from 'cloudflare:workers';
export const runtimeKind = 'cloudflare';
export const operationalStatus = () => ({ state: 'unsupported' as const });
