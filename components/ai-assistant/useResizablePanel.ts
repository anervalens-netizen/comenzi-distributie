import { useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';
import { usePersistentState } from './usePersistentState';

function subscribeViewport(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
const viewportWidth = () => window.innerWidth;

function clampWidth(width: number, viewport: number, minWidth: number) {
  const upper = Math.min(680, Math.floor(viewport * 0.44));
  return Math.min(upper, Math.max(minWidth, width));
}

export function useResizablePanel(key: string, initialWidth: number, minWidth = 360) {
  const [storedWidth, setStoredWidth] = usePersistentState<number>(key, initialWidth, {
    deserialize: (raw, fallback) => {
      try {
        const value: unknown = JSON.parse(raw);
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
      } catch { return fallback; }
    },
  });
  const viewport = useSyncExternalStore(subscribeViewport, viewportWidth, () => initialWidth);
  const dragging = useRef(false);
  const width = clampWidth(storedWidth, viewport, minWidth);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (dragging.current) setStoredWidth(clampWidth(window.innerWidth - event.clientX, window.innerWidth, minWidth));
    };
    const stop = () => { dragging.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
  }, [minWidth, setStoredWidth]);
  function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const steps: Record<string, number> = { ArrowLeft: 40, ArrowRight: -40 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    setStoredWidth(clampWidth(width + steps[event.key]!, viewport, minWidth));
  }
  return { width, setWidth: setStoredWidth, startResize, onResizeKeyDown };
}
