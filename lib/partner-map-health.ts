/** Track unresolved resource failures, not map idleness: errored tiles may be idle. */
export function createMapResourceHealth(
  notify: (degraded: boolean) => void,
  retryDelayMs = 750,
  graceMs = 4000,
) {
  const pending = new Map<
    string,
    {
      reported: boolean;
      retryTimer?: ReturnType<typeof setTimeout>;
      warningTimer: ReturnType<typeof setTimeout>;
    }
  >();
  let disposed = false;
  const publish = () => {
    if (!disposed) notify([...pending.values()].some((entry) => entry.reported));
  };
  return {
    fail(key: string, retry?: () => void) {
      // Repeated errors must not postpone the warning or create an infinite retry loop.
      if (disposed || pending.has(key)) return;
      const entry = {
        reported: false,
        retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        warningTimer: setTimeout(() => {
          entry.reported = true;
          publish();
        }, graceMs),
      };
      pending.set(key, entry);
      if (retry)
        entry.retryTimer = setTimeout(() => {
          if (disposed || pending.get(key) !== entry) return;
          try {
            retry();
          } catch {
            // Preserve the unresolved failure and its explicit user retry control.
          }
        }, retryDelayMs);
    },
    recover(key: string) {
      const entry = pending.get(key);
      if (!entry || disposed) return;
      clearTimeout(entry.retryTimer);
      clearTimeout(entry.warningTimer);
      pending.delete(key);
      publish();
    },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.retryTimer);
        clearTimeout(entry.warningTimer);
      }
      pending.clear();
    },
  };
}

export type MapResourceEvent = {
  sourceId?: string;
  tile?: {
    state?: string;
    tileID?: { key: string; canonical: { x: number; y: number; z: number } };
  };
};

export function mapResourceKey(event: MapResourceEvent): string {
  return `${event.sourceId || 'style'}:${event.tile?.tileID?.key || 'metadata'}`;
}
