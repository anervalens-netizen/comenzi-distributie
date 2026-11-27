// Keep order finalization working in legacy runtimes during rollback. See docs/ORDER-LIMITS.md for legacy admin restrictions.
export const UNLIMITED_WEEKLY_STORAGE = 2147483647;
export const normalizeWeeklyLimit = (limit: number): number => limit === UNLIMITED_WEEKLY_STORAGE ? 0 : limit;
export const persistWeeklyLimit = (limit: number): number => limit === 0 ? UNLIMITED_WEEKLY_STORAGE : limit;
export const validWeeklyLimit = (limit: unknown): limit is number => typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 && limit <= 7;
export function parseWeeklyLimit(limit: unknown): number | null {
  const normalized = limit === UNLIMITED_WEEKLY_STORAGE ? 0 : limit;
  return validWeeklyLimit(normalized) ? normalized : null;
}
