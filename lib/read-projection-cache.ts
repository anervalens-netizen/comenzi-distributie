/** Bounded, versioned cache for read projections. Callers own a fresh decoded value. */
export function createReadProjectionCache(maxBytes = 24 * 1024 * 1024, maxEntries = 16) {
  const entries = new Map<string, { version: string; json: string; bytes: number }>();
  let bytes = 0;
  const remove = (key: string) => {
    const value = entries.get(key);
    if (value) bytes -= value.bytes;
    entries.delete(key);
  };
  return {
    get<T>(key: string, version: string): T | undefined {
      const value = entries.get(key);
      if (!value) return undefined;
      if (value.version !== version) { remove(key); return undefined; }
      entries.delete(key); entries.set(key, value);
      return JSON.parse(value.json) as T;
    },
    put(key: string, version: string, value: unknown) {
      const json = JSON.stringify(value);
      // Conservative JS string storage bound, including non-ASCII text.
      const size = json.length * 2;
      remove(key);
      if (size > maxBytes) return;
      while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value!);
      entries.set(key, { version, json, bytes: size }); bytes += size;
    },
  };
}
