import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeKind } from './runtime';

import { parseVodafoneTopLocations, type VodafoneTopLocation } from './vodafone-top-locations-schema';

export type { VodafoneTopLocation } from './vodafone-top-locations-schema';

const maxBytes = 12 * 1024 * 1024;
let cache: { key: string; rows: readonly VodafoneTopLocation[] } | null = null;

/** Read a validated private snapshot. A missing snapshot means no configured campaign. */
export async function readVodafoneTopLocations(): Promise<readonly VodafoneTopLocation[]> {
  if (runtimeKind !== 'node') return [];
  const path = process.env.MOBIUP_VODAFONE_TOP_LOCATIONS ||
    join(process.env.MOBIUP_DATA_DIR || './work/server-data', 'vodafone-top-locations.json');
  const file = await open(path, 'r').catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return [];
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid Top Locations snapshot size');
    const key = JSON.stringify([path, String(stat.dev), String(stat.ino), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.size)]);
    if (cache?.key === key) return cache.rows;
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat({ bigint: true });
    if (bytesRead !== Number(stat.size) || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs)
      throw new Error('Top Locations snapshot changed during read');
    const rows = parseVodafoneTopLocations(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    cache = { key, rows };
    return rows;
  } finally {
    await file.close();
  }
}
