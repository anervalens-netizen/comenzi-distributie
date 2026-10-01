/** Bounded, versioned cache for read projections. Callers own a fresh decoded value. */
export function createReadProjectionCache(maxBytes = 24 * 1024 * 1024, maxEntries = 16) {
  const entries = new Map<string, { version: string; json: string; bytes: number }>();
  let bytes = 0;
  const metrics={hits:0,misses:0,rejected:0,evicted:0};
  const remove = (key: string) => {
    const value = entries.get(key);
    if (value) bytes -= value.bytes;
    entries.delete(key);
  };
  return {
    stats:()=>({...metrics,bytes,entries:entries.size}),
    get<T>(key: string, version: string): T | undefined {
      const value = entries.get(key);
      if (!value){metrics.misses++;return undefined;}
      if (value.version !== version) { metrics.misses++;remove(key); return undefined; }
      entries.delete(key); entries.set(key, value);
      metrics.hits++;return JSON.parse(value.json) as T;
    },
    put(key: string, version: string, value: unknown) {
      const json = JSON.stringify(value);
      // Conservative JS string storage bound, including non-ASCII text.
      const size = json.length * 2;
      remove(key);
      if (size > maxBytes){metrics.rejected++;return;}
      while (entries.size >= maxEntries || bytes + size > maxBytes){metrics.evicted++;remove(entries.keys().next().value!);}
      entries.set(key, { version, json, bytes: size }); bytes += size;
    },
  };
}
