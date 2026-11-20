import { useEffect, useLayoutEffect, useRef } from 'react';

const stack: HTMLElement[] = [];
/** Focus, Escape and restoration for the topmost open dialog. */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void, enabled = true) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const previous = document.activeElement as HTMLElement | null;
    stack.push(element);
    const controls = () => Array.from(element.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter((node) => !node.hasAttribute('disabled') && node.tabIndex >= 0 && !node.hidden && !node.closest('[hidden], [inert], .hidden') && node.getAttribute('type') !== 'hidden');
    const focusFirst = () => (controls()[0] ?? element).focus();
    focusFirst();
    const keydown = (event: KeyboardEvent) => {
      if (stack.at(-1) !== element) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key === 'Tab') {
        const items = controls(); const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      const index = stack.indexOf(element); if (index >= 0) stack.splice(index, 1);
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [enabled]);
  return ref;
}
