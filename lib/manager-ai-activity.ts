import { AppError } from './server';

// Match the provider's ten-minute request timeout, measured from real progress.
const idleMs = 10 * 60_000;

export function managerAiActivity(parent: AbortSignal) {
  const idle = new AbortController();
  const signal = AbortSignal.any([parent, idle.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  function expireInactiveOperation() {
    idle.abort(new AppError(504,
      'Analiza s-a întrerupt după 10 minute fără progres de la furnizor sau sursa de date. Poți relua cererea.'));
  }
  function progress() {
    if (closed || signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(expireInactiveOperation, idleMs);
    timer.unref?.();
  }
  function close() {
    closed = true;
    clearTimeout(timer);
  }
  async function wait<T>(start: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let rejectAbort!: (error: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    try {
      return await Promise.race([interrupted, Promise.resolve().then(() => { signal.throwIfAborted(); return start(); })]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  progress();
  return { signal, progress, wait, close };
}
