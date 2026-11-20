export type VodafoneTopLocation = Readonly<{
  month: string;
  pointCode: string;
  target: number;
  bonus: number | null;
}>;

const monthPattern = /^20\d{2}-(0[1-9]|1[0-2])$/;
const pointPattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;

export function parseVodafoneTopLocations(payload: unknown): readonly VodafoneTopLocation[] {
  if (!payload || typeof payload !== 'object' || !('version' in payload) || payload.version !== 1 ||
    !('rows' in payload) || !Array.isArray(payload.rows) || payload.rows.length > 100_000)
    throw new Error('Invalid Vodafone Top Locations dataset');
  const keys = new Set<string>();
  const rows = payload.rows.map((value: unknown): VodafoneTopLocation => {
    if (!value || typeof value !== 'object') throw new Error('Invalid Vodafone Top Locations row');
    const row = value as Record<string, unknown>;
    const { month, target, bonus = null } = row;
    const pointCode = typeof row.pointCode === 'string' ? row.pointCode.trim().toUpperCase() : '';
    if (typeof month !== 'string' || !monthPattern.test(month) || !pointPattern.test(pointCode) ||
      typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0 ||
      (bonus !== null && (typeof bonus !== 'number' || !Number.isSafeInteger(bonus) || bonus < 0)))
      throw new Error('Invalid Vodafone Top Locations values');
    const key = month + '|' + pointCode;
    if (keys.has(key)) throw new Error('Duplicate work point in Vodafone Top Locations month');
    keys.add(key);
    return Object.freeze({ month, pointCode, target, bonus });
  });
  return Object.freeze(rows);
}
