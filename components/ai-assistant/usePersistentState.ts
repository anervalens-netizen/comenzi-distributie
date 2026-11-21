import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

type PersistentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PersistentStateOptions<T> {
  storage?: PersistentStorage | null;
  serialize?: (value: T) => string;
  deserialize?: (raw: string, fallback: T) => T;
  removeWhen?: (value: T) => boolean;
}

function getBrowserStorage(): PersistentStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function serializePersistentValue<T>(value: T): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function deserializePersistentValue<T>(raw: string, fallback: T): T {
  // Strings are deliberately stored verbatim, even if they happen to be valid JSON.
  if (typeof fallback === 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return typeof fallback === 'string' ? (raw as T) : fallback;
  }
}

export function readPersistentState<T>(
  key: string,
  fallback: T,
  options: PersistentStateOptions<T> = {},
): T {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  if (!storage) return fallback;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  return (options.deserialize ?? deserializePersistentValue)(raw, fallback);
}

export function writePersistentState<T>(
  key: string,
  value: T,
  options: PersistentStateOptions<T> = {},
) {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  if (!storage) return;
  const remove = options.removeWhen?.(value);
  const serialized = remove ? null : (options.serialize ?? serializePersistentValue)(value);
  try {
    if (serialized === null) storage.removeItem(key);
    else storage.setItem(key, serialized);
  } catch {
    // Preferences can still be used in React state when browser storage is unavailable.
  }
}

export function usePersistentState<T>(
  key: string,
  defaultValue: T | (() => T),
  options: PersistentStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const { storage, serialize, deserialize, removeWhen } = options;
  const [state, setState] = useState<T>(() => {
    const fallback = typeof defaultValue === 'function'
      ? (defaultValue as () => T)()
      : defaultValue;
    return readPersistentState(key, fallback, { storage, deserialize });
  });

  useEffect(() => {
    writePersistentState(key, state, { storage, serialize, removeWhen });
  }, [key, state, storage, serialize, removeWhen]);

  return [state, setState];
}
